import { createHmac } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newToken } from '@leados/shared';
import { WhatsAppIngestMessageProcessor } from '../src/modules/whatsapp/whatsapp.processor.js';
import {
  WhatsAppIngestStatusProcessor,
  WhatsAppSyncTemplatesProcessor,
} from '../src/modules/whatsapp/whatsapp-status.processor.js';
import {
  WhatsAppSendMessageProcessor,
  WhatsAppSendRetryProcessor,
} from '../src/modules/whatsapp/whatsapp-send.processor.js';
import { WhatsAppRateLimiter } from '../src/modules/whatsapp/whatsapp-rate-limiter.service.js';
import { RedisService } from '../src/infra/redis/redis.service.js';
import { bootTestApp, call, cleanupUsers, type EnvelopeBody, type TestApp } from './app-harness.js';

/**
 * THE WHATSAPP SENDING SUITE (Phase 5 step 2: `FR-WA-1`, `FR-WA-4`, `FR-WA-5`, `FR-WA-9`).
 *
 * Meta is a real in-process HTTP server again, so the send, the template submission, the template
 * list and every error shape travel over real sockets. The two processors are driven directly
 * rather than through a worker, which is what makes "the same job twice" and "the receipt that
 * overtook another" things a test can actually do.
 */

const SUFFIX = newToken(4)
  .toLowerCase()
  .replace(/[^a-z0-9]/g, '');
const EMAIL_MARKER = `e2ews${SUFFIX}`;
const PASSWORD = 'a quiet november harbour';
const APP_SECRET = 'd41d8cd98f00b204e9800998ecf8427e';
const ACCESS_TOKEN = 'EAAG-a-permanent-system-user-token-value-0001';
const WABA_ID = '102938475610777';
const PHONE_NUMBER_ID = `5566${Date.now().toString().slice(-6)}`;
const VERIFY_TOKEN = 'a phrase i chose';
const CONTACT = '919845077777';

let ctx: TestApp;
let graph: Server;
let previousGraphUrl: string | undefined;
let previousRate: string | undefined;

/** Every request Meta received, so a test can assert what was actually sent. */
const graphRequests: { method: string; path: string; body: string }[] = [];
/** What Meta answers a send with. A function so a test can make it fail. */
let sendAnswer: () => { status: number; body: string } = () => ({
  status: 200,
  body: JSON.stringify({
    messaging_product: 'whatsapp',
    contacts: [{ input: CONTACT, wa_id: CONTACT }],
    messages: [{ id: `wamid.out.${newToken(6)}` }],
  }),
});
/** What Meta answers a template list with. */
let templateList: () => { status: number; body: string } = () => ({
  status: 200,
  body: JSON.stringify({ data: [] }),
});

let orgA: { token: string; organizationId: string; userId: string };
let connectionId: string;
let accountId: string;
let conversationId: string;
let leadId: string;

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

const delivery = (value: Record<string, unknown>) => ({
  object: 'whatsapp_business_account',
  entry: [
    {
      id: WABA_ID,
      changes: [
        {
          field: 'messages',
          value: {
            messaging_product: 'whatsapp',
            metadata: { display_phone_number: '919845000777', phone_number_id: PHONE_NUMBER_ID },
            ...value,
          },
        },
      ],
    },
  ],
});

async function post(body: unknown) {
  const raw = JSON.stringify(body);
  return call<EnvelopeBody<{ accepted: number; duplicates: number; ignored: number }>>(ctx.app, {
    method: 'POST',
    url: `/api/v1/wh/whatsapp_cloud/${connectionId}`,
    payload: raw,
    headers: {
      'content-type': 'application/json',
      'x-hub-signature-256': `sha256=${createHmac('sha256', APP_SECRET).update(raw).digest('hex')}`,
    },
  });
}

/** Drives every unprocessed ledger row through whichever pipeline it belongs to. */
async function drain(): Promise<void> {
  const messages = ctx.app.get(WhatsAppIngestMessageProcessor);
  const statuses = ctx.app.get(WhatsAppIngestStatusProcessor);
  const rows = await ctx.db.providerEvent.findMany({
    where: { organizationId: orgA.organizationId, status: { in: ['received', 'failed'] } },
    select: { id: true, eventType: true },
  });
  for (const row of rows) {
    const handler = row.eventType.startsWith('status.')
      ? statuses.handle(orgA.organizationId, row.id)
      : messages.handle(orgA.organizationId, row.id);
    await handler.catch(() => {
      /* the row records the failure; the tests assert against the row */
    });
  }
}

/** Hands every queued message to Meta, the way the worker would. */
async function flushSends(): Promise<void> {
  const processor = ctx.app.get(WhatsAppSendMessageProcessor);
  const rows = await ctx.db.message.findMany({
    where: { organizationId: orgA.organizationId, status: 'queued', direction: 'outbound' },
    select: { id: true },
  });
  for (const row of rows) {
    await processor.handle(orgA.organizationId, row.id).catch(() => {
      /* a retryable failure throws on purpose, so BullMQ retries; the row carries the state */
    });
  }
}

