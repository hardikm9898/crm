import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newToken, signRequest } from '@leados/shared';
import { ApiLogService } from '../src/modules/api-keys/api-log.service.js';
import { IntegrationHealthService } from '../src/modules/integrations/integration-health.service.js';
import { bootTestApp, call, cleanupUsers, type EnvelopeBody, type TestApp } from './app-harness.js';

/**
 * THE INTEGRATION FRAMEWORK SUITE (Phase 4 step 6: provider registry, credential vault, health
 * checks, generic mapping templates).
 *
 * Nothing is mocked, including Postmark: a real HTTP server runs in-process answering whatever the
 * test needs, and `POSTMARK_API_URL` points at it. That is the only way to prove the things that
 * matter — that a refused token becomes `revoked` with a notification rather than a retry loop,
 * that a 500 escalates on the second failure and not the first, and that a fresh token clears the
 * failure. A probe that could only be tested against a stub would be a probe nothing proves, which
 * is the lesson the outbound webhook suite established.
 *
 * The inbound door is driven with a **string** body and a signature computed over those exact
 * bytes: `{"a":1}` and `{ "a": 1 }` are the same object and different bytes, so a suite that let
 * the injector serialise for it would be testing a signature over something the sender never sent.
 */

const SUFFIX = newToken(4)
  .toLowerCase()
  .replace(/[^a-z0-9]/g, '');
const EMAIL_MARKER = `e2eint${SUFFIX}`;
const PASSWORD = 'a quiet november harbour';
const GOOD_TOKEN = 'postmark-server-token-0123456789';

let ctx: TestApp;
let postmark: Server;
let postmarkUrl: string;
let previousPostmarkUrl: string | undefined;
const postmarkRequests: { token: string | undefined; path: string }[] = [];
/** What the fake Postmark answers next. A function so a test can change its mind mid-suite. */
let postmarkAnswer: (request: IncomingMessage) => { status: number; body: string } = () => ({
  status: 200,
  body: JSON.stringify({ ID: 1, Name: 'Lead OS transactional' }),
});

let orgA: { token: string; organizationId: string; userId: string };
let orgB: { token: string; organizationId: string; userId: string };
/**
 * A workspace with nothing connected, for the refusals that are *about* connecting.
 *
 * Without it those tests read the "already connected" 422 instead of the refusal they are testing
 * — a test passing for the wrong reason, decided by the order the suite happens to run in. Each
 * test creates what it needs.
 */
let orgC: { token: string; organizationId: string; userId: string };

async function api<T>(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  options: { token?: string; payload?: unknown; headers?: Record<string, string> } = {},
) {
  return call<EnvelopeBody<T>>(ctx.app, {
    method,
    url: `/api/v1${url}`,
    ...(options.token === undefined ? {} : { token: options.token }),
    ...(options.payload === undefined ? {} : { payload: options.payload }),
    ...(options.headers === undefined ? {} : { headers: options.headers }),
  });
}

/**
 * The connections a workspace can see.
 *
 * `data` is the **array**: the envelope lifts `items` out of a paginated payload and moves
 * `pagination` into `meta`, so a caller that reads `data.items` reads `undefined`.
 */
async function connections(token: string, query = ''): Promise<Connection[]> {
  return setup<Connection[]>('GET', `/integrations${query}`, { token });
}

async function connectionOf(token: string, provider: string): Promise<Connection> {
  const found = (await connections(token)).find((item) => item.provider === provider);
  if (!found) throw new Error(`no live ${provider} connection for this workspace`);
  return found;
}

/** A setup call whose status nobody asserts fails silently and takes the assertion with it. */
async function setup<T>(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  options: { token?: string; payload?: unknown } = {},
): Promise<T> {
  const response = await api<T>(method, url, options);
  if (response.statusCode >= 300) {
    throw new Error(`${method} ${url} → ${response.statusCode} ${JSON.stringify(response.body)}`);
  }
  return response.body.data;
}

interface Connection {
  id: string;
  provider: string;
  providerLabel: string;
  name: string;
  status: string;
  statusSummary: string;
  authKind: string | null;
  settings: Record<string, unknown>;
  fieldMappings: { source: string; target: string; transform?: string }[];
  lastSuccessAt: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
  disconnectedAt: string | null;
  recentChecks: { outcome: string; latencyMs: number | null }[];
  secret?: string;
  secretShownOnce?: boolean;
}

