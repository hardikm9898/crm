import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId, newToken, tenantContext, type TenantPrincipal } from '@leados/shared';
import { ApiKeysService } from '../src/modules/api-keys/api-keys.service.js';
import { ApiLogPartitionProcessor } from '../src/modules/api-keys/api-log.processor.js';
import { ApiLogService } from '../src/modules/api-keys/api-log.service.js';
import { bootTestApp, call, cleanupUsers, type EnvelopeBody, type TestApp } from './app-harness.js';

/**
 * THE KEY-AUTHENTICATED REST SURFACE (`FR-API-1`, `FR-SA-4`, `docs/api-architecture.md` §1).
 *
 * The point of this step is that there is **no second API**: the same routes the web app calls
 * answer a program that sends a key instead of a session, and everything after the guard — the
 * permission, the data scope, the tenant-scoped client — cannot tell the difference. So this suite
 * drives real product endpoints (`/leads`, `/tasks`) with a credential rather than a token, and
 * asserts the four things that make that safe: the credential is checked correctly, a key cannot
 * exceed its creator, it cannot leave its workspace, and every request it makes is recorded.
 *
 * The log is flushed by hand where a test reads it back. Waiting a second for the buffer would make
 * the suite slower and the assertion flakier, and `flush()` exists for exactly this.
 */

const SUFFIX = newToken(4)
  .toLowerCase()
  .replace(/[^a-z0-9]/g, '');
const EMAIL_MARKER = `e2eapi${SUFFIX}`;
const PASSWORD = 'a quiet november harbour';

let ctx: TestApp;
let orgA: Workspace;
let orgB: Workspace;

interface Workspace {
  token: string;
  organizationId: string;
  userId: string;
}

interface CreatedKey {
  id: string;
  keyPrefix: string;
  keyId: string;
  secret: string;
  scopes: string[];
}

async function api<T>(
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  url: string,
  options: {
    token?: string;
    payload?: unknown;
    headers?: Record<string, string>;
    ip?: string;
  } = {},
) {
  return call<EnvelopeBody<T>>(ctx.app, {
    method,
    url: `/api/v1${url}`,
    ...(options.token === undefined ? {} : { token: options.token }),
    ...(options.payload === undefined ? {} : { payload: options.payload }),
    ...(options.headers === undefined ? {} : { headers: options.headers }),
    ...(options.ip === undefined ? {} : { ip: options.ip }),
  });
}

async function setup<T>(
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  url: string,
  options: { token?: string; payload?: unknown } = {},
): Promise<T> {
  const response = await api<T>(method, url, options);
  if (response.statusCode >= 300) {
    throw new Error(`${method} ${url} → ${response.statusCode} ${JSON.stringify(response.body)}`);
  }
  return response.body.data;
}

async function register(name: string): Promise<Workspace> {
  const registered = await setup<{
    organization: { id: string };
    user: { id: string };
    tokens: { accessToken: string };
  }>('POST', '/auth/register', {
    payload: {
      email: `${EMAIL_MARKER}${name}@test.local`,
      password: PASSWORD,
      name: 'API Owner',
      organizationName: `API ${name}`,
    },
  });
  return {
    token: registered.tokens.accessToken,
    organizationId: registered.organization.id,
    userId: registered.user.id,
  };
}

/** A key, and the one credential string a caller sends. */
async function key(
  workspace: Workspace,
  scopes: string[],
  overrides: Record<string, unknown> = {},
): Promise<CreatedKey & { credential: string }> {
  const created = await setup<CreatedKey>('POST', '/api-keys', {
    token: workspace.token,
    payload: { name: `Integration ${newId().slice(-6)}`, scopes, ...overrides },
  });
  return { ...created, credential: `${created.keyId}.${created.secret}` };
}

/** The rows this workspace's log holds for a key, newest first. */
async function logRows(organizationId: string, apiKeyId?: string) {
  await ctx.app.get(ApiLogService).flush();
  return ctx.db.apiLog.findMany({
    where: { organizationId, ...(apiKeyId ? { apiKeyId } : {}) },
    orderBy: { createdAt: 'desc' },
  });
}

beforeAll(async () => {
  ctx = await bootTestApp();
  orgA = await register('a');
  orgB = await register('b');
}, 60_000);

afterAll(async () => {
  await ctx.app.get(ApiLogService).flush();
  await cleanupUsers(ctx.db, EMAIL_MARKER);
  await ctx.close();
});

