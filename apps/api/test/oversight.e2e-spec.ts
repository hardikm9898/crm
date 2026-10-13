import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId, newToken } from '@leados/shared';
import { TokenService } from '../src/modules/auth/application/token.service.js';
import { bootTestApp, call, cleanupUsers, type EnvelopeBody, type TestApp } from './app-harness.js';

/**
 * THE OVERSIGHT SUITE (brief §4, `FR-TSK-5`, `FR-TSK-8`).
 *
 * The manager's screen: who is behind, and on what. What this suite is really about is the two
 * things such a screen gets wrong:
 *
 *  * **a number that is not an aggregate over the whole set** — the mistake the pipeline board, the
 *    SLA board and `/my/today` each made once;
 *  * **a rate computed from nothing.** A new joiner who has answered no promises is not at 0 % and
 *    not at 100 %; either answer ranks them against people who have done a month's work. It is
 *    `null`, and the screen says "—".
 *
 * Plus the thing the endpoint is *for*: a lead nobody owns appears in no person's row, so the
 * unassigned count has to be on the screen separately or it is invisible on the one page whose job
 * is to notice it.
 */

const SUFFIX = newToken(4)
  .toLowerCase()
  .replace(/[^a-z0-9]/g, '');
const EMAIL_MARKER = `e2eoversight${SUFFIX}`;
const PASSWORD = 'a quiet november harbour';

let ctx: TestApp;
let owner: Tenant;
let alice: Member;
let bob: Member;

interface Tenant {
  token: string;
  organizationId: string;
  userId: string;
}
interface Member {
  token: string;
  userId: string;
}

interface PersonRow {
  userId: string;
  name: string;
  email: string;
  openFollowUps: number;
  overdue: number;
  rescheduled: number;
  awaitingFirstContact: number;
  noNextAction: number;
  promisesBreached: number;
  promisesAtRisk: number;
  promisesMet: number;
  promisesAnsweredLate: number;
  onTimeRate: number | null;
  medianResponseMinutes: number | null;
  leadsAssigned: number;
  converted: number;
}

interface OversightBody {
  generatedAt: string;
  timeZone: string;
  period: { from: string; to: string; days: number };
  scope: { kind: string; people: number; truncated: boolean };
  queue: {
    unassigned: number;
    awaitingFirstContact: number;
    noNextAction: number;
    overdue: number;
    dueToday: number;
  };
  promises: {
    breached: number;
    atRisk: number;
    met: number;
    answeredLate: number;
    onTimeRate: number | null;
    medianResponseMinutes: number | null;
  } | null;
  people: PersonRow[];
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

async function oversight(token: string, query = ''): Promise<OversightBody> {
  const response = await api<OversightBody>('GET', `/oversight${query}`, { token });
  expect(response.statusCode, JSON.stringify(response.body)).toBe(200);
  return response.body.data;
}

function rowFor(board: OversightBody, userId: string): PersonRow {
  const row = board.people.find((person) => person.userId === userId);
  expect(row, `no row for ${userId}`).toBeDefined();
  return row!;
}

async function createLead(label: string, payload: Record<string, unknown> = {}): Promise<string> {
  const lead = await configure<{ id: string }>('POST', '/leads', {
    token: owner.token,
    payload: {
      firstName: label,
      lastName: 'Enquirer',
      email: `${label.toLowerCase()}.${SUFFIX}@oversight.test`,
      ...payload,
    },
  });
  return lead.body.data.id;
}

/** A follow-up, moved into the past afterwards where the API rightly refuses to plan one. */
async function createTask(
  leadId: string,
  title: string,
  options: { dueAt?: Date; assignedUserId?: string } = {},
): Promise<string> {
  const due = options.dueAt ?? new Date(Date.now() + 4 * 3_600_000);
  const future = due.getTime() > Date.now();
  const created = await configure<{ id: string }>('POST', '/tasks', {
    token: owner.token,
    payload: {
      leadId,
      title,
      dueAt: (future ? due : new Date(Date.now() + 36 * 3_600_000)).toISOString(),
      ...(options.assignedUserId ? { assignedUserId: options.assignedUserId } : {}),
    },
  });
  const id = created.body.data.id;
  if (!future) {
    const local = new Date(due.getTime() + 5.5 * 3_600_000); // the seeded workspace is Asia/Kolkata
    await ctx.db.task.update({
      where: { id },
      data: { dueAt: due, dueDate: new Date(`${local.toISOString().slice(0, 10)}T00:00:00.000Z`) },
    });
  }
  return id;
}

async function addMember(label: string, roleCode: string): Promise<Member> {
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
      organizationName: `Oversight ${SUFFIX}`,
    },
  });
  expect(registered.statusCode, JSON.stringify(registered.body)).toBe(201);
  owner = {
    token: registered.body.data.tokens.accessToken,
    organizationId: registered.body.data.activeOrganizationId,
    userId: registered.body.data.user.id,
  };
  alice = await addMember('alice', 'sales_executive');
  bob = await addMember('bob', 'sales_executive');
}, 120_000);