async function register(name: string) {
  const email = `${EMAIL_MARKER}${name}@test.local`;
  const registered = await setup<{
    organization: { id: string };
    user: { id: string };
    tokens: { accessToken: string };
  }>('POST', '/auth/register', {
    payload: {
      email,
      password: PASSWORD,
      name: 'Integration Owner',
      organizationName: `INT ${name}`,
    },
  });
  return {
    token: registered.tokens.accessToken,
    organizationId: registered.organization.id,
    userId: registered.user.id,
  };
}

/** Connects Postmark for a workspace, with whatever the test wants to vary. */
async function connectPostmark(
  token: string,
  overrides: Record<string, unknown> = {},
): Promise<Connection> {
  return setup<Connection>('POST', '/integrations', {
    token,
    payload: {
      provider: 'postmark',
      name: 'Transactional email',
      credentials: { serverToken: GOOD_TOKEN },
      settings: { fromAddress: 'hello@leados.test', messageStream: 'outbound' },
      ...overrides,
    },
  });
}

async function connectWebhook(
  token: string,
  overrides: Record<string, unknown> = {},
): Promise<Connection & { secret: string }> {
  return setup<Connection & { secret: string }>('POST', '/integrations', {
    token,
    payload: {
      provider: 'generic_webhook',
      name: 'Partner site',
      settings: { sourceName: 'Partner site' },
      fieldMappings: [
        { source: 'contact.full_name', target: 'name', transform: 'trim' },
        { source: 'contact.mobile', target: 'phone', transform: 'phone' },
        { source: 'contact.email_address', target: 'email', transform: 'lowercase' },
        { source: 'enquiry.note', target: 'message' },
      ],
      ...overrides,
    },
  });
}

/** One signed inbound request, over the exact bytes it sends. */
async function post(
  connectionId: string,
  body: unknown,
  options: {
    secret?: string;
    provider?: string;
    idempotencyKey?: string;
    signature?: string;
    timestamp?: number;
  } = {},
) {
  const raw = JSON.stringify(body);
  const timestamp = options.timestamp ?? Math.floor(Date.now() / 1000);
  const signature =
    options.signature ??
    (options.secret === undefined ? undefined : signRequest(options.secret, timestamp, raw));
  return call<EnvelopeBody<{ status: string; leadId: string; payloadId: string }>>(ctx.app, {
    method: 'POST',
    url: `/api/v1/wh/${options.provider ?? 'generic_webhook'}/${connectionId}`,
    payload: raw,
    headers: {
      'content-type': 'application/json',
      ...(signature === undefined ? {} : { 'x-signature': signature }),
      ...(options.idempotencyKey === undefined
        ? {}
        : { 'idempotency-key': options.idempotencyKey }),
    },
  });
}

beforeAll(async () => {
  postmark = createServer((request, response) => {
    postmarkRequests.push({
      token: request.headers['x-postmark-server-token'] as string | undefined,
      path: request.url ?? '',
    });
    const answer = postmarkAnswer(request);
    response.writeHead(answer.status, { 'content-type': 'application/json' });
    response.end(answer.body);
  });
  await new Promise<void>((resolve) => postmark.listen(0, '127.0.0.1', resolve));
  postmarkUrl = `http://127.0.0.1:${(postmark.address() as AddressInfo).port}`;
  // Set before the application is built, because the config is validated once at boot — which is
  // also what makes this a real probe rather than an assertion about a stub.
  previousPostmarkUrl = process.env['POSTMARK_API_URL'];
  process.env['POSTMARK_API_URL'] = postmarkUrl;

  ctx = await bootTestApp();
  await cleanupUsers(ctx.db, EMAIL_MARKER);
  orgA = await register('a');
  orgB = await register('b');
  orgC = await register('c');
}, 120_000);

afterAll(async () => {
  await cleanupUsers(ctx.db, EMAIL_MARKER);
  await ctx.close();
  await new Promise<void>((resolve) => postmark.close(() => resolve()));
  if (previousPostmarkUrl === undefined) delete process.env['POSTMARK_API_URL'];
  else process.env['POSTMARK_API_URL'] = previousPostmarkUrl;
});

