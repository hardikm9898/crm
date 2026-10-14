import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId, newToken } from '@leados/shared';
import { TokenService } from '../src/modules/auth/application/token.service.js';
import { bootTestApp, call, cleanupUsers, type EnvelopeBody, type TestApp } from './app-harness.js';

/**
 * THE TODAY SUITE (`FR-TSK-7`).
 *
 * The screen an executive opens first, and the exit criterion that it arrives in **one request**.
 * So what this suite asserts is mostly about the payload as a whole rather than about any one
 * section:
 *
 *  * every count is an aggregate over the whole set, not the length of the page it ships with —
 *    the mistake the pipeline board and the SLA board each made once;
 *  * the three task sections are non-overlapping and together are exactly the open work due by the
 *    end of the workspace's day, which is the property that lets the counts be believed;
 *  * it is **mine**, with no parameter that makes it anybody else's;
 *  * a section the caller may not read is marked unavailable rather than quietly empty, because an
 *    empty list and a forbidden one are indistinguishable on a screen and must not be.
 */

const SUFFIX = newToken(4)
  .toLowerCase()
  .replace(/[^a-z0-9]/g, '');
const EMAIL_MARKER = `e2etoday${SUFFIX}`;
const PASSWORD = 'a quiet november harbour';

let ctx: TestApp;
let owner: Tenant;
let colleague: { token: string; userId: string };

interface Tenant {
  token: string;
  organizationId: string;
  userId: string;
}

interface TaskCard {
  id: string;
  title: string;
  status: string;
  bucket: string;
  priority: string;
  dueAt: string;
  minutesUntilDue: number;
  rescheduleCount: number;
  taskType: { id: string; name: string } | null;
  leadId: string | null;
  lead: {
    id: string;
    fullName: string;
    phoneE164: string | null;
    score: number;
    scoreBand: string | null;
    valueMinor: number | null;
    currency: string | null;
    source: { id: string; name: string } | null;
  } | null;
}

interface LeadCard {
  id: string;
  fullName: string;
  phoneE164: string | null;
  createdAt: string;
  promise: { id: string; dueAt: string; health: string; minutesLeft: number } | null;
}

interface ClockCard {
  id: string;
  target: string;
  health: string;
  dueAt: string;
  minutesLeft: number;
  lead: { id: string; fullName: string } | null;
}

interface Section<T> {
  count: number;
  items: T[];
  truncated: boolean;
  available: boolean;
}

interface TodayBody {
  generatedAt: string;
  timeZone: string;
  for: { userId: string | null };
  counts: {
    overdue: number;
    dueNow: number;
    laterToday: number;
    upcoming: number;
    awaitingFirstContact: number;
    noNextAction: number;
    promisesBreached: number;
    promisesAtRisk: number;
    unacknowledgedEscalations: number;
  };
  sections: {
    overdue: Section<TaskCard>;
    dueNow: Section<TaskCard>;
    laterToday: Section<TaskCard>;
    awaitingFirstContact: Section<LeadCard>;
    promisesRunningOut: Section<ClockCard>;
  };
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

/** A setup call whose status nobody asserts fails silently and takes the assertion with it. */
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

async function today(token: string): Promise<TodayBody> {
  const response = await api<TodayBody>('GET', '/my/today', { token });
  expect(response.statusCode, JSON.stringify(response.body)).toBe(200);
  return response.body.data;
}

async function createLead(label: string, payload: Record<string, unknown> = {}): Promise<string> {
  const lead = await configure<{ id: string }>('POST', '/leads', {
    token: owner.token,
    payload: {
      firstName: label,
      lastName: 'Enquirer',
      email: `${label.toLowerCase()}.${SUFFIX}@today.test`,
      ...payload,
    },
  });
  return lead.body.data.id;
}

/**
 * A follow-up at a chosen moment.
 *
 * Due times are set through the API where they can be (the future) and moved in the database where
 * they cannot: `POST /tasks` refuses a due time in the past, which is right — nobody plans a call
 * for yesterday — and the overdue section needs one anyway.
 */
async function createTask(
  leadId: string,
  title: string,
  dueAt: Date,
  options: { priority?: string } = {},
): Promise<string> {
  const future = dueAt.getTime() > Date.now();
  const created = await configure<{ id: string }>('POST', '/tasks', {
    token: owner.token,
    payload: {
      leadId,
      title,
      dueAt: (future ? dueAt : new Date(Date.now() + 36 * 3_600_000)).toISOString(),
      ...(options.priority ? { priority: options.priority } : {}),
    },
  });
  const id = created.body.data.id;
  if (!future) {
    await ctx.db.task.update({ where: { id }, data: { dueAt, dueDate: dayOf(dueAt) } });
  }
  return id;
}

/** `due_date` is the stored local day, as the midnight-UTC instant a `date` column holds. */
function dayOf(when: Date): Date {
  const local = new Date(when.getTime() + 5.5 * 3_600_000); // the seeded workspace is Asia/Kolkata
  return new Date(`${local.toISOString().slice(0, 10)}T00:00:00.000Z`);
}

async function createMember(
  label: string,
  roleCode: string,
): Promise<{ token: string; userId: string }> {
  const role = await ctx.db.role.findFirstOrThrow({
    where: { organizationId: owner.organizationId, code: roleCode },
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
      organizationName: `Today ${SUFFIX}`,
    },
  });
  expect(registered.statusCode, JSON.stringify(registered.body)).toBe(201);
  owner = {
    token: registered.body.data.tokens.accessToken,
    organizationId: registered.body.data.activeOrganizationId,
    userId: registered.body.data.user.id,
  };
  colleague = await createMember('colleague', 'sales_executive');
}, 120_000);

