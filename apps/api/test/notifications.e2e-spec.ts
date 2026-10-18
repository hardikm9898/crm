import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId, newToken } from '@leados/shared';
import { bootTestApp, call, cleanupUsers, type EnvelopeBody, type TestApp } from './app-harness.js';

/**
 * THE NOTIFICATION CENTRE SUITE (`FR-NOT-3`).
 *
 * `notification_preferences` has existed since the first migration and was read by nothing: every
 * notification this product sends went out whatever the hour and whatever the person had asked
 * for. This suite is about the three things that changes:
 *
 *  * **a type somebody switched off writes no row at all** — enforced in `create`, which is the
 *    one path all five producers go through;
 *  * **a notification arriving inside somebody's quiet hours is held**, with the release instant
 *    computed in *their* zone, and is not in their inbox or their badge until then;
 *  * **a held notification is re-checked when it is released**, so a warning written at 21:40
 *    about a follow-up finished at 08:15 never arrives — and the fact that it was held and dropped
 *    is still on the record.
 *
 * Nothing is mocked: the release is the same method the per-minute cron calls.
 */

const SUFFIX = newToken(4)
  .toLowerCase()
  .replace(/[^a-z0-9]/g, '');
const EMAIL_MARKER = `e2enotif${SUFFIX}`;
const PASSWORD = 'a quiet november harbour';

let ctx: TestApp;
let owner: Tenant;

interface Tenant {
  token: string;
  organizationId: string;
  userId: string;
}

interface PreferencesBody {
  quietHours: { startMinute: number; endMinute: number } | null;
  timeZone: string | null;
  effectiveTimeZone: string;
  workspaceTimeZone: string;
  deliverableChannels: string[];
  types: {
    type: string;
    label: string;
    hint: string;
    group: string;
    optOut: boolean;
    defaultChannels: string[];
    channels: string[] | null;
    effectiveChannels: string[];
  }[];
}

interface NotificationBody {
  id: string;
  type: string;
  title: string;
  body: string | null;
  link: string | null;
  data: Record<string, unknown>;
  readAt: string | null;
  createdAt: string;
}

async function api<T>(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  options: { token: string; payload?: unknown },
) {
  return call<EnvelopeBody<T>>(ctx.app, {
    method,
    url: `/api/v1${url}`,
    token: options.token,
    ...(options.payload === undefined ? {} : { payload: options.payload }),
  });
}

async function configure<T = unknown>(
  method: 'POST' | 'PATCH' | 'DELETE',
  url: string,
  options: { token: string; payload?: unknown },
) {
  const response = await api<T>(method, url, options);
  if (response.statusCode >= 300) {
    throw new Error(
      `setup ${method} ${url} was refused with ${response.statusCode}: ${JSON.stringify(response.body)}`,
    );
  }
  return response;
}

async function preferences(token: string): Promise<PreferencesBody> {
  const response = await api<PreferencesBody>('GET', '/notifications/preferences', { token });
  expect(response.statusCode, JSON.stringify(response.body)).toBe(200);
  return response.body.data;
}

async function inbox(token: string): Promise<NotificationBody[]> {
  const response = await api<NotificationBody[]>('GET', '/notifications?limit=50', { token });
  expect(response.statusCode, JSON.stringify(response.body)).toBe(200);
  return response.body.data;
}

async function unreadCount(token: string): Promise<number> {
  const response = await api<{ unreadCount: number }>('GET', '/notifications/unread-count', {
    token,
  });
  expect(response.statusCode).toBe(200);
  return response.body.data.unreadCount;
}

/** The service the producers call, under the tenant context a job would have. */
async function notify(input: {
  userId: string;
  type: string;
  title: string;
  data?: Record<string, unknown>;
  dedupeKey?: string;
}): Promise<string | null> {
  const { NotificationsService } =
    await import('../src/modules/notifications/notifications.service.js');
  const { tenantContext, systemPrincipal } = await import('@leados/shared');
  return tenantContext.run(systemPrincipal(owner.organizationId, newId()), async () =>
    ctx.app.get(NotificationsService).create({
      organizationId: owner.organizationId,
      userId: input.userId,
      type: input.type,
      title: input.title,
      ...(input.data ? { data: input.data } : {}),
      ...(input.dedupeKey ? { dedupeKey: input.dedupeKey } : {}),
    }),
  );
}

