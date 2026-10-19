import { createHmac } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newToken, windowExpiryFrom } from '@leados/shared';
import { WhatsAppIngestMessageProcessor } from '../src/modules/whatsapp/whatsapp.processor.js';
import { bootTestApp, call, cleanupUsers, type EnvelopeBody, type TestApp } from './app-harness.js';

/**
 * THE WHATSAPP SUITE (Phase 5 step 1, and `FR-WA-6`: "Meta's duplicate/retried webhook deliveries
 * produce exactly one message, one activity, one automation trigger").
 *
 * Nothing is mocked, including Meta: a real HTTP server runs in-process as the Graph API, and
 * `META_GRAPH_URL` points at it — so the WABA lookup, the numbers discovery and the signature check
 * all happen over real sockets. The ingestion job is driven through `WhatsAppIngestMessageProcessor`
 * directly rather than by waiting for a worker, which is also what makes "the same job delivered
 * twice" a thing a test can actually do.
 */

const SUFFIX = newToken(4)
  .toLowerCase()
  .replace(/[^a-z0-9]/g, '');
const EMAIL_MARKER = `e2ewa${SUFFIX}`;
const PASSWORD = 'a quiet november harbour';
const APP_SECRET = 'd41d8cd98f00b204e9800998ecf8427e';
const ACCESS_TOKEN = 'EAAG-a-permanent-system-user-token-value-0001';
const WABA_ID = '102938475610293';
const PHONE_NUMBER_ID = '55667788';
const VERIFY_TOKEN = 'a phrase i chose';

let ctx: TestApp;
let graph: Server;
let previousGraphUrl: string | undefined;
const graphRequests: { path: string; authorization: string | undefined }[] = [];
/** What the fake Graph answers next. A function so a test can change its mind mid-suite. */
let graphAnswer: (request: IncomingMessage) => { status: number; body: string } = (request) =>
  (request.url ?? '').includes('phone_numbers')
    ? {
        status: 200,
        body: JSON.stringify({
          data: [
            {
              id: PHONE_NUMBER_ID,
              display_phone_number: '+91 98450 00000',
              verified_name: 'Rao Interiors',
              quality_rating: 'GREEN',
              messaging_limit_tier: 'TIER_1K',
            },
          ],
        }),
      }
    : { status: 200, body: JSON.stringify({ id: WABA_ID, name: 'Rao Interiors' }) };

let orgA: { token: string; organizationId: string; userId: string };
let connectionId: string;
let numberId: string;

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

/** One `messages` delivery, as Meta sends it. */
function delivery(messages: unknown[], over: Record<string, unknown> = {}) {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: WABA_ID,
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '919845000000', phone_number_id: PHONE_NUMBER_ID },
              contacts: [{ wa_id: '919845012345', profile: { name: 'Asha Rao' } }],
              messages,
              ...over,
            },
          },
        ],
      },
    ],
  };
}

const textMessage = (over: Record<string, unknown> = {}) => ({
  from: '919845012345',
  id: `wamid.${newToken(8)}`,
  timestamp: String(Math.floor(Date.now() / 1000)),
  type: 'text',
  text: { body: 'Is the 3BHK still available?' },
  ...over,
});

/** A signed delivery, over the exact bytes it sends. */
async function post(
  body: unknown,
  options: { secret?: string; signature?: string; connectionId?: string } = {},
) {
  const raw = JSON.stringify(body);
  const signature =
    options.signature ??
    (options.secret === undefined
      ? undefined
      : `sha256=${createHmac('sha256', options.secret).update(raw).digest('hex')}`);
  return call<EnvelopeBody<{ accepted: number; duplicates: number; ignored: number; message: string }>>(
    ctx.app,
    {
      method: 'POST',
      url: `/api/v1/wh/whatsapp_cloud/${options.connectionId ?? connectionId}`,
      payload: raw,
      headers: {
        'content-type': 'application/json',
        ...(signature === undefined ? {} : { 'x-hub-signature-256': signature }),
      },
    },
  );
}