const sentMessages = () => graphRequests.filter((request) => request.path.includes('/messages'));

beforeAll(async () => {
  graph = createServer((request: IncomingMessage, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const path = request.url ?? '';
      const body = Buffer.concat(chunks).toString('utf8');
      graphRequests.push({ method: request.method ?? 'GET', path, body });
      const answer =
        path.includes('/messages') && request.method === 'POST'
          ? sendAnswer()
          : path.includes('message_templates') && request.method === 'POST'
            ? { status: 200, body: JSON.stringify({ id: `meta-tpl-${newToken(4)}`, status: 'PENDING' }) }
            : path.includes('message_templates')
              ? templateList()
              : path.includes('phone_numbers')
                ? {
                    status: 200,
                    body: JSON.stringify({
                      data: [
                        {
                          id: PHONE_NUMBER_ID,
                          display_phone_number: '+91 98450 00777',
                          verified_name: 'Rao Interiors',
                          quality_rating: 'GREEN',
                          messaging_limit_tier: 'TIER_1K',
                        },
                      ],
                    }),
                  }
                : { status: 200, body: JSON.stringify({ id: WABA_ID, name: 'Rao Interiors' }) };
      response.writeHead(answer.status, { 'content-type': 'application/json' });
      response.end(answer.body);
    });
  });
  await new Promise<void>((resolve) => graph.listen(0, '127.0.0.1', resolve));
  previousGraphUrl = process.env['META_GRAPH_URL'];
  process.env['META_GRAPH_URL'] = `http://127.0.0.1:${(graph.address() as AddressInfo).port}/v21.0`;
  // High enough that no ordinary test trips it; the limiter has its own tests, which exhaust a
  // bucket deliberately rather than depending on how fast the suite happens to run.
  previousRate = process.env['WHATSAPP_SENDS_PER_SECOND'];
  process.env['WHATSAPP_SENDS_PER_SECOND'] = '100';

  ctx = await bootTestApp();
  await cleanupUsers(ctx.db, EMAIL_MARKER);
  const registered = await setup<{
    organization: { id: string };
    user: { id: string };
    tokens: { accessToken: string };
  }>('POST', '/auth/register', {
    payload: {
      email: `${EMAIL_MARKER}a@test.local`,
      password: PASSWORD,
      name: 'Sending Owner',
      organizationName: `WA send ${SUFFIX}`,
    },
  });
  orgA = {
    token: registered.tokens.accessToken,
    organizationId: registered.organization.id,
    userId: registered.user.id,
  };

  const connection = await setup<{ id: string }>('POST', '/integrations', {
    token: orgA.token,
    payload: {
      provider: 'whatsapp_cloud',
      name: 'WhatsApp',
      credentials: { appSecret: APP_SECRET, accessToken: ACCESS_TOKEN },
      settings: { wabaId: WABA_ID, verifyToken: VERIFY_TOKEN },
    },
  });
  connectionId = connection.id;
  const account = await setup<{ id: string }>('POST', '/whatsapp/accounts', {
    token: orgA.token,
    payload: { connectionId },
  });
  accountId = account.id;

  // One inbound message, which is what opens the 24-hour window and creates the conversation and
  // the lead the rest of the suite replies to.
  await post(
    delivery({
      contacts: [{ wa_id: CONTACT, profile: { name: 'Asha Rao' } }],
      messages: [
        {
          from: CONTACT,
          id: `wamid.in.${newToken(8)}`,
          timestamp: String(Math.floor(Date.now() / 1000)),
          type: 'text',
          text: { body: 'Is the 3BHK still available?' },
        },
      ],
    }),
  );
  await drain();
  const [conversation] = await setup<{ id: string; lead: { id: string } }[]>('GET', '/conversations', {
    token: orgA.token,
  });
  if (!conversation) throw new Error('the inbound message did not become a conversation');
  conversationId = conversation.id;
  leadId = conversation.lead.id;
}, 180_000);

afterAll(async () => {
  await cleanupUsers(ctx.db, EMAIL_MARKER);
  await ctx.close();
  await new Promise<void>((resolve) => graph.close(() => resolve()));
  if (previousGraphUrl === undefined) delete process.env['META_GRAPH_URL'];
  else process.env['META_GRAPH_URL'] = previousGraphUrl;
  if (previousRate === undefined) delete process.env['WHATSAPP_SENDS_PER_SECOND'];
  else process.env['WHATSAPP_SENDS_PER_SECOND'] = previousRate;
});

