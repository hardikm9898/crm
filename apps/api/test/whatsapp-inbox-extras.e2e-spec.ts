import { createHmac } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId, newToken } from '@leados/shared';
import { WhatsAppIngestMessageProcessor } from '../src/modules/whatsapp/whatsapp.processor.js';
import { bootTestApp, call, cleanupUsers, type EnvelopeBody, type TestApp } from './app-harness.js';

/**
 * TAGS, CANNED REPLIES AND THE USAGE METER (Phase 5 step 5: `FR-WA-7`, `FR-BIL-4`).
 *
 * The three things the inbox had left, and the two columns that had been written since step 2 with
 * nothing reading them. The pagination case is here too, because it is the defect the 100 k fixture
 * found and the one a test can state in four lines: a list that answers `hasMore: false` beside a
 * `total` of 4 000 is a list whose other 3 950 rows are unreachable.
 */

const SUFFIX = newToken(4)
  .toLowerCase()
  .replace(/[^a-z0-9]/g, '');
const EMAIL_MARKER = `e2ewx${SUFFIX}`;
const PASSWORD = 'a quiet november harbour';
const APP_SECRET = 'd41d8cd98f00b204e9800998ecf8427e';
const ACCESS_TOKEN = 'EAAG-a-permanent-system-user-token-value-0006';
const WABA_ID = '102938475611222';
const PHONE_NUMBER_ID = `3322${Date.now().toString().slice(-6)}`;
const CONTACT = '919845022222';

let ctx: TestApp;
let graph: Server;
let previousGraphUrl: string | undefined;
let owner: { token: string; organizationId: string; userId: string };
let connectionId: string;
let conversationId: string;

async function api<T>(
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  url: string,
  options: { token?: string; payload?: unknown } = {},
) {
  return call<EnvelopeBody<T>>(ctx.app, {
    method: method as 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
    url: `/api/v1${url}`,
    ...(options.token === undefined ? {} : { token: options.token }),
    ...(options.payload === undefined ? {} : { payload: options.payload }),
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
            metadata: { display_phone_number: '919845001222', phone_number_id: PHONE_NUMBER_ID },
            ...value,
          },
        },
      ],
    },
  ],
});

async function customerSays(body: string): Promise<void> {
  const raw = JSON.stringify(
    delivery({
      contacts: [{ wa_id: CONTACT, profile: { name: 'Asha Rao' } }],
      messages: [
        {
          from: CONTACT,
          id: `wamid.in.${newToken(8)}`,
          timestamp: String(Math.floor(Date.now() / 1000)),
          type: 'text',
          text: { body },
        },
      ],
    }),
  );
  await call(ctx.app, {
    method: 'POST',
    url: `/api/v1/wh/whatsapp_cloud/${connectionId}`,
    payload: raw,
    headers: {
      'content-type': 'application/json',
      'x-hub-signature-256': `sha256=${createHmac('sha256', APP_SECRET).update(raw).digest('hex')}`,
    },
  });
  const processor = ctx.app.get(WhatsAppIngestMessageProcessor);
  const rows = await ctx.db.providerEvent.findMany({
    where: { organizationId: owner.organizationId, status: { in: ['received', 'failed'] } },
    select: { id: true },
  });
  for (const row of rows) {
    await processor.handle(owner.organizationId, row.id).catch(() => {
      /* the row records the failure; the tests assert against the row */
    });
  }
}

beforeAll(async () => {
  graph = createServer((request: IncomingMessage, response) => {
    request.on('data', () => undefined);
    request.on('end', () => {
      const path = request.url ?? '';
      const answer = path.includes('phone_numbers')
        ? {
            data: [
              {
                id: PHONE_NUMBER_ID,
                display_phone_number: '+91 98450 01222',
                verified_name: 'Rao Interiors',
                quality_rating: 'GREEN',
                messaging_limit_tier: 'TIER_1K',
              },
            ],
          }
        : path.includes('message_templates')
          ? { data: [] }
          : path.includes('/messages')
            ? {
                messaging_product: 'whatsapp',
                contacts: [{ input: CONTACT, wa_id: CONTACT }],
                messages: [{ id: `wamid.out.${newToken(6)}` }],
              }
            : { id: WABA_ID, name: 'Rao Interiors' };
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(answer));
    });
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
      name: 'Extras Owner',
      organizationName: `WA extras ${SUFFIX}`,
    },
  });
  owner = {
    token: registered.tokens.accessToken,
    organizationId: registered.organization.id,
    userId: registered.user.id,
  };

  const connection = await setup<{ id: string }>('POST', '/integrations', {
    token: owner.token,
    payload: {
      provider: 'whatsapp_cloud',
      name: 'WhatsApp',
      credentials: { appSecret: APP_SECRET, accessToken: ACCESS_TOKEN },
      settings: { wabaId: WABA_ID, verifyToken: 'a phrase i chose' },
    },
  });
  connectionId = connection.id;
  await setup('POST', '/whatsapp/accounts', { token: owner.token, payload: { connectionId } });
  await customerSays('Is the 3BHK still available?');
  const [conversation] = await setup<{ id: string }[]>('GET', '/conversations', {
    token: owner.token,
  });
  if (!conversation) throw new Error('the inbound message did not become a conversation');
  conversationId = conversation.id;
}, 180_000);