afterAll(async () => {
  await cleanupUsers(ctx.db, EMAIL_MARKER);
  await ctx.close();
});

describe('the whole screen in one request (FR-TSK-7)', () => {
  it('answers with every section and every count, and says when it was generated', async () => {
    const screen = await today(owner.token);

    expect(new Date(screen.generatedAt).getTime()).toBeGreaterThan(Date.now() - 60_000);
    expect(screen.timeZone).toBe('Asia/Kolkata');
    expect(screen.for.userId).toBe(owner.userId);
    expect(Object.keys(screen.sections).sort()).toEqual([
      'awaitingFirstContact',
      'dueNow',
      'laterToday',
      'overdue',
      'promisesRunningOut',
    ]);
    // Every section the owner can read is marked readable; none is silently empty.
    for (const section of Object.values(screen.sections)) {
      expect(section.available).toBe(true);
    }
  });

  it('takes no parameters: a query string cannot make it somebody else’s screen', async () => {
    const mine = await today(owner.token);
    const leadId = await createLead('Paramproof');
    await createTask(leadId, 'Mine alone', new Date(Date.now() + 10 * 60_000));

    // Everything a client might try. The payload must be identical to the unparameterised one
    // apart from the work that was just created — no widening, no narrowing, no 400.
    for (const query of [
      '?assignedUserId=' + colleague.userId,
      '?mine=false',
      '?everyone=true',
      '?limit=500',
    ]) {
      const response = await api<TodayBody>('GET', `/my/today${query}`, { token: owner.token });
      expect(response.statusCode, query).toBe(200);
      expect(response.body.data.for.userId, query).toBe(owner.userId);
      expect(response.body.data.counts.dueNow, query).toBe(mine.counts.dueNow + 1);
    }
  });

  it('is the caller’s own queue, and shows a colleague nothing of the owner’s', async () => {
    const leadId = await createLead('Ownership');
    await createTask(leadId, 'The owner’s call', new Date(Date.now() + 15 * 60_000));

    const theirs = await today(colleague.token);
    expect(theirs.for.userId).toBe(colleague.userId);
    expect(theirs.sections.dueNow.items.map((card) => card.title)).not.toContain(
      'The owner’s call',
    );
    expect(theirs.counts.dueNow).toBe(0);
  });
});