describe('sending a reply inside the window (`FR-WA-1`)', () => {
  it('queues the message, hands it to Meta, and keeps the agent’s name on it', async () => {
    const before = sentMessages().length;
    const response = await api<{ id: string; status: string; sender: { name: string } | null }>(
      'POST',
      `/conversations/${conversationId}/messages`,
      { token: orgA.token, payload: { kind: 'text', body: 'It is — would Saturday suit?' } },
    );
    expect(response.statusCode).toBe(202);
    // `queued`, not `sent`: nothing has reached Meta when the request answers, and a screen that
    // said otherwise would be lying about the one thing the agent is watching.
    expect(response.body.data.status).toBe('queued');
    expect(response.body.data.sender?.name).toBe('Sending Owner');
    const messageId = response.body.data.id;

    await flushSends();
    const row = await ctx.db.message.findFirstOrThrow({
      where: { id: messageId },
      select: { status: true, providerMessageId: true, sendAttempts: true, body: true, senderUserId: true },
    });
    // `accepted`, not `sent`: Meta taking it means it is queued at Meta.
    expect(row.status).toBe('accepted');
    expect(row.providerMessageId).toMatch(/^wamid\./);
    expect(row.sendAttempts).toBe(1);
    expect(row.senderUserId).toBe(orgA.userId);

    const sent = sentMessages();
    expect(sent.length).toBe(before + 1);
    const payload = JSON.parse(sent.at(-1)?.body ?? '{}') as {
      to: string;
      type: string;
      text: { body: string; preview_url: boolean };
    };
    // Meta wants the recipient without the plus, and a link preview nobody asked for is Meta
    // fetching somebody else's page on our behalf.
    expect(payload.to).toBe(CONTACT);
    expect(payload.type).toBe('text');
    expect(payload.text.body).toBe('It is — would Saturday suit?');
    expect(payload.text.preview_url).toBe(false);

    // Rule six: the reply is on the lead's timeline.
    const timeline = await setup<{ type: string; payload: Record<string, unknown> }[]>(
      'GET',
      `/leads/${leadId}/timeline`,
      { token: orgA.token },
    );
    const entry = timeline.find((row) => row.type === 'whatsapp.sent');
    expect(entry?.payload['preview']).toBe('It is — would Saturday suit?');
  });

  it('sends nothing twice, however many times the job is delivered', async () => {
    const message = await setup<{ id: string }>('POST', `/conversations/${conversationId}/messages`, {
      token: orgA.token,
      payload: { kind: 'text', body: 'The showroom is open until seven.' },
    });
    const before = sentMessages().length;
    const processor = ctx.app.get(WhatsAppSendMessageProcessor);
    await processor.handle(orgA.organizationId, message.id);
    await processor.handle(orgA.organizationId, message.id);
    await processor.handle(orgA.organizationId, message.id);
    // At-least-once delivery means this job arrives more than once; the status is the guard.
    expect(sentMessages().length).toBe(before + 1);
  });

  it('refuses an empty message, and a conversation in another workspace', async () => {
    const empty = await api('POST', `/conversations/${conversationId}/messages`, {
      token: orgA.token,
      payload: { kind: 'text', body: '   ' },
    });
    // A validation refusal is 400, never 422.
    expect(empty.statusCode).toBe(400);

    const other = await setup<{ tokens: { accessToken: string } }>('POST', '/auth/register', {
      payload: {
        email: `${EMAIL_MARKER}b@test.local`,
        password: PASSWORD,
        name: 'Somebody Else',
        organizationName: `WA other ${SUFFIX}`,
      },
    });
    const theirs = await api('POST', `/conversations/${conversationId}/messages`, {
      token: other.tokens.accessToken,
      payload: { kind: 'text', body: 'hello from another business' },
    });
    expect(theirs.statusCode).toBe(404);
  });
});