describe('the provider registry', () => {
  it('offers every provider with the settings a connect form needs', async () => {
    const response = await api<
      {
        key: string;
        label: string;
        summary: string;
        authKind: string;
        settings: { key: string; label: string; required: boolean }[];
        mappable: boolean;
        probeable: boolean;
        connection: unknown;
      }[]
    >('GET', '/integrations/providers', { token: orgC.token });
    expect(response.statusCode).toBe(200);

    const items = response.body.data;
    const keys = items.map((item) => item.key);
    expect(keys).toContain('postmark');
    expect(keys).toContain('generic_webhook');
    for (const item of items) {
      // Enough for a screen to render the form without knowing anything about the provider.
      expect(item.label.length).toBeGreaterThan(2);
      expect(item.summary.length).toBeGreaterThan(40);
      expect(['api_key', 'shared_secret']).toContain(item.authKind);
      expect(item.connection).toBeNull();
    }

    const postmarkEntry = items.find((item) => item.key === 'postmark')!;
    expect(postmarkEntry.settings.map((setting) => setting.key)).toEqual([
      'fromAddress',
      'messageStream',
    ]);
    // The honest answer to "does the test button do anything here": one of these can be asked and
    // one cannot, and a screen that offered the button on both would be offering a lie.
    expect(postmarkEntry.probeable).toBe(true);
    expect(items.find((item) => item.key === 'generic_webhook')!.probeable).toBe(false);
  });

  it('refuses a provider nothing implements, and says what there is', async () => {
    const response = await api('POST', '/integrations', {
      token: orgC.token,
      payload: { provider: 'salesforce', name: 'Nope', settings: {} },
    });
    expect(response.statusCode).toBe(400);
    expect(response.body.error?.code).toBe('VALIDATION_FAILED');
    expect(JSON.stringify(response.body.error?.details)).toContain('generic_webhook');
  });
});

describe('connecting a provider we authenticate to', () => {
  it('refuses a missing required setting, naming the field', async () => {
    const response = await api('POST', '/integrations', {
      token: orgC.token,
      payload: {
        provider: 'postmark',
        name: 'Email',
        credentials: { serverToken: GOOD_TOKEN },
        settings: { messageStream: 'outbound' },
      },
    });
    expect(response.statusCode).toBe(400);
    expect(JSON.stringify(response.body.error?.details)).toContain('settings.fromAddress');
  });

  it('refuses a setting the provider does not have, rather than storing a dead box', async () => {
    const response = await api('POST', '/integrations', {
      token: orgC.token,
      payload: {
        provider: 'postmark',
        name: 'Email',
        credentials: { serverToken: GOOD_TOKEN },
        settings: { fromAddress: 'hello@leados.test', replyTo: 'nobody@leados.test' },
      },
    });
    expect(response.statusCode).toBe(400);
    expect(JSON.stringify(response.body.error?.details)).toContain('settings.replyTo');
  });

  it('refuses something that is not a credential before it reaches the provider', async () => {
    const before = postmarkRequests.length;
    const response = await api('POST', '/integrations', {
      token: orgC.token,
      payload: {
        provider: 'postmark',
        name: 'Email',
        credentials: { serverToken: 'hunter2' },
        settings: { fromAddress: 'hello@leados.test' },
      },
    });
    expect(response.statusCode).toBe(400);
    expect(JSON.stringify(response.body.error?.details)).toContain('credentials.serverToken');
    // Nothing was asked of Postmark: a shape we can rule out ourselves is not a round trip.
    expect(postmarkRequests.length).toBe(before);
  });

  it('connects, probes immediately, and never answers the credential back', async () => {
    const before = postmarkRequests.length;
    const connection = await connectPostmark(orgA.token);

    expect(connection.provider).toBe('postmark');
    expect(connection.providerLabel).toBe('Postmark');
    expect(connection.status).toBe('connected');
    // A row that said `connected` because nothing had asked would be the dry run's lie again.
    expect(postmarkRequests.length).toBe(before + 1);
    expect(postmarkRequests.at(-1)?.token).toBe(GOOD_TOKEN);
    expect(postmarkRequests.at(-1)?.path).toBe('/server');
    expect(connection.lastSuccessAt).not.toBeNull();
    expect(connection.recentChecks[0]?.outcome).toBe('ok');
    // A successful probe is a measurement, and the CHECK refuses one without it.
    expect(connection.recentChecks[0]?.latencyMs).toBeGreaterThanOrEqual(0);
    // The sentence, not the enum: a screen rendering `degraded` as the word "degraded" is written
    // for the schema rather than for the person reading it.
    expect(connection.statusSummary).toMatch(/Working/i);

    // The credential is not in the answer, under any name.
    expect(connection.secret).toBeUndefined();
    expect(JSON.stringify(connection)).not.toContain(GOOD_TOKEN);

    // And what is stored is an envelope, bound to this row — not the token.
    const row = await ctx.db.integrationConnection.findFirstOrThrow({
      where: { id: connection.id },
      select: { credentialsEncrypted: true, keyVersion: true, organizationId: true },
    });
    expect(row.credentialsEncrypted.startsWith('v1.')).toBe(true);
    expect(row.credentialsEncrypted).not.toContain(GOOD_TOKEN);
    expect(row.keyVersion).toBeGreaterThanOrEqual(1);
    expect(row.organizationId).toBe(orgA.organizationId);
  });

  it('refuses a second live connection to the same provider, naming the first', async () => {
    const response = await api('POST', '/integrations', {
      token: orgA.token,
      payload: {
        provider: 'postmark',
        name: 'Another one',
        credentials: { serverToken: GOOD_TOKEN },
        settings: { fromAddress: 'hello@leados.test' },
      },
    });
    expect(response.statusCode).toBe(422);
    expect(response.body.error?.code).toBe('BUSINESS_RULE_VIOLATION');
    expect(response.body.error?.message).toContain('Transactional email');
  });
});