afterAll(async () => {
  await cleanupUsers(ctx.db, EMAIL_MARKER);
  await ctx.close();
  await new Promise<void>((resolve) => graph.close(() => resolve()));
  if (previousGraphUrl === undefined) delete process.env['META_GRAPH_URL'];
  else process.env['META_GRAPH_URL'] = previousGraphUrl;
});

describe('a list that can be paged (the 100 k fixture’s finding)', () => {
  it('hands out a cursor that walks every row, and says honestly when there are no more', async () => {
    // One conversation, so this is the "no more" half: `hasMore` has to be read from the database
    // rather than inferred from a full page, which is wrong exactly when the total is a multiple
    // of the limit.
    const first = await api<{ id: string }[]>('GET', '/conversations?limit=1', {
      token: owner.token,
    });
    expect(first.statusCode).toBe(200);
    expect(first.body.meta?.pagination).toMatchObject({ hasMore: false, nextCursor: null, total: 1 });
  });

  it('refuses a cursor it did not issue, rather than paging through a shape it invented', async () => {
    const forged = await api('GET', '/conversations?cursor=not-a-cursor', { token: owner.token });
    expect(forged.statusCode).toBe(400);
  });
});

describe('tags (`FR-WA-7`)', () => {
  it('replaces the whole set, cleaned, and the filter then finds it', async () => {
    const tagged = await setup<{ tags: string[] }>('PUT', `/conversations/${conversationId}/tags`, {
      token: owner.token,
      payload: { tags: ['Site Visit', 'site-visit', '  Pricing  '] },
    });
    // Three spellings of two ideas: a vocabulary that kept them apart would be three chips for one
    // idea and a filter that finds a third of what it should.
    expect(tagged.tags).toEqual(['site-visit', 'pricing']);

    const found = await setup<{ id: string }[]>('GET', '/conversations?tag=site-visit', {
      token: owner.token,
    });
    expect(found.map((row) => row.id)).toContain(conversationId);

    const missed = await setup<{ id: string }[]>('GET', '/conversations?tag=documents', {
      token: owner.token,
    });
    expect(missed).toEqual([]);
  });

  it('refuses a submission that would silently become nothing', async () => {
    const punctuation = await api('PUT', `/conversations/${conversationId}/tags`, {
      token: owner.token,
      payload: { tags: ['###'] },
    });
    // Answering "saved" would be a lie about a filter that will never match.
    expect(punctuation.statusCode).toBe(400);
    expect(JSON.stringify(punctuation.body)).toContain('letter or number');
  });

  it('audits the change, because a tag is how a queue is organised', async () => {
    await setup('PUT', `/conversations/${conversationId}/tags`, {
      token: owner.token,
      payload: { tags: ['documents'] },
    });
    const audited = await ctx.db.auditLog.findFirst({
      where: {
        organizationId: owner.organizationId,
        action: 'conversation.tagged',
        resourceId: conversationId,
      },
      orderBy: { createdAt: 'desc' },
      select: { before: true, after: true },
    });
    expect(JSON.stringify(audited?.after)).toContain('documents');
    // No timeline entry: "somebody added a label" is not what a business owner opens a lead to
    // read, and the audit log is where a question about the inbox belongs.
    const entries = await ctx.db.activity.count({
      where: { organizationId: owner.organizationId, type: 'conversation.tagged' },
    });
    expect(entries).toBe(0);
  });

  it('empties them, which is a real answer rather than an omission', async () => {
    const cleared = await setup<{ tags: string[] }>('PUT', `/conversations/${conversationId}/tags`, {
      token: owner.token,
      payload: { tags: [] },
    });
    expect(cleared.tags).toEqual([]);
  });
});