afterAll(async () => {
  await cleanupUsers(ctx.db, EMAIL_MARKER);
  await ctx.close();
});

describe('the shape of the answer', () => {
  it('answers with the period, the scope and every section in one request', async () => {
    const board = await oversight(owner.token);
    expect(board.timeZone).toBe('Asia/Kolkata');
    expect(board.period.days).toBe(30);
    expect(new Date(board.period.from).getTime()).toBeLessThan(new Date(board.period.to).getTime());
    // The owner's `report:read` is workspace-wide, and the screen says so rather than leaving
    // somebody to guess whose numbers they are looking at.
    expect(board.scope.kind).toBe('organization');
    expect(board.scope.people).toBe(3);
    expect(board.people.map((person) => person.name)).toContain('Member alice');
  });

  it('takes a period, and refuses one it would have to scan two years for', async () => {
    expect((await oversight(owner.token, '?days=7')).period.days).toBe(7);
    expect((await oversight(owner.token, '?days=90')).period.days).toBe(90);
    const refused = await api('GET', '/oversight?days=365', { token: owner.token });
    expect(refused.statusCode).toBe(400);
    expect(JSON.stringify(refused.body)).toMatch(/Choose one of/);
  });

  it('lists a person who has been given nothing at all', async () => {
    // From the member list, not from the work: somebody with no tasks, no leads and no clocks would
    // otherwise be invisible on exactly the screen whose job is to notice that.
    const row = rowFor(await oversight(owner.token), bob.userId);
    expect(row.openFollowUps).toBe(0);
    expect(row.leadsAssigned).toBe(0);
    expect(row.onTimeRate).toBeNull();
    expect(row.medianResponseMinutes).toBeNull();
  });
});

describe('the backlog nobody owns', () => {
  it('counts the unassigned leads separately, because they are in nobody’s row', async () => {
    const before = await oversight(owner.token);
    const leadId = await createLead('Unowned');
    const lead = await ctx.db.lead.findFirstOrThrow({ where: { id: leadId } });
    expect(lead.assignedUserId).toBeNull();

    const after = await oversight(owner.token);
    expect(after.queue.unassigned).toBe(before.queue.unassigned + 1);
    // And it is in nobody's row, which is the whole argument for the separate number.
    const total = after.people.reduce((sum, person) => sum + person.awaitingFirstContact, 0);
    expect(after.queue.awaitingFirstContact).toBeGreaterThan(total);
  });

  it('counts the leads with nothing planned, and stops counting one once something is', async () => {
    const leadId = await createLead('Silentlead', { assignedUserId: alice.userId });
    const before = await oversight(owner.token);
    expect(rowFor(before, alice.userId).noNextAction).toBeGreaterThanOrEqual(1);

    await createTask(leadId, 'Something planned');
    const after = await oversight(owner.token);
    expect(rowFor(after, alice.userId).noNextAction).toBe(
      rowFor(before, alice.userId).noNextAction - 1,
    );
    expect(after.queue.noNextAction).toBe(before.queue.noNextAction - 1);
  });
});