describe('status receipts (`FR-WA-4`)', () => {
  it('advances the message, keeps every receipt, and never goes backwards', async () => {
    const message = await setup<{ id: string }>('POST', `/conversations/${conversationId}/messages`, {
      token: orgA.token,
      payload: { kind: 'text', body: 'Saturday at eleven, then.' },
    });
    await flushSends();
    const accepted = await ctx.db.message.findFirstOrThrow({
      where: { id: message.id },
      select: { providerMessageId: true },
    });
    const wamid = accepted.providerMessageId as string;
    const at = Math.floor(Date.now() / 1000);

    const receipt = (status: string, offset: number, extra: Record<string, unknown> = {}) =>
      post(
        delivery({
          statuses: [
            {
              id: wamid,
              status,
              timestamp: String(at + offset),
              recipient_id: CONTACT,
              ...extra,
            },
          ],
        }),
      );

    const sent = await receipt('sent', 1, {
      conversation: { id: 'c1', origin: { type: 'service' } },
      pricing: { billable: true, category: 'service' },
    });
    // A receipt is an event of its own, so the door accepts it rather than ignoring it.
    expect(sent.body.data.accepted).toBe(1);
    await drain();
    await receipt('read', 3);
    await drain();
    // And now the one that arrives late, out of order, as Meta's really do.
    await receipt('delivered', 2);
    await drain();

    const row = await ctx.db.message.findFirstOrThrow({
      where: { id: message.id },
      select: {
        status: true,
        sentAt: true,
        deliveredAt: true,
        readAt: true,
        billable: true,
        conversationCategory: true,
      },
    });
    // The late `delivered` must not undo `read`, or the agent watches a message go backwards.
    expect(row.status).toBe('read');
    expect(row.sentAt).not.toBeNull();
    expect(row.readAt).not.toBeNull();
    // The history keeps it anyway, with Meta's own instant.
    expect(row.deliveredAt).not.toBeNull();
    expect(row.billable).toBe(true);
    expect(row.conversationCategory).toBe('service');

    const events = await ctx.db.messageStatusEvent.findMany({
      where: { messageId: message.id },
      orderBy: { occurredAt: 'asc' },
      select: { status: true, occurredAt: true },
    });
    expect(events.map((event) => event.status)).toEqual(['sent', 'delivered', 'read']);

    // A redelivered receipt is one row, not two: Meta repeats these.
    await receipt('read', 3);
    await drain();
    expect(await ctx.db.messageStatusEvent.count({ where: { messageId: message.id } })).toBe(3);

    const conversation = await setup<{ lastOutboundAt: string | null }>(
      'GET',
      `/conversations/${conversationId}`,
      { token: orgA.token },
    );
    // Written from the `sent` receipt rather than from the queueing, so "how fast did this business
    // answer" is not flattered by however long the queue was.
    expect(conversation.lastOutboundAt).not.toBeNull();
  });

  it('acknowledges a receipt for a message this workspace never sent', async () => {
    const response = await post(
      delivery({
        statuses: [
          { id: 'wamid.somebody-elses', status: 'delivered', timestamp: String(Math.floor(Date.now() / 1000)) },
        ],
      }),
    );
    expect(response.statusCode).toBe(200);
    await drain();
    // Recorded as dealt with rather than failed: a provider that gets an error learns to stop
    // delivering, and this is not an error.
    const row = await ctx.db.providerEvent.findFirstOrThrow({
      where: {
        organizationId: orgA.organizationId,
        externalEventId: 'wamid.somebody-elses:delivered',
      },
      select: { status: true },
    });
    expect(row.status).toBe('duplicate');
  });

  it('keeps one ledger row per message **and** status, not per message', async () => {
    // The trap this keying exists for: one message produces four receipts, and a ledger keyed on
    // the `wamid` alone would call the second one a duplicate of the first and drop it.
    const rows = await ctx.db.providerEvent.findMany({
      where: { organizationId: orgA.organizationId, eventType: { startsWith: 'status.' } },
      select: { externalEventId: true, eventType: true },
    });
    expect(rows.length).toBeGreaterThan(2);
    for (const row of rows) {
      expect(row.externalEventId).toMatch(/:(sent|delivered|read|failed)$/);
    }
    expect(new Set(rows.map((row) => row.externalEventId)).size).toBe(rows.length);
  });
});

describe('the window, closed (`FR-WA-1`)', () => {
  it('refuses free text and accepts a template, with a sentence that says what to do', async () => {
    // The window closed, which is a fact about time rather than something an endpoint can be asked
    // for: so the clock is moved rather than mocked.
    await ctx.db.conversation.update({
      where: { id: conversationId },
      data: { windowExpiresAt: new Date(Date.now() - 60_000) },
    });

    const refused = await api<{ message?: string }>(
      'POST',
      `/conversations/${conversationId}/messages`,
      { token: orgA.token, payload: { kind: 'text', body: 'Still there?' } },
    );
    expect(refused.statusCode).toBe(422);
    expect(refused.body.error?.code).toBe('BUSINESS_RULE_VIOLATION');
    // The refusal names the way through, because one that only says no is a dead end.
    expect(refused.body.error?.message).toMatch(/template/i);

    const conversation = await setup<{ windowIsOpen: boolean; windowSummary: string }>(
      'GET',
      `/conversations/${conversationId}`,
      { token: orgA.token },
    );
    expect(conversation.windowIsOpen).toBe(false);
    expect(conversation.windowSummary).toMatch(/closed|template/i);
  });
});

