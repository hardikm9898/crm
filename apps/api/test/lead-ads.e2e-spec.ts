import { createHmac } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newToken } from '@leados/shared';
import { IntegrationInboundService } from '../src/modules/integrations/integration-inbound.service.js';
import { bootTestApp, call, cleanupUsers, type EnvelopeBody, type TestApp } from './app-harness.js';

/**
 * THE LEAD-ADS SUITE (Phase 4's fifth exit criterion: "Meta Lead Ads: duplicate webhook delivery ⇒
 * one lead; token revocation surfaces as a reconnect prompt").
 *
 * Nothing is mocked, including Meta: a real HTTP server runs in-process as the Graph API, and
 * `META_GRAPH_URL` points at it. That is the only way to prove the two things this step is for —
 * that a delivery Meta retries produces exactly one lead, and that a revoked page token becomes a
 * reconnect prompt rather than silence.
 *
 * The ingestion job is driven through `IntegrationInboundService` directly rather than by waiting
 * for a worker: the suite boots the API, and a job queued here would be consumed by nothing. That
 * is the arrangement the outbound webhook suite established, and it is also what makes "the same
 * job delivered twice" a thing a test can actually do.
 */

const SUFFIX = newToken(4)
  .toLowerCase()
  .replace(/[^a-z0-9]/g, '');
const EMAIL_MARKER = `e2eads${SUFFIX}`;
const PASSWORD = 'a quiet november harbour';
const APP_SECRET = 'd41d8cd98f00b204e9800998ecf8427e';
const PAGE_TOKEN = 'EAAG-a-long-lived-page-access-token-value-0001';
const PAGE_ID = '102938475610293';
const VERIFY_TOKEN = 'a phrase i chose';

let ctx: TestApp;
let graph: Server;
let graphUrl: string;
let previousGraphUrl: string | undefined;
const graphRequests: { path: string; authorization: string | undefined }[] = [];
/** What the fake Graph answers next. A function so a test can change its mind mid-suite. */
let graphAnswer: (request: IncomingMessage) => { status: number; body: string } = () => ({
  status: 200,
  body: JSON.stringify({ id: PAGE_ID, name: 'Rao Interiors' }),
});

let orgA: { token: string; organizationId: string; userId: string };

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

/** What a provider is answered: the counts, and the sentence that travels with them. */
interface DeliveryBody {
  accepted: number;
  duplicates: number;
  ignored: number;
  message: string;
}

interface Connection {
  id: string;
  provider: string;
  status: string;
  statusSummary: string;
  lastError: string | null;
  lastSuccessAt: string | null;
  recentChecks: { outcome: string }[];
  secret?: string;
}

async function register(name: string) {
  const registered = await setup<{
    organization: { id: string };
    user: { id: string };
    tokens: { accessToken: string };
  }>('POST', '/auth/register', {
    payload: {
      email: `${EMAIL_MARKER}${name}@test.local`,
      password: PASSWORD,
      name: 'Ads Owner',
      organizationName: `ADS ${name}`,
    },
  });
  return {
    token: registered.tokens.accessToken,
    organizationId: registered.organization.id,
    userId: registered.user.id,
  };
}

/** A signed Meta delivery, over the exact bytes it sends. */
async function metaPost(
  connectionId: string,
  body: unknown,
  options: { secret?: string; signature?: string } = {},
) {
  const raw = JSON.stringify(body);
  const signature =
    options.signature ??
    (options.secret === undefined
      ? undefined
      : `sha256=${createHmac('sha256', options.secret).update(raw).digest('hex')}`);
  return call<EnvelopeBody<DeliveryBody>>(ctx.app, {
    method: 'POST',
    url: `/api/v1/wh/meta_lead_ads/${connectionId}`,
    payload: raw,
    headers: {
      'content-type': 'application/json',
      ...(signature === undefined ? {} : { 'x-hub-signature-256': signature }),
    },
  });
}

/** One Meta delivery envelope for one lead. */
function leadgen(leadgenId: string, formId = '7788990011') {
  return {
    object: 'page',
    entry: [
      {
        id: PAGE_ID,
        time: Math.floor(Date.now() / 1000),
        changes: [
          {
            field: 'leadgen',
            value: {
              leadgen_id: leadgenId,
              page_id: PAGE_ID,
              form_id: formId,
              created_time: Math.floor(Date.now() / 1000),
            },
          },
        ],
      },
    ],
  };
}