async function releaseSweep(): Promise<{ released: number; superseded: number }> {
  const { NotificationReleaseProcessor } =
    await import('../src/modules/notifications/notifications.processor.js');
  return ctx.app.get(NotificationReleaseProcessor).release();
}

/**
 * Sets quiet hours to a window that definitely contains *now*, whatever the wall clock says when
 * the suite runs.
 *
 * A fixed `21:00–07:00` would only exercise the hold between nine at night and seven in the
 * morning, so the test would pass for the wrong reason for sixteen hours of the day. The window is
 * computed from the workspace's own current local time instead.
 */
async function quietNow(token: string, timeZone: string): Promise<void> {
  const local = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date());
  const [hour, minute] = local.split(':').map(Number);
  const nowMinute = (hour ?? 0) * 60 + (minute ?? 0);
  // Opened an hour ago, closes in two — expressed modulo the day, so it works at 00:30 too.
  const start = (nowMinute - 60 + 1440) % 1440;
  const end = (nowMinute + 120) % 1440;
  await configure('PATCH', '/notifications/preferences', {
    token,
    payload: {
      quietHours: { start: asTime(start), end: asTime(end) },
      timeZone,
    },
  });
}

function asTime(minuteOfDay: number): string {
  const hour = Math.floor(minuteOfDay / 60);
  const minute = minuteOfDay % 60;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

async function clearQuietHours(token: string): Promise<void> {
  await configure('PATCH', '/notifications/preferences', {
    token,
    payload: { quietHours: null },
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
      name: 'Owner',
      organizationName: `Notif ${SUFFIX}`,
    },
  });
  expect(registered.statusCode, JSON.stringify(registered.body)).toBe(201);
  owner = {
    token: registered.body.data.tokens.accessToken,
    organizationId: registered.body.data.activeOrganizationId,
    userId: registered.body.data.user.id,
  };
}, 120_000);

afterAll(async () => {
  await cleanupUsers(ctx.db, EMAIL_MARKER);
  await ctx.close();
});

describe('what a new member starts with', () => {
  it('has no quiet hours, and falls back to the workspace’s zone', async () => {
    const settings = await preferences(owner.token);
    expect(settings.quietHours).toBeNull();
    expect(settings.timeZone).toBeNull();
    // The only honest default: nobody can be asked where they are before they have signed in once.
    expect(settings.effectiveTimeZone).toBe('Asia/Kolkata');
    expect(settings.workspaceTimeZone).toBe('Asia/Kolkata');
  });

  it('offers every type the product actually sends, and only the channels it can deliver', async () => {
    const settings = await preferences(owner.token);
    // `email` joined the list in step 7, when there was a sender behind it. `whatsapp` and `push`
    // have not, and the screen still says so rather than offering a tick box that drops messages.
    expect(settings.deliverableChannels).toEqual(['in_app', 'email']);
    expect(settings.types.map((entry) => entry.type).sort()).toEqual([
      // Phase 3 step 6: the nudge that asks what happened on a call nobody recorded.
      'call.outcome_missing',
      'lead.unassigned_pool',
      'member.joined',
      'sla.at_risk',
      'sla.breached',
      'task.overdue',
      'task.reminder',
      'trial.expired',
      // Phase 4 step 3: an endpoint the product stopped posting to. Like `trial.expired`, it
      // cannot be switched off — an integration disabled silently is one nobody can diagnose.
      'webhook.disabled',
    ]);
    for (const entry of settings.types) {
      // A switch with no sentence under it is a switch somebody turns off to find out what it does.
      expect(entry.label, entry.type).toBeTruthy();
      expect(entry.hint, entry.type).toBeTruthy();
      // Untouched: the screen can say "default" rather than inventing a state.
      expect(entry.channels, entry.type).toBeNull();
      expect(entry.effectiveChannels, entry.type).toEqual(['in_app']);
    }
  });
});