describe('templates (`FR-WA-5`)', () => {
  let templateId: string;

  it('refuses a template WhatsApp would refuse, before anybody waits a day', async () => {
    const refused = await api('POST', '/whatsapp/templates', {
      token: orgA.token,
      payload: {
        accountId,
        name: 'Order Update',
        language: 'english',
        category: 'utility',
        components: { body: 'Hello {{1}} and {{3}}' },
        variableMap: { '1': 'lead.fullName' },
      },
    });
    expect(refused.statusCode).toBe(400);
    const fields = (refused.body.error?.details as { field: string; code: string }[]) ?? [];
    expect(fields.map((entry) => entry.code)).toContain('INVALID_TEMPLATE_NAME');
    expect(fields.map((entry) => entry.code)).toContain('INVALID_LANGUAGE');
    expect(fields.map((entry) => entry.code)).toContain('VARIABLE_GAP');
  });

  it('refuses a variable map naming something nothing can fill', async () => {
    const refused = await api('POST', '/whatsapp/templates', {
      token: orgA.token,
      payload: {
        accountId,
        name: `greeting_${SUFFIX}`,
        language: 'en',
        category: 'utility',
        components: { body: 'Hello {{1}}' },
        variableMap: { '1': 'lead.favouriteColour' },
      },
    });
    expect(refused.statusCode).toBe(400);
    expect(JSON.stringify(refused.body.error?.details)).toMatch(/VARIABLE_SOURCE_UNKNOWN/);
  });

  it('saves a draft, submits it, and takes WhatsApp’s word for what happens next', async () => {
    const created = await setup<{ id: string; status: string; sendable: boolean; blockedReason: string | null }>(
      'POST',
      '/whatsapp/templates',
      {
        token: orgA.token,
        payload: {
          accountId,
          name: `visit_${SUFFIX}`,
          language: 'en',
          category: 'utility',
          components: {
            header: 'Rao Interiors',
            body: 'Hello {{1}}, your site visit is confirmed for {{2}}.',
            footer: 'Reply STOP to opt out',
          },
          variableMap: { '1': 'lead.firstName', '2': 'literal:Saturday at 11am' },
        },
      },
    );
    templateId = created.id;
    expect(created.status).toBe('draft');
    expect(created.sendable).toBe(false);
    // The screen greys the button and says why in the same breath.
    expect(created.blockedReason).toMatch(/not been submitted/i);

    const submitted = await setup<{ status: string; providerTemplateId: string | null }>(
      'POST',
      `/whatsapp/templates/${templateId}/submit`,
      { token: orgA.token },
    );
    expect(submitted.status).toBe('pending');
    expect(submitted.providerTemplateId).toMatch(/^meta-tpl-/);

    const submission = graphRequests.filter(
      (request) => request.method === 'POST' && request.path.includes('message_templates'),
    );
    const body = JSON.parse(submission.at(-1)?.body ?? '{}') as {
      category: string;
      components: { type: string; text?: string; example?: { body_text: string[][] } }[];
    };
    expect(body.category).toBe('UTILITY');
    expect(body.components.map((component) => component.type)).toEqual(['HEADER', 'BODY', 'FOOTER']);
    // Meta requires an example per variable, and it must not be a real customer's data: a reviewer
    // is reading the wording, not the record.
    expect(body.components[1]?.example?.body_text[0]).toEqual(['firstName', 'Saturday at 11am']);
    expect(JSON.stringify(body)).not.toContain('Asha');
  });

  it('cannot be edited once WhatsApp has it, and says so', async () => {
    const refused = await api('PATCH', `/whatsapp/templates/${templateId}`, {
      token: orgA.token,
      payload: { components: { body: 'Hello {{1}}, we have moved the visit to {{2}}.' } },
    });
    expect(refused.statusCode).toBe(422);
    expect(refused.body.error?.message).toMatch(/cannot be edited/i);
  });

  it('refuses to send an unapproved template, with WhatsApp’s standing in the sentence', async () => {
    const refused = await api('POST', `/conversations/${conversationId}/messages`, {
      token: orgA.token,
      payload: { kind: 'template', templateId },
    });
    expect(refused.statusCode).toBe(422);
    expect(refused.body.error?.message).toMatch(/still reviewing/i);
  });

  it('takes the approval from Meta rather than from its own last word', async () => {
    const template = await ctx.db.whatsAppTemplate.findFirstOrThrow({
      where: { id: templateId },
      select: { providerTemplateId: true, name: true, language: true },
    });
    templateList = () => ({
      status: 200,
      body: JSON.stringify({
        data: [
          {
            id: template.providerTemplateId,
            name: template.name,
            language: template.language,
            status: 'APPROVED',
            category: 'UTILITY',
            rejected_reason: 'NONE',
          },
          // One Meta holds that this workspace has never seen: a template they can send is one the
          // picker should offer.
          {
            id: 'meta-tpl-adopted',
            name: `adopted_${SUFFIX}`,
            language: 'en',
            status: 'APPROVED',
            category: 'MARKETING',
            rejected_reason: 'NONE',
          },
        ],
      }),
    });

    const result = await setup<{ checked: number; updated: number; adopted: number }>(
      'POST',
      '/whatsapp/templates/sync',
      { token: orgA.token, payload: { accountId } },
    );
    expect(result.checked).toBe(2);
    expect(result.updated).toBe(1);
    expect(result.adopted).toBe(1);

    const after = await setup<{ status: string; sendable: boolean; blockedReason: string | null }>(
      'GET',
      `/whatsapp/templates/${templateId}`,
      { token: orgA.token },
    );
    expect(after.status).toBe('approved');
    expect(after.sendable).toBe(true);
    expect(after.blockedReason).toBeNull();
  });

  it('previews the sentence this person will actually read', async () => {
    const preview = await setup<{ text: string; values: string[]; missing: string[] }>(
      'GET',
      `/whatsapp/templates/${templateId}/preview?leadId=${leadId}`,
      { token: orgA.token },
    );
    // The lead's own first name, resolved — not `{{1}}`, which proves nothing.
    expect(preview.text).toContain('Asha');
    expect(preview.text).toContain('Saturday at 11am');
    expect(preview.values).toEqual(['Asha', 'Saturday at 11am']);
    expect(preview.missing).toEqual([]);
  });

  it('sends an approved template outside the window, with its parameters in Meta’s order', async () => {
    const before = sentMessages().length;
    const response = await api<{ id: string; type: string; body: string }>(
      'POST',
      `/conversations/${conversationId}/messages`,
      { token: orgA.token, payload: { kind: 'template', templateId } },
    );
    expect(response.statusCode).toBe(202);
    expect(response.body.data.type).toBe('template');
    // The thread shows the words, not the template's name: "visit_a1b2" is not a message.
    expect(response.body.data.body).toContain('Asha');

    await flushSends();
    expect(sentMessages().length).toBe(before + 1);
    const payload = JSON.parse(sentMessages().at(-1)?.body ?? '{}') as {
      type: string;
      template: { name: string; language: { code: string }; components: { parameters: { text: string }[] }[] };
    };
    expect(payload.type).toBe('template');
    expect(payload.template.name).toBe(`visit_${SUFFIX}`);
    expect(payload.template.language.code).toBe('en');
    expect(payload.template.components[0]?.parameters.map((parameter) => parameter.text)).toEqual([
      'Asha',
      'Saturday at 11am',
    ]);

    const row = await ctx.db.message.findFirstOrThrow({
      where: { id: response.body.data.id },
      select: { templateId: true, type: true, status: true },
    });
    expect(row.templateId).toBe(templateId);
    expect(row.status).toBe('accepted');

    const timeline = await setup<{ type: string }[]>('GET', `/leads/${leadId}/timeline`, {
      token: orgA.token,
    });
    // Its own type, not `whatsapp.sent`: a template is a different thing from a reply somebody
    // typed, and a business owner reading the history can tell them apart.
    expect(timeline.some((entry) => entry.type === 'whatsapp.template_sent')).toBe(true);
  });

  it('refuses a marketing template to somebody who never agreed to marketing', async () => {
    const adopted = await ctx.db.whatsAppTemplate.findFirstOrThrow({
      where: { organizationId: orgA.organizationId, name: `adopted_${SUFFIX}` },
      select: { id: true },
    });
    // The adopted one is `marketing`, and this lead has given no WhatsApp consent.
    const refused = await api('POST', `/conversations/${conversationId}/messages`, {
      token: orgA.token,
      payload: { kind: 'template', templateId: adopted.id },
    });
    expect(refused.statusCode).toBe(422);
    expect(refused.body.error?.message).toMatch(/marketing/i);
    // And the refusal says what can still reach them, rather than only what cannot.
    expect(refused.body.error?.message).toMatch(/utility|24-hour/i);

    await ctx.db.lead.update({ where: { id: leadId }, data: { consentWhatsapp: true } });
    const allowed = await api('POST', `/conversations/${conversationId}/messages`, {
      token: orgA.token,
      payload: { kind: 'template', templateId: adopted.id, variables: {} },
    });
    expect(allowed.statusCode).toBe(202);
  });

  it('refuses a template whose variable nothing can fill, naming the variable', async () => {
    const created = await setup<{ id: string; providerTemplateId: string | null }>(
      'POST',
      '/whatsapp/templates',
      {
        token: orgA.token,
        payload: {
          accountId,
          name: `needs_city_${SUFFIX}`,
          language: 'en',
          category: 'utility',
          components: { body: 'We will visit you in {{1}} on Tuesday.' },
          variableMap: { '1': 'lead.city' },
        },
      },
    );
    await setup('POST', `/whatsapp/templates/${created.id}/submit`, { token: orgA.token });
    await ctx.db.whatsAppTemplate.update({
      where: { id: created.id },
      data: { status: 'approved' },
    });

    // This lead has no city, so nothing can fill `{{1}}`.
    const refused = await api('POST', `/conversations/${conversationId}/messages`, {
      token: orgA.token,
      payload: { kind: 'template', templateId: created.id },
    });
    expect(refused.statusCode).toBe(400);
    const details = JSON.stringify(refused.body.error?.details);
    expect(details).toMatch(/VARIABLE_MISSING/);
    expect(details).toMatch(/\{\{1\}\}/);

    // And the agent can type the value the record does not have, which is the difference between a
    // template that can be sent and one that is stuck.
    const typed = await api('POST', `/conversations/${conversationId}/messages`, {
      token: orgA.token,
      payload: { kind: 'template', templateId: created.id, variables: { '1': 'Pune' } },
    });
    expect(typed.statusCode).toBe(202);
    await flushSends();
    const payload = JSON.parse(sentMessages().at(-1)?.body ?? '{}') as {
      template: { components: { parameters: { text: string }[] }[] };
    };
    expect(payload.template.components[0]?.parameters[0]?.text).toBe('Pune');
  });

  it('shows another workspace nothing of these templates', async () => {
    const other = await setup<{ tokens: { accessToken: string } }>('POST', '/auth/register', {
      payload: {
        email: `${EMAIL_MARKER}c@test.local`,
        password: PASSWORD,
        name: 'Third Owner',
        organizationName: `WA third ${SUFFIX}`,
      },
    });
    const theirs = await setup<{ id: string }[]>('GET', '/whatsapp/templates', {
      token: other.tokens.accessToken,
    });
    expect(theirs.length).toBe(0);
    const read = await api('GET', `/whatsapp/templates/${templateId}`, {
      token: other.tokens.accessToken,
    });
    expect(read.statusCode).toBe(404);
  });
});