describe('what a probe does to a connection', () => {
  it('escalates a provider that answers and refuses, on the second failure and not the first', async () => {
    const connection = await connectPostmark(orgB.token);
    postmarkAnswer = () => ({ status: 500, body: JSON.stringify({ Message: 'Server error' }) });
    try {
      const first = await setup<{ outcome: string; statusAfter: string; latencyMs: number | null }>(
        'POST',
        `/integrations/${connection.id}/check`,
        { token: orgB.token },
      );
      expect(first.outcome).toBe('degraded');
      expect(first.statusAfter).toBe('degraded');
      // Reached and timed: the difference between this and `unreachable` is that one has a
      // measurement and the other cannot.
      expect(first.latencyMs).toBeGreaterThanOrEqual(0);

      const second = await setup<{ statusAfter: string }>(
        'POST',
        `/integrations/${connection.id}/check`,
        { token: orgB.token },
      );
      expect(second.statusAfter).toBe('error');

      const after = await setup<Connection>('GET', `/integrations/${connection.id}`, {
        token: orgB.token,
      });
      expect(after.status).toBe('error');
      // The provider's own sentence, kept rather than paraphrased.
      expect(after.lastError).toContain('Server error');
      expect(after.lastErrorAt).not.toBeNull();
      expect(after.statusSummary).toMatch(/status page/i);
    } finally {
      postmarkAnswer = () => ({ status: 200, body: JSON.stringify({ Name: 'Lead OS' }) });
    }
  });

  it('revokes a refused credential with no grace period, and tells somebody who can fix it', async () => {
    const id = (await connectionOf(orgB.token, 'postmark')).id;

    postmarkAnswer = () => ({
      status: 401,
      body: JSON.stringify({
        ErrorCode: 10,
        Message: 'No account or server API tokens were supplied.',
      }),
    });
    try {
      const result = await setup<{ outcome: string; statusAfter: string }>(
        'POST',
        `/integrations/${id}/check`,
        { token: orgB.token },
      );
      expect(result.outcome).toBe('unauthorized');
      // No grace period: no number of retries fixes a credential somebody deleted.
      expect(result.statusAfter).toBe('revoked');
    } finally {
      postmarkAnswer = () => ({ status: 200, body: JSON.stringify({ Name: 'Lead OS' }) });
    }

    const after = await setup<Connection>('GET', `/integrations/${id}`, { token: orgB.token });
    expect(after.status).toBe('revoked');
    expect(after.statusSummary).toMatch(/reconnect/i);

    const notifications = await ctx.db.notification.findMany({
      where: { organizationId: orgB.organizationId, type: 'integration.revoked' },
      select: { userId: true, title: true, body: true, data: true, link: true },
    });
    expect(notifications.length).toBe(1);
    expect(notifications[0]?.userId).toBe(orgB.userId);
    expect(notifications[0]?.link).toBe('/settings/integrations');
    expect(notifications[0]?.title).toContain('Postmark');
    // The connection id, because the release sweep re-checks the subject by it before delivering a
    // held notice — a warning about a credential somebody has already replaced is worse than none.
    expect((notifications[0]?.data as { connectionId?: string })?.connectionId).toBe(id);
  });

  it('starts again from connected when a fresh credential is pasted, and re-probes', async () => {
    const id = (await connectionOf(orgB.token, 'postmark')).id;
    const before = postmarkRequests.length;

    const updated = await setup<Connection>('PATCH', `/integrations/${id}`, {
      token: orgB.token,
      payload: { credentials: { serverToken: 'postmark-server-token-abcdefghij' } },
    });
    expect(updated.status).toBe('connected');
    expect(updated.lastError).toBeNull();
    expect(postmarkRequests.length).toBe(before + 1);
    expect(postmarkRequests.at(-1)?.token).toBe('postmark-server-token-abcdefghij');
  });

  it('refuses to check a provider there is nothing to ask, and says what to do instead', async () => {
    const connection = await connectWebhook(orgB.token);
    const response = await api('POST', `/integrations/${connection.id}/check`, {
      token: orgB.token,
    });
    expect(response.statusCode).toBe(422);
    expect(response.body.error?.message).toMatch(/sends to us/i);
    expect(response.body.error?.message).toMatch(/mapping preview/i);
  });
});

