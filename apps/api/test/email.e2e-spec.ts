import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newToken } from '@leados/shared';
import { bootTestApp, call, cleanupUsers, type EnvelopeBody, type TestApp } from './app-harness.js';
import { EmailSenderService } from '../src/infra/mail/email-sender.service.js';
import { EmailSuppressionService } from '../src/infra/mail/email-suppression.service.js';

/**
 * THE EMAIL SUITE.
 *
 * `FR-PRV-2` asks for a suppression list "checked at send time"; `FR-NOT-2` and `FR-NOT-3` ask for
 * email as a per-type channel with quiet hours. The point of this step is that the product can say
 * **why** a message never arrived — so the assertions that matter are the ones about refusals:
 *
 *  * that a bounced address stops everything, and a complaint stops everything *except* the
 *    password reset the person themselves asked for;
 *  * that the refusal is a recorded row naming the suppression, not an exception and not silence;
 *  * that the webhook — the only writer of the list — is unauthenticated nowhere, idempotent, and
 *    answers 200 to an event it does not understand;
 *  * that a soft bounce suppresses nothing, because a full mailbox is not a dead mailbox;
 *  * that a workspace is *told* when one of its members cannot be emailed.
 *
 * Nothing is mocked. The driver is the real development one, which logs instead of sending and
 * returns a real message id — which is exactly what makes the bounce path testable here.
 */

const SUFFIX = newToken(4)
  .toLowerCase()
  .replace(/[^a-z0-9]/g, '');
const EMAIL_MARKER = `e2email${SUFFIX}`;
const PASSWORD = 'a quiet november harbour';

let ctx: TestApp;
let owner: { token: string; organizationId: string; userId: string; email: string };
let sender: EmailSenderService;
let suppressions: EmailSuppressionService;

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

/** One address per test: a shared one would carry the previous test's suppression. */
let addressCounter = 0;
function freshAddress(label: string): string {
  addressCounter += 1;
  return `${label}.${addressCounter}.${SUFFIX}@mail.test`;
}

async function messagesFor(address: string) {
  return ctx.db.emailMessage.findMany({
    where: { to: address.toLowerCase() },
    orderBy: { queuedAt: 'asc' },
  });
}

beforeAll(async () => {
  ctx = await bootTestApp();
  const registered = await call<
    EnvelopeBody<{
      tokens: { accessToken: string };
      activeOrganizationId: string;
      user: { id: string };
    }>
  >(ctx.app, {
    method: 'POST',
    url: '/api/v1/auth/register',
    payload: {
      email: `owner.${EMAIL_MARKER}@test.local`,
      password: PASSWORD,
      name: 'Rahul Verma',
      organizationName: `Email ${SUFFIX}`,
    },
  });
  owner = {
    token: registered.body.data.tokens.accessToken,
    organizationId: registered.body.data.activeOrganizationId,
    userId: registered.body.data.user.id,
    email: `owner.${EMAIL_MARKER}@test.local`,
  };
  sender = ctx.app.get(EmailSenderService);
  suppressions = ctx.app.get(EmailSuppressionService);
}, 120_000);

afterAll(async () => {
  await cleanupUsers(ctx.db, EMAIL_MARKER);
  await ctx.close();
});

describe('every send is recorded (FR-PRV-2)', () => {
  it('writes a row with the provider and its message id', async () => {
    const to = freshAddress('plain');
    const outcome = await sender.send({
      to,
      kind: 'invitation',
      subject: 'You have been invited',
      text: 'Come and join.',
    });
    expect(outcome.status).toBe('sent');

    const [row] = await messagesFor(to);
    expect(row?.status).toBe('sent');
    expect(row?.kind).toBe('invitation');
    // The development driver still returns an id, which is what makes the bounce path testable
    // without a provider account.
    expect(row?.providerMessageId).toBeTruthy();
    expect(row?.provider).toBe('log');
    expect(row?.sentAt).not.toBeNull();
  });

  it('lower-cases the address, so the suppression list can ever match it', async () => {
    const to = freshAddress('MixedCase');
    await sender.send({ to, kind: 'invitation', subject: 'Hello', text: 'Hello.' });
    const [row] = await messagesFor(to);
    expect(row?.to).toBe(to.toLowerCase());
  });

  it('refuses an address that is not an address, and records why', async () => {
    const outcome = await sender.send({
      to: 'not-an-address',
      kind: 'invitation',
      subject: 'Hello',
      text: 'Hello.',
    });
    expect(outcome.status).toBe('failed');
    expect(outcome.reason).toMatch(/not valid/i);

    // Deliberately **not** on the suppression list: that list holds mailboxes, which is what
    // `email_suppressions_identifier_is_an_address` says, and the sender refuses this every time
    // anyway — a stronger guarantee than a row an operator could release.
    expect(await suppressions.find('not-an-address')).toBeNull();
    const [row] = await messagesFor('not-an-address');
    expect(row?.status).toBe('failed');
    expect(row?.provider).toBeNull();
  });
});