describe('who is behind, and on what', () => {
  it('counts overdue follow-ups per person, and in the workspace total', async () => {
    const leadId = await createLead('Overduesubject', { assignedUserId: alice.userId });
    const before = await oversight(owner.token);
    await createTask(leadId, 'Two days late', { dueAt: new Date(Date.now() - 48 * 3_600_000) });

    const after = await oversight(owner.token);
    expect(rowFor(after, alice.userId).overdue).toBe(rowFor(before, alice.userId).overdue + 1);
    expect(after.queue.overdue).toBe(before.queue.overdue + 1);
    // Bob is not implicated by Alice's backlog.
    expect(rowFor(after, bob.userId).overdue).toBe(0);
  });

  it('counts a follow-up that keeps moving — the coaching signal, not the punishment', async () => {
    const leadId = await createLead('Movedsubject', { assignedUserId: alice.userId });
    const taskId = await createTask(leadId, 'Keeps moving');
    const reasons = await api<{ rescheduleReasons: { id: string }[] }>('GET', '/tasks/config', {
      token: owner.token,
    });
    const reasonId = reasons.body.data.rescheduleReasons[0]!.id;

    const before = rowFor(await oversight(owner.token), alice.userId).rescheduled;
    await configure('POST', `/tasks/${taskId}/reschedule`, {
      token: owner.token,
      payload: { dueAt: new Date(Date.now() + 26 * 3_600_000).toISOString(), reasonId },
    });
    const after = rowFor(await oversight(owner.token), alice.userId).rescheduled;
    expect(after).toBe(before + 1);
  });

  it('counts each number over the whole set, not over a page', async () => {
    const leadId = await createLead('Manylate', { assignedUserId: bob.userId });
    for (let index = 0; index < 25; index += 1) {
      await createTask(leadId, `Late ${index}`, {
        dueAt: new Date(Date.now() - (index + 1) * 3_600_000),
        assignedUserId: bob.userId,
      });
    }
    const row = rowFor(await oversight(owner.token), bob.userId);
    // Twenty-five, not twenty: a manager's screen that stops counting at a page size is a screen
    // that tells somebody their team is a fifth as far behind as it is.
    expect(row.overdue).toBe(25);
    expect(row.openFollowUps).toBe(25);
  });
});

