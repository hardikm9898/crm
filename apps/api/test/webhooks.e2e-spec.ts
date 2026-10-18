import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  MAX_CONSECUTIVE_FAILURES,
  WEBHOOK_TEST_EVENT,
  newId,
  newToken,
  systemPrincipal,
  tenantContext,
  verifySignature,
} from '@leados/shared';
import { WebhookDispatchService } from '../src/modules/webhooks/webhook-dispatch.service.js';
import { bootTestApp, call, cleanupUsers, type EnvelopeBody, type TestApp } from './app-harness.js';

/**
 * THE OUTBOUND WEBHOOK SUITE (`FR-API-4`, `docs/api-architecture.md` §8).
 *
 * Nothing is mocked, including the receiver: a real HTTP server runs in-process, records what
 * arrived, and answers whatever the test needs it to. That is the only way to assert the things
 * that matter — that the signature a stranger's server would verify actually verifies, that a 500
 * schedules a retry rather than losing the event, that a 410 stops us immediately, and that fifteen
 * consecutive failures switch the endpoint off and tell somebody.
 *
 * The delivery path is driven through `WebhookDispatchService` directly rather than by waiting for
 * a worker: the suite boots the API, and a job queued here would be consumed by nothing. Entering
 * the tenant context by hand is what the SLA suite had to learn too — a service handed an unscoped
 * client reads every workspace's rows.
 */

const SUFFIX = newToken(4)
  .toLowerCase()
  .replace(/[^a-z0-9]/g, '');
const EMAIL_MARKER = `e2ewh${SUFFIX}`;
const PASSWORD = 'a quiet november harbour';

interface Received {
  readonly headers: Record<string, string | string[] | undefined>;
  readonly body: string;
  readonly path: string;
}

let ctx: TestApp;
let receiver: Server;
let origin: string;
let received: Received[] = [];
/** What the receiver answers next. A function so a test can change its mind mid-suite. */
let answer: (request: IncomingMessage) => { status: number; body?: string; location?: string } = () => ({
  status: 200,
  body: 'ok',
});

let orgA: { token: string; organizationId: string; userId: string };
let orgB: { token: string; organizationId: string };

async function api<T>(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  options: { token?: string; payload?: unknown } = {},
) {
  return call<EnvelopeBody<T>>(ctx.app, {
    method,
    url: `/api/v1${url}`,
    ...(options.token === undefined ? {} : { token: options.token }),
    ...(options.payload === undefined ? {} : { payload: options.payload }),
  });
}

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

async function register(name: string) {
  const email = `${EMAIL_MARKER}${name}@test.local`;
  const registered = await setup<{
    organization: { id: string };
    user: { id: string };
    tokens: { accessToken: string };
  }>('POST', '/auth/register', {
    payload: { email, password: PASSWORD, name: 'Webhook Owner', organizationName: `WH ${name}` },
  });
  return {
    token: registered.tokens.accessToken,
    organizationId: registered.organization.id,
    userId: registered.user.id,
  };
}

interface Endpoint {
  id: string;
  url: string;
  isActive: boolean;
  failureCount: number;
  disabledReason: string | null;
  secret?: string;
  secretShownOnce?: boolean;
}

async function endpoint(
  token: string,
  overrides: Record<string, unknown> = {},
): Promise<Endpoint & { secret: string }> {
  return setup<Endpoint & { secret: string }>('POST', '/webhooks', {
    token,
    payload: {
      url: `${origin}/hook/${newId().slice(-8)}`,
      eventTypes: ['lead.created'],
      ...overrides,
    },
  });
}

/** One fan-out plus one attempt, through the real services, inside the real tenant context. */
async function dispatch(
  organizationId: string,
  event: { name: string; eventId?: string; payload?: Record<string, unknown> },
): Promise<string[]> {
  const service = ctx.app.get(WebhookDispatchService);
  const eventId = event.eventId ?? newId();
  await service.fanOut({
    organizationId,
    eventId,
    eventName: event.name,
    payload: event.payload ?? { aggregateId: newId() },
  });
  const deliveries = await ctx.db.webhookDelivery.findMany({
    where: { organizationId, eventId },
    select: { id: true },
  });
  for (const delivery of deliveries) await service.deliver(organizationId, delivery.id);
  return deliveries.map((row) => row.id);
}