describe('a key reaches the product API, not a second one (FR-API-1)', () => {
  it('reads leads with lead:read, and is refused the write it was not given', async () => {
    const reader = await key(orgA, ['lead:read']);
    await setup('POST', '/leads', {
      token: orgA.token,
      payload: { firstName: 'Asha', lastName: 'Patel', phone: '+919845012345' },
    });

    const listed = await api<{ fullName: string }[]>('GET', '/leads?limit=5', {
      token: reader.credential,
    });
    expect(listed.statusCode).toBe(200);
    expect(Array.isArray(listed.body.data)).toBe(true);
    expect(listed.body.data.length).toBeGreaterThan(0);

    // The same credential, one route along: the permission guard refuses it with no change to the
    // route and nothing written for keys in particular.
    const refused = await api('POST', '/leads', {
      token: reader.credential,
      payload: { firstName: 'Nobody', lastName: 'AtAll', phone: '+919845099999' },
    });
    expect(refused.statusCode).toBe(403);
    expect(refused.body.error?.code).toBe('PERMISSION_DENIED');
  }, 60_000);

  it('creates a lead when it holds lead:create, and the lead is a real one', async () => {
    const writer = await key(orgA, ['lead:create', 'lead:read']);
    const created = await api<{ id: string }>('POST', '/leads', {
      token: writer.credential,
      payload: { firstName: 'Ravi', lastName: 'FromZapier', phone: '+919845012399' },
    });
    expect(created.statusCode).toBe(201);

    const readBack = await api<{ fullName: string }>('GET', `/leads/${created.body.data.id}`, {
      token: writer.credential,
    });
    expect(readBack.statusCode).toBe(200);
    expect(readBack.body.data.fullName).toBe('Ravi FromZapier');
  }, 60_000);

  it('still lets a session through the same header, told apart by shape', async () => {
    // The regression that would matter most: the key branch must not swallow a JWT.
    const session = await api<{ id: string }>('GET', '/auth/me', { token: orgA.token });
    expect(session.statusCode).toBe(200);
  }, 60_000);

  it('tells a key that a route about the signed-in person is not for it', async () => {
    const reader = await key(orgA, ['lead:read']);
    const refused = await api('GET', '/auth/me', { token: reader.credential });
    // Not "authentication required", which would send an integrator to check a credential that is
    // working perfectly: there is no session behind a key, and the message says so.
    expect(refused.statusCode).toBe(403);
    expect(refused.body.error?.message).toMatch(/signed-in person/i);
  }, 60_000);

  it('answers a key with no REST scopes with the reason, not a bare 403', async () => {
    const ingestOnly = await key(orgA, ['ingest:write']);
    const refused = await api('GET', '/leads', { token: ingestOnly.credential });
    expect(refused.statusCode).toBe(403);
    expect(refused.body.error?.message).toMatch(/public endpoint/i);
  }, 60_000);
});

describe('the credential itself', () => {
  it('refuses a missing, malformed or reversed credential with instructions', async () => {
    const none = await api('GET', '/leads');
    expect(none.statusCode).toBe(401);

    const malformed = await api('GET', '/leads', { token: 'pk_live_nodothere' });
    expect(malformed.statusCode).toBe(401);
    expect(malformed.body.error?.message).toMatch(/pk_live_/);

    const reversed = await api('GET', '/leads', { token: 'pk_live_a.not_a_secret' });
    expect(reversed.statusCode).toBe(401);
  }, 60_000);

  it('refuses an unknown key, a wrong secret, a revoked key and an expired one alike', async () => {
    const live = await key(orgA, ['lead:read']);

    const unknown = await api('GET', '/leads', { token: `pk_live_${newToken(8)}.sk_live_x` });
    expect(unknown.statusCode).toBe(401);

    const wrongSecret = await api('GET', '/leads', { token: `${live.keyId}.sk_live_wrong` });
    expect(wrongSecret.statusCode).toBe(401);
    expect(wrongSecret.body.error?.code).toBe('INVALID_API_KEY');

    const expired = await key(orgA, ['lead:read'], {
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    });
    const expiredCall = await api('GET', '/leads', { token: expired.credential });
    expect(expiredCall.statusCode).toBe(401);

    await setup('POST', `/api-keys/${live.id}/revoke`, { token: orgA.token });
    const revoked = await api('GET', '/leads', { token: live.credential });
    expect(revoked.statusCode).toBe(401);
  }, 60_000);

  it('stops working the moment the key is rotated', async () => {
    const original = await key(orgA, ['lead:read']);
    expect((await api('GET', '/leads', { token: original.credential })).statusCode).toBe(200);

    const rotated = await setup<{ keyId: string; secret: string }>(
      'POST',
      `/api-keys/${original.id}/rotate`,
      { token: orgA.token },
    );
    expect((await api('GET', '/leads', { token: original.credential })).statusCode).toBe(401);
    expect(
      (await api('GET', '/leads', { token: `${rotated.keyId}.${rotated.secret}` })).statusCode,
    ).toBe(200);
  }, 60_000);

  it('honours the address allowlist, and says so', async () => {
    const restricted = await key(orgA, ['lead:read'], { ipAllowlist: ['203.0.113.0/24'] });
    const fromElsewhere = await api('GET', '/leads', {
      token: restricted.credential,
      ip: '198.51.100.9',
    });
    expect(fromElsewhere.statusCode).toBe(403);
    expect(fromElsewhere.body.error?.message).toMatch(/allowlist/i);

    const fromAllowed = await api('GET', '/leads', {
      token: restricted.credential,
      ip: '203.0.113.7',
    });
    expect(fromAllowed.statusCode).toBe(200);
  }, 60_000);

  it('rate limits per key, counting the REST surface separately from ingestion', async () => {
    const slow = await key(orgA, ['lead:read'], { rateLimitPerMin: 1 });
    expect((await api('GET', '/leads', { token: slow.credential })).statusCode).toBe(200);

    const limited = await api('GET', '/leads', { token: slow.credential });
    expect(limited.statusCode).toBe(429);
    expect(limited.body.error?.code).toBe('RATE_LIMITED');
  }, 60_000);
});