async function googlePost(connectionId: string, body: unknown) {
  return call<EnvelopeBody<DeliveryBody>>(ctx.app, {
    method: 'POST',
    url: `/api/v1/wh/google_ads_leads/${connectionId}`,
    payload: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
}

/** Drives the queued ingestion for every event that has not been processed. */
async function drain(organizationId: string): Promise<void> {
  const service = ctx.app.get(IntegrationInboundService);
  const rows = await ctx.db.providerEvent.findMany({
    where: { organizationId, status: { in: ['received', 'failed'] } },
    select: { id: true },
  });
  for (const row of rows) {
    await service.ingest(organizationId, row.id).catch(() => {
      /* the row records the failure; a test asserts against the row, not against this throw */
    });
  }
}

beforeAll(async () => {
  graph = createServer((request, response) => {
    graphRequests.push({
      path: request.url ?? '',
      authorization: request.headers.authorization as string | undefined,
    });
    const answer = graphAnswer(request);
    response.writeHead(answer.status, { 'content-type': 'application/json' });
    response.end(answer.body);
  });
  await new Promise<void>((resolve) => graph.listen(0, '127.0.0.1', resolve));
  graphUrl = `http://127.0.0.1:${(graph.address() as AddressInfo).port}/v21.0`;
  // Set before the application is built, because the configuration is validated once at boot —
  // which is also what makes this a real fetch rather than an assertion about a stub.
  previousGraphUrl = process.env['META_GRAPH_URL'];
  process.env['META_GRAPH_URL'] = graphUrl;

  ctx = await bootTestApp();
  await cleanupUsers(ctx.db, EMAIL_MARKER);
  orgA = await register('a');
}, 120_000);

afterAll(async () => {
  await cleanupUsers(ctx.db, EMAIL_MARKER);
  await ctx.close();
  await new Promise<void>((resolve) => graph.close(() => resolve()));
  if (previousGraphUrl === undefined) delete process.env['META_GRAPH_URL'];
  else process.env['META_GRAPH_URL'] = previousGraphUrl;
});

describe('connecting Meta Lead Ads', () => {
  it('asks for two secrets, and refuses one of them on its own', async () => {
    const catalogue = await setup<
      { key: string; credentialFields: { key: string; required: boolean }[] }[]
    >('GET', '/integrations/providers', { token: orgA.token });
    const meta = catalogue.find((entry) => entry.key === 'meta_lead_ads')!;
    // Two, doing two jobs: one proves a delivery is Meta's, the other fetches the lead it refers
    // to. A single `credential` would have forced the second into `settings`, which are shown back.
    expect(meta.credentialFields.map((field) => field.key)).toEqual([
      'appSecret',
      'pageAccessToken',
    ]);

    const half = await api('POST', '/integrations', {
      token: orgA.token,
      payload: {
        provider: 'meta_lead_ads',
        name: 'Facebook',
        credentials: { appSecret: APP_SECRET },
        settings: { pageId: PAGE_ID },
      },
    });
    expect(half.statusCode).toBe(400);
    expect(JSON.stringify(half.body.error?.details)).toContain('credentials.pageAccessToken');
  });

  it('refuses a page id that is not one, and a secret it has no field for', async () => {
    const badPage = await api('POST', '/integrations', {
      token: orgA.token,
      payload: {
        provider: 'meta_lead_ads',
        name: 'Facebook',
        credentials: { appSecret: APP_SECRET, pageAccessToken: PAGE_TOKEN },
        settings: { pageId: 'my-page' },
      },
    });
    expect(badPage.statusCode).toBe(400);
    expect(JSON.stringify(badPage.body.error?.details)).toContain('settings.pageId');

    const extra = await api('POST', '/integrations', {
      token: orgA.token,
      payload: {
        provider: 'meta_lead_ads',
        name: 'Facebook',
        credentials: { appSecret: APP_SECRET, pageAccessToken: PAGE_TOKEN, clientSecret: 'x' },
        settings: { pageId: PAGE_ID },
      },
    });
    expect(extra.statusCode).toBe(400);
    // A secret nothing reads is a secret somebody believes is protecting something.
    expect(JSON.stringify(extra.body.error?.details)).toContain('UNKNOWN_CREDENTIAL');
  });

  it('connects, probes the page with the token, and never answers either secret back', async () => {
    const before = graphRequests.length;
    const connection = await setup<Connection>('POST', '/integrations', {
      token: orgA.token,
      payload: {
        provider: 'meta_lead_ads',
        name: 'Facebook lead forms',
        credentials: { appSecret: APP_SECRET, pageAccessToken: PAGE_TOKEN },
        settings: { pageId: PAGE_ID, verifyToken: VERIFY_TOKEN, sourceName: 'Facebook' },
      },
    });
    expect(connection.status).toBe('connected');
    expect(graphRequests.length).toBe(before + 1);
    expect(graphRequests.at(-1)?.path).toContain(PAGE_ID);
    // The **page token**, not the app secret: the two are not interchangeable and a connection
    // that probed with the wrong one would read as revoked while working perfectly.
    expect(graphRequests.at(-1)?.authorization).toBe(`Bearer ${PAGE_TOKEN}`);
    expect(connection.recentChecks[0]?.outcome).toBe('ok');

    const serialized = JSON.stringify(connection);
    expect(serialized).not.toContain(APP_SECRET);
    expect(serialized).not.toContain(PAGE_TOKEN);

    // And both are in one envelope, bound to the row.
    const row = await ctx.db.integrationConnection.findFirstOrThrow({
      where: { id: connection.id },
      select: { credentialsEncrypted: true },
    });
    expect(row.credentialsEncrypted.startsWith('v1.')).toBe(true);
    expect(row.credentialsEncrypted).not.toContain(APP_SECRET);
    expect(row.credentialsEncrypted).not.toContain(PAGE_TOKEN);
  });
});

describe('Meta’s handshake', () => {
  let connectionId: string;

  beforeAll(async () => {
    const live = await setup<Connection[]>('GET', '/integrations', { token: orgA.token });
    connectionId = live.find((item) => item.provider === 'meta_lead_ads')!.id;
  });

  it('echoes the challenge when the verify token matches', async () => {
    const response = await call<string>(ctx.app, {
      method: 'GET',
      url: `/api/v1/wh/meta_lead_ads/${connectionId}?hub.mode=subscribe&hub.verify_token=${encodeURIComponent(VERIFY_TOKEN)}&hub.challenge=1158201444`,
    });
    expect(response.statusCode).toBe(200);
    // Plain text, not an envelope: Meta's verifier compares the body to the challenge it sent, and
    // `{"success":true,"data":"1158201444"}` would never confirm the subscription.
    expect(String(response.body)).toBe('1158201444');
    expect(response.headers['content-type']).toContain('text/plain');
  });

  it('refuses a challenge with the wrong token, and one with no mode', async () => {
    const wrong = await call(ctx.app, {
      method: 'GET',
      url: `/api/v1/wh/meta_lead_ads/${connectionId}?hub.mode=subscribe&hub.verify_token=guessed&hub.challenge=1`,
    });
    expect(wrong.statusCode).toBe(403);

    const noMode = await call(ctx.app, {
      method: 'GET',
      url: `/api/v1/wh/meta_lead_ads/${connectionId}?hub.challenge=1`,
    });
    expect(noMode.statusCode).toBe(403);
  });

  it('answers 404 for a connection that does not exist', async () => {
    const unknown = await call(ctx.app, {
      method: 'GET',
      url: `/api/v1/wh/meta_lead_ads/00000000-0000-7000-8000-000000000000?hub.mode=subscribe&hub.verify_token=${encodeURIComponent(VERIFY_TOKEN)}&hub.challenge=1`,
    });
    expect(unknown.statusCode).toBe(404);
  });
});

describe('a Meta delivery', () => {
  let connectionId: string;

  beforeAll(async () => {
    const live = await setup<Connection[]>('GET', '/integrations', { token: orgA.token });
    connectionId = live.find((item) => item.provider === 'meta_lead_ads')!.id;
  });

  it('refuses an unsigned delivery, and one signed with the wrong secret', async () => {
    const unsigned = await metaPost(connectionId, leadgen('unsigned-1'));
    expect(unsigned.statusCode).toBe(401);
    expect(unsigned.body.error?.message).toContain('X-Hub-Signature-256');

    const wrong = await metaPost(connectionId, leadgen('wrong-1'), { secret: 'another-app-secret' });
    expect(wrong.statusCode).toBe(401);
    // The likeliest cause, named: an app secret from a different app signs perfectly.
    expect(wrong.body.error?.message).toMatch(/app secret/i);

    const malformed = await metaPost(connectionId, leadgen('bad-1'), { signature: 'nonsense' });
    expect(malformed.statusCode).toBe(401);
    expect(malformed.body.error?.message).toMatch(/sha256=/);

    // Nothing was written for any of them: a delivery we cannot attribute is not a delivery.
    expect(
      await ctx.db.providerEvent.count({ where: { organizationId: orgA.organizationId } }),
    ).toBe(0);
  });

  it('fetches the lead Meta only referred to, and captures it through the one pipeline', async () => {
    const leadgenId = `lead_${newToken(6)}`;
    graphAnswer = (request) =>
      (request.url ?? '').includes(leadgenId)
        ? {
            status: 200,
            body: JSON.stringify({
              id: leadgenId,
              created_time: '2026-10-19T06:00:00+0000',
              ad_name: 'Monsoon offer',
              campaign_name: 'Interiors — Bengaluru',
              form_id: '7788990011',
              field_data: [
                { name: 'full_name', values: ['Asha Rao'] },
                { name: 'phone_number', values: ['+91 98450 12345'] },
                { name: 'email', values: ['ASHA@example.test'] },
                { name: 'city', values: ['Bengaluru'] },
              ],
            }),
          }
        : { status: 200, body: JSON.stringify({ id: PAGE_ID, name: 'Rao Interiors' }) };

    const delivered = await metaPost(connectionId, leadgen(leadgenId), { secret: APP_SECRET });
    // 200, not 201: Meta is told we have it, and the lead is made in the background. A provider
    // that waits for us is a provider that retries.
    expect(delivered.statusCode).toBe(200);
    expect(delivered.body.data.accepted).toBe(1);
    expect(delivered.body.data.duplicates).toBe(0);

    const ledgerBefore = await ctx.db.providerEvent.findFirstOrThrow({
      where: { organizationId: orgA.organizationId, externalEventId: leadgenId },
    });
    expect(ledgerBefore.status).toBe('received');
    expect(ledgerBefore.provider).toBe('meta_lead_ads');
    expect(ledgerBefore.connectionId).toBe(connectionId);
    // The whole delivery, kept: a failed ingestion is retried from the row rather than from Meta.
    expect(JSON.stringify(ledgerBefore.raw)).toContain(leadgenId);

    await drain(orgA.organizationId);

    const ledger = await ctx.db.providerEvent.findFirstOrThrow({
      where: { id: ledgerBefore.id },
    });
    expect(ledger.status).toBe('processed');
    expect(ledger.processedAt).not.toBeNull();
    expect(ledger.leadId).not.toBeNull();

    const lead = await ctx.db.lead.findFirstOrThrow({
      where: { id: ledger.leadId as string },
      select: {
        firstName: true,
        lastName: true,
        phoneE164: true,
        email: true,
        city: true,
        createdVia: true,
        leadSourceId: true,
      },
    });
    // Meta's standard questions, through the provider's own default mapping and then the
    // workspace's own normalisation — nobody edited a mapping to make this work.
    expect(lead.firstName).toBe('Asha');
    expect(lead.lastName).toBe('Rao');
    expect(lead.phoneE164).toBe('+919845012345');
    expect(lead.email).toBe('asha@example.test');
    expect(lead.city).toBe('Bengaluru');

    const payload = await ctx.db.inboundPayload.findFirstOrThrow({
      where: { organizationId: orgA.organizationId, channel: 'meta_ads' },
      orderBy: { receivedAt: 'desc' },
      select: { integrationConnectionId: true, status: true, rawBody: true },
    });
    expect(payload.integrationConnectionId).toBe(connectionId);
    expect(payload.status).toBe('processed');
    // The answers as Meta gave them, flattened by question name — and the array still there.
    expect((payload.rawBody as Record<string, unknown>)['full_name']).toBe('Asha Rao');
    expect(Array.isArray((payload.rawBody as Record<string, unknown>)['field_data'])).toBe(true);
  });

  /**
   * The exit criterion, exactly as the roadmap words it.
   */
  it('produces one lead from a delivery Meta retries', async () => {
    const leadgenId = `retry_${newToken(6)}`;
    graphAnswer = (request) =>
      (request.url ?? '').includes(leadgenId)
        ? {
            status: 200,
            body: JSON.stringify({
              id: leadgenId,
              field_data: [
                { name: 'full_name', values: ['Vikram Shetty'] },
                { name: 'phone_number', values: ['+919845012399'] },
              ],
            }),
          }
        : { status: 200, body: JSON.stringify({ id: PAGE_ID, name: 'Rao Interiors' }) };

    const body = leadgen(leadgenId);
    const first = await metaPost(connectionId, body, { secret: APP_SECRET });
    expect(first.body.data.accepted).toBe(1);

    // The same delivery again, byte for byte, as Meta sends it when it did not see our 200.
    const second = await metaPost(connectionId, body, { secret: APP_SECRET });
    expect(second.statusCode).toBe(200);
    expect(second.body.data.accepted).toBe(0);
    expect(second.body.data.duplicates).toBe(1);
    // In the payload, not the envelope — the same place the public lead API next door puts it, so
    // both doors of this family answer one shape. The provider reads neither.
    expect(second.body.data.message).toMatch(/already received/i);

    // A third, with a different `time` so the bytes differ — the ledger is keyed on Meta's id, not
    // on a hash of the body, which is the difference between a dedupe and an idempotency ledger.
    const third = await metaPost(
      connectionId,
      { ...body, entry: [{ ...body.entry[0], time: 1 }] },
      { secret: APP_SECRET },
    );
    expect(third.body.data.duplicates).toBe(1);

    expect(
      await ctx.db.providerEvent.count({
        where: { organizationId: orgA.organizationId, externalEventId: leadgenId },
      }),
    ).toBe(1);

    await drain(orgA.organizationId);
    // And draining twice must not create a second lead either: the job is at-least-once.
    await drain(orgA.organizationId);

    expect(
      await ctx.db.lead.count({
        where: { organizationId: orgA.organizationId, phoneE164: '+919845012399' },
      }),
    ).toBe(1);
  });

  it('acknowledges a delivery with nothing in it that is a lead', async () => {
    // Meta sends changes nobody subscribed to. A 4xx teaches it to disable the endpoint, which
    // would stop the leads we do want — silently.
    const other = await metaPost(
      connectionId,
      {
        object: 'page',
        entry: [{ id: PAGE_ID, changes: [{ field: 'feed', value: { post_id: '1' } }] }],
      },
      { secret: APP_SECRET },
    );
    expect(other.statusCode).toBe(200);
    expect(other.body.data.accepted).toBe(0);
    expect(other.body.data.message).toMatch(/nothing in that delivery/i);
  });

  it('records why a lead could not be fetched, and keeps the event for a retry', async () => {
    const leadgenId = `gone_${newToken(6)}`;
    graphAnswer = (request) =>
      (request.url ?? '').includes(leadgenId)
        ? {
            status: 400,
            body: JSON.stringify({
              error: { message: 'Unsupported get request.', code: 100 },
            }),
          }
        : { status: 200, body: JSON.stringify({ id: PAGE_ID, name: 'Rao Interiors' }) };

    await metaPost(connectionId, leadgen(leadgenId), { secret: APP_SECRET });
    await drain(orgA.organizationId);

    const ledger = await ctx.db.providerEvent.findFirstOrThrow({
      where: { organizationId: orgA.organizationId, externalEventId: leadgenId },
    });
    expect(ledger.status).toBe('failed');
    expect(ledger.attempts).toBe(1);
    // Meta's own words, so "why is this lead not here" is answerable without reading our logs.
    expect(ledger.error).toContain('Unsupported get request');
    expect(ledger.leadId).toBeNull();

    // And the sweep offers it again, because the row is what is owed.
    const service = ctx.app.get(IntegrationInboundService);
    expect(await service.sweepUnresolved()).toBeGreaterThanOrEqual(1);
  });
});

/**
 * The other half of the exit criterion.
 */
describe('a revoked page token', () => {
  it('surfaces as a reconnect prompt rather than as silence', async () => {
    const live = await setup<Connection[]>('GET', '/integrations', { token: orgA.token });
    const connectionId = live.find((item) => item.provider === 'meta_lead_ads')!.id;

    // Meta answers **200 with an error body** for some failures and 400 for an expired token
    // rather than 401, so the code inside the body is what has to be read.
    graphAnswer = () => ({
      status: 400,
      body: JSON.stringify({
        error: {
          message: 'Error validating access token: the user has not authorized application.',
          code: 190,
          type: 'OAuthException',
        },
      }),
    });
    const checked = await setup<{ outcome: string; statusAfter: string }>(
      'POST',
      `/integrations/${connectionId}/check`,
      { token: orgA.token },
    );
    expect(checked.outcome).toBe('unauthorized');
    // No grace period: no number of retries fixes a token somebody revoked.
    expect(checked.statusAfter).toBe('revoked');

    const after = await setup<Connection>('GET', `/integrations/${connectionId}`, {
      token: orgA.token,
    });
    expect(after.status).toBe('revoked');
    expect(after.statusSummary).toMatch(/reconnect/i);
    expect(after.lastError).toContain('not authorized');

    const notifications = await ctx.db.notification.findMany({
      where: { organizationId: orgA.organizationId, type: 'integration.revoked' },
      select: { title: true, link: true, data: true },
    });
    expect(notifications.length).toBe(1);
    expect(notifications[0]?.title).toContain('Meta Lead Ads');
    expect(notifications[0]?.link).toBe('/settings/integrations');
    expect((notifications[0]?.data as { connectionId?: string })?.connectionId).toBe(connectionId);

    // And pasting a fresh pair starts it again.
    graphAnswer = () => ({ status: 200, body: JSON.stringify({ id: PAGE_ID, name: 'Rao' }) });
    const reconnected = await setup<Connection>('PATCH', `/integrations/${connectionId}`, {
      token: orgA.token,
      payload: {
        credentials: { appSecret: APP_SECRET, pageAccessToken: `${PAGE_TOKEN}-rotated` },
      },
    });
    expect(reconnected.status).toBe('connected');
    expect(reconnected.lastError).toBeNull();
    expect(graphRequests.at(-1)?.authorization).toBe(`Bearer ${PAGE_TOKEN}-rotated`);
  });
});

describe('Google Ads lead forms', () => {
  let connectionId: string;
  let webhookKey: string;

  beforeAll(async () => {
    const connected = await setup<Connection & { secret: string }>('POST', '/integrations', {
      token: orgA.token,
      payload: {
        provider: 'google_ads_leads',
        name: 'Google Ads',
        settings: { sourceName: 'Google Ads' },
      },
    });
    connectionId = connected.id;
    webhookKey = connected.secret;
  });

  it('generates the key Google echoes, and shows it exactly once', () => {
    expect(webhookKey).toMatch(/^whsec_/);
  });

  it('refuses a delivery with no key, and one with the wrong key', async () => {
    const none = await googlePost(connectionId, { lead_id: 'no-key', user_column_data: [] });
    expect(none.statusCode).toBe(401);
    expect(none.body.error?.message).toMatch(/google_key/);

    const wrong = await googlePost(connectionId, {
      lead_id: 'wrong-key',
      google_key: 'whsec_not_this_one',
      user_column_data: [],
    });
    expect(wrong.statusCode).toBe(401);
    expect(wrong.body.error?.message).toMatch(/does not match/i);
  });

  it('refuses a delivery with no lead id, because a retry could not be told from a new lead', async () => {
    const response = await googlePost(connectionId, {
      google_key: webhookKey,
      user_column_data: [{ column_id: 'FULL_NAME', string_value: 'No Id' }],
    });
    expect(response.statusCode).toBe(400);
    expect(JSON.stringify(response.body.error?.details)).toContain('lead_id');
  });

  it('captures the answers it carries, with no second request to anybody', async () => {
    const leadId = `g_${newToken(6)}`;
    const before = graphRequests.length;
    const delivered = await googlePost(connectionId, {
      lead_id: leadId,
      google_key: webhookKey,
      form_id: 55667788,
      campaign_id: 112233,
      user_column_data: [
        { column_id: 'FULL_NAME', column_name: 'Full name', string_value: 'Meera Pillai' },
        { column_id: 'PHONE_NUMBER', column_name: 'Phone', string_value: '+91 98450 12388' },
        { column_id: 'EMAIL', column_name: 'Email', string_value: 'MEERA@example.test' },
      ],
    });
    expect(delivered.statusCode).toBe(200);
    expect(delivered.body.data.accepted).toBe(1);
    // Google sends the answers, so nothing is fetched: `deliveryIsAReference` is false for it.
    expect(graphRequests.length).toBe(before);

    await drain(orgA.organizationId);
    const ledger = await ctx.db.providerEvent.findFirstOrThrow({
      where: { organizationId: orgA.organizationId, externalEventId: leadId },
    });
    expect(ledger.provider).toBe('google_ads_leads');
    expect(ledger.status).toBe('processed');

    const lead = await ctx.db.lead.findFirstOrThrow({
      where: { id: ledger.leadId as string },
      select: { firstName: true, lastName: true, phoneE164: true, email: true },
    });
    expect(lead.firstName).toBe('Meera');
    expect(lead.lastName).toBe('Pillai');
    expect(lead.phoneE164).toBe('+919845012388');
    expect(lead.email).toBe('meera@example.test');

    const payload = await ctx.db.inboundPayload.findFirstOrThrow({
      where: { organizationId: orgA.organizationId, channel: 'google_ads' },
      orderBy: { receivedAt: 'desc' },
      select: { integrationConnectionId: true, rawBody: true },
    });
    expect(payload.integrationConnectionId).toBe(connectionId);
    expect((payload.rawBody as Record<string, unknown>)['FULL_NAME']).toBe('Meera Pillai');
  });

  it('produces one lead from a delivery Google retries', async () => {
    const leadId = `gretry_${newToken(6)}`;
    const body = {
      lead_id: leadId,
      google_key: webhookKey,
      user_column_data: [
        { column_id: 'FULL_NAME', string_value: 'Retry Nair' },
        { column_id: 'PHONE_NUMBER', string_value: '+919845012377' },
      ],
    };
    expect((await googlePost(connectionId, body)).body.data.accepted).toBe(1);
    const again = await googlePost(connectionId, body);
    expect(again.statusCode).toBe(200);
    expect(again.body.data.duplicates).toBe(1);

    await drain(orgA.organizationId);
    expect(
      await ctx.db.lead.count({
        where: { organizationId: orgA.organizationId, phoneE164: '+919845012377' },
      }),
    ).toBe(1);
  });

  it('acknowledges a test delivery and puts nothing in the pipeline', async () => {
    const response = await googlePost(connectionId, {
      lead_id: 'lead_id_123',
      google_key: webhookKey,
      is_test: true,
      user_column_data: [{ column_id: 'FULL_NAME', string_value: 'Test Lead' }],
    });
    // Verified and acknowledged — a provider that gets a 4xx from its own test disables the
    // endpoint — and recorded, but never captured: a test lead in somebody's pipeline is worse
    // than no test at all.
    expect(response.statusCode).toBe(200);
    expect(response.body.data.ignored).toBe(1);
    expect(response.body.data.accepted).toBe(0);
    expect(response.body.data.message).toMatch(/test delivery/i);

    const ledger = await ctx.db.providerEvent.findFirstOrThrow({
      where: { organizationId: orgA.organizationId, externalEventId: 'lead_id_123' },
    });
    expect(ledger.eventType).toBe('test_lead');
    expect(ledger.status).toBe('processed');
    expect(ledger.leadId).toBeNull();

    expect(
      await ctx.db.lead.count({
        where: { organizationId: orgA.organizationId, firstName: 'Test' },
      }),
    ).toBe(0);
  });

  it('has nothing to probe, and says so rather than returning a tick it has not earned', async () => {
    const response = await api('POST', `/integrations/${connectionId}/check`, {
      token: orgA.token,
    });
    expect(response.statusCode).toBe(422);
    expect(response.body.error?.message).toMatch(/sends to us/i);
  });

  it('marks the connection as working once something has arrived', async () => {
    const row = await ctx.db.integrationConnection.findFirstOrThrow({
      where: { id: connectionId },
      select: { status: true, lastSuccessAt: true },
    });
    expect(row.status).toBe('connected');
    expect(row.lastSuccessAt).not.toBeNull();
  });
});