describe('the three sections of today’s work', () => {
  it('sorts each follow-up into exactly one section, by the clock', async () => {
    const leadId = await createLead('Buckets');
    const longOverdue = await createTask(
      leadId,
      'Two days late',
      new Date(Date.now() - 48 * 3_600_000),
    );
    const justOverdue = await createTask(leadId, 'A minute late', new Date(Date.now() - 60_000));
    const soon = await createTask(leadId, 'In ten minutes', new Date(Date.now() + 10 * 60_000));
    const later = await createTask(leadId, 'In four hours', new Date(Date.now() + 4 * 3_600_000));

    const screen = await today(owner.token);
    const ids = (section: Section<TaskCard>) => section.items.map((card) => card.id);

    expect(ids(screen.sections.overdue)).toEqual(
      expect.arrayContaining([longOverdue, justOverdue]),
    );
    expect(ids(screen.sections.dueNow)).toContain(soon);
    // Four hours out is "later today" unless four hours from now is tomorrow in Kolkata, in which
    // case it is upcoming and carries no section — so this asserts the union, not the section.
    const everywhere = [
      ...ids(screen.sections.overdue),
      ...ids(screen.sections.dueNow),
      ...ids(screen.sections.laterToday),
    ];
    expect(new Set(everywhere).size).toBe(everywhere.length); // nothing appears twice
    expect(everywhere.includes(later) || screen.counts.upcoming > 0).toBe(true);

    // Each card reports the bucket its own section is named after.
    for (const card of screen.sections.overdue.items) expect(card.bucket).toBe('overdue');
    for (const card of screen.sections.dueNow.items) expect(card.bucket).toBe('due_now');
    for (const card of screen.sections.laterToday.items) expect(card.bucket).toBe('due_today');
  });

  it('reads the overdue section oldest-first, which is the order somebody apologises in', async () => {
    const leadId = await createLead('Oldestfirst');
    await createTask(leadId, 'Three days late', new Date(Date.now() - 72 * 3_600_000));

    const screen = await today(owner.token);
    const dueTimes = screen.sections.overdue.items.map((card) => new Date(card.dueAt).getTime());
    expect([...dueTimes].sort((a, b) => a - b)).toEqual(dueTimes);
    expect(screen.sections.overdue.items[0]!.minutesUntilDue).toBeLessThan(0);
  });

  it('puts the urgent call first in the next few hours, even when it is due later', async () => {
    // A fresh assignee, so this test's ordering is not read off work other tests created.
    const solo = await createMember('urgency', 'sales_executive');
    const leadId = await createLead('Urgency', { assignedUserId: solo.userId });
    await createTask(leadId, 'Routine, sooner', new Date(Date.now() + 12 * 60_000), {
      priority: 'low',
    });
    await createTask(leadId, 'Urgent, later', new Date(Date.now() + 25 * 60_000), {
      priority: 'urgent',
    });

    const screen = await today(solo.token);
    expect(screen.sections.dueNow.items.map((card) => card.title)).toEqual([
      'Urgent, later',
      'Routine, sooner',
    ]);
  });

  it('counts the whole set and ships a page, and says it was truncated', async () => {
    const solo = await createMember('manyoverdue', 'sales_executive');
    const leadId = await createLead('Manyoverdue', { assignedUserId: solo.userId });
    // One more than the section's limit of twenty.
    for (let index = 0; index < 21; index += 1) {
      await createTask(
        leadId,
        `Late call ${index}`,
        new Date(Date.now() - (index + 1) * 3_600_000),
      );
    }

    const screen = await today(solo.token);
    // The count is the aggregate, the page is the page, and the two are allowed to differ — which
    // is the whole point. A screen that reported 20 here would be lying to somebody who is behind.
    expect(screen.counts.overdue).toBe(21);
    expect(screen.sections.overdue.items).toHaveLength(20);
    expect(screen.sections.overdue.count).toBe(21);
    expect(screen.sections.overdue.truncated).toBe(true);
  });

  it('carries enough of the lead to decide from, without a second request', async () => {
    const leadId = await createLead('Richcard', {
      phone: '+919845012345',
      city: 'Pune',
      valueMinor: 5_000_000,
      currency: 'INR',
    });
    const taskId = await createTask(
      leadId,
      'Call about the 3BHK',
      new Date(Date.now() + 8 * 60_000),
    );

    const screen = await today(owner.token);
    const card = screen.sections.dueNow.items.find((item) => item.id === taskId);
    expect(card).toBeDefined();
    expect(card!.lead?.fullName).toBe('Richcard Enquirer');
    expect(card!.lead?.phoneE164).toBe('+919845012345');
    expect(card!.lead?.valueMinor).toBe(5_000_000);
    expect(card!.lead?.currency).toBe('INR');
    expect(card!.lead?.score).toBeTypeOf('number');
  });
});