describe('a key cannot exceed the person who made it', () => {
  it('refuses a scope the creator does not hold, when the key is created', async () => {
    // Driven through the service with a deliberately narrow principal rather than by rebuilding a
    // role: the rule is about the *caller's* permissions, and this is the smallest honest way to
    // present a caller who lacks one.
    const narrow: TenantPrincipal = {
      organizationId: orgA.organizationId,
      actorType: 'user',
      actorId: orgA.userId,
      permissions: new Set(['api_key:manage', 'lead:read']),
      scopes: new Map([
        ['api_key:manage', 'organization'],
        ['lead:read', 'organization'],
      ]),
      teamIds: [],
      branchIds: [],
      requestId: newId(),
    };

    const service = ctx.app.get(ApiKeysService);
    await expect(
      tenantContext.run(narrow, async () =>
        service.create({ name: 'Too much', scopes: ['lead:read', 'deal:manage'] } as never),
      ),
    ).rejects.toThrow(/deal:manage/);

    // The scope they do hold is fine, which is what makes the refusal about the permission rather
    // than about keys.
    const allowed = await tenantContext.run(narrow, async () =>
      service.create({ name: 'Just right', scopes: ['lead:read'] } as never),
    );
    expect(allowed.scopes).toEqual(['lead:read']);
  }, 60_000);

  it('narrows with its creator, and stops when their access does', async () => {
    const orgC = await register('c');
    const narrowed = await key(orgC, ['lead:read', 'task:read']);
    expect((await api('GET', '/leads', { token: narrowed.credential })).statusCode).toBe(200);

    // The creator's role is replaced with one that no longer reads leads. The key keeps the scope
    // in its row — and must lose the permission anyway, because the row is a ceiling and the
    // creator's current grants are the floor.
    const role = await setup<{ id: string }>('POST', '/roles', {
      token: orgC.token,
      payload: {
        code: `narrow_${SUFFIX}`,
        name: 'Tasks only',
        grants: [
          { permission: 'task:read', scope: 'organization' },
          { permission: 'api_key:manage', scope: 'organization' },
          // Kept so the workspace still has somebody who can administer it, which the API rightly
          // insists on.
          { permission: 'role:manage', scope: 'organization' },
          { permission: 'user:manage', scope: 'organization' },
          { permission: 'organization:read', scope: 'organization' },
        ],
      },
    });
    await setup('PUT', `/users/${orgC.userId}/roles`, {
      token: orgC.token,
      payload: { roleIds: [role.id] },
    });

    const afterNarrowing = await api('GET', '/leads', { token: narrowed.credential });
    expect(afterNarrowing.statusCode).toBe(403);
    // What it still holds keeps working: this is an intersection, not an on/off switch.
    expect((await api('GET', '/tasks', { token: narrowed.credential })).statusCode).toBe(200);
  }, 90_000);
});