/** Drives the queued ingestion for every event that has not been processed. */
async function drain(): Promise<void> {
  const processor = ctx.app.get(WhatsAppIngestMessageProcessor);
  const rows = await ctx.db.providerEvent.findMany({
    where: { organizationId: orgA.organizationId, status: { in: ['received', 'failed'] } },
    select: { id: true },
  });
  for (const row of rows) {
    await processor.handle(orgA.organizationId, row.id).catch(() => {
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
  previousGraphUrl = process.env['META_GRAPH_URL'];
  process.env['META_GRAPH_URL'] = `http://127.0.0.1:${(graph.address() as AddressInfo).port}/v21.0`;

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
      name: 'Inbox Owner',
      organizationName: `WA ${SUFFIX}`,
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
}, 120_000);

afterAll(async () => {
  await cleanupUsers(ctx.db, EMAIL_MARKER);
  await ctx.close();
  await new Promise<void>((resolve) => graph.close(() => resolve()));
  if (previousGraphUrl === undefined) delete process.env['META_GRAPH_URL'];
  else process.env['META_GRAPH_URL'] = previousGraphUrl;
});

describe('connecting a WhatsApp Business Account', () => {
  it('discovers the numbers rather than asking somebody to type an id', async () => {
    const before = graphRequests.length;
    const account = await setup<{
      wabaId: string;
      businessName: string | null;
      status: string;
      numbers: {
        id: string;
        phoneNumberId: string;
        displayPhoneE164: string;
        qualityRating: string | null;
        messagingLimitTier: string | null;
        isActive: boolean;
      }[];
    }>('POST', '/whatsapp/accounts', { token: orgA.token, payload: { connectionId } });

    expect(account.wabaId).toBe(WABA_ID);
    expect(account.businessName).toBe('Rao Interiors');
    expect(account.status).toBe('connected');
    // Two requests: the WABA, then its numbers. Both with the access token, not the app secret.
    expect(graphRequests.length).toBe(before + 2);
    expect(graphRequests.every((entry) => entry.authorization === `Bearer ${ACCESS_TOKEN}`)).toBe(true);

    expect(account.numbers.length).toBe(1);
    const [number] = account.numbers;
    expect(number?.phoneNumberId).toBe(PHONE_NUMBER_ID);
    // Meta sends it with spaces; the column's CHECK is E.164, so the adapter settles the shape.
    expect(number?.displayPhoneE164).toBe('+919845000000');
    // The two things `FR-WA-2` means by connection health, refreshed by the same call.
    expect(number?.qualityRating).toBe('GREEN');
    expect(number?.messagingLimitTier).toBe('TIER_1K');
    expect(number?.isActive).toBe(true);
    numberId = number!.id;
  });

  it('is idempotent, which is how a workspace refreshes the list', async () => {
    graphAnswer = (request) =>
      (request.url ?? '').includes('phone_numbers')
        ? {
            status: 200,
            body: JSON.stringify({
              data: [
                { id: PHONE_NUMBER_ID, display_phone_number: '+91 98450 00000', quality_rating: 'YELLOW' },
                { id: '99887766', display_phone_number: '+91 98450 00001', verified_name: 'Rao Sales' },
              ],
            }),
          }
        : { status: 200, body: JSON.stringify({ id: WABA_ID, name: 'Rao Interiors' }) };

    const account = await setup<{ id: string; numbers: { phoneNumberId: string; qualityRating: string | null }[] }>(
      'POST',
      '/whatsapp/accounts',
      { token: orgA.token, payload: { connectionId } },
    );
    expect(account.numbers.length).toBe(2);
    // The rating Meta now reports, not the one we stored a minute ago.
    expect(
      account.numbers.find((number) => number.phoneNumberId === PHONE_NUMBER_ID)?.qualityRating,
    ).toBe('YELLOW');

    // And a number Meta stops listing is switched off rather than deleted: a conversation
    // references it, and what arrived at a number the business no longer has is still history.
    graphAnswer = (request) =>
      (request.url ?? '').includes('phone_numbers')
        ? {
            status: 200,
            body: JSON.stringify({
              data: [{ id: PHONE_NUMBER_ID, display_phone_number: '+91 98450 00000', quality_rating: 'GREEN' }],
            }),
          }
        : { status: 200, body: JSON.stringify({ id: WABA_ID, name: 'Rao Interiors' }) };
    const after = await setup<{ numbers: { phoneNumberId: string; isActive: boolean }[] }>(
      'POST',
      '/whatsapp/accounts',
      { token: orgA.token, payload: { connectionId } },
    );
    expect(after.numbers.find((number) => number.phoneNumberId === '99887766')?.isActive).toBe(false);
    expect(after.numbers.length).toBe(2);
  });

  it('records who answers a number by default, and lets that be nobody', async () => {
    const assigned = await setup<{
      numbers: { id: string; defaultAgentUserId: string | null }[];
    }>('PATCH', `/whatsapp/numbers/${numberId}`, {
      token: orgA.token,
      payload: { userId: orgA.userId },
    });
    expect(assigned.numbers.find((number) => number.id === numberId)?.defaultAgentUserId).toBe(
      orgA.userId,
    );

    // "Nobody by default" is a real answer, so `null` has to be storable: a schema that only
    // accepted a uuid would make an unclaimed number unrepresentable.
    const cleared = await setup<{
      numbers: { id: string; defaultAgentUserId: string | null }[];
    }>('PATCH', `/whatsapp/numbers/${numberId}`, {
      token: orgA.token,
      payload: { userId: null },
    });
    expect(cleared.numbers.find((number) => number.id === numberId)?.defaultAgentUserId).toBeNull();
  });

  it('refuses a token Meta rejects, before anything is stored', async () => {
    const previous = graphAnswer;
    graphAnswer = () => ({
      status: 400,
      body: JSON.stringify({
        error: { message: 'Error validating access token: the session is invalid.', code: 190 },
      }),
    });
    try {
      const response = await api('POST', '/whatsapp/accounts', {
        token: orgA.token,
        payload: { connectionId },
      });
      expect(response.statusCode).toBe(401);
      expect(response.body.error?.message).toMatch(/session is invalid/i);
    } finally {
      graphAnswer = previous;
    }
  });
});

describe('Meta’s handshake and signature', () => {
  it('echoes the challenge as plain text when the verify token matches', async () => {
    const response = await call<string>(ctx.app, {
      method: 'GET',
      url: `/api/v1/wh/whatsapp_cloud/${connectionId}?hub.mode=subscribe&hub.verify_token=${encodeURIComponent(VERIFY_TOKEN)}&hub.challenge=1158201444`,
    });
    expect(response.statusCode).toBe(200);
    expect(String(response.body)).toBe('1158201444');
    expect(response.headers['content-type']).toContain('text/plain');
  });

  it('refuses an unsigned delivery, and one signed with another app’s secret', async () => {
    const unsigned = await post(delivery([textMessage()]));
    expect(unsigned.statusCode).toBe(401);
    expect(unsigned.body.error?.message).toContain('X-Hub-Signature-256');

    const wrong = await post(delivery([textMessage()]), { secret: 'another-app-secret' });
    expect(wrong.statusCode).toBe(401);
    expect(wrong.body.error?.message).toMatch(/app secret/i);

    expect(
      await ctx.db.providerEvent.count({ where: { organizationId: orgA.organizationId } }),
    ).toBe(0);
  });
});

describe('an inbound message', () => {
  let wamid: string;

  it('becomes a conversation, a message, a lead and a timeline entry', async () => {
    const message = textMessage();
    wamid = message.id;
    const delivered = await post(delivery([message]), { secret: APP_SECRET });
    // 200 and acknowledged at once: a provider that waits for us is a provider that retries.
    expect(delivered.statusCode).toBe(200);
    expect(delivered.body.data.accepted).toBe(1);

    await drain();

    const conversations = await setup<
      {
        id: string;
        contact: string | null;
        unreadCount: number;
        status: string;
        windowIsOpen: boolean;
        windowSummary: string;
        lead: { id: string; fullName: string } | null;
        lastMessage: { direction: string; preview: string } | null;
        number: { displayPhoneE164: string } | null;
      }[]
    >('GET', '/conversations', { token: orgA.token });
    expect(conversations.length).toBe(1);
    const [conversation] = conversations;
    expect(conversation?.contact).toBe('+919845012345');
    expect(conversation?.status).toBe('open');
    expect(conversation?.unreadCount).toBe(1);
    expect(conversation?.number?.displayPhoneE164).toBe('+919845000000');
    expect(conversation?.lastMessage?.direction).toBe('inbound');
    expect(conversation?.lastMessage?.preview).toBe('Is the 3BHK still available?');
    // The 24-hour window, open and counted in words rather than left as an instant to subtract.
    expect(conversation?.windowIsOpen).toBe(true);
    expect(conversation?.windowSummary).toMatch(/left to reply freely/i);

    // A message from a number nobody recognises is a lead the business has already paid for.
    expect(conversation?.lead).not.toBeNull();
    const lead = await setup<{
      fullName: string;
      whatsapp: string | null;
      phone: string | null;
      createdVia: string;
    }>('GET', `/leads/${conversation?.lead?.id}`, { token: orgA.token });
    expect(lead.fullName).toContain('Asha');
    expect(lead.whatsapp ?? lead.phone).toBe('+919845012345');
    expect(lead.createdVia).toBe('whatsapp');

    // Rule six: a business owner opening the lead must see that they messaged.
    const timeline = await setup<{ type: string; payload: Record<string, unknown> }[]>(
      'GET',
      `/leads/${conversation?.lead?.id}/timeline`,
      { token: orgA.token },
    );
    const received = timeline.find((entry) => entry.type === 'whatsapp.received');
    expect(received).toBeDefined();
    expect(received?.payload['preview']).toBe('Is the 3BHK still available?');
    expect(received?.payload['conversationId']).toBe(conversation?.id);

    // And the message itself, readable, with Meta's own id on it.
    const messages = await setup<
      { direction: string; type: string; body: string | null; status: string; providerMessageId: string | null }[]
    >('GET', `/conversations/${conversation?.id}/messages`, { token: orgA.token });
    expect(messages.length).toBe(1);
    expect(messages[0]?.direction).toBe('inbound');
    expect(messages[0]?.providerMessageId).toBe(wamid);
    // Inbound is `delivered` the moment we have it: it is in our hands and there is nothing
    // further to wait for.
    expect(messages[0]?.status).toBe('delivered');
  });

  /**
   * The exit criterion, exactly as the roadmap words it.
   */
  it('produces exactly one message and one activity from a delivery Meta retries', async () => {
    const message = textMessage({ text: { body: 'And the 2BHK?' } });
    const body = delivery([message]);

    const first = await post(body, { secret: APP_SECRET });
    expect(first.body.data.accepted).toBe(1);
    await drain();

    // The same delivery again, byte for byte, as Meta sends it when it did not see our 200.
    const second = await post(body, { secret: APP_SECRET });
    expect(second.statusCode).toBe(200);
    expect(second.body.data.accepted).toBe(0);
    expect(second.body.data.duplicates).toBe(1);

    // And once more with a different envelope so the bytes differ: the ledger is keyed on Meta's
    // own message id, not on a hash of the body.
    const third = await post({ ...body, object: 'whatsapp_business_account_v2' }, { secret: APP_SECRET });
    expect(third.body.data.duplicates).toBe(1);

    await drain();
    await drain();

    expect(
      await ctx.db.message.count({
        where: { organizationId: orgA.organizationId, providerMessageId: message.id },
      }),
    ).toBe(1);
    expect(
      await ctx.db.providerEvent.count({
        where: { organizationId: orgA.organizationId, externalEventId: message.id },
      }),
    ).toBe(1);
    expect(
      await ctx.db.activity.count({
        where: { organizationId: orgA.organizationId, type: 'whatsapp.received' },
      }),
    ).toBe(2);
  });

  it('records on the ledger row which lead the message became', async () => {
    const message = textMessage({ text: { body: 'Who do I speak to about this?' } });
    await post(delivery([message]), { secret: APP_SECRET });
    await drain();
    const row = await ctx.db.providerEvent.findFirstOrThrow({
      where: { organizationId: orgA.organizationId, externalEventId: message.id },
      select: { status: true, leadId: true, processedAt: true },
    });
    expect(row.status).toBe('processed');
    expect(row.processedAt).not.toBeNull();
    // "Which lead did this become" has to be answerable for a message that landed on a lead who
    // already existed, which is most of them after the first.
    expect(row.leadId).not.toBeNull();
  });

  it('attaches a second message to the lead they already were, not a second lead', async () => {
    const leadsBefore = await ctx.db.lead.count({ where: { organizationId: orgA.organizationId } });
    await post(delivery([textMessage({ text: { body: 'Any parking?' } })]), { secret: APP_SECRET });
    await drain();
    expect(await ctx.db.lead.count({ where: { organizationId: orgA.organizationId } })).toBe(
      leadsBefore,
    );
    const conversations = await setup<{ id: string; unreadCount: number }[]>('GET', '/conversations', {
      token: orgA.token,
    });
    // One conversation, however many messages: keyed on `(number, contact)`.
    expect(conversations.length).toBe(1);
    expect(conversations[0]?.unreadCount).toBeGreaterThan(1);
  });

  it('keeps a message whose content it cannot store, with the provider’s payload', async () => {
    const message = textMessage({
      type: 'image',
      text: undefined,
      image: { id: 'media-1', mime_type: 'image/jpeg', sha256: 'abc' },
    });
    await post(delivery([message]), { secret: APP_SECRET });
    await drain();
    const row = await ctx.db.message.findFirstOrThrow({
      where: { organizationId: orgA.organizationId, providerMessageId: message.id },
      select: { type: true, body: true, payload: true },
    });
    expect(row.type).toBe('image');
    // Never a placeholder: "[image]" would be indistinguishable from somebody typing it.
    expect(row.body).toBeNull();
    expect((row.payload as { image?: { id?: string } }).image?.id).toBe('media-1');

    const conversations = await setup<{ lastMessage: { preview: string } | null }[]>(
      'GET',
      '/conversations',
      { token: orgA.token },
    );
    expect(conversations[0]?.lastMessage?.preview).toBe('Sent a photo');
  });

  it('stores every message of a batch, each on its own id', async () => {
    const one = textMessage({ text: { body: 'First of two' } });
    const two = textMessage({ text: { body: 'Second of two' } });
    const delivered = await post(delivery([one, two]), { secret: APP_SECRET });
    expect(delivered.body.data.accepted).toBe(2);
    await drain();
    for (const message of [one, two]) {
      expect(
        await ctx.db.message.count({
          where: { organizationId: orgA.organizationId, providerMessageId: message.id },
        }),
      ).toBe(1);
    }
  });

  it('acknowledges a delivery that carries only status receipts', async () => {
    // Meta sends these for messages we sent. This step sends nothing, so there is nothing for them
    // to be about — and a 4xx would teach Meta to disable the endpoint and stop delivering the
    // messages we do want.
    const response = await post(
      delivery([], { messages: undefined, statuses: [{ id: 'wamid.ours', status: 'delivered' }] }),
      { secret: APP_SECRET },
    );
    expect(response.statusCode).toBe(200);
    expect(response.body.data.accepted).toBe(0);
  });

  it('refuses a delivery naming a number this workspace does not have', async () => {
    const response = await post(
      delivery([textMessage()], { metadata: { phone_number_id: '00000000' } }),
      { secret: APP_SECRET },
    );
    // Verified, so accepted into the ledger — and then the job finds no number and records why,
    // rather than the endpoint refusing a signed delivery Meta would retry forever.
    expect(response.statusCode).toBe(200);
    await drain();
    const events = await ctx.db.providerEvent.findMany({
      where: { organizationId: orgA.organizationId, status: 'failed' },
      select: { error: true },
    });
    expect(events.length).toBeGreaterThan(0);
    expect(events.some((event) => /number/i.test(event.error ?? ''))).toBe(true);
  });
});

describe('the inbox', () => {
  it('answers the window as a sentence a person can act on', async () => {
    const conversations = await setup<
      { id: string; windowExpiresAt: string | null; windowIsOpen: boolean; windowSummary: string }[]
    >('GET', '/conversations', { token: orgA.token });
    const [conversation] = conversations;
    expect(conversation?.windowExpiresAt).not.toBeNull();

    // Aged past Meta's 24 hours, which is the state the next step refuses a free-form send in.
    const closed = new Date(Date.now() - 25 * 3_600_000);
    await ctx.db.conversation.update({
      where: { id: conversation!.id },
      data: { lastInboundAt: closed, windowExpiresAt: windowExpiryFrom(closed) },
    });
    const after = await setup<{ windowIsOpen: boolean; windowSummary: string }>(
      'GET',
      `/conversations/${conversation!.id}`,
      { token: orgA.token },
    );
    expect(after.windowIsOpen).toBe(false);
    expect(after.windowSummary).toMatch(/only an approved template/i);
  });

  it('carries the lead context beside the conversation', async () => {
    const [conversation] = await setup<{ id: string }[]>('GET', '/conversations', {
      token: orgA.token,
    });
    const detail = await setup<{
      lead: { id: string; fullName: string; phone: string | null; status: { name: string } | null } | null;
    }>('GET', `/conversations/${conversation!.id}`, { token: orgA.token });
    // `FR-WA-8`: the whole point of an inbox in a CRM is that the person's history is on the same
    // screen as their message.
    expect(detail.lead?.fullName).toContain('Asha');
    expect(detail.lead?.phone).toBe('+919845012345');
    expect(detail.lead?.status?.name).toBeTruthy();
  });

  it('totals the filter rather than the page', async () => {
    const response = await api<{ id: string }[]>('GET', '/conversations?limit=1', {
      token: orgA.token,
    });
    expect(response.statusCode).toBe(200);
    expect(response.body.data.length).toBe(1);
    // A badge that counted the one row it loaded would tell an agent their inbox was empty.
    expect(Number(response.body.meta?.['unread'] ?? 0)).toBeGreaterThan(0);
    expect(Number(response.body.meta?.['open'] ?? 0)).toBeGreaterThan(0);
  });

  it('marks a conversation read, and the badge and the list agree', async () => {
    const [conversation] = await setup<{ id: string }[]>('GET', '/conversations', {
      token: orgA.token,
    });
    const read = await setup<{ unreadCount: number }>(
      'POST',
      `/conversations/${conversation!.id}/read`,
      { token: orgA.token },
    );
    expect(read.unreadCount).toBe(0);
    const unread = await api<{ id: string }[]>('GET', '/conversations?unread=true', {
      token: orgA.token,
    });
    expect(unread.body.data.length).toBe(0);
    expect(Number(unread.body.meta?.['unread'] ?? -1)).toBe(0);
  });

  it('finds a conversation by what was said in it, and by the number', async () => {
    const byBody = await setup<{ id: string }[]>('GET', '/conversations?q=3BHK', {
      token: orgA.token,
    });
    expect(byBody.length).toBe(1);
    const byNumber = await setup<{ id: string }[]>('GET', '/conversations?q=9845012345', {
      token: orgA.token,
    });
    expect(byNumber.length).toBe(1);
    const byNothing = await setup<{ id: string }[]>('GET', '/conversations?q=helicopter', {
      token: orgA.token,
    });
    expect(byNothing.length).toBe(0);
  });

  it('pages messages with both halves of the partitioned key', async () => {
    const [conversation] = await setup<{ id: string }[]>('GET', '/conversations', {
      token: orgA.token,
    });
    const first = await api<{ id: string; createdAt: string }[]>(
      `GET`,
      `/conversations/${conversation!.id}/messages?limit=2`,
      { token: orgA.token },
    );
    expect(first.body.data.length).toBe(2);
    expect(first.body.meta?.['pagination']).toBeDefined();
    const cursor = (first.body.meta?.['pagination'] as { nextCursor?: string })?.nextCursor;
    expect(typeof cursor).toBe('string');

    const next = await setup<{ id: string }[]>(
      'GET',
      `/conversations/${conversation!.id}/messages?limit=2&before=${cursor}`,
      { token: orgA.token },
    );
    // A different page, not the same one: an id alone would select the wrong rows on a table
    // partitioned by `created_at`.
    expect(next.every((message) => !first.body.data.some((row) => row.id === message.id))).toBe(true);
  });

  it('refuses a conversation from another workspace', async () => {
    const other = await setup<{ tokens: { accessToken: string } }>('POST', '/auth/register', {
      payload: {
        email: `${EMAIL_MARKER}b@test.local`,
        password: PASSWORD,
        name: 'Another Owner',
        organizationName: `WA other ${SUFFIX}`,
      },
    });
    const [conversation] = await setup<{ id: string }[]>('GET', '/conversations', {
      token: orgA.token,
    });
    const read = await api('GET', `/conversations/${conversation!.id}`, {
      token: other.tokens.accessToken,
    });
    expect(read.statusCode).toBe(404);
    const messages = await api('GET', `/conversations/${conversation!.id}/messages`, {
      token: other.tokens.accessToken,
    });
    expect(messages.statusCode).toBe(404);
    const theirs = await setup<{ id: string }[]>('GET', '/conversations', {
      token: other.tokens.accessToken,
    });
    expect(theirs.length).toBe(0);
  });

  it('refuses a second workspace connecting the same number, with a sentence rather than a 500', async () => {
    // `phone_number_id` is unique globally, which is what makes an inbound delivery resolvable at
    // all — so this refusal is a property of the schema. The check that produces it has to read
    // **across** tenants: the scoped client cannot see the row that would collide, and without the
    // platform-scoped read this came back as a raw unique violation.
    const other = await setup<{ tokens: { accessToken: string } }>('POST', '/auth/register', {
      payload: {
        email: `${EMAIL_MARKER}c@test.local`,
        password: PASSWORD,
        name: 'Third Owner',
        organizationName: `WA third ${SUFFIX}`,
      },
    });
    const connection = await setup<{ id: string }>('POST', '/integrations', {
      token: other.tokens.accessToken,
      payload: {
        provider: 'whatsapp_cloud',
        name: 'Somebody else’s WhatsApp',
        credentials: { appSecret: APP_SECRET, accessToken: ACCESS_TOKEN },
        settings: { wabaId: WABA_ID, verifyToken: 'their own phrase' },
      },
    });
    const response = await api('POST', '/whatsapp/accounts', {
      token: other.tokens.accessToken,
      payload: { connectionId: connection.id },
    });
    expect(response.statusCode).toBe(422);
    expect(response.body.error?.message).toMatch(/already connected to another workspace/i);
    // And nothing of theirs was written: the refusal is before the transaction.
    const theirs = await setup<{ id: string }[]>('GET', '/whatsapp/accounts', {
      token: other.tokens.accessToken,
    });
    expect(theirs.length).toBe(0);
  });
});