describe('a failure nobody can miss (`FR-WA-9`)', () => {
  it('records Meta’s own reason, tells the sender, and can be tried again', async () => {
    const message = await setup<{ id: string }>('POST', `/conversations/${conversationId}/messages`, {
      token: orgA.token,
      payload: { kind: 'template', templateId: (await approvedTemplate()).id },
    });

    const previous = sendAnswer;
    sendAnswer = () => ({
      status: 400,
      body: JSON.stringify({
        error: {
          message: 'Template name does not exist in the translation',
          code: 132001,
          error_data: { details: 'template name (visit) does not exist in en' },
        },
      }),
    });
    try {
      await flushSends();
    } finally {
      sendAnswer = previous;
    }

    const failed = await ctx.db.message.findFirstOrThrow({
      where: { id: message.id },
      select: { status: true, errorCode: true, errorMessage: true, failedAt: true, sendAttempts: true },
    });
    expect(failed.status).toBe('failed');
    expect(failed.errorCode).toBe('132001');
    // Meta's own words. A paraphrase would lose the one sentence that says what is wrong.
    expect(failed.errorMessage).toMatch(/does not exist/i);
    expect(failed.failedAt).not.toBeNull();

    // On the lead's timeline…
    const timeline = await setup<{ type: string; payload: Record<string, unknown> }[]>(
      'GET',
      `/leads/${leadId}/timeline`,
      { token: orgA.token },
    );
    const entry = timeline.find((row) => row.type === 'whatsapp.failed');
    expect(entry).toBeDefined();
    expect(String(entry?.payload['reason'])).toMatch(/does not exist/i);

    // …and in front of the person who sent it, quiet hours or not.
    const notifications = await setup<{ type: string; title: string; body: string | null }[]>(
      'GET',
      '/notifications',
      { token: orgA.token },
    );
    const notice = notifications.find((row) => row.type === 'whatsapp.send_failed');
    expect(notice?.title).toMatch(/did not send/i);
    expect(notice?.body).toMatch(/does not exist/i);

    // Retried on the same row: a second row would read as the customer being messaged twice.
    const retried = await api<{ status: string }>(
      'POST',
      `/conversations/${conversationId}/messages/${message.id}/retry`,
      { token: orgA.token },
    );
    expect(retried.statusCode).toBe(202);
    expect(retried.body.data.status).toBe('queued');
    await flushSends();
    const after = await ctx.db.message.findFirstOrThrow({
      where: { id: message.id },
      select: { status: true, errorMessage: true, sendAttempts: true },
    });
    expect(after.status).toBe('accepted');
    expect(after.errorMessage).toBeNull();
    // Both attempts counted, which is what makes a retry visible rather than a quiet second try.
    expect(after.sendAttempts).toBe(2);
    expect(
      await ctx.db.message.count({
        where: { organizationId: orgA.organizationId, conversationId, status: 'failed' },
      }),
    ).toBe(0);
  });

  it('leaves a message queued when Meta is merely busy, and counts the attempt', async () => {
    const message = await setup<{ id: string }>('POST', `/conversations/${conversationId}/messages`, {
      token: orgA.token,
      payload: { kind: 'template', templateId: (await approvedTemplate()).id },
    });
    const previous = sendAnswer;
    sendAnswer = () => ({
      status: 429,
      body: JSON.stringify({ error: { message: 'Too many requests', code: 130429 } }),
    });
    try {
      await flushSends();
    } finally {
      sendAnswer = previous;
    }
    const row = await ctx.db.message.findFirstOrThrow({
      where: { id: message.id },
      select: { status: true, sendAttempts: true, errorCode: true },
    });
    // Still on its way: a 429 is Meta asking us to come back, not a message that will never send.
    expect(row.status).toBe('queued');
    expect(row.sendAttempts).toBe(1);
    expect(row.errorCode).toBe('130429');

    // And the sweep is what picks it up if the worker died in the meantime.
    await ctx.db.message.update({
      where: { id_createdAt: { id: message.id, createdAt: (await createdAtOf(message.id)) } },
      data: {},
    });
    await flushSends();
    expect(
      (await ctx.db.message.findFirstOrThrow({ where: { id: message.id }, select: { status: true } }))
        .status,
    ).toBe('accepted');
  });

  it('refuses to retry a message that is not failed, and one that arrived', async () => {
    const [inbound] = await ctx.db.message.findMany({
      where: { organizationId: orgA.organizationId, direction: 'inbound' },
      select: { id: true },
      take: 1,
    });
    const refused = await api('POST', `/conversations/${conversationId}/messages/${inbound?.id}/retry`, {
      token: orgA.token,
    });
    expect(refused.statusCode).toBe(422);
    expect(refused.body.error?.message).toMatch(/they sent you/i);
  });
});