describe('the credential vault', () => {
  it('generates the secret for an inbound connection and answers it exactly once', async () => {
    const connection = await connectWebhook(orgA.token);
    expect(connection.secret).toMatch(/^whsec_/);
    expect(connection.secretShownOnce).toBe(true);

    // Not on the way back out, by any route.
    const read = await setup<Connection>('GET', `/integrations/${connection.id}`, {
      token: orgA.token,
    });
    expect(read.secret).toBeUndefined();
    expect(JSON.stringify(read)).not.toContain(connection.secret);

    expect(JSON.stringify(await connections(orgA.token))).not.toContain(connection.secret);
  });

  it('refuses a caller-chosen secret rather than ignoring it', async () => {
    const response = await api('POST', '/integrations', {
      token: orgC.token,
      payload: {
        provider: 'generic_webhook',
        name: 'Mine',
        credentials: { signingSecret: 'whsec_i_picked_this_myself' },
        settings: {},
      },
    });
    expect(response.statusCode).toBe(400);
    expect(JSON.stringify(response.body.error?.details)).toContain('generate');
  });

  it('rotates an inbound secret, and the old one stops verifying', async () => {
    const existing = await connectionOf(orgB.token, 'generic_webhook');

    // Rotated once to learn a secret (the one from `connect` was answered to a caller that did not
    // keep it), then rotated again — which is the transition this is about.
    const first = await setup<Connection & { secret: string }>(
      'POST',
      `/integrations/${existing.id}/rotate-secret`,
      { token: orgB.token },
    );
    expect(first.secret).toMatch(/^whsec_/);
    const accepted = await post(
      existing.id,
      { contact: { full_name: 'Rotation One', mobile: '+919845012391' } },
      { secret: first.secret },
    );
    expect(accepted.statusCode).toBe(201);

    const second = await setup<Connection & { secret: string }>(
      'POST',
      `/integrations/${existing.id}/rotate-secret`,
      { token: orgB.token },
    );
    expect(second.secret).not.toBe(first.secret);

    // Each request carries a different body, or the second would be answered as a replay of the
    // first: with no `Idempotency-Key`, the key is derived from the bytes.
    const body = { contact: { full_name: 'Rotation Two', mobile: '+919845012392' } };
    const stale = await post(existing.id, body, { secret: first.secret });
    expect(stale.statusCode).toBe(401);
    const fresh = await post(existing.id, body, { secret: second.secret });
    expect(fresh.statusCode).toBe(201);
  });
});

