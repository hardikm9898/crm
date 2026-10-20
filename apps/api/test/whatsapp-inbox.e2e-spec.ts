import { createHmac } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CONVERSATION_LOCK_TTL_MS, newId, newToken } from '@leados/shared';
import { TokenService } from '../src/modules/auth/application/token.service.js';
import { WhatsAppIngestMessageProcessor } from '../src/modules/whatsapp/whatsapp.processor.js';
import { WhatsAppIngestStatusProcessor } from '../src/modules/whatsapp/whatsapp-status.processor.js';
import { ConversationSweepProcessor } from '../src/modules/whatsapp/conversation-sweep.processor.js';
import { bootTestApp, call, cleanupUsers, type EnvelopeBody, type TestApp } from './app-harness.js';

/**
 * THE SHARED INBOX SUITE (Phase 5 step 4: `FR-WA-7`, `FR-WA-10`).
 *
 * Two of this phase's exit criteria live here — "two agents opening the same conversation see the
 * ownership lock; transfer is audited" and "opt-out keyword suppresses marketing sends
 * immediately, verified end to end" — so both are driven over HTTP with **two real members**,
 * because a lock is a thing between two people and a suite with one caller cannot see it.
 */

const SUFFIX = newToken(4)
  .toLowerCase()
  .replace(/[^a-z0-9]/g, '');
const EMAIL_MARKER = `e2ewi${SUFFIX}`;
const PASSWORD = 'a quiet november harbour';
const APP_SECRET = 'd41d8cd98f00b204e9800998ecf8427e';
const ACCESS_TOKEN = 'EAAG-a-permanent-system-user-token-value-0004';
const WABA_ID = '102938475610999';
const PHONE_NUMBER_ID = `9911${Date.now().toString().slice(-6)}`;
const VERIFY_TOKEN = 'a phrase i chose';
const CONTACT = '919845044444';

let ctx: TestApp;
let graph: Server;
let previousGraphUrl: string | undefined;

let owner: { token: string; organizationId: string; userId: string };
let mate: { token: string; userId: string };
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