describe('per-number rate limiting (`FR-WA-9`)', () => {
  it('refuses a send over the limit and recovers in the next second', async () => {
    const limiter = ctx.app.get(WhatsAppRateLimiter);
    const number = `limiter-${newToken(6)}`;
    let refusedAt = 0;
    for (let attempt = 1; attempt <= 120; attempt += 1) {
      const allowance = await limiter.take(number);
      if (!allowance.allowed) {
        refusedAt = attempt;
        // Just enough to reach the next window, never a minute: a message somebody typed is
        // waiting.
        expect(allowance.retryInMs).toBeGreaterThan(0);
        expect(allowance.retryInMs).toBeLessThan(1_100);
        break;
      }
    }
    expect(refusedAt).toBe(101);
    // A different number is a different bucket: Meta limits per number, not per app.
    expect((await limiter.take(`other-${newToken(6)}`)).allowed).toBe(true);
  });

  it('re-queues rather than failing, and does not count the attempt', async () => {
    const message = await setup<{ id: string }>('POST', `/conversations/${conversationId}/messages`, {
      token: orgA.token,
      payload: { kind: 'template', templateId: (await approvedTemplate()).id },
    });
    const limiter = ctx.app.get(WhatsAppRateLimiter);
    // Exhaust this number's bucket deliberately, rather than depending on how fast the suite runs.
    for (let attempt = 0; attempt < 101; attempt += 1) await limiter.take(PHONE_NUMBER_ID);

    const before = sentMessages().length;
    await ctx.app.get(WhatsAppSendMessageProcessor).handle(orgA.organizationId, message.id);
    expect(sentMessages().length).toBe(before);
    const held = await ctx.db.message.findFirstOrThrow({
      where: { id: message.id },
      select: { status: true, sendAttempts: true },
    });
    expect(held.status).toBe('queued');
    // Nobody was handed the message, so nothing was attempted.
    expect(held.sendAttempts).toBe(0);

    // The next window, reached by clearing the counter rather than by sleeping through it.
    await ctx.app.get(RedisService).del(`wa:send-rate:${PHONE_NUMBER_ID}:${Math.floor(Date.now() / 1000)}`);
    await ctx.app.get(WhatsAppSendMessageProcessor).handle(orgA.organizationId, message.id);
    expect(
      (await ctx.db.message.findFirstOrThrow({ where: { id: message.id }, select: { status: true } }))
        .status,
    ).toBe('accepted');
  });
});