describe('switching a type off (FR-NOT-3)', () => {
  it('writes no notification at all, rather than one nobody sees', async () => {
    await configure('PATCH', '/notifications/preferences', {
      token: owner.token,
      payload: { types: [{ type: 'member.joined', channels: [] }] },
    });

    const id = await notify({
      userId: owner.userId,
      type: 'member.joined',
      title: 'Somebody joined',
    });
    // `null`, and no row: a notification nobody will ever see is not a record worth keeping, and
    // leaving one would make the unread badge and the list disagree about what "off" means.
    expect(id).toBeNull();
    const rows = await ctx.db.notification.count({
      where: { organizationId: owner.organizationId, type: 'member.joined' },
    });
    expect(rows).toBe(0);
  });

  it('turns it back on, and the next one arrives', async () => {
    await configure('PATCH', '/notifications/preferences', {
      token: owner.token,
      payload: { types: [{ type: 'member.joined', channels: ['in_app'] }] },
    });
    const id = await notify({
      userId: owner.userId,
      type: 'member.joined',
      title: 'Somebody else joined',
    });
    expect(id).not.toBeNull();
    expect((await inbox(owner.token)).map((row) => row.title)).toContain('Somebody else joined');
  });

  it('refuses to switch off the notice that explains the product refusing to work', async () => {
    const refused = await api('PATCH', '/notifications/preferences', {
      token: owner.token,
      payload: { types: [{ type: 'trial.expired', channels: [] }] },
    });
    expect(refused.statusCode).toBe(422);
    expect(JSON.stringify(refused.body)).toMatch(/cannot be switched off/);
  });

  it('refuses a channel nothing can deliver on, rather than storing a promise it breaks', async () => {
    const refused = await api('PATCH', '/notifications/preferences', {
      token: owner.token,
      payload: { types: [{ type: 'task.overdue', channels: ['whatsapp'] }] },
    });
    expect(refused.statusCode).toBe(400);
    expect(JSON.stringify(refused.body)).toMatch(/arrive with their channels/);
  });

  it('accepts email now that there is a sender behind it', async () => {
    const accepted = await api('PATCH', '/notifications/preferences', {
      token: owner.token,
      payload: { types: [{ type: 'task.overdue', channels: ['in_app', 'email'] }] },
    });
    expect(accepted.statusCode).toBe(200);
    const settings = await preferences(owner.token);
    const overdue = settings.types.find((entry) => entry.type === 'task.overdue');
    expect(overdue?.channels).toEqual(['in_app', 'email']);
    expect(overdue?.effectiveChannels).toEqual(['in_app', 'email']);
    // Put back, so the suites that follow see the default.
    await api('PATCH', '/notifications/preferences', {
      token: owner.token,
      payload: { types: [{ type: 'task.overdue', channels: ['in_app'] }] },
    });
  });

  it('refuses a type the product does not send', async () => {
    const refused = await api('PATCH', '/notifications/preferences', {
      token: owner.token,
      payload: { types: [{ type: 'lead.telepathy', channels: ['in_app'] }] },
    });
    expect(refused.statusCode).toBe(400);
  });
});