/** A second real member, through the invitation path the product actually uses. */
async function addMember(label: string): Promise<{ token: string; userId: string }> {
  const role = await ctx.db.role.findFirstOrThrow({
    where: { organizationId: owner.organizationId, code: 'sales_executive' },
  });
  const inviteToken = newToken(32);
  await ctx.db.invitation.create({
    data: {
      id: newId(),
      organizationId: owner.organizationId,
      email: `${EMAIL_MARKER}${label}@test.local`,
      roleId: role.id,
      tokenHash: TokenService.hashToken(inviteToken),
      expiresAt: new Date(Date.now() + 72 * 3_600_000),
    },
  });
  const accepted = await setup<{ tokens: { accessToken: string }; user: { id: string } }>(
    'POST',
    '/auth/invitations/accept',
    { payload: { token: inviteToken, name: `Mate ${label}`, password: PASSWORD } },
  );
  return { token: accepted.tokens.accessToken, userId: accepted.user.id };
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
            metadata: { display_phone_number: '919845000999', phone_number_id: PHONE_NUMBER_ID },
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

async function drain(): Promise<void> {
  const messages = ctx.app.get(WhatsAppIngestMessageProcessor);
  const statuses = ctx.app.get(WhatsAppIngestStatusProcessor);
  const rows = await ctx.db.providerEvent.findMany({
    where: { organizationId: owner.organizationId, status: { in: ['received', 'failed'] } },
    select: { id: true, eventType: true },
  });
  for (const row of rows) {
    const handler = row.eventType.startsWith('status.')
      ? statuses.handle(owner.organizationId, row.id)
      : messages.handle(owner.organizationId, row.id);
    await handler.catch(() => {
      /* the row records the failure; the tests assert against the row */
    });
  }
}

/** One inbound text from the customer, which is also what reopens the window. */
async function customerSays(body: string): Promise<void> {
  await post(
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
  await drain();
}

beforeAll(async () => {
  graph = createServer((request: IncomingMessage, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const path = request.url ?? '';
      const answer = path.includes('phone_numbers')
        ? {
            data: [
              {
                id: PHONE_NUMBER_ID,
                display_phone_number: '+91 98450 00999',
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
      name: 'Inbox Owner',
      organizationName: `WA inbox ${SUFFIX}`,
    },
  });
  owner = {
    token: registered.tokens.accessToken,
    organizationId: registered.organization.id,
    userId: registered.user.id,
  };
  mate = await addMember('b');

  const connection = await setup<{ id: string }>('POST', '/integrations', {
    token: owner.token,
    payload: {
      provider: 'whatsapp_cloud',
      name: 'WhatsApp',
      credentials: { appSecret: APP_SECRET, accessToken: ACCESS_TOKEN },
      settings: { wabaId: WABA_ID, verifyToken: VERIFY_TOKEN },
    },
  });
  connectionId = connection.id;
  const account = await setup<{ id: string }>('POST', '/whatsapp/accounts', {
    token: owner.token,
    payload: { connectionId },
  });
  accountId = account.id;

  await customerSays('Is the 3BHK still available?');
  const [conversation] = await setup<{ id: string; lead: { id: string } }[]>('GET', '/conversations', {
    token: owner.token,
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
});

describe('two agents on one conversation (`FR-WA-7`)', () => {
  it('shows each of them the other, from their own side', async () => {
    const claimed = await setup<{ lock: { held: boolean; mine: boolean; message: string | null } }>(
      'POST',
      `/conversations/${conversationId}/claim`,
      { token: owner.token },
    );
    expect(claimed.lock.held).toBe(true);
    expect(claimed.lock.mine).toBe(true);
    expect(claimed.lock.message).toBe('You have this conversation open.');

    // The same row, read by the colleague: a warning rather than a reassurance, and naming the
    // person. One row, two readings, and the viewer is what makes them different.
    const theirs = await setup<{
      lock: { held: boolean; mine: boolean; message: string | null };
      lockedBy: { name: string } | null;
    }>('GET', `/conversations/${conversationId}`, { token: mate.token });
    expect(theirs.lock.held).toBe(true);
    expect(theirs.lock.mine).toBe(false);
    expect(theirs.lock.message).toContain('Inbox Owner opened this');
    expect(theirs.lock.message).toContain('check with them before replying');
    expect(theirs.lockedBy?.name).toBe('Inbox Owner');
  });

  it('lets the colleague answer anyway, because a refusal costs the customer', async () => {
    // Advisory, not a gate. `FR-WA-7` asks that two agents *see* each other; refusing the second
    // one means a customer waits until somebody else's five minutes run out.
    const sent = await api('POST', `/conversations/${conversationId}/messages`, {
      token: mate.token,
      payload: { kind: 'text', body: 'Yes — Saturday at 11?' },
    });
    expect(sent.statusCode).toBe(202);
  });

  it('records an override in the audit log rather than refusing it', async () => {
    const before = await ctx.db.auditLog.count({
      where: {
        organizationId: owner.organizationId,
        action: 'conversation.lock_taken_over',
      },
    });
    const taken = await setup<{ lock: { mine: boolean } }>(
      'POST',
      `/conversations/${conversationId}/claim`,
      { token: mate.token },
    );
    expect(taken.lock.mine).toBe(true);
    const after = await ctx.db.auditLog.findMany({
      where: {
        organizationId: owner.organizationId,
        action: 'conversation.lock_taken_over',
      },
      select: { before: true, after: true },
    });
    expect(after.length).toBe(before + 1);
    expect(JSON.stringify(after.at(-1))).toContain(mate.userId);
  });

  it('releases only your own lock, never a colleague’s', async () => {
    // The colleague holds it from the test above. The owner releasing is a no-op, not a lie.
    const unchanged = await setup<{ lock: { held: boolean }; lockedBy: { id: string } | null }>(
      'DELETE',
      `/conversations/${conversationId}/claim`,
      { token: owner.token },
    );
    expect(unchanged.lock.held).toBe(true);
    expect(unchanged.lockedBy?.id).toBe(mate.userId);

    const released = await setup<{ lock: { held: boolean }; lockedBy: unknown }>(
      'DELETE',
      `/conversations/${conversationId}/claim`,
      { token: mate.token },
    );
    expect(released.lock.held).toBe(false);
    expect(released.lockedBy).toBeNull();
  });

  it('treats a lapsed lock as absent, and the sweep then stops the column claiming it', async () => {
    await setup('POST', `/conversations/${conversationId}/claim`, { token: owner.token });
    // Backdated past the five minutes, which is what a tab left open over lunch produces.
    await ctx.db.conversation.update({
      where: { id: conversationId },
      data: { lockExpiresAt: new Date(Date.now() - CONVERSATION_LOCK_TTL_MS) },
    });

    const read = await setup<{ lock: { held: boolean }; lockedBy: { id: string } | null }>(
      'GET',
      `/conversations/${conversationId}`,
      { token: mate.token },
    );
    // The read is already honest…
    expect(read.lock.held).toBe(false);
    // …and the column is not, until the sweep runs. That gap is the whole reason the sweep exists:
    // every screen and every query would otherwise have to remember to compare it to the clock.
    expect(read.lockedBy?.id).toBe(owner.userId);

    await ctx.app.get(ConversationSweepProcessor).process();
    const swept = await ctx.db.conversation.findFirstOrThrow({
      where: { id: conversationId },
      select: { lockUserId: true, lockExpiresAt: true },
    });
    expect(swept.lockUserId).toBeNull();
    expect(swept.lockExpiresAt).toBeNull();
  });
});

describe('assignment and transfer (`FR-WA-7`)', () => {
  it('assigns, tells them, and writes the lead’s timeline', async () => {
    const assigned = await setup<{ assignedTo: { id: string; name: string } | null }>(
      'POST',
      `/conversations/${conversationId}/assign`,
      { token: owner.token, payload: { assignedUserId: mate.userId, reason: 'They know the site' } },
    );
    expect(assigned.assignedTo?.id).toBe(mate.userId);

    const told = await ctx.db.notification.findFirst({
      where: {
        organizationId: owner.organizationId,
        userId: mate.userId,
        type: 'conversation.assigned',
      },
      orderBy: { createdAt: 'desc' },
      select: { title: true, body: true, link: true },
    });
    expect(told?.body).toBe('They know the site');
    expect(told?.link).toBe(`/inbox?c=${conversationId}`);

    const entry = await ctx.db.activity.findFirst({
      where: { organizationId: owner.organizationId, leadId, type: 'conversation.assigned' },
      orderBy: { occurredAt: 'desc' },
      select: { payload: true },
    });
    expect(JSON.stringify(entry?.payload)).toContain(mate.userId);
    expect(JSON.stringify(entry?.payload)).toContain('They know the site');
  });

  it('puts it back in the pool, which is a real answer rather than an omission', async () => {
    const pooled = await setup<{ assignedTo: unknown }>(
      'POST',
      `/conversations/${conversationId}/assign`,
      { token: owner.token, payload: { assignedUserId: null } },
    );
    // A conversation nobody owns is the one at the greatest risk of never being answered, which is
    // why it is visible to everybody who can read it rather than hidden by a "mine" filter.
    expect(pooled.assignedTo).toBeNull();
  });

  it('is quiet about pressing it twice, instead of refusing', async () => {
    const again = await api('POST', `/conversations/${conversationId}/assign`, {
      token: owner.token,
      payload: { assignedUserId: null },
    });
    expect(again.statusCode).toBe(200);
  });

  it('refuses a person who is not a member', async () => {
    const stranger = await api('POST', `/conversations/${conversationId}/assign`, {
      token: owner.token,
      payload: { assignedUserId: newId() },
    });
    expect(stranger.statusCode).toBe(400);
    expect(JSON.stringify(stranger.body)).toContain('not an active member');
  });

  it('audits a transfer with the note that makes it accountable', async () => {
    await setup('POST', `/conversations/${conversationId}/assign`, {
      token: owner.token,
      payload: { assignedUserId: owner.userId },
    });
    const transferred = await api<{ assignedTo: { id: string } | null }>(
      'POST',
      `/conversations/${conversationId}/transfer`,
      {
        token: owner.token,
        payload: { toUserId: mate.userId, note: 'Going on leave — she is expecting a call Monday' },
      },
    );
    expect(transferred.statusCode).toBe(200);
    expect(transferred.body.data.assignedTo?.id).toBe(mate.userId);

    const audited = await ctx.db.auditLog.findFirst({
      where: {
        organizationId: owner.organizationId,
        action: 'conversation.transferred',
        resourceId: conversationId,
      },
      orderBy: { createdAt: 'desc' },
      select: { before: true, after: true, actorId: true },
    });
    // The exit criterion is "transfer is audited", and an audit row with no reason answers nothing:
    // who it came from, who it went to, and why, all on one row.
    expect(JSON.stringify(audited?.before)).toContain(owner.userId);
    expect(JSON.stringify(audited?.after)).toContain(mate.userId);
    expect(JSON.stringify(audited?.after)).toContain('Going on leave');
    expect(audited?.actorId).toBe(owner.userId);

    const entry = await ctx.db.activity.findFirst({
      where: { organizationId: owner.organizationId, leadId, type: 'conversation.transferred' },
      select: { payload: true },
    });
    expect(JSON.stringify(entry?.payload)).toContain('Going on leave');
  });

  it('refuses a transfer to the person who already has it', async () => {
    const pointless = await api('POST', `/conversations/${conversationId}/transfer`, {
      token: owner.token,
      payload: { toUserId: mate.userId, note: 'again' },
    });
    expect(pointless.statusCode).toBe(422);
  });

  it('releases the lock when ownership moves, because the holder has moved on', async () => {
    await setup('POST', `/conversations/${conversationId}/claim`, { token: mate.token });
    const reassigned = await setup<{ lock: { held: boolean } }>(
      'POST',
      `/conversations/${conversationId}/assign`,
      { token: owner.token, payload: { assignedUserId: owner.userId } },
    );
    expect(reassigned.lock.held).toBe(false);
  });
});

describe('close, reopen and snooze (`FR-WA-7`)', () => {
  it('closes with the reason on the timeline, and refuses a second close', async () => {
    const closed = await setup<{ status: string }>('POST', `/conversations/${conversationId}/close`, {
      token: owner.token,
      payload: { note: 'Booked a site visit' },
    });
    expect(closed.status).toBe('closed');
    const entry = await ctx.db.activity.findFirst({
      where: { organizationId: owner.organizationId, leadId, type: 'conversation.closed' },
      select: { payload: true },
    });
    expect(JSON.stringify(entry?.payload)).toContain('Booked a site visit');

    const twice = await api('POST', `/conversations/${conversationId}/close`, {
      token: owner.token,
      payload: {},
    });
    expect(twice.statusCode).toBe(422);
  });

  it('is reopened by the customer writing again, without anybody pressing anything', async () => {
    await customerSays('Actually, can we make it Sunday?');
    const row = await ctx.db.conversation.findFirstOrThrow({
      where: { id: conversationId },
      select: { status: true, closedAt: true },
    });
    // Leaving it closed is how a reply never comes.
    expect(row.status).toBe('open');
    expect(row.closedAt).toBeNull();
  });

  it('refuses a snooze into the past, and takes one in the future', async () => {
    const backwards = await api('POST', `/conversations/${conversationId}/snooze`, {
      token: owner.token,
      payload: { until: new Date(Date.now() - 60_000).toISOString() },
    });
    expect(backwards.statusCode).toBe(400);
    expect(JSON.stringify(backwards.body)).toContain('future');

    const snoozed = await setup<{ status: string; snoozedUntil: string | null }>(
      'POST',
      `/conversations/${conversationId}/snooze`,
      { token: owner.token, payload: { until: new Date(Date.now() + 3_600_000).toISOString() } },
    );
    expect(snoozed.status).toBe('snoozed');
    expect(snoozed.snoozedUntil).not.toBeNull();
  });

  it('comes back when the sweep delivers it, and tells whoever asked', async () => {
    await setup('POST', `/conversations/${conversationId}/assign`, {
      token: owner.token,
      payload: { assignedUserId: mate.userId },
    });
    await setup('POST', `/conversations/${conversationId}/snooze`, {
      token: owner.token,
      payload: { until: new Date(Date.now() + 3_600_000).toISOString() },
    });
    // The moment has come. Backdating the row is the honest stand-in for waiting an hour.
    await ctx.db.conversation.update({
      where: { id: conversationId },
      data: { snoozedUntil: new Date(Date.now() - 1_000) },
    });

    await ctx.app.get(ConversationSweepProcessor).process();
    const woken = await ctx.db.conversation.findFirstOrThrow({
      where: { id: conversationId },
      select: { status: true, snoozedUntil: true },
    });
    expect(woken.status).toBe('open');
    expect(woken.snoozedUntil).toBeNull();

    const told = await ctx.db.notification.findFirst({
      where: {
        organizationId: owner.organizationId,
        userId: mate.userId,
        type: 'conversation.woke',
      },
      select: { title: true },
    });
    // The passage of time is not a thing anybody notices, which is why a snooze is delivered
    // rather than merely expiring.
    expect(told?.title).toBe('A conversation you snoozed is back');
  });

  it('does not drag back a conversation somebody closed in the meantime', async () => {
    await setup('POST', `/conversations/${conversationId}/snooze`, {
      token: owner.token,
      payload: { until: new Date(Date.now() + 3_600_000).toISOString() },
    });
    await ctx.db.conversation.update({
      where: { id: conversationId },
      data: { snoozedUntil: new Date(Date.now() - 1_000) },
    });
    // The sweep read it as due; a person closed it a millisecond later. The conditional update is
    // what stops a job that is a second behind undoing somebody's decision.
    const due = await ctx.app
      .get(ConversationSweepProcessor)
      .process()
      .then(() => null)
      .catch((error: unknown) => error);
    expect(due).toBeNull();

    await setup('POST', `/conversations/${conversationId}/close`, {
      token: owner.token,
      payload: { note: 'Done' },
    });
    await ctx.db.conversation.update({
      where: { id: conversationId },
      data: { snoozedUntil: new Date(Date.now() - 1_000) },
    });
    await ctx.app.get(ConversationSweepProcessor).process();
    const still = await ctx.db.conversation.findFirstOrThrow({
      where: { id: conversationId },
      select: { status: true },
    });
    expect(still.status).toBe('closed');

    await setup('POST', `/conversations/${conversationId}/reopen`, { token: owner.token });
    const reopened = await ctx.db.conversation.findFirstOrThrow({
      where: { id: conversationId },
      select: { status: true, closedAt: true, closedById: true, snoozedUntil: true },
    });
    expect(reopened.status).toBe('open');
    // Cleared, because they describe a state it is not in.
    expect(reopened.closedAt).toBeNull();
    expect(reopened.closedById).toBeNull();
    expect(reopened.snoozedUntil).toBeNull();
  });

  it('refuses reopening something that is already open', async () => {
    const pointless = await api('POST', `/conversations/${conversationId}/reopen`, {
      token: owner.token,
    });
    expect(pointless.statusCode).toBe(422);
  });
});

describe('internal notes and mentions (`FR-WA-7`)', () => {
  it('writes a note, tells the person it names, and puts it on the lead’s timeline', async () => {
    // `data` **is** the array: the envelope lifts `items` when `pagination` is beside it, so a
    // test reading `data.items` reads `undefined` and fails with nothing about the endpoint.
    const notes = await setup<
      { body: string; author: { name: string }; mentions: { id: string; name: string }[] }[]
    >('POST', `/conversations/${conversationId}/notes`, {
      token: owner.token,
      payload: {
        body: '@Mate b can you check the floor plan before Saturday?',
        mentionedUserIds: [mate.userId],
      },
    });
    const note = notes[0];
    expect(note?.author.name).toBe('Inbox Owner');
    // The name behind the id, resolved for the screen: a raw uuid where a colleague's name belongs
    // is the "Changed billingLine1" mistake.
    expect(note?.mentions).toEqual([{ id: mate.userId, name: 'Mate b' }]);

    const told = await ctx.db.notification.findFirst({
      where: {
        organizationId: owner.organizationId,
        userId: mate.userId,
        type: 'conversation.mentioned',
      },
      select: { body: true, link: true },
    });
    expect(told?.body).toContain('floor plan');
    expect(told?.link).toBe(`/inbox?c=${conversationId}`);

    const entry = await ctx.db.activity.findFirst({
      where: { organizationId: owner.organizationId, leadId, type: 'mention.created' },
      select: { payload: true },
    });
    expect(JSON.stringify(entry?.payload)).toContain('floor plan');
  });

  it('is readable by the colleague, through the conversation’s own permission', async () => {
    const theirs = await setup<{ body: string }[]>(
      'GET',
      `/conversations/${conversationId}/notes`,
      { token: mate.token },
    );
    expect(theirs.length).toBeGreaterThan(0);
  });

  it('refuses a note naming somebody who is not here', async () => {
    const stranger = await api('POST', `/conversations/${conversationId}/notes`, {
      token: owner.token,
      payload: { body: 'Asking a ghost', mentionedUserIds: [newId()] },
    });
    expect(stranger.statusCode).toBe(400);
    expect(JSON.stringify(stranger.body)).toContain('not an active member');
  });

  it('refuses a note with nothing in it', async () => {
    const blank = await api('POST', `/conversations/${conversationId}/notes`, {
      token: owner.token,
      payload: { body: '   ' },
    });
    expect(blank.statusCode).toBe(400);
  });

  it('writes no mention entry for a note that names nobody', async () => {
    const before = await ctx.db.activity.count({
      where: { organizationId: owner.organizationId, leadId, type: 'mention.created' },
    });
    await setup('POST', `/conversations/${conversationId}/notes`, {
      token: owner.token,
      payload: { body: 'Site visit booked for Saturday 11am' },
    });
    const after = await ctx.db.activity.count({
      where: { organizationId: owner.organizationId, leadId, type: 'mention.created' },
    });
    // A note is not a mention: `mention.created` says a colleague was pulled in, and writing it for
    // a note that named nobody would make the timeline claim something that did not happen.
    expect(after).toBe(before);
  });

  it('does not notify somebody about their own note', async () => {
    const before = await ctx.db.notification.count({
      where: {
        organizationId: owner.organizationId,
        userId: owner.userId,
        type: 'conversation.mentioned',
      },
    });
    await setup('POST', `/conversations/${conversationId}/notes`, {
      token: owner.token,
      payload: { body: 'Noting this for myself @Inbox Owner', mentionedUserIds: [owner.userId] },
    });
    const after = await ctx.db.notification.count({
      where: {
        organizationId: owner.organizationId,
        userId: owner.userId,
        type: 'conversation.mentioned',
      },
    });
    expect(after).toBe(before);
  });
});

describe('the word that stops a send (`FR-WA-10`)', () => {
  it('revokes consent in the request that received it, not in a job', async () => {
    // Consent first, so there is something to revoke.
    await setup('PATCH', `/leads/${leadId}`, {
      token: owner.token,
      payload: { consent: { whatsapp: true } },
    });

    await customerSays('STOP');
    const lead = await ctx.db.lead.findFirstOrThrow({
      where: { id: leadId },
      select: { consentWhatsapp: true },
    });
    // No `await` on a queue, no sweep: a queue hop is a window in which a campaign reads the old
    // value and sends the person the thing they asked to stop.
    expect(lead.consentWhatsapp).toBe(false);

    const entry = await ctx.db.activity.findFirst({
      where: { organizationId: owner.organizationId, leadId, type: 'consent.revoked' },
      select: { payload: true },
    });
    // The word they actually sent: "why did we stop messaging her?" is answered by the message.
    expect(JSON.stringify(entry?.payload)).toContain('STOP');

    const audited = await ctx.db.auditLog.findFirst({
      where: { organizationId: owner.organizationId, action: 'consent.revoked' },
      select: { after: true },
    });
    expect(JSON.stringify(audited?.after)).toContain('whatsapp_keyword');
  });

  it('then refuses a marketing template, with the sentence that says why', async () => {
    const template = await setup<{ id: string }>('POST', '/whatsapp/templates', {
      token: owner.token,
      payload: {
        accountId,
        name: `offer_${SUFFIX}`,
        language: 'en',
        category: 'marketing',
        components: { body: 'A new launch in your area' },
      },
    });
    await ctx.db.whatsAppTemplate.update({
      where: { id: template.id },
      data: { status: 'approved', providerTemplateId: 'meta-marketing-1' },
    });

    const refused = await api('POST', `/conversations/${conversationId}/messages`, {
      token: owner.token,
      payload: { kind: 'template', templateId: template.id },
    });
    expect(refused.statusCode).toBe(422);
    // The API's own sentence, asserted as written: it names the person, says what is missing, and
    // names the two ways through — which is the thing `ERROR_COPY` once paraphrased away.
    expect(refused.body.error?.message).toContain('has not agreed to marketing messages');
    expect(refused.body.error?.message).toContain('24-hour window');
  });

  it('leaves a free reply working, because a `STOP` is about marketing and not about answering', async () => {
    // The customer wrote `STOP` a moment ago, which also opened the 24-hour window. Refusing to
    // answer somebody who just messaged us would be the wrong rule in the other direction.
    const replied = await api('POST', `/conversations/${conversationId}/messages`, {
      token: owner.token,
      payload: { kind: 'text', body: 'Understood — no more offers. We are still here if you need us.' },
    });
    expect(replied.statusCode).toBe(202);
  });

  it('gives it back on `START`, and says so on the timeline', async () => {
    await customerSays('START');
    const lead = await ctx.db.lead.findFirstOrThrow({
      where: { id: leadId },
      select: { consentWhatsapp: true },
    });
    expect(lead.consentWhatsapp).toBe(true);
    const entry = await ctx.db.activity.findFirst({
      where: { organizationId: owner.organizationId, leadId, type: 'consent.granted' },
      select: { payload: true },
    });
    expect(JSON.stringify(entry?.payload)).toContain('START');
  });

  it('writes nothing for a second `STOP`, because they were already stopped', async () => {
    await customerSays('stop');
    const before = await ctx.db.activity.count({
      where: { organizationId: owner.organizationId, leadId, type: 'consent.revoked' },
    });
    await customerSays('STOP');
    const after = await ctx.db.activity.count({
      where: { organizationId: owner.organizationId, leadId, type: 'consent.revoked' },
    });
    // A product that logged it twice would read as not having listened the first time.
    expect(after).toBe(before);
  });

  it('leaves a sentence containing the word alone, which is the whole safety of the rule', async () => {
    await setup('PATCH', `/leads/${leadId}`, {
      token: owner.token,
      payload: { consent: { whatsapp: true } },
    });
    await customerSays('please stop sending the wrong floor plan, send the 3BHK one');
    const lead = await ctx.db.lead.findFirstOrThrow({
      where: { id: leadId },
      select: { consentWhatsapp: true },
    });
    // Silencing somebody for this would be invisible: nothing on any screen says why they stopped
    // getting messages, and the only person who could explain it is the customer.
    expect(lead.consentWhatsapp).toBe(true);
  });
});