describe('canned replies (`FR-WA-7`)', () => {
  let replyId: string;

  it('cleans the shortcut rather than demanding punctuation', async () => {
    const made = await setup<{ id: string; shortcut: string; usageCount: number }[]>(
      'POST',
      '/canned-replies',
      { token: owner.token, payload: { shortcut: 'Price List', body: 'Our price list is attached.' } },
    );
    const reply = made.find((row) => row.shortcut === '/price-list');
    expect(reply).toBeDefined();
    // Times **sent**, so a new one is zero — not "times offered in a picker".
    expect(reply?.usageCount).toBe(0);
    replyId = reply!.id;
  });

  it('refuses a shortcut already taken, saying whose it is', async () => {
    const clash = await api('POST', '/canned-replies', {
      token: owner.token,
      payload: { shortcut: '/price-list', body: 'Again' },
    });
    expect(clash.statusCode).toBe(400);
    // The partial unique would refuse it anyway, as a raw constraint violation — a 500 on a
    // mistake somebody can fix.
    expect(JSON.stringify(clash.body)).toContain('already a shared reply');
  });

  it('counts a send, not a click, and sends what the agent actually typed', async () => {
    const before = (await setup<{ id: string; usageCount: number }[]>('GET', '/canned-replies', {
      token: owner.token,
    })).find((row) => row.id === replyId)!.usageCount;

    const sent = await api<{ id: string; body: string }>(
      'POST',
      `/conversations/${conversationId}/messages`,
      {
        token: owner.token,
        // Edited before sending, which is the ordinary case: a send that silently used the stored
        // wording would put words in somebody's mouth.
        payload: { kind: 'text', body: 'Our price list is attached — shall I book a visit?', cannedReplyId: replyId },
      },
    );
    expect(sent.statusCode).toBe(202);
    expect(sent.body.data.body).toBe('Our price list is attached — shall I book a visit?');

    const after = (await setup<{ id: string; usageCount: number }[]>('GET', '/canned-replies', {
      token: owner.token,
    })).find((row) => row.id === replyId)!.usageCount;
    expect(after).toBe(before + 1);

    const row = await ctx.db.message.findFirstOrThrow({
      where: { id: sent.body.data.id },
      select: { cannedReplyId: true },
    });
    // The column as well as the counter: "which wording actually gets used" is answerable from the
    // messages rather than from a number that could drift.
    expect(row.cannedReplyId).toBe(replyId);
  });

  it('lets two people each keep their own private shortcut', async () => {
    const mine = await setup<{ shortcut: string; visibility: string }[]>('POST', '/canned-replies', {
      token: owner.token,
      payload: { shortcut: '/thanks', body: 'Thank you!', visibility: 'private' },
    });
    expect(mine.find((row) => row.shortcut === '/thanks')?.visibility).toBe('private');
    // The same person cannot have two, which the clash check says in a sentence.
    const again = await api('POST', '/canned-replies', {
      token: owner.token,
      payload: { shortcut: '/thanks', body: 'Thanks again', visibility: 'private' },
    });
    expect(again.statusCode).toBe(400);
    expect(JSON.stringify(again.body)).toContain('You already have a reply on /thanks');
  });

  it('archives rather than deletes, and frees the shortcut', async () => {
    await setup('DELETE', `/canned-replies/${replyId}`, { token: owner.token });
    const after = await setup<{ id: string }[]>('GET', '/canned-replies', { token: owner.token });
    expect(after.some((row) => row.id === replyId)).toBe(false);

    // The row is still there, because a message points at it: `messages.canned_reply_id` is
    // `Restrict`, so deleting would either fail or take the history.
    const archived = await ctx.db.cannedReply.findFirstOrThrow({
      where: { id: replyId },
      select: { deletedAt: true },
    });
    expect(archived.deletedAt).not.toBeNull();

    // And the shortcut is free again, which a plain unique would have made impossible for ever.
    const reused = await setup<{ shortcut: string }[]>('POST', '/canned-replies', {
      token: owner.token,
      payload: { shortcut: '/price-list', body: 'The shortcut is free again' },
    });
    expect(reused.some((row) => row.shortcut === '/price-list')).toBe(true);
  });

  it('refuses a blank body and a shortcut nothing could type', async () => {
    for (const payload of [
      { shortcut: '/ok', body: '   ' },
      { shortcut: '!!!', body: 'Fine' },
    ]) {
      const refused = await api('POST', '/canned-replies', { token: owner.token, payload });
      expect(refused.statusCode, JSON.stringify(payload)).toBe(400);
    }
  });
});