describe('a suppressed address is refused, and the refusal is recorded', () => {
  it('stops everything once the mailbox has bounced', async () => {
    const to = freshAddress('bounced');
    await suppressions.record({ address: to, reason: 'bounce', detail: 'user unknown' });

    for (const kind of [
      'invitation',
      'notification',
      'password_reset',
      'security_notice',
    ] as const) {
      const outcome = await sender.send({ to, kind, subject: 'Hello', text: 'Hello.' });
      expect(outcome.status, kind).toBe('suppressed');
      expect(outcome.reason, kind).toMatch(/bounce/);
    }

    const rows = await messagesFor(to);
    expect(rows).toHaveLength(4);
    for (const row of rows) {
      // The row names the suppression that stopped it, which is what makes "why did this never
      // arrive" answerable — and it did not also claim to have been sent.
      expect(row.status).toBe('suppressed');
      expect(row.suppressionId).not.toBeNull();
      expect(row.sentAt).toBeNull();
      expect(row.provider).toBeNull();
    }
  });

  it('still lets somebody reset their own password after they complained', async () => {
    const to = freshAddress('complained');
    await suppressions.record({ address: to, reason: 'complaint', detail: 'marked as spam' });

    const reset = await sender.send({
      to,
      kind: 'password_reset',
      subject: 'Reset your password',
      text: 'Here.',
    });
    // A complaint is a request to stop being *contacted*. Treating it as consent to be locked out
    // of your own account is the kind of literal-mindedness that loses a customer.
    expect(reset.status).toBe('sent');

    const notification = await sender.send({
      to,
      kind: 'notification',
      subject: 'A follow-up is overdue',
      text: 'Here.',
    });
    expect(notification.status).toBe('suppressed');
  });

  it('keeps one row per mailbox, however many bounces arrive', async () => {
    const to = freshAddress('twice');
    const first = await suppressions.record({ address: to, reason: 'bounce' });
    const second = await suppressions.record({ address: to, reason: 'complaint' });
    // Upsert, not check-then-insert: a webhook is at-least-once and two deliveries of the same
    // bounce arrive concurrently. The first reason wins — an address that does not exist is still,
    // first and most importantly, an address that does not exist.
    expect(second.id).toBe(first.id);
    expect(second.reason).toBe('bounce');
  });

  it('matches whatever case the address was written in', async () => {
    const to = freshAddress('CaseBounce');
    await suppressions.record({ address: to.toUpperCase(), reason: 'bounce' });
    const outcome = await sender.send({ to, kind: 'invitation', subject: 'Hi', text: 'Hi.' });
    expect(outcome.status).toBe('suppressed');
  });
});