describe('the promises', () => {
  it('reads a breach from the clock, before the sweep has run', async () => {
    const leadId = await createLead('Breaching', { assignedUserId: alice.userId });
    const clock = await ctx.db.slaClock.findFirstOrThrow({ where: { leadId } });
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

    const board = await oversight(owner.token);
    expect(rowFor(board, alice.userId).promisesBreached).toBeGreaterThanOrEqual(1);
    expect(board.promises!.breached).toBeGreaterThanOrEqual(1);
  });

  it('computes an on-time rate only from promises that were actually answered', async () => {
    const solo = await addMember('ratesubject', 'sales_executive');
    /**
     * Three answered: two inside their hour, one after it.
     *
     * Every instant is derived from one `startedAt` rather than from `dueAt` independently —
     * `sla_clocks_instants_ordered` requires `started_at <= warn_at <= due_at`, and the first
     * version of this fixture computed `warn_at` from the due instant and produced a clock that
     * was warned before it started. The constraint was right; the fixture was wrong, which is the
     * second time this suite's shape has paid for it.
     */
    const answeredAfter = [30, 45, 90];
    let index = 0;
    for (const minutes of answeredAfter) {
      const leadId = await createLead(`Rate${index}`, { assignedUserId: solo.userId });
      const clock = await ctx.db.slaClock.findFirstOrThrow({ where: { leadId } });
      const startedAt = new Date(Date.now() - (minutes + 5) * 60_000);
      await ctx.db.slaClock.update({
        where: { id: clock.id },
        data: {
          state: 'satisfied',
          startedAt,
          warnAt: new Date(startedAt.getTime() + 48 * 60_000),
          dueAt: new Date(startedAt.getTime() + 60 * 60_000),
          satisfiedAt: new Date(startedAt.getTime() + minutes * 60_000),
          satisfiedBy: 'a call was logged',
        },
      });
      index += 1;
    }

    const row = rowFor(await oversight(owner.token), solo.userId);
    expect(row.promisesMet).toBe(3);
    expect(row.promisesAnsweredLate).toBe(1);
    expect(row.onTimeRate).toBe(67);
    // 30, 45 and 90 minutes from start to answer: the median is the middle one.
    expect(row.medianResponseMinutes).toBe(45);
  });

  it('answers null — not zero, and not a hundred — for somebody who has answered nothing', async () => {
    const row = rowFor(await oversight(owner.token), bob.userId);
    expect(row.promisesMet).toBe(0);
    expect(row.onTimeRate).toBeNull();
    expect(row.medianResponseMinutes).toBeNull();
  });

  it('takes a median rather than a mean, so one bad week does not swallow the number', async () => {
    const solo = await addMember('mediansubject', 'sales_executive');
    // Four answered in ten minutes, one in three days. The mean is over fourteen hours; the median
    // is ten minutes, and the median is the true sentence about this person's week.
    const spans = [10, 10, 10, 10, 3 * 24 * 60];
    let index = 0;
    for (const minutes of spans) {
      const leadId = await createLead(`Median${index}`, { assignedUserId: solo.userId });
      const clock = await ctx.db.slaClock.findFirstOrThrow({ where: { leadId } });
      const startedAt = new Date(Date.now() - (minutes + 5) * 60_000);
      await ctx.db.slaClock.update({
        where: { id: clock.id },
        data: {
          state: 'satisfied',
          startedAt,
          warnAt: new Date(startedAt.getTime() + 48 * 60_000),
          dueAt: new Date(startedAt.getTime() + 60 * 60_000),
          satisfiedAt: new Date(startedAt.getTime() + minutes * 60_000),
          satisfiedBy: 'a call was logged',
        },
      });
      index += 1;
    }

    const row = rowFor(await oversight(owner.token), solo.userId);
    expect(row.promisesMet).toBe(5);
    expect(row.medianResponseMinutes).toBe(10);
  });

  it('keeps the period: a promise answered before the window is not in it', async () => {
    const solo = await addMember('oldsubject', 'sales_executive');
    const leadId = await createLead('Oldanswer', { assignedUserId: solo.userId });
    const clock = await ctx.db.slaClock.findFirstOrThrow({ where: { leadId } });
    const longAgo = new Date(Date.now() - 60 * 24 * 3_600_000);
    await ctx.db.slaClock.update({
      where: { id: clock.id },
      data: {
        state: 'satisfied',
        startedAt: new Date(longAgo.getTime() - 30 * 60_000),
        warnAt: new Date(longAgo.getTime() - 12 * 60_000),
        dueAt: longAgo,
        satisfiedAt: new Date(longAgo.getTime() - 20 * 60_000),
        satisfiedBy: 'a call was logged',
      },
    });

    expect(rowFor(await oversight(owner.token, '?days=7'), solo.userId).promisesMet).toBe(0);
    expect(rowFor(await oversight(owner.token, '?days=90'), solo.userId).promisesMet).toBe(1);
  });
});

describe('who may read it', () => {
  it('refuses somebody without report:read', async () => {
    // A sales executive has no `report:read` in the seeded template, by design: the screen is
    // about other people's work.
    const refused = await api('GET', '/oversight', { token: alice.token });
    expect(refused.statusCode).toBe(403);
  });

  it('narrows to a branch for a branch-scoped manager', async () => {
    const branch = await ctx.db.branch.create({
      data: {
        id: newId(),
        organizationId: owner.organizationId,
        name: `North ${SUFFIX}`,
        code: `north-${SUFFIX}`,
      },
    });
    const manager = await addMember('branchmanager', 'sales_manager');
    await ctx.db.membership.updateMany({
      where: { organizationId: owner.organizationId, userId: manager.userId },
      data: { defaultBranchId: branch.id },
    });
    const { PrincipalService } =
      await import('../src/modules/auth/application/principal.service.js');
    await ctx.app.get(PrincipalService).invalidateOrganization(owner.organizationId);

    const board = await oversight(manager.token);
    // `report:read` at branch scope, and the only member of that branch is the manager — so the
    // table is one row rather than the whole workspace. The same predicate the SLA board uses.
    expect(board.scope.kind).toBe('branch');
    expect(board.people.map((person) => person.userId)).toEqual([manager.userId]);
  });

  it('needs a session', async () => {
    const anonymous = await call(ctx.app, { method: 'GET', url: '/api/v1/oversight' });
    expect(anonymous.statusCode).toBe(401);
  });
});