describe('a key stays inside its workspace', () => {
  it('cannot read another workspace’s lead, and the refusal is a 404', async () => {
    const theirLead = await setup<{ id: string }>('POST', '/leads', {
      token: orgB.token,
      payload: { firstName: 'Not', lastName: 'Yours', phone: '+919845011111' },
    });
    const reader = await key(orgA, ['lead:read']);

    const refused = await api('GET', `/leads/${theirLead.id}`, { token: reader.credential });
    // 404 rather than 403: another tenant's id and a malformed one must be indistinguishable.
    expect(refused.statusCode).toBe(404);
  }, 60_000);

  it('cannot be granted the permissions that administer the workspace at all', async () => {
    const refused = await api('POST', '/api-keys', {
      token: orgA.token,
      payload: { name: 'Escalation', scopes: ['role:manage'] },
    });
    // Refused by the schema, before any service sees it: `role:manage` is not in the grantable
    // list, so there is no request that puts it on a key.
    expect(refused.statusCode).toBe(400);
  }, 60_000);

  it('cannot read the request log, because api_key:manage is not grantable', async () => {
    const reader = await key(orgA, ['lead:read']);
    const refused = await api('GET', '/api-logs', { token: reader.credential });
    expect(refused.statusCode).toBe(403);
  }, 60_000);
});