describe('the leads nobody has called (FR-TSK-4, FR-TSK-8)', () => {
  it('lists uncontacted leads oldest-first with the promise running on each', async () => {
    const solo = await createMember('firstcontact', 'sales_executive');
    const first = await createLead('Firstcontactone', { assignedUserId: solo.userId });
    const second = await createLead('Firstcontacttwo', { assignedUserId: solo.userId });

    const screen = await today(solo.token);
    const ids = screen.sections.awaitingFirstContact.items.map((lead) => lead.id);
    expect(ids).toEqual([first, second]); // captured in that order, listed in that order
    expect(screen.counts.awaitingFirstContact).toBe(2);

    // The "SLA 43 min left" the screen shows, from the clock the capture started.
    const card = screen.sections.awaitingFirstContact.items[0]!;
    expect(card.promise).not.toBeNull();
    expect(card.promise!.health).toBe('running');
    expect(card.promise!.minutesLeft).toBeGreaterThan(0);
  });

  it('drops a lead from the list the moment somebody has actually spoken to it', async () => {
    const solo = await createMember('contacted', 'sales_executive');
    const leadId = await createLead('Contacted', { assignedUserId: solo.userId });
    expect((await today(solo.token)).counts.awaitingFirstContact).toBe(1);

    // What finishing a follow-up does — the only writer of `first_contacted_at` in the product.
    await ctx.db.lead.update({ where: { id: leadId }, data: { firstContactedAt: new Date() } });

    const after = await today(solo.token);
    expect(after.counts.awaitingFirstContact).toBe(0);
    expect(after.sections.awaitingFirstContact.items).toHaveLength(0);
  });

  it('shows a lead nobody has been given to the person who can hand it out', async () => {
    // What the browser check found: a workspace with no assignment rule leaves every captured
    // lead unassigned, and a Today screen that is strictly "mine" shows them to **nobody** — the
    // leads most at risk of never being called are the ones it hides.
    const before = await today(owner.token);
    const leadId = await createLead('Unclaimed');
    // Returned to the pool through the real endpoint, rather than *hoping* capture left it there.
    // The seeded round-robin rule assigns whoever is on shift, so a lead created inside the
    // workspace's working hours comes back owned — which made this test pass only when the suite
    // ran before 09:00 IST, and pass for the wrong reason the rest of the time.
    await configure('POST', `/leads/${leadId}/assign`, {
      token: owner.token,
      payload: { assignedUserId: null, reason: 'nobody has picked this up' },
    });
    const lead = await ctx.db.lead.findFirstOrThrow({ where: { id: leadId } });
    expect(lead.assignedUserId).toBeNull();

    const after = await today(owner.token);
    expect(after.counts.awaitingFirstContact).toBe(before.counts.awaitingFirstContact + 1);
    expect(after.sections.awaitingFirstContact.items.map((item) => item.id)).toContain(leadId);
  });

  it('and keeps it off the screen of somebody who could not read it anyway', async () => {
    // The data scope does this, not a second rule: an executive is scoped to their own rows, so
    // `applyScopeFilter` adds `assigned_user_id = me` on top and the unclaimed branch cannot
    // widen anything. A rule that said "mine plus unclaimed" without the scope would have shown
    // one executive another branch's untouched leads.
    const solo = await createMember('narrowscope', 'sales_executive');
    const leadId = await createLead('Unclaimedtoo');
    await configure('POST', `/leads/${leadId}/assign`, {
      token: owner.token,
      payload: { assignedUserId: null, reason: 'nobody has picked this up' },
    });

    const theirs = await today(solo.token);
    expect(theirs.sections.awaitingFirstContact.items.map((item) => item.id)).not.toContain(leadId);
    expect(theirs.counts.awaitingFirstContact).toBe(0);
  });

  it('counts the open leads with nothing planned beside it, which is a different failure', async () => {
    const solo = await createMember('silent', 'sales_executive');
    const leadId = await createLead('Silent', { assignedUserId: solo.userId });

    // A lead nobody has contacted *and* has nothing planned for is in both numbers, because it is
    // failing in both ways.
    const before = await today(solo.token);
    expect(before.counts.awaitingFirstContact).toBe(1);
    expect(before.counts.noNextAction).toBe(1);

    await createTask(leadId, 'Something planned', new Date(Date.now() + 30 * 60_000));
    const after = await today(solo.token);
    expect(after.counts.noNextAction).toBe(0);
    // Still uncontacted: planning a call is not making one.
    expect(after.counts.awaitingFirstContact).toBe(1);
  });
});