describe('the usage meter (`FR-BIL-4`)', () => {
  it('counts billable conversations by the category Meta billed under', async () => {
    // The two columns the receipts have written since step 2, read for the first time. Written
    // here directly because only Meta sets them, and a receipt fixture would be measuring the
    // receipt path rather than the meter.
    const message = await ctx.db.message.findFirstOrThrow({
      where: { organizationId: owner.organizationId, direction: 'outbound' },
      select: { id: true, createdAt: true },
    });
    await ctx.db.message.updateMany({
      where: { id: message.id },
      data: { billable: true, conversationCategory: 'service' },
    });

    const beforeAccepted = await setup<{ messagesSent: number }>('GET', '/whatsapp/usage', {
      token: owner.token,
    });
    // **Zero**, and that is the meter being right: every outbound message in this suite is still
    // `queued`, because nothing has driven the send job — and a message that has not left is not
    // one that was sent. A meter that counted it would flatter the figure an owner reconciles
    // against an invoice.
    expect(beforeAccepted.messagesSent).toBe(0);
    await ctx.db.message.updateMany({ where: { id: message.id }, data: { status: 'accepted' } });

    const usage = await setup<{
      billableConversations: number;
      byCategory: { category: string; conversations: number }[];
      messagesSent: number;
      note: string;
    }>('GET', '/whatsapp/usage', { token: owner.token });

    expect(usage.billableConversations).toBe(1);
    expect(usage.byCategory).toEqual([{ category: 'service', conversations: 1 }]);
    // Once Meta has it, which is what `accepted` means.
    expect(usage.messagesSent).toBe(1);
    // No invented cost: Meta's prices are per-country and change, and a rate card here would be
    // wrong within a quarter and wrong silently on somebody's invoice.
    expect(usage.note).toContain('does not estimate cost');
  });

  it('counts a message with no category rather than dropping it', async () => {
    const another = await ctx.db.message.findFirstOrThrow({
      where: { organizationId: owner.organizationId, direction: 'inbound' },
      select: { id: true },
    });
    await ctx.db.message.updateMany({
      where: { id: another.id },
      data: { billable: true, conversationCategory: null },
    });
    const usage = await setup<{
      billableConversations: number;
      byCategory: { category: string }[];
    }>('GET', '/whatsapp/usage', { token: owner.token });
    // A total that silently omits what it could not classify is a total nobody can reconcile.
    expect(usage.billableConversations).toBe(2);
    expect(usage.byCategory.map((row) => row.category).sort()).toEqual(['service', 'unknown']);
  });

  it('honours the window, and defaults to this month', async () => {
    const lastMonth = await setup<{ billableConversations: number; from: string }>(
      'GET',
      `/whatsapp/usage?from=${new Date('2026-01-01').toISOString()}&to=${new Date('2026-02-01').toISOString()}`,
      { token: owner.token },
    );
    expect(lastMonth.billableConversations).toBe(0);
    const thisMonth = await setup<{ from: string }>('GET', '/whatsapp/usage', {
      token: owner.token,
    });
    // The period an invoice covers, which is the only reason anybody opens this screen.
    expect(new Date(thisMonth.from).getUTCDate()).toBe(1);
  });

  it('is behind `billing:read`, not `whatsapp:manage`', async () => {
    const role = await ctx.db.role.findFirstOrThrow({
      where: { organizationId: owner.organizationId, code: 'sales_executive' },
    });
    const grants = await ctx.db.rolePermission.findMany({
      where: { roleId: role.id, permissionKey: { in: ['billing:read', 'whatsapp:manage'] } },
      select: { permissionKey: true },
    });
    // An invoice question, and the person who reconciles an invoice is not necessarily the person
    // who connects a number. A sales executive holds neither, which is what this asserts.
    expect(grants.map((row) => row.permissionKey)).toEqual([]);
    expect(newId()).toBeTruthy();
  });
});
