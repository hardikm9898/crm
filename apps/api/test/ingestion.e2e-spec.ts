import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId, newToken, signRequest } from '@leados/shared';
import { bootTestApp, call, cleanupUsers, type EnvelopeBody, type TestApp } from './app-harness.js';

/**
 * THE PUBLIC LEAD API SUITE.
 *
 * `FR-CAP-6` asks for ingestion that is "authenticated per tenant (public key + secret/HMAC), rate
 * limited, idempotent on a client-supplied or derived key, and observable"; `FR-CAP-3` that the raw
 * payload persists whether or not the lead was created; `FR-CAP-5` that unknown fields are accepted
 * and surfaced; `FR-API-5` that a duplicate `Idempotency-Key` returns the first response and
 * creates nothing new.
 *
 * Most of this suite is **refusals**, because this endpoint is the one an attacker reaches: a
 * missing signature, a signature from the wrong secret, a replayed one, a body modified after
 * signing, a key for another workspace, a revoked key, a key with no scope, an address outside the
 * allowlist. A verifier with only a happy-path test is one nobody has tried to break.
 *
 * Nothing is mocked. The signatures are computed the way a client would compute them, and the
 * leads are read back through the real lead endpoints.
 */

const SUFFIX = newToken(4)
  .toLowerCase()
  .replace(/[^a-z0-9]/g, '');
const EMAIL_MARKER = `e2eapi${SUFFIX}`;
const PASSWORD = 'a quiet november harbour';

interface Tenant {
  token: string;
  organizationId: string;
  publicKey: string;
}

interface KeyPair {
  id: string;
  keyId: string;
  secret: string;
}

let ctx: TestApp;
let orgA: Tenant;
let orgB: Tenant;
let keyA: KeyPair;