describe('the request log (FR-SA-4)', () => {
  it('records what a key did, with the path and without the query string', async () => {
    const reader = await key(orgA, ['lead:read']);
    await api('GET', '/leads?limit=3&search=asha', { token: reader.credential });

    const rows = await logRows(orgA.organizationId, reader.id);
    expect(rows.length).toBeGreaterThan(0);
    const row = rows[0]!;
    expect(row.method).toBe('GET');
    expect(row.path).toBe('/api/v1/leads');
    // The query carried somebody's name. It must not appear in a log that is read by whoever
    // holds `api_key:manage` rather than `lead:read`.
    expect(row.path).not.toContain('asha');
    expect(row.statusCode).toBe(200);
    expect(row.errorCode).toBeNull();
    expect(row.surface).toBe('rest');
    expect(row.durationMs).toBeGreaterThanOrEqual(0);
    expect(row.requestId).toMatch(/^req_/);
  }, 60_000);

  it('records the refusals an integrator opens the log to understand', async () => {
    const throttled = await key(orgA, ['lead:read'], { rateLimitPerMin: 1 });
    await api('GET', '/leads', { token: throttled.credential });
    await api('GET', '/leads', { token: throttled.credential });

    // Its own key, because the rate limiter runs *before* the secret is checked — on a key already
    // at its limit the second refusal would be a 429 and this assertion would quietly be about the
    // same row twice.
    const mistyped = await key(orgA, ['lead:read']);
    await api('GET', '/leads', { token: `${mistyped.keyId}.sk_live_wrong` });

    const throttledRows = await logRows(orgA.organizationId, throttled.id);
    expect(throttledRows.map((row) => `${row.statusCode}:${row.errorCode ?? ''}`)).toContain(
      '429:RATE_LIMITED',
    );

    const mistypedRows = await logRows(orgA.organizationId, mistyped.id);
    // The key resolved, so the workspace can see that somebody is holding a wrong secret for it —
    // which is the difference between "my integration is broken" and "somebody is guessing".
    expect(mistypedRows.map((row) => `${row.statusCode}:${row.errorCode ?? ''}`)).toContain(
      '401:INVALID_API_KEY',
    );
  }, 60_000);

  it('leaves the web app’s own session traffic out of it', async () => {
    const before = await logRows(orgA.organizationId);
    await api('GET', '/leads?limit=1', { token: orgA.token });
    await api('GET', '/tasks?limit=1', { token: orgA.token });
    const after = await logRows(orgA.organizationId);
    // This log is the integration's, not an access log: a hundred times the rows for the one
    // caller that already has a request log would make it useless for the caller that does not.
    expect(after.length).toBe(before.length);
  }, 60_000);

  it('records a capture on the public endpoint under the same key', async () => {
    const poster = await key(orgA, ['ingest:write']);
    const organization = await ctx.db.organization.findFirstOrThrow({
      where: { id: orgA.organizationId },
      select: { publicKey: true },
    });
    const body = JSON.stringify({
      firstName: 'From',
      lastName: 'AWebsite',
      phone: '+919845012388',
    });
    const { signRequest } = await import('@leados/shared');

    const posted = await call(ctx.app, {
      method: 'POST',
      url: `/api/v1/public/leads/${organization.publicKey}`,
      payload: body,
      headers: {
        'content-type': 'application/json',
        'x-api-key': poster.keyId,
        'x-signature': signRequest(poster.secret, Math.floor(Date.now() / 1000), body),
      },
    });
    expect(posted.statusCode).toBe(201);

    const rows = await logRows(orgA.organizationId, poster.id);
    expect(rows[0]?.surface).toBe('public_ingest');
    expect(rows[0]?.path).toContain('/leads');
  }, 60_000);

  it('reads back through GET /api-logs, with a summary over the same filter', async () => {
    const reader = await key(orgA, ['lead:read']);
    await api('GET', '/leads?limit=1', { token: reader.credential });
    await api('GET', '/leads?limit=1', { token: reader.credential });
    await ctx.app.get(ApiLogService).flush();

    const listed = await api<{ statusCode: number; path: string }[]>(
      'GET',
      `/api-logs?apiKeyId=${reader.id}`,
      { token: orgA.token },
    );
    expect(listed.statusCode).toBe(200);
    expect(listed.body.data.length).toBe(2);
    const summary = (listed.body.meta as { summary: Record<string, number> }).summary;
    // Over the filter, not the page: two requests from this key, both of which succeeded.
    expect(summary.requests).toBe(2);
    expect(summary.succeeded).toBe(2);
    expect(summary.refused).toBe(0);
    expect(summary.averageDurationMs).toBeGreaterThanOrEqual(0);

    const usage = await api<{ apiKeyId: string; requests: number }[]>('GET', '/api-logs/usage', {
      token: orgA.token,
    });
    expect(usage.statusCode).toBe(200);
    expect(usage.body.data.find((row) => row.apiKeyId === reader.id)?.requests).toBe(2);
  }, 60_000);

  it('shows one workspace nothing of another’s requests', async () => {
    const theirs = await key(orgB, ['lead:read']);
    await api('GET', '/leads?limit=1', { token: theirs.credential });
    await ctx.app.get(ApiLogService).flush();

    const listed = await api<{ id: string }[]>('GET', '/api-logs?limit=200', {
      token: orgA.token,
    });
    const theirRows = await logRows(orgB.organizationId, theirs.id);
    expect(theirRows.length).toBeGreaterThan(0);
    // The scoping extension does this; the assertion is that nothing in the read path undoes it.
    expect(listed.body.data.map((row) => row.id)).not.toContain(theirRows[0]!.id);
  }, 60_000);

  it('cannot be made to fail a request, even when the write cannot happen', async () => {
    const logs = ctx.app.get(ApiLogService);
    // A row whose organization does not exist: the FK refuses the batch, and the request that
    // produced it has already been answered. A recorder of what happened must not be able to
    // change what happened.
    logs.record({
      organizationId: newId(),
      apiKeyId: null,
      surface: 'rest',
      method: 'GET',
      path: '/api/v1/leads',
      statusCode: 200,
      errorCode: null,
      durationMs: 1,
      bytesIn: 0,
      bytesOut: 0,
      requestId: `req_${newId()}`,
      ip: null,
      userAgent: null,
      createdAt: new Date(),
    });
    await expect(logs.flush()).resolves.toBeUndefined();

    // And the surface still works afterwards.
    const reader = await key(orgA, ['lead:read']);
    expect((await api('GET', '/leads?limit=1', { token: reader.credential })).statusCode).toBe(200);
  }, 60_000);
});

describe('the log’s partitions', () => {
  it('keeps a week of days ahead and drops what is past retention', async () => {
    // A partition for a day far outside the window, created the way the function would have.
    await ctx.db.$executeRawUnsafe(
      `CREATE TABLE IF NOT EXISTS "api_logs_20200101" PARTITION OF "api_logs" FOR VALUES FROM ('2020-01-01') TO ('2020-01-02')`,
    );

    await ctx.app.get(ApiLogPartitionProcessor).process({} as never, {} as never);

    const partitions = await ctx.db.$queryRawUnsafe<{ relname: string }[]>(
      `SELECT c.relname FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
       WHERE i.inhparent = 'api_logs'::regclass`,
    );
    const names = partitions.map((row) => row.relname);
    expect(names).not.toContain('api_logs_20200101');
    // The default partition is never dropped: it is what stops a day with no partition losing a
    // row, and its name cannot match the dated pattern the sweep looks for.
    expect(names).toContain('api_logs_default');

    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10).replace(/-/g, '');
    expect(names).toContain(`api_logs_${tomorrow}`);
  }, 60_000);
});