describe('the delivery webhook — the only writer of the list', () => {
  async function post(payload: unknown, headers: Record<string, string> = {}) {
    return api<{ received: number; matched: number; suppressed: number }>(
      'POST',
      '/webhooks/email',
      { payload, headers },
    );
  }

  it('is public, because a provider has no session', async () => {
    const response = await post([]);
    expect(response.statusCode).toBe(200);
    expect(response.body.data.received).toBe(0);
  });

  it('turns a hard bounce into a suppression, and marks the message', async () => {
    const to = freshAddress('webhook-bounce');
    const outcome = await sender.send({ to, kind: 'invitation', subject: 'Hi', text: 'Hi.' });
    const [sent] = await messagesFor(to);

    const response = await post([
      {
        event: 'bounced',
        providerMessageId: sent!.providerMessageId,
        recipient: to,
        detail: 'user unknown',
      },
    ]);
    expect(response.statusCode).toBe(200);
    expect(response.body.data).toEqual({ received: 1, matched: 1, suppressed: 1 });

    const [after] = await messagesFor(to);
    expect(after?.status).toBe('bounced');
    expect(after?.error).toMatch(/user unknown/);
    expect(await suppressions.find(to)).not.toBeNull();
    expect(outcome.status).toBe('sent');
  });

  it('is idempotent, because a provider delivers at least once', async () => {
    const to = freshAddress('webhook-twice');
    await sender.send({ to, kind: 'invitation', subject: 'Hi', text: 'Hi.' });
    const [sent] = await messagesFor(to);
    const event = { event: 'bounced', providerMessageId: sent!.providerMessageId, recipient: to };

    const first = await post([event]);
    const second = await post([event]);
    expect(first.body.data.matched).toBe(1);
    expect(second.body.data.matched).toBe(1);
    const rows = await ctx.db.emailSuppression.findMany({
      where: { identifier: to.toLowerCase() },
    });
    expect(rows).toHaveLength(1);
    expect(await messagesFor(to)).toHaveLength(1);
  });

  it('suppresses nothing for a soft failure', async () => {
    const to = freshAddress('soft');
    await sender.send({ to, kind: 'invitation', subject: 'Hi', text: 'Hi.' });
    const [sent] = await messagesFor(to);

    const response = await post([
      {
        event: 'failed',
        providerMessageId: sent!.providerMessageId,
        recipient: to,
        detail: 'mailbox full',
      },
    ]);
    expect(response.body.data.suppressed).toBe(0);
    // A full mailbox is a reason to try again, not a reason to stop writing to somebody for ever.
    expect(await suppressions.find(to)).toBeNull();
    expect((await messagesFor(to))[0]?.status).toBe('failed');
  });

  it('marks a delivery, and does not pretend it was delivered before it was sent', async () => {
    const to = freshAddress('delivered');
    await sender.send({ to, kind: 'notification', subject: 'Hi', text: 'Hi.' });
    const [sent] = await messagesFor(to);
    await post([{ event: 'delivered', providerMessageId: sent!.providerMessageId, recipient: to }]);
    const [after] = await messagesFor(to);
    expect(after?.status).toBe('delivered');
    expect(after?.deliveredAt).not.toBeNull();
    expect(after!.deliveredAt!.getTime()).toBeGreaterThanOrEqual(after!.sentAt!.getTime());
  });

  it('answers 200 to an event it does not understand', async () => {
    // A 4xx teaches a provider to retry and then disable the endpoint, which would silently stop
    // the suppression list being filled — the expensive failure, not the loud one.
    const response = await post([{ RecordType: 'Open', MessageID: 'whatever' }]);
    expect(response.statusCode).toBe(200);
    expect(response.body.data.received).toBe(0);
  });

  it('suppresses an address even when it does not remember sending to it', async () => {
    const to = freshAddress('unknown-send');
    const response = await post([
      { event: 'bounced', providerMessageId: 'never-sent-this', recipient: to },
    ]);
    // A bounce is a fact about the mailbox; forgetting the send does not make the mailbox work.
    expect(response.body.data).toEqual({ received: 1, matched: 0, suppressed: 1 });
    expect(await suppressions.find(to)).not.toBeNull();
  });

  it('refuses to put something that is not an address on the list', async () => {
    const response = await post([
      { event: 'bounced', providerMessageId: 'nope', recipient: 'not-an-address' },
    ]);
    expect(response.body.data.suppressed).toBe(0);
  });
});