describe('the field mapping', () => {
  it('reports every problem at once, including the one a schema cannot see', async () => {
    const response = await api('POST', '/integrations', {
      token: orgC.token,
      payload: {
        provider: 'generic_webhook',
        name: 'Broken mapping',
        settings: {},
        fieldMappings: [
          { source: 'a', target: 'phone' },
          // Two sources writing one target: the lower one wins silently, which is the mapping
          // somebody debugs for an afternoon.
          { source: 'b', target: 'phone' },
          { source: 'c', target: 'score' },
          { source: 'd', target: 'custom.Not A Key' },
        ],
      },
    });
    expect(response.statusCode).toBe(400);
    const details = JSON.stringify(response.body.error?.details);
    expect(details).toContain('fieldMappings.1');
    expect(details).toContain('fieldMappings.2');
    expect(details).toContain('fieldMappings.3');
    // A mapping may not write a field the workspace's own rules decide.
    expect(details).toContain('score');
  });

  it('previews a payload through the mapping *and* the capture’s own normalisation', async () => {
    const connection = await connectionOf(orgA.token, 'generic_webhook');

    const preview = await setup<{
      mapped: Record<string, unknown>;
      missing: string[];
      unmapped: string[];
      wouldCreate: boolean;
      normalized: { fullName: string | null; phone: string | null; phoneAsSent: string | null };
    }>('POST', `/integrations/${connection.id}/preview`, {
      token: orgA.token,
      payload: {
        payload: {
          contact: { full_name: '  Anita Desai ', mobile: '(+91) 98450-12345' },
          enquiry: { note: 'Wants a site visit' },
          property_type: 'villa',
        },
      },
    });

    expect(preview.mapped['name']).toBe('Anita Desai');
    // The phone as it would be **stored**, which is what the preview exists to show: a dry run that
    // echoed the number as sent would be the import's lie in a new place.
    expect(preview.normalized.phone).toBe('+919845012345');
    expect(preview.normalized.phoneAsSent).toBe('+919845012345');
    expect(preview.normalized.fullName).toBe('Anita Desai');
    expect(preview.wouldCreate).toBe(true);
    // Named rather than dropped: the mapping asked for an address this payload did not carry.
    expect(preview.missing).toContain('contact.email_address');
    // And the key nothing mapped is kept, because `FR-CAP-5`'s one-click field is driven by it.
    expect(preview.unmapped).toContain('property_type');
  });

  it('refuses a mapping on a provider that does not bring leads in', async () => {
    const postmarkConnection = await connectionOf(orgA.token, 'postmark');
    const response = await api('PATCH', `/integrations/${postmarkConnection.id}`, {
      token: orgA.token,
      payload: { fieldMappings: [{ source: 'x', target: 'phone' }] },
    });
    expect(response.statusCode).toBe(400);
    expect(JSON.stringify(response.body.error?.details)).toContain('MAPPING_NOT_SUPPORTED');
  });
});