describe('quiet hours', () => {
  it('refuses a window whose ends are the same, because nobody can tell what it means', async () => {
    const refused = await api('PATCH', '/notifications/preferences', {
      token: owner.token,
      payload: { quietHours: { start: '21:00', end: '21:00' } },
    });
    expect(refused.statusCode).toBe(400);
    expect(JSON.stringify(refused.body)).toMatch(/start and an end that differ/);
  });

  it('refuses a time that is not one', async () => {
    for (const start of ['9:00', '24:00', '21:60', 'half nine']) {
      const refused = await api('PATCH', '/notifications/preferences', {
        token: owner.token,
        payload: { quietHours: { start, end: '07:00' } },
      });
      expect(refused.statusCode, start).toBe(400);
    }
  });

  it('refuses a timezone this system does not know', async () => {
    const refused = await api('PATCH', '/notifications/preferences', {
      token: owner.token,
      payload: { timeZone: 'Mars/Olympus_Mons' },
    });
    expect(refused.statusCode).toBe(400);
  });

  it('stores the window and says which zone it is read in', async () => {
    await configure('PATCH', '/notifications/preferences', {
      token: owner.token,
      payload: { quietHours: { start: '21:30', end: '07:00' }, timeZone: 'Europe/Berlin' },
    });
    const settings = await preferences(owner.token);
    expect(settings.quietHours).toEqual({ startMinute: 21 * 60 + 30, endMinute: 7 * 60 });
    expect(settings.timeZone).toBe('Europe/Berlin');
    expect(settings.effectiveTimeZone).toBe('Europe/Berlin');
    // The workspace's own is still reported, so a screen can say "the workspace uses Asia/Kolkata".
    expect(settings.workspaceTimeZone).toBe('Asia/Kolkata');
  });

  it('leaves the window alone when only the type list is sent', async () => {
    // The reason `PATCH` is not `PUT`: a tab open on half this screen must not clear the other
    // half. An absent key means "unchanged", and `null` is the way to clear it.
    await configure('PATCH', '/notifications/preferences', {
      token: owner.token,
      payload: { types: [{ type: 'task.overdue', channels: ['in_app'] }] },
    });
    const settings = await preferences(owner.token);
    expect(settings.quietHours).toEqual({ startMinute: 21 * 60 + 30, endMinute: 7 * 60 });
  });

  it('clears the window when asked explicitly', async () => {
    await clearQuietHours(owner.token);
    expect((await preferences(owner.token)).quietHours).toBeNull();
  });

  it('holds a notification that arrives inside the window, out of the inbox and the badge', async () => {
    await quietNow(owner.token, 'Asia/Kolkata');
    const before = await unreadCount(owner.token);

    const id = await notify({
      userId: owner.userId,
      type: 'lead.unassigned_pool',
      title: 'A lead nobody has been given',
    });
    // The row exists — it is a commitment to tell somebody, not a dropped message.
    expect(id).not.toBeNull();
    const row = await ctx.db.notification.findFirstOrThrow({ where: { id: id! } });
    expect(row.deferredUntil).not.toBeNull();
    expect(row.deferredUntil!.getTime()).toBeGreaterThan(Date.now());
    // And it records the hold in its own payload, so the screen can say "held until 07:00" after
    // the column has been cleared by the release.
    expect((row.data as Record<string, unknown>)['heldUntil']).toBe(
      row.deferredUntil!.toISOString(),
    );

    // Not in the inbox, and — the part that matters — not in the count either. A badge that counts
    // rows the list hides is how a screen stops being believed.
    expect((await inbox(owner.token)).map((entry) => entry.id)).not.toContain(id);
    expect(await unreadCount(owner.token)).toBe(before);
  });

  it('cannot be marked read while it is still held', async () => {
    const held = await ctx.db.notification.findFirstOrThrow({
      where: { organizationId: owner.organizationId, deferredUntil: { not: null } },
    });
    const refused = await api('POST', `/notifications/${held.id}/read`, { token: owner.token });
    expect(refused.statusCode).toBe(404);
  });

  it('releases it once the window has closed', async () => {
    const held = await ctx.db.notification.findFirstOrThrow({
      where: { organizationId: owner.organizationId, deferredUntil: { not: null } },
    });
    // What waiting until morning does.
    await ctx.db.notification.update({
      where: { id: held.id },
      data: { deferredUntil: new Date(Date.now() - 60_000) },
    });

    const result = await releaseSweep();
    expect(result.released).toBeGreaterThanOrEqual(1);

    const after = await ctx.db.notification.findFirstOrThrow({ where: { id: held.id } });
    expect(after.deferredUntil).toBeNull();
    expect(after.supersededAt).toBeNull();
    expect((await inbox(owner.token)).map((entry) => entry.id)).toContain(held.id);
  });

  it('lets a notification straight through outside the window', async () => {
    await clearQuietHours(owner.token);
    const id = await notify({
      userId: owner.userId,
      type: 'lead.unassigned_pool',
      title: 'Another unassigned lead',
    });
    const row = await ctx.db.notification.findFirstOrThrow({ where: { id: id! } });
    expect(row.deferredUntil).toBeNull();
    expect((await inbox(owner.token)).map((entry) => entry.id)).toContain(id);
  });
});