describe('one registration is one verification email', () => {
  it('emits one `user.registered`, not two', async () => {
    // Found by the delivery log on its first run against a real registration: `register` emitted
    // `user.registered` inside its own transaction **and** called `requestEmailVerification`,
    // which emits the same event again — so every new user got two links, the second superseding
    // the first. Invisible for four phases, because nothing recorded that a send had happened.
    //
    // Asserted on the **event** rather than on the email, because this harness runs no worker:
    // one event is what makes one send, and it is the half the bug was in.
    const events = await ctx.db.outboxEvent.findMany({
      where: { eventName: 'user.registered', aggregateId: owner.userId },
    });
    expect(events).toHaveLength(1);
  });

  it('and the processor turns that one event into one recorded send', async () => {
    const { EmailVerificationMailProcessor } =
      await import('../src/modules/auth/processors/credential-mail.processor.js');
    await ctx.app
      .get(EmailVerificationMailProcessor)
      .process({ organizationId: null, aggregateId: owner.userId } as never, {} as never);

    const rows = await ctx.db.emailMessage.findMany({
      where: { to: owner.email, kind: 'email_verification' },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('sent');
  });
});

describe('what a workspace is told (FR-PRV-2)', () => {
  it('marks a member the platform cannot email, with the reason', async () => {
    await suppressions.record({
      address: owner.email,
      reason: 'bounce',
      detail: 'mailbox does not exist',
    });

    const members = await api<
      { userId: string; email: string; emailSuppressed: { reason: string } | null }[]
    >('GET', '/users?limit=50', { token: owner.token });
    expect(members.statusCode).toBe(200);
    const row = members.body.data.find((member) => member.userId === owner.userId);
    // The alternative is silence: a colleague whose address bounced stops receiving every
    // notification they chose email for, and nothing anywhere would say so.
    expect(row?.emailSuppressed?.reason).toBe('bounce');

    await suppressions.release(owner.email);
    const after = await api<{ userId: string; emailSuppressed: unknown }[]>(
      'GET',
      '/users?limit=50',
      {
        token: owner.token,
      },
    );
    expect(
      after.body.data.find((member) => member.userId === owner.userId)?.emailSuppressed,
    ).toBeNull();
  });
});

describe('email as a notification channel (FR-NOT-2, FR-NOT-3)', () => {
  it('is offered now that there is a sender behind it', async () => {
    const settings = await api<{ deliverableChannels: string[] }>(
      'GET',
      '/notifications/preferences',
      { token: owner.token },
    );
    expect(settings.body.data.deliverableChannels).toEqual(['in_app', 'email']);
  });

  it('emails a notification the person chose email for', async () => {
    await call(ctx.app, {
      method: 'PATCH',
      url: '/api/v1/notifications/preferences',
      token: owner.token,
      payload: { types: [{ type: 'task.overdue', channels: ['in_app', 'email'] }] },
    });

    const notifications = ctx.app.get(
      (await import('../src/modules/notifications/notifications.service.js')).NotificationsService,
    );
    const id = await notifications.create({
      organizationId: owner.organizationId,
      userId: owner.userId,
      type: 'task.overdue',
      title: `Overdue: ring Priya ${SUFFIX}`,
      body: 'This was due and has not been done yet.',
      link: '/tasks',
    });
    expect(id).not.toBeNull();

    // The job is enqueued rather than sent inline: a notification must not wait for a provider.
    // Running the processor is what the worker does, and the test does exactly that.
    const { NotificationEmailProcessor } =
      await import('../src/modules/notifications/notifications.processor.js');
    await ctx.app
      .get(NotificationEmailProcessor)
      .process({ organizationId: null, notificationId: id! } as never, {} as never);

    const rows = await messagesFor(owner.email);
    const emailed = rows.find((row) => row.subject === `Overdue: ring Priya ${SUFFIX}`);
    // The email is a *delivery of the notification*, so it carries the notification's own words —
    // a second vocabulary for one event is how an email and an app tell somebody different things.
    expect(emailed).toBeDefined();
    expect(emailed?.kind).toBe('notification');
    expect(emailed?.status).toBe('sent');
  });

  it('does not email one the inbox is hiding', async () => {
    // Quiet hours promise that nothing arrives. An email at 21:40 about a row the inbox will not
    // show until 07:00 breaks the only promise they make.
    const { NotificationEmailProcessor } =
      await import('../src/modules/notifications/notifications.processor.js');
    const held = await ctx.db.notification.create({
      data: {
        id: crypto.randomUUID(),
        organizationId: owner.organizationId,
        userId: owner.userId,
        type: 'task.overdue',
        title: `Held: ring Imran ${SUFFIX}`,
        deferredUntil: new Date(Date.now() + 3_600_000),
      },
    });
    await ctx.app
      .get(NotificationEmailProcessor)
      .process({ organizationId: null, notificationId: held.id } as never, {} as never);
    const rows = await messagesFor(owner.email);
    expect(rows.find((row) => row.subject === `Held: ring Imran ${SUFFIX}`)).toBeUndefined();
  });

  it('does not email a notification that was superseded while it was held', async () => {
    const { NotificationEmailProcessor } =
      await import('../src/modules/notifications/notifications.processor.js');
    const dropped = await ctx.db.notification.create({
      data: {
        id: crypto.randomUUID(),
        organizationId: owner.organizationId,
        userId: owner.userId,
        type: 'task.overdue',
        title: `Dropped: ring Sunita ${SUFFIX}`,
        supersededAt: new Date(),
      },
    });
    await ctx.app
      .get(NotificationEmailProcessor)
      .process({ organizationId: null, notificationId: dropped.id } as never, {} as never);
    const rows = await messagesFor(owner.email);
    expect(rows.find((row) => row.subject === `Dropped: ring Sunita ${SUFFIX}`)).toBeUndefined();
  });
});