describe('the sweep that re-queues an unsent message (`FR-WA-9`)', () => {
  it('finds a message a worker never handed to Meta', async () => {
    const message = await setup<{ id: string }>('POST', `/conversations/${conversationId}/messages`, {
      token: orgA.token,
      payload: { kind: 'template', templateId: (await approvedTemplate()).id },
    });
    // Older than the two-minute grace period, which is what the sweep selects on. Within the same
    // month, because `created_at` is the partition key.
    await ctx.db.$executeRawUnsafe(
      `UPDATE messages SET created_at = now() - interval '10 minutes' WHERE id = $1::uuid`,
      message.id,
    );

    const before = sentMessages().length;
    await ctx.app.get(WhatsAppSendRetryProcessor).process();
    // The sweep queues rather than sends, so nothing has reached Meta yet.
    expect(sentMessages().length).toBe(before);
    await flushSends();
    expect(sentMessages().length).toBe(before + 1);
  });
});

describe('the scheduled template sync', () => {
  it('reconciles every connected account without ending the tick on one failure', async () => {
    templateList = () => ({ status: 500, body: JSON.stringify({ error: { message: 'Meta is down' } }) });
    try {
      // One workspace's broken account must not throw out of the sweep.
      await expect(ctx.app.get(WhatsAppSyncTemplatesProcessor).process()).resolves.toBeUndefined();
    } finally {
      templateList = () => ({ status: 200, body: JSON.stringify({ data: [] }) });
    }
  });
});

/** The approved template this workspace has, for the tests that only need one. */
async function approvedTemplate(): Promise<{ id: string }> {
  return ctx.db.whatsAppTemplate.findFirstOrThrow({
    where: { organizationId: orgA.organizationId, status: 'approved', name: { startsWith: 'visit_' } },
    select: { id: true },
  });
}

async function createdAtOf(messageId: string): Promise<Date> {
  const row = await ctx.db.message.findFirstOrThrow({
    where: { id: messageId },
    select: { createdAt: true },
  });
  return row.createdAt;
}