describe('the inbound door', () => {
  /**
   * Its own workspace and its own connection.
   *
   * Earlier drafts reached for the connection another test had made, which made every assertion
   * here depend on the order the file happened to run in — and passed only when the whole file ran.
   * A test that finds its fixture instead of creating it passes for the wrong reason.
   */
  let door: { token: string; organizationId: string; userId: string };
  let connection: Connection & { secret: string };
  let partnerSourceId: string;

  beforeAll(async () => {
    door = await register('d');
    // A source the connection's `sourceName` can resolve to.
    const source = await setup<{ id: string }>('POST', '/crm/sources', {
      token: door.token,
      payload: { name: 'Partner site' },
    });
    partnerSourceId = source.id;
    connection = await connectWebhook(door.token);
  });

  it('refuses an unsigned request with the sentence an integrator can act on', async () => {
    const response = await post(connection.id, { contact: { full_name: 'No Signature' } });
    expect(response.statusCode).toBe(401);
    expect(response.body.error?.code).toBe('INVALID_API_KEY');
    expect(response.body.error?.message).toContain('X-Signature');
  });

  it('refuses a signature over different bytes', async () => {
    const timestamp = Math.floor(Date.now() / 1000);
    const response = await post(
      connection.id,
      { contact: { full_name: 'Wrong Bytes' } },
      { signature: signRequest(connection.secret, timestamp, '{"something":"else"}'), timestamp },
    );
    expect(response.statusCode).toBe(401);
    expect(response.body.error?.message).toMatch(/signature did not match/i);
  });

  it('captures a signed payload in the sender’s own field names, and keeps what arrived', async () => {
    const body = {
      contact: {
        full_name: 'Rohit Sharma',
        mobile: '(+91) 98450-11122',
        email_address: 'ROHIT@example.test',
      },
      enquiry: { note: 'Asked about the 3BHK' },
      property_type: 'apartment',
    };
    const response = await post(connection.id, body, { secret: connection.secret });
    expect(response.statusCode).toBe(201);
    expect(response.body.data.status).toBe('created');
    const leadId = response.body.data.leadId;

    const lead = await ctx.db.lead.findFirstOrThrow({
      where: { id: leadId },
      select: {
        organizationId: true,
        firstName: true,
        lastName: true,
        phoneE164: true,
        email: true,
        createdVia: true,
        leadSourceId: true,
      },
    });
    expect(lead.organizationId).toBe(door.organizationId);
    expect(lead.firstName).toBe('Rohit');
    expect(lead.lastName).toBe('Sharma');
    // The mapping's `phone` transform plus the workspace's own normalisation.
    expect(lead.phoneE164).toBe('+919845011122');
    expect(lead.email).toBe('rohit@example.test');

    const payload = await ctx.db.inboundPayload.findFirstOrThrow({
      where: { id: response.body.data.payloadId },
      select: {
        channel: true,
        apiKeyId: true,
        integrationConnectionId: true,
        rawBody: true,
        status: true,
        leadId: true,
        signatureValid: true,
      },
    });
    expect(payload.channel).toBe('webhook');
    // Which connection brought it in — the first question about a lead from somebody else's system.
    expect(payload.integrationConnectionId).toBe(connection.id);
    expect(payload.apiKeyId).toBeNull();
    expect(payload.status).toBe('processed');
    expect(payload.leadId).toBe(leadId);
    expect(payload.signatureValid).toBe(true);
    // Exactly what arrived, in their field names: a never-lose store holding our interpretation
    // cannot answer "what did they actually send us".
    expect((payload.rawBody as typeof body).contact.full_name).toBe('Rohit Sharma');
    expect((payload.rawBody as Record<string, unknown>)['property_type']).toBe('apartment');

    // The connection's own source name, because the payload did not say — resolved against the
    // workspace's own list by name, which the suite created before this test.
    expect(lead.leadSourceId).toBe(partnerSourceId);
    expect(lead.createdVia).toBe('api');
  });

  it('marks the connection as working only once a lead is in', async () => {
    const row = await ctx.db.integrationConnection.findFirstOrThrow({
      where: { id: connection.id },
      select: { lastSuccessAt: true, status: true },
    });
    expect(row.status).toBe('connected');
    expect(row.lastSuccessAt).not.toBeNull();
  });

  it('answers a replay with the first answer and does not create a second lead', async () => {
    const key = `replay-${newToken(6)}`;
    const body = { contact: { full_name: 'Replay Singh', mobile: '+919845011133' } };
    const first = await post(connection.id, body, {
      secret: connection.secret,
      idempotencyKey: key,
    });
    expect(first.statusCode).toBe(201);

    const again = await post(connection.id, body, {
      secret: connection.secret,
      idempotencyKey: key,
    });
    expect(again.statusCode).toBe(200);
    expect(again.body.data.status).toBe('replayed');
    expect(again.body.data.leadId).toBe(first.body.data.leadId);

    const leads = await ctx.db.lead.count({
      where: { organizationId: door.organizationId, phoneE164: '+919845011133' },
    });
    expect(leads).toBe(1);
  });

  it('records why a mapped payload was refused, with the stage, and keeps the payload', async () => {
    // `valueMinor` is an integer in minor units; "lots" is not one, and the mapping is not what
    // refuses it — the schema the public endpoint publishes is.
    const mapped = await setup<Connection>('PATCH', `/integrations/${connection.id}`, {
      token: door.token,
      payload: {
        fieldMappings: [
          { source: 'contact.full_name', target: 'name' },
          { source: 'budget', target: 'valueMinor' },
        ],
      },
    });
    expect(mapped.fieldMappings.length).toBe(2);

    const response = await post(
      connection.id,
      { contact: { full_name: 'Bad Value' }, budget: 'lots' },
      { secret: connection.secret },
    );
    expect(response.statusCode).toBe(400);
    expect(response.body.error?.code).toBe('VALIDATION_FAILED');
    expect(JSON.stringify(response.body.error?.details)).toContain('valueMinor');

    const payload = await ctx.db.inboundPayload.findFirstOrThrow({
      where: { organizationId: door.organizationId, integrationConnectionId: connection.id },
      orderBy: { receivedAt: 'desc' },
      select: {
        status: true,
        error: true,
        id: true,
        errors: { select: { stage: true, isReplayable: true } },
      },
    });
    expect(payload.status).toBe('failed');
    expect(payload.errors[0]?.stage).toBe('validate');
    // A refusal nothing can fix by re-running it is not replayable.
    expect(payload.errors[0]?.isReplayable).toBe(false);
  });

  it('logs the request without a key, so one log answers “my integration posted and nothing happened”', async () => {
    // The request log is buffered for a second, or a hundred rows, so that a lead's capture never
    // waits on an insert nobody is reading yet. A test that asserted straight after the request
    // would pass or fail on how long the assertions above happened to take.
    await ctx.app.get(ApiLogService).flush();
    const logs = await ctx.db.apiLog.findMany({
      where: { organizationId: door.organizationId, surface: 'public_ingest' },
      orderBy: { createdAt: 'desc' },
      take: 5,
      select: { path: true, apiKeyId: true, statusCode: true, method: true },
    });
    const inbound = logs.filter((log) => log.path.startsWith('/api/v1/wh/'));
    expect(inbound.length).toBeGreaterThan(0);
    expect(inbound[0]?.method).toBe('POST');
    // No key: this request was authenticated by a connection, not by a credential a person made.
    expect(inbound.every((log) => log.apiKeyId === null)).toBe(true);
    // The query string is never stored — `api_logs` is read by whoever holds `api_key:manage`.
    expect(inbound.every((log) => !log.path.includes('?'))).toBe(true);
  });

  it('answers 404 for a connection that does not exist, and for one from another workspace', async () => {
    const unknown = await post('00000000-0000-7000-8000-000000000000', { a: 1 }, { secret: 'x' });
    expect(unknown.statusCode).toBe(404);

    // Org B's own connection id, posted with org A's secret: still a 401 rather than a hint about
    // whose it is — and org A's token cannot read it at all.
    const theirWebhook = await connectionOf(orgB.token, 'generic_webhook');
    const read = await api('GET', `/integrations/${theirWebhook.id}`, { token: door.token });
    expect(read.statusCode).toBe(404);
  });

  it('answers 404 for the wrong provider in the path', async () => {
    const response = await post(
      connection.id,
      { a: 1 },
      { secret: connection.secret, provider: 'postmark' },
    );
    expect(response.statusCode).toBe(404);
  });
});