describe('a held notification that stopped mattering', () => {
  /** A lead and a follow-up on it, as the reminder and overdue producers would have. */
  async function followUp(title: string): Promise<{ taskId: string; leadId: string }> {
    const lead = await configure<{ id: string }>('POST', '/leads', {
      token: owner.token,
      payload: {
        firstName: title.replace(/[^A-Za-z]/g, ''),
        lastName: 'Enquirer',
        email: `${title.replace(/[^a-z]/gi, '').toLowerCase()}.${SUFFIX}@notif.test`,
      },
    });
    const task = await configure<{ id: string }>('POST', '/tasks', {
      token: owner.token,
      payload: {
        leadId: lead.body.data.id,
        title,
        dueAt: new Date(Date.now() + 4 * 3_600_000).toISOString(),
      },
    });
    return { taskId: task.body.data.id, leadId: lead.body.data.id };
  }

  it('drops an overdue notice about a follow-up that has since been finished', async () => {
    const { taskId } = await followUp('Ring them back');
    await quietNow(owner.token, 'Asia/Kolkata');
    const id = await notify({
      userId: owner.userId,
      type: 'task.overdue',
      title: 'Overdue: Ring them back',
      data: { taskId },
    });
    expect(id).not.toBeNull();

    // Somebody does the work at 08:15, before the window closes at 09:00.
    const config = await api<{ outcomes: { id: string; requiresNote: boolean }[] }>(
      'GET',
      '/tasks/config',
      { token: owner.token },
    );
    const outcome = config.body.data.outcomes.find((entry) => !entry.requiresNote)!;
    await configure('POST', `/tasks/${taskId}/complete`, {
      token: owner.token,
      payload: { outcomeId: outcome.id },
    });

    await ctx.db.notification.update({
      where: { id: id! },
      data: { deferredUntil: new Date(Date.now() - 60_000) },
    });
    const result = await releaseSweep();
    expect(result.superseded).toBeGreaterThanOrEqual(1);

    const row = await ctx.db.notification.findFirstOrThrow({ where: { id: id! } });
    // Kept, not deleted: "was I ever told?" has an answer, and the answer is "no, and here is why".
    expect(row.supersededAt).not.toBeNull();
    expect(row.deferredUntil).toBeNull();
    expect((await inbox(owner.token)).map((entry) => entry.id)).not.toContain(id);
  });

  it('delivers an overdue notice about a follow-up still owed', async () => {
    const { taskId } = await followUp('Still owed');
    await quietNow(owner.token, 'Asia/Kolkata');
    const id = await notify({
      userId: owner.userId,
      type: 'task.overdue',
      title: 'Overdue: Still owed',
      data: { taskId },
    });
    await ctx.db.notification.update({
      where: { id: id! },
      data: { deferredUntil: new Date(Date.now() - 60_000) },
    });
    await releaseSweep();

    const row = await ctx.db.notification.findFirstOrThrow({ where: { id: id! } });
    expect(row.supersededAt).toBeNull();
    expect((await inbox(owner.token)).map((entry) => entry.id)).toContain(id);
  });

  it('still delivers a missed-promise notice, because a breach is a fact about the past', async () => {
    const { leadId } = await followUp('Breach subject');
    const clock = await ctx.db.slaClock.findFirstOrThrow({ where: { leadId } });
    // The promise was answered overnight. The warning would be absurd; the breach is not.
    await ctx.db.slaClock.update({
      where: { id: clock.id },
      data: { state: 'satisfied', satisfiedAt: new Date(), satisfiedBy: 'answered' },
    });

    await quietNow(owner.token, 'Asia/Kolkata');
    const warning = await notify({
      userId: owner.userId,
      type: 'sla.at_risk',
      title: 'SLA running out',
      data: { clockId: clock.id },
    });
    const breach = await notify({
      userId: owner.userId,
      type: 'sla.breached',
      title: 'SLA missed',
      data: { clockId: clock.id },
    });

    await ctx.db.notification.updateMany({
      where: { id: { in: [warning!, breach!] } },
      data: { deferredUntil: new Date(Date.now() - 60_000) },
    });
    await releaseSweep();

    const warningRow = await ctx.db.notification.findFirstOrThrow({ where: { id: warning! } });
    const breachRow = await ctx.db.notification.findFirstOrThrow({ where: { id: breach! } });
    expect(warningRow.supersededAt, 'a warning about an answered clock is noise').not.toBeNull();
    expect(breachRow.supersededAt, 'a missed promise stays missed').toBeNull();
    expect((await inbox(owner.token)).map((entry) => entry.id)).toContain(breach);
  });

  it('delivers a type with no staleness check rather than dropping it', async () => {
    // A producer added without a registry entry should be visible and annoying, not silent.
    await quietNow(owner.token, 'Asia/Kolkata');
    const id = await notify({
      userId: owner.userId,
      type: 'something.nobody.registered',
      title: 'An unregistered notice',
    });
    await ctx.db.notification.update({
      where: { id: id! },
      data: { deferredUntil: new Date(Date.now() - 60_000) },
    });
    await releaseSweep();
    const row = await ctx.db.notification.findFirstOrThrow({ where: { id: id! } });
    expect(row.supersededAt).toBeNull();
    expect(row.deferredUntil).toBeNull();
  });

  it('is idempotent: a second sweep over the same rows settles nothing twice', async () => {
    await clearQuietHours(owner.token);
    const again = await releaseSweep();
    expect(again).toEqual({ released: 0, superseded: 0 });
  });
});