async function api<T>(
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
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

/**
 * A capture, signed the way a client signs one.
 *
 * The body is serialised **once** and both signed and sent as those bytes — which is the whole
 * point of signing the raw body, and the thing a verifier that re-serialised would break.
 */
async function post(
  tenant: Tenant,
  key: KeyPair,
  body: Record<string, unknown>,
  options: {
    idempotencyKey?: string;
    secret?: string;
    skewSeconds?: number;
    sendInstead?: Record<string, unknown>;
  } = {},
) {
  const raw = JSON.stringify(body);
  const timestamp = Math.floor(Date.now() / 1000) + (options.skewSeconds ?? 0);
  const signature = signRequest(options.secret ?? key.secret, timestamp, raw);
  return api<Record<string, unknown>>('POST', `/public/leads/${tenant.publicKey}`, {
    payload: options.sendInstead ?? body,
    headers: {
      'x-api-key': key.keyId,
      'x-signature': signature,
      ...(options.idempotencyKey ? { 'idempotency-key': options.idempotencyKey } : {}),
    },
  });
}

let phoneCounter = 0;
function freshPhone(): string {
  phoneCounter += 1;
  return `+9198460${String(10_000 + phoneCounter).slice(0, 5)}`;
}

async function registerTenant(label: string): Promise<Tenant> {
  const registered = await call<
    EnvelopeBody<{ tokens: { accessToken: string }; activeOrganizationId: string }>
  >(ctx.app, {
    method: 'POST',
    url: '/api/v1/auth/register',
    payload: {
      email: `${label}.${EMAIL_MARKER}@test.local`,
      password: PASSWORD,
      name: 'Nikhil Rao',
      organizationName: `Ingest ${label} ${SUFFIX}`,
    },
  });
  const token = registered.body.data.tokens.accessToken;
  const organization = await setup<{ publicKey: string }>('GET', '/organization', { token });
  return {
    token,
    organizationId: registered.body.data.activeOrganizationId,
    publicKey: organization.publicKey,
  };
}

async function mintKey(tenant: Tenant, over: Record<string, unknown> = {}): Promise<KeyPair> {
  const created = await setup<{ id: string; keyId: string; secret: string }>('POST', '/api-keys', {
    token: tenant.token,
    payload: { name: `Key ${newToken(3)}`, scopes: ['ingest:write'], ...over },
  });
  return { id: created.id, keyId: created.keyId, secret: created.secret };
}

beforeAll(async () => {
  ctx = await bootTestApp();
  orgA = await registerTenant('orga');
  orgB = await registerTenant('orgb');
  keyA = await mintKey(orgA);
}, 120_000);

afterAll(async () => {
  await cleanupUsers(ctx.db, EMAIL_MARKER);
  await ctx.close();
});

describe('the credential (FR-CAP-7, FR-API-2)', () => {
  it('is answered once, and never again', async () => {
    const created = await setup<{
      id: string;
      keyId: string;
      secret: string;
      secretShownOnce: boolean;
    }>('POST', '/api-keys', {
      token: orgA.token,
      payload: { name: 'Website server', scopes: ['ingest:write'] },
    });
    expect(created.keyId.startsWith('pk_live_')).toBe(true);
    expect(created.secret.startsWith('sk_live_')).toBe(true);
    expect(created.secretShownOnce).toBe(true);

    // There is no endpoint that answers the secret again — not because it could not be recovered
    // (it is encrypted, not hashed, because an HMAC needs it) but because an endpoint that hands
    // a credential back is one an attacker with a session can use.
    const read = await setup<Record<string, unknown>>('GET', `/api-keys/${created.id}`, {
      token: orgA.token,
    });
    expect(read['secret']).toBeUndefined();
    expect(JSON.stringify(read)).not.toContain(created.secret);
    const listed = await setup<Record<string, unknown>[]>('GET', '/api-keys', {
      token: orgA.token,
    });
    expect(JSON.stringify(listed)).not.toContain(created.secret);
  });

  it('stores the secret encrypted, and never in the clear', async () => {
    const key = await mintKey(orgA);
    const row = await ctx.db.apiKey.findFirstOrThrow({ where: { keyId: key.keyId } });
    // The column holds an `EncryptionService` envelope, which a CHECK also insists on: the obvious
    // mistake, once a secret has to be recoverable, is to store it as it was generated.
    expect(row.secretEncrypted.startsWith('v1.')).toBe(true);
    expect(row.secretEncrypted).not.toContain(key.secret);
  });

  it('refuses a key with no scopes, and a malformed allowlist entry', async () => {
    expect(
      (
        await api('POST', '/api-keys', {
          token: orgA.token,
          payload: { name: 'Useless', scopes: [] },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await api('POST', '/api-keys', {
          token: orgA.token,
          payload: { name: 'Bad', scopes: ['ingest:write'], ipAllowlist: ['not-an-address'] },
        })
      ).statusCode,
    ).toBe(400);
  });

  it('cannot be read or rotated by another workspace', async () => {
    expect((await api('GET', `/api-keys/${keyA.id}`, { token: orgB.token })).statusCode).toBe(404);
    expect(
      (await api('POST', `/api-keys/${keyA.id}/rotate`, { token: orgB.token })).statusCode,
    ).toBe(404);
    expect(
      (await api('POST', `/api-keys/${keyA.id}/revoke`, { token: orgB.token })).statusCode,
    ).toBe(404);
  });
});

describe('a signed capture (FR-CAP-4, FR-CAP-6)', () => {
  it('creates a lead through the one ingestion path', async () => {
    const phone = freshPhone();
    const response = await post(orgA, keyA, {
      name: 'Rohit Kulkarni',
      phone,
      email: `rohit.${SUFFIX}@api.test`,
      city: 'Pune',
      message: 'Need a 3BHK before Diwali',
      utm: { utm_source: 'google', gclid: 'noise' },
      propertyType: 'Apartment',
    });
    expect(response.statusCode).toBe(201);
    const data = response.body.data as { status: string; leadId: string; unmappedFields: string[] };
    expect(data.status).toBe('created');
    expect(data.unmappedFields).toEqual(['propertyType']);

    const lead = await setup<{
      phone: string | null;
      firstName: string | null;
      lastName: string | null;
      createdVia: string;
      utm: Record<string, string>;
      touchpoints: { channel: string }[];
    }>('GET', `/leads/${data.leadId}`, { token: orgA.token });
    expect(lead.phone).toBe(phone);
    // The surname is the last word, as the import and the forms split it: one definition, in
    // `@leados/shared`, because three channels now do this.
    expect(lead.firstName).toBe('Rohit');
    expect(lead.lastName).toBe('Kulkarni');
    expect(lead.createdVia).toBe('api');
    expect(lead.utm).toEqual({ utm_source: 'google' });
    expect(lead.touchpoints[0]?.channel).toBe('api');
  });

  it('writes what they said to the timeline, as an enquiry rather than a form', async () => {
    const phone = freshPhone();
    const response = await post(orgA, keyA, {
      name: 'Anita Rao',
      phone,
      message: 'Plot in Wakad, want a quote by Friday',
    });
    const { leadId } = response.body.data as { leadId: string };
    const timeline = await setup<{ type: string; payload: Record<string, unknown> }[]>(
      'GET',
      `/leads/${leadId}/timeline?limit=30`,
      { token: orgA.token },
    );
    const entry = timeline.find((row) => row.type === 'lead.enquiry_received');
    // Its own type, not `lead.form_submitted` with an invented form name: "Filled in the public
    // API" is a sentence about something that did not happen (rule 6 either way).
    expect(entry, 'an API enquiry carrying a message has to be on the timeline').toBeDefined();
    expect(JSON.stringify(entry?.payload['answers'])).toContain('Wakad');
    expect(entry?.payload['channel']).toBe('api');
  });

  it('starts the first-response clock, like every other capture', async () => {
    const phone = freshPhone();
    const { leadId } = (await post(orgA, keyA, { name: 'Clock Test', phone })).body.data as {
      leadId: string;
    };
    const clocks = await setup<{ target: string }[]>('GET', `/sla/clocks?leadId=${leadId}`, {
      token: orgA.token,
    });
    expect(clocks.map((clock) => clock.target)).toContain('first_response');
  });

  it('attaches a repeat capture to the lead that already exists', async () => {
    const phone = freshPhone();
    await post(orgA, keyA, { name: 'Repeat Caller', phone, message: 'First' });
    const second = await post(orgA, keyA, { name: 'Repeat Caller', phone, message: 'Second' });
    // 200 and `duplicate_attached`, as §6 of the API architecture promises: a client can tell "I
    // created something" from "that already existed" without parsing a message.
    expect(second.statusCode).toBe(200);
    expect((second.body.data as { status: string }).status).toBe('duplicate_attached');

    const found = await setup<{ id: string }[]>(
      'GET',
      `/leads?search=${encodeURIComponent(phone.slice(-8))}`,
      { token: orgA.token },
    );
    expect(found, 'one person, one lead').toHaveLength(1);
  });

  it('resolves the lead source by name, and says so when the name matches nothing', async () => {
    const sources = await setup<{ id: string; name: string }[]>('GET', '/crm/sources', {
      token: orgA.token,
    });
    const source = sources[0]!;
    const matched = await post(orgA, keyA, {
      name: 'Attributed Caller',
      phone: freshPhone(),
      source: source.name.toUpperCase(),
    });
    const { leadId } = matched.body.data as { leadId: string };
    // `leadSourceId`, which is what the detail presenter actually carries — asserting a `source`
    // object that does not exist would have been a test passing on `undefined === undefined` the
    // day the mapper stopped resolving names at all.
    const lead = await setup<{
      leadSourceId: string | null;
      touchpoints: { leadSourceId: string | null }[];
    }>('GET', `/leads/${leadId}`, { token: orgA.token });
    // Case-insensitively, because an integrator types a name rather than copying a uuid.
    expect(lead.leadSourceId).toBe(source.id);
    // And the touchpoint carries it too, which is what attribution is actually read from.
    expect(lead.touchpoints[0]?.leadSourceId).toBe(source.id);

    const unmatched = await post(orgA, keyA, {
      name: 'Unattributed Caller',
      phone: freshPhone(),
      source: 'A source nobody created',
    });
    // Still a lead: losing the capture over an attribution would be the worse outcome by a long way.
    expect(unmatched.statusCode).toBe(201);
  });
});

describe('idempotency (FR-API-5)', () => {
  it('answers the first response to a replay, and creates nothing new', async () => {
    const body = { name: 'Idempotent Caller', phone: freshPhone() };
    const key = `enquiry-${newToken(4)}`;
    const first = await post(orgA, keyA, body, { idempotencyKey: key });
    expect(first.statusCode).toBe(201);
    const firstData = first.body.data as { leadId: string };

    const replay = await post(orgA, keyA, body, { idempotencyKey: key });
    expect(replay.statusCode).toBe(200);
    const replayData = replay.body.data as { leadId: string; status: string };
    expect(replayData.status).toBe('replayed');
    expect(replayData.leadId).toBe(firstData.leadId);

    const found = await setup<{ id: string }[]>(
      'GET',
      `/leads?search=${encodeURIComponent(body.phone.slice(-8))}`,
      { token: orgA.token },
    );
    expect(found).toHaveLength(1);
  });

  it('refuses the same key with a different body, rather than answering the wrong lead', async () => {
    const key = `conflict-${newToken(4)}`;
    await post(orgA, keyA, { name: 'First Body', phone: freshPhone() }, { idempotencyKey: key });
    const mismatch = await post(
      orgA,
      keyA,
      { name: 'Different Body', phone: freshPhone() },
      { idempotencyKey: key },
    );
    expect(mismatch.statusCode).toBe(409);
    expect(JSON.stringify(mismatch.body)).toContain('IDEMPOTENT_REPLAY_MISMATCH');
  });

  it('derives a key from the body when the client sends none', async () => {
    const body = { name: 'Derived Caller', phone: freshPhone() };
    expect((await post(orgA, keyA, body)).statusCode).toBe(201);
    const second = await post(orgA, keyA, body);
    // The retry a client makes when it never saw the answer, with no key of its own: `FR-CAP-6`
    // says "client-supplied **or derived**", and the derived one is a hash of the body.
    expect(second.statusCode).toBe(200);
    expect((second.body.data as { status: string }).status).toBe('replayed');
  });

  it('keeps the key scoped to this workspace, so two tenants cannot collide', async () => {
    const keyB = await mintKey(orgB);
    const shared = `shared-${newToken(4)}`;
    const a = await post(
      orgA,
      keyA,
      { name: 'Tenant A', phone: freshPhone() },
      { idempotencyKey: shared },
    );
    const b = await post(
      orgB,
      keyB,
      { name: 'Tenant B', phone: freshPhone() },
      { idempotencyKey: shared },
    );
    expect(a.statusCode).toBe(201);
    expect(b.statusCode).toBe(201);
  });
});

describe('the refusals', () => {
  it('answers 404 for a workspace key that names nothing', async () => {
    const response = await api('POST', '/public/leads/not-a-real-workspace-key', {
      payload: {},
      headers: { 'x-api-key': keyA.keyId },
    });
    expect(response.statusCode).toBe(404);
  });

  it('answers 401 with no key, an unknown key, or a key from another workspace', async () => {
    const body = { name: 'Refused', phone: freshPhone() };
    expect(
      (await api('POST', `/public/leads/${orgA.publicKey}`, { payload: body })).statusCode,
    ).toBe(401);
    expect(
      (
        await api('POST', `/public/leads/${orgA.publicKey}`, {
          payload: body,
          headers: { 'x-api-key': 'pk_live_nothinghere000000' },
        })
      ).statusCode,
    ).toBe(401);

    // The attack this one exists for: a real credential, pointed at somebody else's workspace.
    const keyB = await mintKey(orgB);
    expect((await post(orgA, keyB, body)).statusCode).toBe(401);
  });

  it('answers 401 for every way a signature can be wrong', async () => {
    const body = { name: 'Signature Test', phone: freshPhone() };

    const unsigned = await api('POST', `/public/leads/${orgA.publicKey}`, {
      payload: body,
      headers: { 'x-api-key': keyA.keyId },
    });
    expect(unsigned.statusCode).toBe(401);
    // The refusal says what to send: an integrator reads this message, not our source.
    expect(JSON.stringify(unsigned.body)).toContain('X-Signature');

    const malformed = await api('POST', `/public/leads/${orgA.publicKey}`, {
      payload: body,
      headers: { 'x-api-key': keyA.keyId, 'x-signature': 'nonsense' },
    });
    expect(malformed.statusCode).toBe(401);

    expect((await post(orgA, keyA, body, { secret: 'sk_live_wrong' })).statusCode).toBe(401);
    // A replay from an hour ago, which is what the timestamp window is for.
    expect((await post(orgA, keyA, body, { skewSeconds: -3600 })).statusCode).toBe(401);
    // A clock set an hour ahead is the same problem in the other direction.
    expect((await post(orgA, keyA, body, { skewSeconds: 3600 })).statusCode).toBe(401);
    // Signed one body, sent another.
    expect(
      (await post(orgA, keyA, body, { sendInstead: { name: 'Tampered', phone: freshPhone() } }))
        .statusCode,
    ).toBe(401);
  });

  it('refuses a key whose scopes do not include writing', async () => {
    const readOnly = await mintKey(orgA, { scopes: ['ingest:read'] });
    const response = await post(orgA, readOnly, { name: 'No Scope', phone: freshPhone() });
    expect(response.statusCode).toBe(403);
    expect(JSON.stringify(response.body)).toContain('ingest:write');
  });

  it('refuses a key restricted to an address the request did not come from', async () => {
    const locked = await mintKey(orgA, { ipAllowlist: ['203.0.113.0/24'] });
    expect((await post(orgA, locked, { name: 'Locked Out', phone: freshPhone() })).statusCode).toBe(
      403,
    );
  });

  it('stops working the moment a key is rotated or revoked', async () => {
    const key = await mintKey(orgA);
    const rotated = await setup<{ keyId: string; secret: string }>(
      'POST',
      `/api-keys/${key.id}/rotate`,
      { token: orgA.token },
    );
    expect(rotated.keyId).not.toBe(key.keyId);
    expect(
      (await post(orgA, key, { name: 'Old Credential', phone: freshPhone() })).statusCode,
    ).toBe(401);
    const fresh = { id: key.id, keyId: rotated.keyId, secret: rotated.secret };
    expect(
      (await post(orgA, fresh, { name: 'New Credential', phone: freshPhone() })).statusCode,
    ).toBe(201);

    await setup('POST', `/api-keys/${key.id}/revoke`, { token: orgA.token });
    expect(
      (await post(orgA, fresh, { name: 'After Revocation', phone: freshPhone() })).statusCode,
    ).toBe(401);
    // And a revoked key cannot be brought back, which is the point of revoking it.
    expect(
      (await api('POST', `/api-keys/${key.id}/rotate`, { token: orgA.token })).statusCode,
    ).toBe(422);
  });

  it('refuses a capture with no way to reach anybody, and records why', async () => {
    const response = await post(orgA, keyA, { city: 'Pune' });
    // 400, not 422: a missing identity is a validation failure, and the field errors say which.
    expect(response.statusCode).toBe(400);

    const payloads = await setup<{ status: string; error: string | null; body: unknown }[]>(
      'GET',
      '/ingestion/payloads?status=failed',
      { token: orgA.token },
    );
    expect(payloads.length).toBeGreaterThan(0);
    const errors = await setup<{ stage: string; message: string; isReplayable: boolean }[]>(
      'GET',
      '/ingestion/errors',
      { token: orgA.token },
    );
    expect(errors[0]?.stage).toBe('validate');
    // Not replayable: a payload with no phone and no name will fail the same way next time.
    expect(errors[0]?.isReplayable).toBe(false);
  });
});

describe('the never-lose store (FR-CAP-3, FR-CAP-5)', () => {
  it('keeps the payload exactly as sent, including fields it does not understand', async () => {
    const phone = freshPhone();
    await post(orgA, keyA, {
      name: 'Kept Whole',
      phone,
      propertyType: 'Villa',
      agent_code: 'AG-7',
    });
    const payloads = await setup<{ body: Record<string, unknown>; unmappedFields: string[] }[]>(
      'GET',
      '/ingestion/payloads?limit=5',
      { token: orgA.token },
    );
    const mine = payloads.find((row) => (row.body as { phone?: string }).phone === phone);
    expect(mine?.body['propertyType']).toBe('Villa');
    expect(mine?.unmappedFields).toContain('agent_code');
  });

  it('never stores the credential beside the payload it authorised', async () => {
    await post(orgA, keyA, { name: 'Header Check', phone: freshPhone() });
    const row = await ctx.db.inboundPayload.findFirstOrThrow({
      where: { organizationId: orgA.organizationId },
      orderBy: { receivedAt: 'desc' },
    });
    const headers = JSON.stringify(row.headers);
    // Storing a key beside the request it signed turns the never-lose store into a place to steal
    // credentials from.
    expect(headers).not.toContain('x-api-key');
    expect(headers).not.toContain('x-signature');
    expect(headers).not.toContain(keyA.secret);
    // And the address is a hash, not an address.
    expect(row.ipHash === null || !row.ipHash.includes('.')).toBe(true);
  });

  it('surfaces the unmapped fields by name, with a sample of what was sent', async () => {
    await post(orgA, keyA, {
      name: 'Unmapped Sample',
      phone: freshPhone(),
      propertyType: 'Penthouse',
    });
    const unmapped = await setup<{ field: string; count: number; samples: string[] }[]>(
      'GET',
      '/ingestion/unmapped',
      { token: orgA.token },
    );
    const entry = unmapped.find((row) => row.field === 'propertyType');
    expect(entry, 'FR-CAP-5 asks for the unmapped fields to be surfaced').toBeDefined();
    // The sample is what turns "propertyType" into a decision about which kind of field to make.
    expect(entry?.samples.length).toBeGreaterThan(0);
    expect(entry?.count).toBeGreaterThan(0);
  });

  it('fills in a field made from an unmapped answer — the other half of the one click', async () => {
    // `FR-CAP-5` asks for the unmapped fields to be surfaced "with a one-click create custom
    // field". A button that creates a field the next payload does not fill in would satisfy the
    // words and nothing else, so this is the round trip: the field is created exactly as the web
    // app's button creates it (`POST /custom-fields`, key derived from the sent name), and then the
    // same integration's next payload is read back off the lead.
    await setup('POST', '/custom-fields', {
      token: orgA.token,
      payload: {
        entityType: 'lead',
        key: 'agent_code',
        label: 'Agent code',
        type: 'text',
      },
    });

    const response = await post(orgA, keyA, {
      name: 'Absorbed Extra',
      phone: freshPhone(),
      // The integrator's own spelling, unchanged — they are not going to redeploy for us.
      agentCode: 'AG-4471',
    });
    expect(response.statusCode).toBe(201);
    const data = response.body.data as { leadId: string; unmappedFields: string[] };
    // No longer unmapped: it has somewhere to go now.
    expect(data.unmappedFields).not.toContain('agentCode');

    const lead = await setup<{ customValues: Record<string, unknown> }>(
      'GET',
      `/leads/${data.leadId}`,
      { token: orgA.token },
    );
    expect(lead.customValues['agent_code']).toBe('AG-4471');
  });

  it('keeps an answer that does not fit its field rather than refusing the capture', async () => {
    // The other side of the same coin, and the reason the value is validated before it is accepted:
    // somebody makes `possessionYear` a *number* field and the integration keeps sending words. A
    // capture that worked yesterday must not become a 400 today — losing the lead over a field.
    await setup('POST', '/custom-fields', {
      token: orgA.token,
      payload: {
        entityType: 'lead',
        key: 'possession_year',
        label: 'Possession year',
        type: 'number',
      },
    });

    const response = await post(orgA, keyA, {
      name: 'Bad Fit',
      phone: freshPhone(),
      possessionYear: 'next Diwali',
    });
    expect(response.statusCode).toBe(201);
    const data = response.body.data as { leadId: string; unmappedFields: string[] };
    // Still unmapped, still in the payload, and said out loud in the dry run's notes.
    expect(data.unmappedFields).toContain('possessionYear');

    const lead = await setup<{ customValues: Record<string, unknown> }>(
      'GET',
      `/leads/${data.leadId}`,
      { token: orgA.token },
    );
    expect(lead.customValues['possession_year']).toBeUndefined();

    const dry = await setup<{ notes: string[] }>('POST', '/ingestion/test', {
      token: orgA.token,
      payload: { payload: { name: 'Bad Fit', phone: freshPhone(), possessionYear: 'next Diwali' } },
    });
    expect(dry.notes.join(' ')).toContain('Possession year');
  });

  it('replays a payload that failed, and refuses to replay one that worked', async () => {
    // A capture that fails for a reason a replay could fix: the lead limit is not it, so this uses
    // a payload whose source makes it fail at `persist` — a deleted pipeline would too. The honest
    // available case is a payload stored by a *failed* capture, replayed after the cause is gone.
    const failing = await post(orgA, keyA, { city: 'Pune' });
    expect(failing.statusCode).toBe(400);
    const failed = await ctx.db.inboundPayload.findFirstOrThrow({
      where: { organizationId: orgA.organizationId, status: 'failed' },
      orderBy: { receivedAt: 'desc' },
    });
    // Replaying it fails the same way, which is the honest outcome — and the attempt is counted.
    const replay = await api('POST', `/ingestion/payloads/${failed.id}/replay`, {
      token: orgA.token,
    });
    expect(replay.statusCode).toBe(400);
    const after = await ctx.db.inboundPayload.findFirstOrThrow({
      where: { id: failed.id },
    });
    expect(after.attempts).toBe(2);
    expect(after.replayedAt).not.toBeNull();

    const processed = await ctx.db.inboundPayload.findFirstOrThrow({
      where: { organizationId: orgA.organizationId, status: 'processed' },
    });
    const refused = await api('POST', `/ingestion/payloads/${processed.id}/replay`, {
      token: orgA.token,
    });
    // Replaying a capture that became a lead would create a second one.
    expect(refused.statusCode).toBe(422);
  });

  it('loses no lead when the process dies mid-ingestion — the phase’s exit criterion', async () => {
    // The crash, as the store sees it: the payload row exists in `received`, which is the state it
    // is written in before anything is attempted, and nothing else happened. This is precisely the
    // row a capture that died after the write would leave behind.
    const phone = freshPhone();
    const raw = { name: 'Crashed Capture', phone, message: 'Still wants calling' };
    const payload = await ctx.db.inboundPayload.create({
      data: {
        id: newId(),
        organizationId: orgA.organizationId,
        channel: 'public_api',
        apiKeyId: null,
        rawBody: raw,
        headers: {},
        signatureValid: true,
        idempotencyKey: `crashed-${newToken(6)}`,
        dedupeHash: 'd'.repeat(64),
        status: 'received',
      },
    });

    // The replay finishes the job, which is what "the payload replays to completion" means.
    const replay = await setup<{ status: string; leadId: string }>(
      'POST',
      `/ingestion/payloads/${payload.id}/replay`,
      { token: orgA.token },
    );
    expect(replay.status).toBe('processed');

    const lead = await setup<{ fullName: string; createdVia: string }>(
      'GET',
      `/leads/${replay.leadId}`,
      { token: orgA.token },
    );
    expect(lead.fullName).toBe('Crashed Capture');
    expect(lead.createdVia).toBe('api');

    // And the row now says what became of it, with the attempt counted and the replay recorded.
    const after = await ctx.db.inboundPayload.findFirstOrThrow({ where: { id: payload.id } });
    expect(after.status).toBe('processed');
    expect(after.leadId).toBe(replay.leadId);
    expect(after.attempts).toBe(2);
    expect(after.replayedAt).not.toBeNull();

    // What they said survived the crash too: the message is on the timeline, not only in the body.
    const timeline = await setup<{ type: string; payload: Record<string, unknown> }[]>(
      'GET',
      `/leads/${replay.leadId}/timeline?limit=30`,
      { token: orgA.token },
    );
    expect(JSON.stringify(timeline)).toContain('Still wants calling');
  });

  it('keeps one workspace out of another’s payloads', async () => {
    await post(orgA, keyA, { name: 'Private Payload', phone: freshPhone() });
    const theirs = await setup<unknown[]>('GET', '/ingestion/payloads', { token: orgB.token });
    expect(JSON.stringify(theirs)).not.toContain('Private Payload');
  });
});

describe('the test tool (FR-CAP-6)', () => {
  it('says what would happen, and persists nothing', async () => {
    const before = await ctx.db.inboundPayload.count({
      where: { organizationId: orgA.organizationId },
    });
    const result = await setup<{
      normalized: Record<string, unknown>;
      unmappedFields: string[];
      notes: string[];
    }>('POST', '/ingestion/test', {
      token: orgA.token,
      payload: {
        payload: {
          name: 'Dry Run',
          phone: '9846099999',
          source: 'A source nobody created',
          customFields: { nope: 'x' },
          propertyType: 'Villa',
        },
      },
    });
    expect(result.normalized['firstName']).toBe('Dry');
    expect(result.unmappedFields).toContain('propertyType');
    // The notes are the point: "why did my lead not appear" answered without a support conversation.
    expect(result.notes.join(' ')).toContain('A source nobody created');
    expect(result.notes.join(' ')).toContain('nope');

    const after = await ctx.db.inboundPayload.count({
      where: { organizationId: orgA.organizationId },
    });
    expect(after, 'a dry run must not write a payload').toBe(before);
    const leads = await setup<unknown[]>('GET', '/leads?search=9846099999', { token: orgA.token });
    expect(leads).toEqual([]);
  });

  it('runs the normalize step for real, rather than echoing what was sent', async () => {
    // The import's dry run paid for this: a preview that re-checks a schema instead of doing what
    // the write path does reported "5 rows ready to import" for a column of `not-a-phone`. The
    // phone is the commonest reason a capture is refused, so the tool normalises it with the
    // workspace's own country — and says so when it cannot.
    const good = await setup<{ wouldCreate: boolean; normalized: Record<string, unknown> }>(
      'POST',
      '/ingestion/test',
      { token: orgA.token, payload: { payload: { name: 'Normalised Run', phone: '98460 99997' } } },
    );
    expect(good.wouldCreate).toBe(true);
    expect(good.normalized['phone']).toBe('+919846099997');
    // Beside it, so "why is this not the number I typed" has an answer on the same screen.
    expect(good.normalized['phoneAsSent']).toBe('98460 99997');

    const bad = await setup<{ wouldCreate: boolean; normalized: Record<string, unknown>; notes: string[] }>(
      'POST',
      '/ingestion/test',
      { token: orgA.token, payload: { payload: { name: 'Bad Number', phone: '12' } } },
    );
    expect(bad.normalized['phone']).toBeNull();
    expect(bad.notes.join(' ')).toMatch(/does not look like a phone number/i);
    // And the verdict is honest: the real endpoint refuses a phone it cannot read, so a tool that
    // answered "this would work" because the name is present would be the lie, not the kindness.
    expect(bad.wouldCreate).toBe(false);
  });

  it('refuses to say a payload with nothing to reach anybody by would work', async () => {
    const result = await setup<{ wouldCreate: boolean; notes: string[] }>(
      'POST',
      '/ingestion/test',
      { token: orgA.token, payload: { payload: { city: 'Pune' } } },
    );
    expect(result.wouldCreate).toBe(false);
    expect(result.notes.join(' ')).toContain('at least a name');
  });

  it('is a POST that answers 200, because it creates nothing', async () => {
    const response = await api('POST', '/ingestion/test', {
      token: orgA.token,
      payload: { payload: { name: 'Status Check', phone: '9846099998' } },
    });
    expect(response.statusCode).toBe(200);
  });
});

describe('the signature a client computes', () => {
  it('matches the one the shared helper produces, byte for byte', () => {
    // The contract an integrator implements from the docs: HMAC-SHA256 over "<t>.<raw body>".
    const secret = 'sk_live_example';
    const body = '{"phone":"9845012345"}';
    const timestamp = 1_759_000_000;
    const expected = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
    expect(signRequest(secret, timestamp, body)).toBe(`t=${timestamp},v1=${expected}`);
  });
});