describe('disconnecting', () => {
  it('keeps the history, hides the connection, and lets the provider be connected again', async () => {
    const postmarkConnection = await connectionOf(orgA.token, 'postmark');

    const disconnected = await setup<Connection>(
      'POST',
      `/integrations/${postmarkConnection.id}/disconnect`,
      { token: orgA.token },
    );
    expect(disconnected.disconnectedAt).not.toBeNull();
    // A CHECK refuses a disconnected connection that still claims to be connected.
    expect(disconnected.status).not.toBe('connected');

    const after = await connections(orgA.token);
    expect(after.some((item) => item.id === postmarkConnection.id)).toBe(false);

    const history = await connections(orgA.token, '?disconnected=true');
    expect(history.some((item) => item.id === postmarkConnection.id)).toBe(true);

    // The partial unique is what makes this work: one *live* connection per provider.
    const reconnected = await connectPostmark(orgA.token, { name: 'Email, again' });
    expect(reconnected.id).not.toBe(postmarkConnection.id);
    expect(reconnected.status).toBe('connected');

    // Twice is not an error.
    const twice = await api('POST', `/integrations/${postmarkConnection.id}/disconnect`, {
      token: orgA.token,
    });
    expect(twice.statusCode).toBe(200);

    // And editing history is refused, with what to do instead.
    const edit = await api('PATCH', `/integrations/${postmarkConnection.id}`, {
      token: orgA.token,
      payload: { name: 'Renaming the past' },
    });
    expect(edit.statusCode).toBe(422);
  });
});

describe('the scheduled sweep', () => {
  it('probes a connection whose interval has elapsed and leaves a freshly checked one alone', async () => {
    const service = ctx.app.get(IntegrationHealthService);
    const postmarkConnection = await connectionOf(orgA.token, 'postmark');

    // Just connected, so just probed: the sweep must not ask again a second later.
    const quiet = await service.sweep();
    const quietChecks = await ctx.db.integrationHealthCheck.count({
      where: { connectionId: postmarkConnection.id },
    });
    expect(quiet.probed).toBe(0);

    // Age the last check past the provider's own ten minutes.
    await ctx.db.integrationHealthCheck.updateMany({
      where: { connectionId: postmarkConnection.id },
      data: { checkedAt: new Date(Date.now() - 20 * 60_000) },
    });
    const swept = await service.sweep();
    expect(swept.probed).toBeGreaterThanOrEqual(1);
    expect(
      await ctx.db.integrationHealthCheck.count({ where: { connectionId: postmarkConnection.id } }),
    ).toBe(quietChecks + 1);

    // An inbound connection is never swept: there is nothing to ask it.
    const webhookConnection = await connectionOf(orgA.token, 'generic_webhook');
    expect(
      await ctx.db.integrationHealthCheck.count({ where: { connectionId: webhookConnection.id } }),
    ).toBe(0);
  });

  it('answers the health history, newest first, with the connection it belongs to', async () => {
    const history = await setup<
      { outcome: string; connection: { id: string; provider: string }; checkedAt: string }[]
    >('GET', '/integrations/health', { token: orgA.token });
    expect(history.length).toBeGreaterThan(0);
    for (const entry of history) {
      expect(['ok', 'degraded', 'unauthorized', 'unreachable']).toContain(entry.outcome);
      expect(entry.connection.id).toBeTruthy();
    }
    const instants = history.map((entry) => new Date(entry.checkedAt).getTime());
    expect([...instants].sort((a, b) => b - a)).toEqual(instants);
  });
});