describe('whose settings they are', () => {
  it('needs a session', async () => {
    const anonymous = await call(ctx.app, {
      method: 'GET',
      url: '/api/v1/notifications/preferences',
    });
    expect(anonymous.statusCode).toBe(401);
  });

  it('answers with the caller’s own, never another member’s', async () => {
    const colleague = await addMember('colleague');
    await configure('PATCH', '/notifications/preferences', {
      token: colleague.token,
      payload: { quietHours: { start: '20:00', end: '06:00' }, timeZone: 'Asia/Dubai' },
    });

    // The owner's are untouched by the colleague's write, and there is no route that reads or
    // writes somebody else's: a preference a manager can change is not a preference.
    expect((await preferences(owner.token)).timeZone).not.toBe('Asia/Dubai');
    const theirs = await preferences(colleague.token);
    expect(theirs.timeZone).toBe('Asia/Dubai');
    expect(theirs.quietHours).toEqual({ startMinute: 20 * 60, endMinute: 6 * 60 });

    const rows = await ctx.db.notificationSetting.count({
      where: { organizationId: owner.organizationId },
    });
    expect(rows).toBe(2);
  });
});

async function addMember(label: string): Promise<{ token: string; userId: string }> {
  const { TokenService } = await import('../src/modules/auth/application/token.service.js');
  const role = await ctx.db.role.findFirstOrThrow({
    where: { organizationId: owner.organizationId, code: 'sales_executive' },
  });
  const token = newToken(32);
  await ctx.db.invitation.create({
    data: {
      id: newId(),
      organizationId: owner.organizationId,
      email: `${label}.${EMAIL_MARKER}@test.local`,
      roleId: role.id,
      tokenHash: TokenService.hashToken(token),
      expiresAt: new Date(Date.now() + 72 * 3_600_000),
    },
  });
  const accepted = await call<
    EnvelopeBody<{ tokens: { accessToken: string }; user: { id: string } }>
  >(ctx.app, {
    method: 'POST',
    url: '/api/v1/auth/invitations/accept',
    payload: { token, name: `Member ${label}`, password: PASSWORD },
  });
  expect(accepted.statusCode, JSON.stringify(accepted.body)).toBe(200);
  return { token: accepted.body.data.tokens.accessToken, userId: accepted.body.data.user.id };
}