beforeAll(async () => {
  ctx = await bootTestApp();
  receiver = createServer((request: IncomingMessage, response: ServerResponse) => {
    let body = '';
    request.on('data', (chunk) => (body += chunk));
    request.on('end', () => {
      received.push({ headers: request.headers, body, path: request.url ?? '/' });
      const outcome = answer(request);
      if (outcome.location) {
        response.writeHead(outcome.status, { location: outcome.location });
        response.end();
        return;
      }
      response.writeHead(outcome.status, { 'content-type': 'text/plain' });
      response.end(outcome.body ?? '');
    });
  });
  await new Promise<void>((resolve) => receiver.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}`;

  orgA = await register('a');
  orgB = await register('b');
}, 60_000);

afterAll(async () => {
  await new Promise<void>((resolve) => receiver.close(() => resolve()));
  await cleanupUsers(ctx.db, EMAIL_MARKER);
  await ctx.close();
});

describe('endpoints (FR-API-4)', () => {
  it('answers the signing secret exactly once, and never again', async () => {
    const created = await endpoint(orgA.token, { description: 'Our server' });
    expect(created.secret.startsWith('whsec_')).toBe(true);
    expect(created.secretShownOnce).toBe(true);

    const readBack = await setup<Record<string, unknown>>('GET', `/webhooks/${created.id}`, {
      token: orgA.token,
    });
    expect(readBack['secret']).toBeUndefined();
    expect(JSON.stringify(readBack)).not.toContain(created.secret);
  });

  it('stores the secret encrypted, not as it was shown', async () => {
    const created = await endpoint(orgA.token);
    const row = await ctx.db.webhookEndpoint.findFirstOrThrow({ where: { id: created.id } });
    expect(row.secretEncrypted.startsWith('v1.')).toBe(true);
    expect(row.secretEncrypted).not.toContain(created.secret);
  });

  it('refuses a URL it could never post to', async () => {
    for (const url of [
      'file:///etc/passwd',
      'ftp://example.com/hook',
      'https://user:pass@hooks.example.com/x',
      'not-a-url',
    ]) {
      const response = await api('POST', '/webhooks', {
        token: orgA.token,
        payload: { url, eventTypes: ['lead.created'] },
      });
      expect(response.statusCode, url).toBe(400);
    }
  });

  it('refuses an endpoint subscribed to nothing, or to an event nothing emits', async () => {
    const none = await api('POST', '/webhooks', {
      token: orgA.token,
      payload: { url: `${origin}/none`, eventTypes: [] },
    });
    expect(none.statusCode).toBe(400);
    const unknown = await api('POST', '/webhooks', {
      token: orgA.token,
      payload: { url: `${origin}/unknown`, eventTypes: ['conversation.created'] },
    });
    expect(unknown.statusCode).toBe(400);
  });

  it('refuses a second endpoint for the same URL, which would deliver everything twice', async () => {
    const url = `${origin}/hook/duplicate-${SUFFIX}`;
    expect((await api('POST', '/webhooks', { token: orgA.token, payload: { url, eventTypes: ['lead.created'] } })).statusCode).toBe(201);
    const second = await api('POST', '/webhooks', {
      token: orgA.token,
      payload: { url, eventTypes: ['lead.created'] },
    });
    expect(second.statusCode).toBe(409);
  });

  it('rotates the secret, and the old one stops verifying', async () => {
    received = [];
    answer = () => ({ status: 200, body: 'ok' });
    // Its own event type: several endpoints in this workspace subscribe to `lead.created` by the
    // time this runs, and reading "the last request" out of a fan-out to six endpoints is a test
    // that passes on the order the rows happened to come back in.
    const created = await endpoint(orgA.token, { eventTypes: ['lead.stage_changed'] });
    const rotated = await setup<{ secret: string }>(
      'POST',
      `/webhooks/${created.id}/rotate-secret`,
      { token: orgA.token },
    );
    expect(rotated.secret).not.toBe(created.secret);

    await dispatch(orgA.organizationId, { name: 'lead.stage_changed' });
    expect(received).toHaveLength(1);
    const sent = received.at(-1);
    expect(sent).toBeDefined();
    const header = `t=${sent?.headers['x-leados-timestamp']},${sent?.headers['x-leados-signature']}`;
    expect(verifySignature(rotated.secret, header, sent?.body ?? '').ok).toBe(true);
    expect(verifySignature(created.secret, header, sent?.body ?? '').ok).toBe(false);
  });

  it('keeps one workspace’s endpoints out of another’s list', async () => {
    const mine = await endpoint(orgA.token);
    const theirs = await setup<{ id: string }[]>('GET', '/webhooks', { token: orgB.token });
    expect(theirs.some((row) => row.id === mine.id)).toBe(false);
    expect((await api('GET', `/webhooks/${mine.id}`, { token: orgB.token })).statusCode).toBe(404);
  });
});

describe('delivery', () => {
  it('signs the body the way the documentation says, and the receiver can verify it', async () => {
    received = [];
    answer = () => ({ status: 200, body: 'thanks' });
    const created = await endpoint(orgA.token, { eventTypes: ['lead.updated'] });
    const eventId = newId();
    await dispatch(orgA.organizationId, {
      name: 'lead.updated',
      eventId,
      payload: { aggregateId: 'lead-1', fullName: 'Rohit Kulkarni' },
    });

    expect(received).toHaveLength(1);
    const sent = received[0]!;
    expect(sent.headers['x-leados-event']).toBe('lead.updated');
    expect(sent.headers['x-leados-event-id']).toBe(eventId);
    expect(sent.headers['x-leados-delivery-id']).toBeDefined();
    expect(sent.headers['content-type']).toContain('application/json');

    // Verified the way a stranger's server would: the timestamp from its header, the body as bytes.
    const header = `t=${sent.headers['x-leados-timestamp']},${sent.headers['x-leados-signature']}`;
    expect(verifySignature(created.secret, header, sent.body).ok).toBe(true);

    const body = JSON.parse(sent.body) as Record<string, unknown>;
    expect(body['id']).toBe(eventId);
    expect(body['type']).toBe('lead.updated');
    expect(body['apiVersion']).toBe('v1');
    expect(body['organizationId']).toBe(orgA.organizationId);
    expect((body['data'] as Record<string, unknown>)['fullName']).toBe('Rohit Kulkarni');

    const delivery = await ctx.db.webhookDelivery.findFirstOrThrow({ where: { eventId } });
    expect(delivery.status).toBe('succeeded');
    expect(delivery.attemptCount).toBe(1);
    expect(delivery.nextAttemptAt).toBeNull();
    expect(delivery.deliveredAt).not.toBeNull();
    expect(delivery.lastStatusCode).toBe(200);
    expect(delivery.lastResponseBody).toBe('thanks');

    const attempts = await ctx.db.webhookAttempt.findMany({
      where: { deliveryId: delivery.id },
      orderBy: { attemptNo: 'asc' },
    });
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.statusCode).toBe(200);
    expect(attempts[0]?.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('sends only to the endpoints that asked for the event', async () => {
    received = [];
    answer = () => ({ status: 200 });
    const wanted = await endpoint(orgA.token, { eventTypes: ['task.completed'] });
    await endpoint(orgA.token, { eventTypes: ['deal.won'] });
    const eventId = newId();
    await dispatch(orgA.organizationId, { name: 'task.completed', eventId });

    const deliveries = await ctx.db.webhookDelivery.findMany({ where: { eventId } });
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]?.endpointId).toBe(wanted.id);
  });

  it('does not send to an endpoint that is switched off', async () => {
    received = [];
    const off = await endpoint(orgA.token, { eventTypes: ['deal.lost'] });
    await setup('PATCH', `/webhooks/${off.id}`, { token: orgA.token, payload: { isActive: false } });
    const eventId = newId();
    await dispatch(orgA.organizationId, { name: 'deal.lost', eventId });
    expect(await ctx.db.webhookDelivery.count({ where: { eventId } })).toBe(0);
  });

  it('creates one delivery for a re-dispatched event, not two', async () => {
    // The outbox is at-least-once, so the fan-out has to be idempotent on `(endpoint, event)`.
    received = [];
    answer = () => ({ status: 200 });
    await endpoint(orgA.token, { eventTypes: ['quotation.sent'] });
    const eventId = newId();
    const service = ctx.app.get(WebhookDispatchService);
    await service.fanOut({ organizationId: orgA.organizationId, eventId, eventName: 'quotation.sent', payload: {} });
    await service.fanOut({ organizationId: orgA.organizationId, eventId, eventName: 'quotation.sent', payload: {} });
    expect(await ctx.db.webhookDelivery.count({ where: { eventId } })).toBe(1);
  });

  it('never delivers one workspace’s event to another workspace’s endpoint', async () => {
    received = [];
    answer = () => ({ status: 200 });
    await endpoint(orgB.token, { eventTypes: ['lead.assigned'] });
    const eventId = newId();
    await dispatch(orgA.organizationId, { name: 'lead.assigned', eventId });
    const deliveries = await ctx.db.webhookDelivery.findMany({ where: { eventId } });
    expect(deliveries.every((row) => row.organizationId === orgA.organizationId)).toBe(true);
  });
});

describe('when the endpoint does not take it', () => {
  it('schedules a retry rather than losing the event', async () => {
    received = [];
    answer = () => ({ status: 500, body: 'our database is down' });
    const created = await endpoint(orgA.token, { eventTypes: ['customer.created'] });
    const eventId = newId();
    await dispatch(orgA.organizationId, { name: 'customer.created', eventId });

    const delivery = await ctx.db.webhookDelivery.findFirstOrThrow({ where: { eventId } });
    expect(delivery.status).toBe('failed');
    expect(delivery.attemptCount).toBe(1);
    expect(delivery.lastStatusCode).toBe(500);
    // The response body is kept, truncated, because it is what a developer needs to read.
    expect(delivery.lastResponseBody).toBe('our database is down');
    // The first retry is ten seconds out, ±20 % of jitter.
    const due = (delivery.nextAttemptAt as Date).getTime() - Date.now();
    expect(due).toBeGreaterThan(5_000);
    expect(due).toBeLessThan(13_000);

    const endpointRow = await ctx.db.webhookEndpoint.findFirstOrThrow({ where: { id: created.id } });
    expect(endpointRow.failureCount).toBe(1);
    expect(endpointRow.isActive).toBe(true);
    expect(endpointRow.lastFailureAt).not.toBeNull();
  });

  it('does not treat a redirect as an acknowledgement', async () => {
    received = [];
    answer = () => ({ status: 302, location: 'https://elsewhere.example.com/hook' });
    await endpoint(orgA.token, { eventTypes: ['payment.received'] });
    const eventId = newId();
    await dispatch(orgA.organizationId, { name: 'payment.received', eventId });

    const delivery = await ctx.db.webhookDelivery.findFirstOrThrow({ where: { eventId } });
    expect(delivery.status).toBe('failed');
    expect(delivery.lastStatusCode).toBe(302);
    // And it was not followed: the receiver saw exactly one request, to its own path.
    expect(received).toHaveLength(1);
  });

  it('records an attempt when there was no answer at all', async () => {
    received = [];
    // A port nothing is listening on: connection refused, which is the commonest real failure.
    const dead = await setup<Endpoint>('POST', '/webhooks', {
      token: orgA.token,
      payload: { url: 'http://127.0.0.1:9/hook', eventTypes: ['lead.deleted'] },
    });
    const eventId = newId();
    await dispatch(orgA.organizationId, { name: 'lead.deleted', eventId });

    const delivery = await ctx.db.webhookDelivery.findFirstOrThrow({ where: { eventId } });
    expect(delivery.status).toBe('failed');
    expect(delivery.lastStatusCode).toBeNull();
    expect(delivery.lastError).toBeTruthy();
    const attempts = await ctx.db.webhookAttempt.findMany({ where: { deliveryId: delivery.id } });
    // A CHECK refuses an attempt with neither a status code nor a reason.
    expect(attempts[0]?.error).toBeTruthy();
    expect(dead.id).toBeTruthy();
  });

  it('gives up after the schedule is spent, and says so', async () => {
    received = [];
    answer = () => ({ status: 503 });
    await endpoint(orgA.token, { eventTypes: ['deal.stage_changed'] });
    const eventId = newId();
    await dispatch(orgA.organizationId, { name: 'deal.stage_changed', eventId });
    const delivery = await ctx.db.webhookDelivery.findFirstOrThrow({ where: { eventId } });

    // Seven retries later the schedule is spent. Driven by moving the row's own counter rather
    // than by waiting 33 hours; the attempt rows are the real ones.
    for (let attempt = 2; attempt <= 8; attempt += 1) {
      await ctx.db.webhookDelivery.updateMany({
        where: { id: delivery.id },
        data: { attemptCount: attempt - 1, status: 'failed', nextAttemptAt: new Date() },
      });
      await ctx.app.get(WebhookDispatchService).deliver(orgA.organizationId, delivery.id);
    }

    const spent = await ctx.db.webhookDelivery.findFirstOrThrow({ where: { id: delivery.id } });
    expect(spent.status).toBe('exhausted');
    expect(spent.attemptCount).toBe(8);
    // A finished delivery has nothing due, or the sweep would retry it forever.
    expect(spent.nextAttemptAt).toBeNull();
  });

  it('stops immediately on 410 Gone, and tells somebody', async () => {
    received = [];
    answer = () => ({ status: 410, body: 'gone' });
    const created = await endpoint(orgA.token, { eventTypes: ['lead.merged'] });
    await dispatch(orgA.organizationId, { name: 'lead.merged' });

    const row = await ctx.db.webhookEndpoint.findFirstOrThrow({ where: { id: created.id } });
    expect(row.isActive).toBe(false);
    expect(row.disabledAt).not.toBeNull();
    expect(row.disabledReason).toContain('410');

    // `FR-API-4` asks for a failure alert, and the notification type is not opt-out.
    const notification = await ctx.db.notification.findFirst({
      where: { organizationId: orgA.organizationId, type: 'webhook.disabled' },
      orderBy: { createdAt: 'desc' },
    });
    expect(notification).not.toBeNull();
    expect(notification?.body).toContain(row.url);
  });

  it('switches an endpoint off after fifteen failures in a row', async () => {
    received = [];
    answer = () => ({ status: 500 });
    const created = await endpoint(orgA.token, { eventTypes: ['task.rescheduled'] });

    for (let round = 1; round <= MAX_CONSECUTIVE_FAILURES; round += 1) {
      await dispatch(orgA.organizationId, { name: 'task.rescheduled' });
    }

    const row = await ctx.db.webhookEndpoint.findFirstOrThrow({ where: { id: created.id } });
    expect(row.failureCount).toBeGreaterThanOrEqual(MAX_CONSECUTIVE_FAILURES);
    expect(row.isActive).toBe(false);
    expect(row.disabledReason).toContain('failed in a row');
  });

  it('forgets the failures as soon as one delivery works', async () => {
    received = [];
    answer = () => ({ status: 500 });
    const created = await endpoint(orgA.token, { eventTypes: ['customer.updated'] });
    await dispatch(orgA.organizationId, { name: 'customer.updated' });
    expect(
      (await ctx.db.webhookEndpoint.findFirstOrThrow({ where: { id: created.id } })).failureCount,
    ).toBe(1);

    answer = () => ({ status: 204 });
    await dispatch(orgA.organizationId, { name: 'customer.updated' });
    const row = await ctx.db.webhookEndpoint.findFirstOrThrow({ where: { id: created.id } });
    // Reset, not decremented: the threshold is consecutive failures, so one success clears it.
    expect(row.failureCount).toBe(0);
    expect(row.lastSuccessAt).not.toBeNull();
  });

  it('re-enabling clears the count, so a fixed endpoint is not disabled again at once', async () => {
    received = [];
    answer = () => ({ status: 500 });
    const created = await endpoint(orgA.token, { eventTypes: ['quotation.rejected'] });
    await dispatch(orgA.organizationId, { name: 'quotation.rejected' });
    await setup('PATCH', `/webhooks/${created.id}`, {
      token: orgA.token,
      payload: { isActive: false },
    });
    await setup('PATCH', `/webhooks/${created.id}`, {
      token: orgA.token,
      payload: { isActive: true },
    });
    const row = await ctx.db.webhookEndpoint.findFirstOrThrow({ where: { id: created.id } });
    expect(row.failureCount).toBe(0);
    expect(row.isActive).toBe(true);
    expect(row.disabledAt).toBeNull();
    expect(row.disabledReason).toBeNull();
  });
});

describe('the delivery log, the sweep and the manual retry', () => {
  it('lists what was sent, with the attempts underneath', async () => {
    received = [];
    answer = () => ({ status: 200, body: 'ok' });
    const created = await endpoint(orgA.token, { eventTypes: ['deal.created'] });
    await dispatch(orgA.organizationId, { name: 'deal.created' });

    const page = await call<EnvelopeBody<Record<string, unknown>[]>>(ctx.app, {
      method: 'GET',
      url: `/api/v1/webhooks/deliveries?endpointId=${created.id}&limit=10`,
      token: orgA.token,
    });
    expect(page.statusCode).toBe(200);
    const rows = page.body.data;
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0]?.['status']).toBe('succeeded');
    expect((rows[0]?.['attempts'] as unknown[]).length).toBeGreaterThanOrEqual(1);
    // The envelope lifts `items` only when `pagination` is present.
    expect((page.body.meta as { pagination?: { total?: number } }).pagination?.total).toBeGreaterThanOrEqual(1);
  });

  it('queues a delivery whose next attempt is due, and only that one', async () => {
    received = [];
    answer = () => ({ status: 500 });
    await endpoint(orgA.token, { eventTypes: ['payment.refunded'] });
    const eventId = newId();
    await dispatch(orgA.organizationId, { name: 'payment.refunded', eventId });
    const delivery = await ctx.db.webhookDelivery.findFirstOrThrow({ where: { eventId } });

    // Not due yet: the sweep must leave it alone.
    const before = await ctx.app.get(WebhookDispatchService).sweepDue(new Date(Date.now() - 60_000));
    expect(before).toBe(0);

    await ctx.db.webhookDelivery.updateMany({
      where: { id: delivery.id },
      data: { nextAttemptAt: new Date(Date.now() - 1_000) },
    });
    const queued = await ctx.app.get(WebhookDispatchService).sweepDue();
    expect(queued).toBeGreaterThanOrEqual(1);
  });

  it('sends it again when somebody presses retry', async () => {
    received = [];
    answer = () => ({ status: 500 });
    await endpoint(orgA.token, { eventTypes: ['lead.status_changed'] });
    const eventId = newId();
    await dispatch(orgA.organizationId, { name: 'lead.status_changed', eventId });
    const delivery = await ctx.db.webhookDelivery.findFirstOrThrow({ where: { eventId } });

    answer = () => ({ status: 200, body: 'ok now' });
    const retried = await api('POST', `/webhooks/deliveries/${delivery.id}/retry`, {
      token: orgA.token,
    });
    expect(retried.statusCode).toBe(200);

    await ctx.app.get(WebhookDispatchService).deliver(orgA.organizationId, delivery.id);
    const after = await ctx.db.webhookDelivery.findFirstOrThrow({ where: { id: delivery.id } });
    expect(after.status).toBe('succeeded');
    // The attempt count keeps rising: the log is what happened, not what somebody wishes had.
    expect(after.attemptCount).toBeGreaterThanOrEqual(2);
  });

  it('refuses to retry into an endpoint that is switched off', async () => {
    received = [];
    answer = () => ({ status: 500 });
    const created = await endpoint(orgA.token, { eventTypes: ['lead.score_changed'] });
    const eventId = newId();
    await dispatch(orgA.organizationId, { name: 'lead.score_changed', eventId });
    const delivery = await ctx.db.webhookDelivery.findFirstOrThrow({ where: { eventId } });
    await setup('PATCH', `/webhooks/${created.id}`, {
      token: orgA.token,
      payload: { isActive: false },
    });

    const response = await api('POST', `/webhooks/deliveries/${delivery.id}/retry`, {
      token: orgA.token,
    });
    expect(response.statusCode).toBe(422);
  });

  it('does not deliver a queued event to an endpoint switched off in the meantime', async () => {
    received = [];
    answer = () => ({ status: 200 });
    const created = await endpoint(orgA.token, { eventTypes: ['lead.converted'] });
    const eventId = newId();
    const service = ctx.app.get(WebhookDispatchService);
    await service.fanOut({ organizationId: orgA.organizationId, eventId, eventName: 'lead.converted', payload: {} });
    await setup('PATCH', `/webhooks/${created.id}`, {
      token: orgA.token,
      payload: { isActive: false },
    });
    const delivery = await ctx.db.webhookDelivery.findFirstOrThrow({ where: { eventId } });
    await service.deliver(orgA.organizationId, delivery.id);

    expect(received).toHaveLength(0);
    const after = await ctx.db.webhookDelivery.findFirstOrThrow({ where: { id: delivery.id } });
    expect(after.status).toBe('exhausted');
    expect(after.lastError).toContain('switched off');
  });

  it('sends a test ping through the same path as a real event', async () => {
    received = [];
    answer = () => ({ status: 200, body: 'pong' });
    const created = await endpoint(orgA.token, { eventTypes: ['deal.won'] });
    const queued = await setup<{ deliveryId: string }>('POST', `/webhooks/${created.id}/test`, {
      token: orgA.token,
    });
    await ctx.app.get(WebhookDispatchService).deliver(orgA.organizationId, queued.deliveryId);

    expect(received).toHaveLength(1);
    expect(received[0]?.headers['x-leados-event']).toBe(WEBHOOK_TEST_EVENT);
    const header = `t=${received[0]?.headers['x-leados-timestamp']},${received[0]?.headers['x-leados-signature']}`;
    expect(verifySignature(created.secret, header, received[0]?.body ?? '').ok).toBe(true);

    const delivery = await ctx.db.webhookDelivery.findFirstOrThrow({ where: { id: queued.deliveryId } });
    expect(delivery.status).toBe('succeeded');
    expect(delivery.eventType).toBe(WEBHOOK_TEST_EVENT);
  });

  it('deletes an endpoint and its log together', async () => {
    received = [];
    answer = () => ({ status: 200 });
    const created = await endpoint(orgA.token, { eventTypes: ['task.created'] });
    await dispatch(orgA.organizationId, { name: 'task.created' });
    expect(await ctx.db.webhookDelivery.count({ where: { endpointId: created.id } })).toBeGreaterThan(0);

    await setup('DELETE', `/webhooks/${created.id}`, { token: orgA.token });
    expect(await ctx.db.webhookEndpoint.count({ where: { id: created.id } })).toBe(0);
    // The log is a record of what we sent *that* endpoint; keeping it would leave rows nothing can
    // be read against.
    expect(await ctx.db.webhookDelivery.count({ where: { endpointId: created.id } })).toBe(0);
  });

  it('writes the delivery before the attempt, so a crash mid-send loses nothing', async () => {
    // The fan-out's row exists with nothing attempted — which is what a worker killed between
    // "created" and "posted" leaves behind, and what the sweep then finishes.
    received = [];
    answer = () => ({ status: 200, body: 'late but fine' });
    await endpoint(orgA.token, { eventTypes: ['quotation.accepted'] });
    const eventId = newId();
    const service = ctx.app.get(WebhookDispatchService);
    await service.fanOut({ organizationId: orgA.organizationId, eventId, eventName: 'quotation.accepted', payload: {} });

    const pending = await ctx.db.webhookDelivery.findFirstOrThrow({ where: { eventId } });
    expect(pending.status).toBe('pending');
    expect(pending.attemptCount).toBe(0);
    expect(pending.payload).toBeTruthy();

    await service.deliver(orgA.organizationId, pending.id);
    const finished = await ctx.db.webhookDelivery.findFirstOrThrow({ where: { id: pending.id } });
    expect(finished.status).toBe('succeeded');
  });

  it('is driven by a context the service entered itself, not by the caller’s', async () => {
    // A sanity check on the thing the SLA suite got wrong: the dispatch service enters each
    // tenant's context itself, so it works from a platform-scoped sweep with no context at all.
    received = [];
    answer = () => ({ status: 200 });
    await endpoint(orgA.token, { eventTypes: ['call.logged'] });
    const eventId = newId();
    await tenantContext.run(systemPrincipal(orgB.organizationId, newId()), async () => {
      await ctx.app
        .get(WebhookDispatchService)
        .fanOut({ organizationId: orgA.organizationId, eventId, eventName: 'call.logged', payload: {} });
    });
    const rows = await ctx.db.webhookDelivery.findMany({ where: { eventId } });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.organizationId).toBe(orgA.organizationId);
  });
});