describe('the promises running out (FR-TSK-8)', () => {
  it('shows nothing while every clock is comfortable', async () => {
    const solo = await createMember('comfortable', 'sales_executive');
    await createLead('Comfortable', { assignedUserId: solo.userId });

    const screen = await today(solo.token);
    expect(screen.counts.promisesAtRisk).toBe(0);
    expect(screen.counts.promisesBreached).toBe(0);
    expect(screen.sections.promisesRunningOut.items).toHaveLength(0);
  });

  it('reads the health from the clock, not from the state the sweep last wrote', async () => {
    const solo = await createMember('fromclock', 'sales_executive');
    const leadId = await createLead('Fromclock', { assignedUserId: solo.userId });
    const clock = await ctx.db.slaClock.findFirstOrThrow({ where: { leadId } });

    // Past due, and the five-minute sweep has not run: the row still says `running`. A screen that
    // believed the column would tell somebody their 10:00 promise is fine at 10:01.
    const now = Date.now();
    await ctx.db.slaClock.update({
      where: { id: clock.id },
      data: {
        startedAt: new Date(now - 3_600_000),
        warnAt: new Date(now - 120_000),
        dueAt: new Date(now - 60_000),
      },
    });
    expect((await ctx.db.slaClock.findFirstOrThrow({ where: { id: clock.id } })).state).toBe(
      'running',
    );

    const screen = await today(solo.token);
    expect(screen.counts.promisesBreached).toBe(1);
    expect(screen.sections.promisesRunningOut.items).toHaveLength(1);
    const card = screen.sections.promisesRunningOut.items[0]!;
    expect(card.health).toBe('breached');
    expect(card.target).toBe('first_response');
    expect(card.minutesLeft).toBeLessThanOrEqual(0);
    expect(card.lead?.fullName).toBe('Fromclock Enquirer');
    // The lead's own card carries the same reading, from the same arithmetic.
    expect(screen.sections.awaitingFirstContact.items[0]!.promise!.health).toBe('breached');
  });

  it('shows an at-risk clock before it is missed, which is the point of warning at all', async () => {
    const solo = await createMember('atrisk', 'sales_executive');
    const leadId = await createLead('Atrisk', { assignedUserId: solo.userId });
    const clock = await ctx.db.slaClock.findFirstOrThrow({ where: { leadId } });
    const now = Date.now();
    await ctx.db.slaClock.update({
      where: { id: clock.id },
      data: {
        startedAt: new Date(now - 3_600_000),
        warnAt: new Date(now - 60_000),
        dueAt: new Date(now + 10 * 60_000),
      },
    });

    const screen = await today(solo.token);
    expect(screen.counts.promisesAtRisk).toBe(1);
    expect(screen.counts.promisesBreached).toBe(0);
    expect(screen.sections.promisesRunningOut.items[0]!.health).toBe('at_risk');
    expect(screen.sections.promisesRunningOut.items[0]!.minutesLeft).toBeGreaterThan(0);
  });

  it('puts the soonest deadline first, so the breaches are at the top by arithmetic', async () => {
    const solo = await createMember('ordering', 'sales_executive');
    const breachedLead = await createLead('Orderingbreached', { assignedUserId: solo.userId });
    const atRiskLead = await createLead('Orderingatrisk', { assignedUserId: solo.userId });
    const now = Date.now();
    await ctx.db.slaClock.updateMany({
      where: { leadId: breachedLead },
      data: {
        startedAt: new Date(now - 3_600_000),
        warnAt: new Date(now - 300_000),
        dueAt: new Date(now - 120_000),
      },
    });
    await ctx.db.slaClock.updateMany({
      where: { leadId: atRiskLead },
      data: {
        startedAt: new Date(now - 3_600_000),
        warnAt: new Date(now - 60_000),
        dueAt: new Date(now + 300_000),
      },
    });

    const screen = await today(solo.token);
    expect(screen.sections.promisesRunningOut.items.map((card) => card.health)).toEqual([
      'breached',
      'at_risk',
    ]);
    expect(screen.sections.promisesRunningOut.count).toBe(2);
  });
});

describe('a role that may not read everything', () => {
  it('still gives the queue, and marks the sections it withholds', async () => {
    // A role with the follow-up queue and nothing else: no `lead:read`, no `sla:read`. A 403 on the
    // whole screen would make the product's landing page unreachable for a configuration the
    // permission catalogue has always offered.
    const roleId = newId();
    await ctx.db.role.create({
      data: {
        id: roleId,
        organizationId: owner.organizationId,
        code: `tasks_only_${SUFFIX}`,
        name: 'Tasks only',
        isSystem: false,
      },
    });
    await ctx.db.rolePermission.create({
      data: {
        id: newId(),
        organizationId: owner.organizationId,
        roleId,
        permissionKey: 'task:read',
        scope: 'own',
      },
    });
    const token = newToken(32);
    await ctx.db.invitation.create({
      data: {
        id: newId(),
        organizationId: owner.organizationId,
        email: `narrow.${EMAIL_MARKER}@test.local`,
        roleId,
        tokenHash: TokenService.hashToken(token),
        expiresAt: new Date(Date.now() + 72 * 3_600_000),
      },
    });
    const accepted = await call<EnvelopeBody<{ tokens: { accessToken: string } }>>(ctx.app, {
      method: 'POST',
      url: '/api/v1/auth/invitations/accept',
      payload: { token, name: 'Narrow', password: PASSWORD },
    });
    expect(accepted.statusCode, JSON.stringify(accepted.body)).toBe(200);

    const screen = await today(accepted.body.data.tokens.accessToken);
    expect(screen.sections.overdue.available).toBe(true);
    expect(screen.sections.awaitingFirstContact.available).toBe(false);
    expect(screen.sections.promisesRunningOut.available).toBe(false);
    expect(screen.counts.awaitingFirstContact).toBe(0);
    expect(screen.counts.promisesBreached).toBe(0);
  });

  it('refuses the screen outright to somebody with no follow-up queue at all', async () => {
    const roleId = newId();
    await ctx.db.role.create({
      data: {
        id: roleId,
        organizationId: owner.organizationId,
        code: `no_tasks_${SUFFIX}`,
        name: 'No tasks',
        isSystem: false,
      },
    });
    await ctx.db.rolePermission.create({
      data: {
        id: newId(),
        organizationId: owner.organizationId,
        roleId,
        permissionKey: 'lead:read',
        scope: 'own',
      },
    });
    const token = newToken(32);
    await ctx.db.invitation.create({
      data: {
        id: newId(),
        organizationId: owner.organizationId,
        email: `notasks.${EMAIL_MARKER}@test.local`,
        roleId,
        tokenHash: TokenService.hashToken(token),
        expiresAt: new Date(Date.now() + 72 * 3_600_000),
      },
    });
    const accepted = await call<EnvelopeBody<{ tokens: { accessToken: string } }>>(ctx.app, {
      method: 'POST',
      url: '/api/v1/auth/invitations/accept',
      payload: { token, name: 'Notasks', password: PASSWORD },
    });
    expect(accepted.statusCode, JSON.stringify(accepted.body)).toBe(200);

    const refused = await api('GET', '/my/today', {
      token: accepted.body.data.tokens.accessToken,
    });
    expect(refused.statusCode).toBe(403);
  });

  it('needs a session at all', async () => {
    const anonymous = await call(ctx.app, { method: 'GET', url: '/api/v1/my/today' });
    expect(anonymous.statusCode).toBe(401);
  });
});
