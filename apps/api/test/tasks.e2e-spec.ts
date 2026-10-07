import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newToken } from '@leados/shared';
import { bootTestApp, call, cleanupUsers, type EnvelopeBody, type TestApp } from './app-harness.js';

/**
 * THE TASKS SUITE.
 *
 * `FR-TSK-1..7` asks for follow-ups with an owner, a due time and an outcome; a reschedule that
 * cannot happen without a reason; a completion that offers the next follow-up in the same
 * interaction; and a Today view whose counts are about the whole queue rather than the page.
 *
 * The assertions that matter are the ones that would pass for the wrong reason if written loosely:
 *
 *  * that the lead's `nextActionAt` / `openTasksCount` always agree with the tasks that exist —
 *    recomputed, so creating, completing, rescheduling, cancelling and deleting all have to land;
 *  * that a reschedule **cannot** be completed without a reason, over HTTP and not only in a
 *    schema;
 *  * that the overdue sweep reports a missed follow-up exactly once, however many times it runs;
 *  * that a reminder is a row whose moment can pass, and that the dispatcher is idempotent.
 *
 * Nothing is mocked. The sweeps are the same methods the cron ticks call.
 */

const SUFFIX = newToken(4)
  .toLowerCase()
  .replace(/[^a-z0-9]/g, '');
const EMAIL_MARKER = `e2etask${SUFFIX}`;
const PASSWORD = 'a quiet november harbour';

let ctx: TestApp;
let orgA: Tenant;
let orgB: Tenant;

interface Tenant {
  token: string;
  organizationId: string;
  userId: string;
}

interface TaskBody {
  id: string;
  title: string;
  status: string;
  bucket: string;
  priority: string;
  dueAt: string;
  completedAt: string | null;
  cancelledAt: string | null;
  completionNote: string | null;
  reminderOffsets: number[];
  rescheduleCount: number;
  followsTaskId: string | null;
  assignedUserId: string | null;
  taskType: { id: string; name: string; icon: string | null } | null;
  outcome: { id: string; name: string; isPositive: boolean | null } | null;
  leadId: string | null;
  customerId: string | null;
  dealId: string | null;
}

interface ConfigBody {
  types: { id: string; name: string; defaultReminderOffsets: number[] }[];
  outcomes: { id: string; name: string; isPositive: boolean | null; requiresNote: boolean }[];
  rescheduleReasons: { id: string; name: string; requiresNote: boolean }[];
}

interface LeadBody {
  id: string;
  nextActionAt: string | null;
  nextActionTaskId: string | null;
  openTasksCount: number;
}

async function api<T>(
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
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
  method: 'POST' | 'PATCH' | 'PUT' | 'DELETE',
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

async function createTenant(label: string): Promise<Tenant> {
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
      email: `${label}.${EMAIL_MARKER}@test.local`,
      password: PASSWORD,
      name: `Owner ${label}`,
      organizationName: `Task ${label} ${SUFFIX}`,
    },
  });
  return {
    token: registered.body.data.tokens.accessToken,
    organizationId: registered.body.data.activeOrganizationId,
    userId: registered.body.data.user.id,
  };
}

async function createLead(tenant: Tenant, label: string): Promise<string> {
  const lead = await configure<{ id: string }>('POST', '/leads', {
    token: tenant.token,
    payload: {
      firstName: label,
      lastName: 'Prospect',
      email: `${label.toLowerCase()}.${SUFFIX}@task.test`,
    },
  });
  return lead.body.data.id;
}

async function taskConfig(tenant: Tenant): Promise<ConfigBody> {
  const response = await api<ConfigBody>('GET', '/tasks/config', { token: tenant.token });
  expect(response.statusCode).toBe(200);
  return response.body.data;
}

async function lead(tenant: Tenant, id: string): Promise<LeadBody> {
  const response = await api<LeadBody>('GET', `/leads/${id}`, { token: tenant.token });
  expect(response.statusCode).toBe(200);
  return response.body.data;
}

function inHours(hours: number): string {
  return new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
}

function hoursAgo(hours: number): string {
  return new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
}

let config: ConfigBody;

beforeAll(async () => {
  ctx = await bootTestApp();
  orgA = await createTenant('orga');
  orgB = await createTenant('orgb');
  config = await taskConfig(orgA);
}, 120_000);

afterAll(async () => {
  await cleanupUsers(ctx.db, EMAIL_MARKER);
  await ctx.close();
});

describe('the follow-up vocabulary a workspace starts with (FR-TSK-2, FR-TSK-5, FR-TSK-6)', () => {
  it('seeds types, outcomes and reasons, so the form has something to offer on day one', () => {
    expect(config.types.length).toBeGreaterThanOrEqual(8);
    expect(config.types.map((type) => type.name)).toContain('Call');
    expect(config.types.map((type) => type.name)).toContain('Site visit');
    expect(config.outcomes.length).toBeGreaterThanOrEqual(5);
    expect(config.rescheduleReasons.map((reason) => reason.name)).toContain(
      'Customer requested later',
    );
  });

  it('carries reminder defaults, which is what makes the form one field long', () => {
    const call_ = config.types.find((type) => type.name === 'Call');
    const visit = config.types.find((type) => type.name === 'Site visit');
    expect(call_?.defaultReminderOffsets).toEqual([60]);
    // Somebody has to travel to a site visit, so it warns the day before as well.
    expect(visit?.defaultReminderOffsets).toEqual([1440, 120]);
  });

  it('marks the outcomes that mean progress, which is what makes a report possible', () => {
    const positives = config.outcomes.filter((outcome) => outcome.isPositive === true);
    const negatives = config.outcomes.filter((outcome) => outcome.isPositive === false);
    expect(positives.length).toBeGreaterThan(0);
    expect(negatives.length).toBeGreaterThan(0);
    // A no-answer is neither — it is a call to make again.
    expect(config.outcomes.some((outcome) => outcome.isPositive === null)).toBe(true);
  });

  it('refuses to leave a workspace with no outcome left to choose', async () => {
    // `tasks_completed_has_outcome` is a database constraint, so a workspace with no active
    // outcome is one where no task can ever be completed again — and the error would name the
    // constraint rather than the setting somebody changed five minutes earlier.
    const outcomes = await api<{ id: string; isActive: boolean }[]>(
      'GET',
      '/settings/task-outcomes',
      {
        token: orgB.token,
      },
    );
    const ids = outcomes.body.data.map((outcome) => outcome.id);
    for (const id of ids.slice(0, ids.length - 1)) {
      await configure('PATCH', `/settings/task-outcomes/${id}`, {
        token: orgB.token,
        payload: { isActive: false },
      });
    }
    const last = await api('PATCH', `/settings/task-outcomes/${ids[ids.length - 1]}`, {
      token: orgB.token,
      payload: { isActive: false },
    });
    expect(last.statusCode).toBe(422);
    expect(JSON.stringify(last.body)).toMatch(/only outcome left/i);

    // Put the workspace back, so the suite's other tenant is usable.
    for (const id of ids) {
      await configure('PATCH', `/settings/task-outcomes/${id}`, {
        token: orgB.token,
        payload: { isActive: true },
      });
    }
  });

  it('refuses to delete a type that tasks still carry, and names the count', async () => {
    const leadId = await createLead(orgA, 'Typed');
    const callType = config.types.find((type) => type.name === 'Call')!;
    await configure('POST', '/tasks', {
      token: orgA.token,
      payload: { leadId, title: 'Ring them', taskTypeId: callType.id, dueAt: inHours(4) },
    });
    const refused = await api('DELETE', `/settings/task-types/${callType.id}`, {
      token: orgA.token,
    });
    expect(refused.statusCode).toBe(422);
    expect(JSON.stringify(refused.body)).toMatch(/Deactivate it instead/);
  });
});

describe('creating a follow-up (FR-TSK-1)', () => {
  it('records the owner, the due time and the type, and puts it on the lead', async () => {
    const leadId = await createLead(orgA, 'Created');
    const created = await api<TaskBody>('POST', '/tasks', {
      token: orgA.token,
      payload: {
        leadId,
        title: 'Call about the 3BHK',
        description: 'Wants the east-facing one',
        taskTypeId: config.types.find((type) => type.name === 'Call')!.id,
        dueAt: inHours(5),
        priority: 'high',
      },
    });
    expect(created.statusCode).toBe(201);
    expect(created.body.data.title).toBe('Call about the 3BHK');
    expect(created.body.data.status).toBe('pending');
    expect(created.body.data.priority).toBe('high');
    expect(created.body.data.taskType?.name).toBe('Call');
    // Defaults to the subject's owner, not to whoever typed it in.
    expect(created.body.data.assignedUserId).toBe(orgA.userId);
    // The type's reminder default was applied without the client having to know it.
    expect(created.body.data.reminderOffsets).toEqual([60]);

    const subject = await lead(orgA, leadId);
    expect(subject.openTasksCount).toBe(1);
    expect(subject.nextActionTaskId).toBe(created.body.data.id);
    expect(subject.nextActionAt).toBe(created.body.data.dueAt);
  });

  it('refuses a task about nobody', async () => {
    const refused = await api('POST', '/tasks', {
      token: orgA.token,
      payload: { title: 'Ring the bank', dueAt: inHours(2) },
    });
    expect(refused.statusCode).toBe(400);
    expect(JSON.stringify(refused.body)).toMatch(/a lead, a customer or a deal/);
  });

  it('writes it to the lead’s timeline, because rule 6 is the product', async () => {
    const leadId = await createLead(orgA, 'Timelined');
    await configure('POST', '/tasks', {
      token: orgA.token,
      payload: { leadId, title: 'Send the brochure', dueAt: inHours(6) },
    });
    const timeline = await api<{ type: string; summary?: string }[]>(
      'GET',
      `/leads/${leadId}/timeline`,
      { token: orgA.token },
    );
    expect(timeline.body.data.map((entry) => entry.type)).toContain('task.created');
  });

  it('keeps the next action as the soonest of several, and counts them all', async () => {
    const leadId = await createLead(orgA, 'Several');
    const later = await configure<TaskBody>('POST', '/tasks', {
      token: orgA.token,
      payload: { leadId, title: 'Second call', dueAt: inHours(48) },
    });
    const sooner = await configure<TaskBody>('POST', '/tasks', {
      token: orgA.token,
      payload: { leadId, title: 'First call', dueAt: inHours(3) },
    });
    const subject = await lead(orgA, leadId);
    expect(subject.openTasksCount).toBe(2);
    expect(subject.nextActionTaskId).toBe(sooner.body.data.id);
    expect(subject.nextActionTaskId).not.toBe(later.body.data.id);
  });
});

describe('completing a follow-up (FR-TSK-6)', () => {
  it('requires an outcome, which is what makes the log worth keeping', async () => {
    const leadId = await createLead(orgA, 'Outcomeless');
    const task = await configure<TaskBody>('POST', '/tasks', {
      token: orgA.token,
      payload: { leadId, title: 'Call', dueAt: inHours(2) },
    });
    const refused = await api('POST', `/tasks/${task.body.data.id}/complete`, {
      token: orgA.token,
      payload: {},
    });
    expect(refused.statusCode).toBe(400);
    expect(JSON.stringify(refused.body)).toMatch(/outcomeId/);
  });

  it('demands a note when the outcome says so', async () => {
    const leadId = await createLead(orgA, 'Noteless');
    const task = await configure<TaskBody>('POST', '/tasks', {
      token: orgA.token,
      payload: { leadId, title: 'Call', dueAt: inHours(2) },
    });
    const other = config.outcomes.find((outcome) => outcome.requiresNote)!;
    const refused = await api('POST', `/tasks/${task.body.data.id}/complete`, {
      token: orgA.token,
      payload: { outcomeId: other.id },
    });
    expect(refused.statusCode).toBe(400);
    expect(JSON.stringify(refused.body)).toMatch(/needs a note/);

    const accepted = await api<TaskBody>('POST', `/tasks/${task.body.data.id}/complete`, {
      token: orgA.token,
      payload: { outcomeId: other.id, note: 'Asked us to call his brother instead' },
    });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.body.data.completionNote).toBe('Asked us to call his brother instead');
  });

  it('creates the next follow-up in the same interaction, so the lead is never left empty', async () => {
    const leadId = await createLead(orgA, 'Chained');
    const first = await configure<TaskBody>('POST', '/tasks', {
      token: orgA.token,
      payload: { leadId, title: 'First call', dueAt: inHours(2) },
    });
    const positive = config.outcomes.find((outcome) => outcome.isPositive === true)!;

    const completed = await api<TaskBody>('POST', `/tasks/${first.body.data.id}/complete`, {
      token: orgA.token,
      payload: {
        outcomeId: positive.id,
        note: 'Interested, wants a site visit',
        nextFollowUp: { title: 'Site visit', dueAt: inHours(72) },
      },
    });
    expect(completed.statusCode).toBe(200);
    expect(completed.body.data.status).toBe('completed');
    expect(completed.body.data.outcome?.id).toBe(positive.id);

    const subject = await lead(orgA, leadId);
    expect(subject.openTasksCount).toBe(1);
    expect(subject.nextActionTaskId).not.toBe(first.body.data.id);

    const next = await api<TaskBody>('GET', `/tasks/${subject.nextActionTaskId}`, {
      token: orgA.token,
    });
    expect(next.body.data.title).toBe('Site visit');
    // The chain a manager reads as "five calls over three weeks".
    expect(next.body.data.followsTaskId).toBe(first.body.data.id);

    const timeline = await api<{ type: string }[]>('GET', `/leads/${leadId}/timeline`, {
      token: orgA.token,
    });
    const types = timeline.body.data.map((entry) => entry.type);
    expect(types).toContain('task.completed');
    // Two entries, not one: finishing a call and planning the next one are two facts.
    expect(types.filter((type) => type === 'task.created')).toHaveLength(2);
  });

  it('leaves the lead with no next action when nothing follows, which is the point of FR-TSK-4', async () => {
    const leadId = await createLead(orgA, 'Finished');
    // Assigned on purpose: "silent leads" is a question about *somebody's* leads. An unassigned
    // lead with no next action is the unassigned-pool problem (`FR-ASG-4`), which has its own
    // notification, and counting it here would mix two different failures under one number.
    await configure('POST', `/leads/${leadId}/assign`, {
      token: orgA.token,
      payload: { assignedUserId: orgA.userId },
    });
    const task = await configure<TaskBody>('POST', '/tasks', {
      token: orgA.token,
      payload: { leadId, title: 'Only call', dueAt: inHours(2) },
    });
    await configure('POST', `/tasks/${task.body.data.id}/complete`, {
      token: orgA.token,
      payload: { outcomeId: config.outcomes.find((o) => o.isPositive !== false)!.id },
    });
    const subject = await lead(orgA, leadId);
    expect(subject.openTasksCount).toBe(0);
    expect(subject.nextActionTaskId).toBeNull();
    expect(subject.nextActionAt).toBeNull();

    // And it shows up in the counter the summary exposes.
    const summary = await api<{ noNextAction: number }>('GET', '/tasks/summary', {
      token: orgA.token,
    });
    expect(summary.body.data.noNextAction).toBeGreaterThan(0);
  });

  it('is idempotent, and refuses to resurrect a cancelled task', async () => {
    const leadId = await createLead(orgA, 'Twice');
    const task = await configure<TaskBody>('POST', '/tasks', {
      token: orgA.token,
      payload: { leadId, title: 'Call', dueAt: inHours(2) },
    });
    const outcome = config.outcomes[0]!;
    const payload = { outcomeId: outcome.id, note: 'done' };
    const once = await configure<TaskBody>('POST', `/tasks/${task.body.data.id}/complete`, {
      token: orgA.token,
      payload,
    });
    const twice = await api<TaskBody>('POST', `/tasks/${task.body.data.id}/complete`, {
      token: orgA.token,
      payload,
    });
    expect(twice.statusCode).toBe(200);
    expect(twice.body.data.completedAt).toBe(once.body.data.completedAt);

    const cancelled = await configure<TaskBody>('POST', '/tasks', {
      token: orgA.token,
      payload: { leadId, title: 'Abandoned', dueAt: inHours(9) },
    });
    await configure('POST', `/tasks/${cancelled.body.data.id}/cancel`, {
      token: orgA.token,
      payload: { reason: 'Customer bought elsewhere' },
    });
    const refused = await api('POST', `/tasks/${cancelled.body.data.id}/complete`, {
      token: orgA.token,
      payload,
    });
    expect(refused.statusCode).toBe(422);
  });
});

describe('rescheduling (FR-TSK-5)', () => {
  it('cannot be done without a new time and a reason', async () => {
    const leadId = await createLead(orgA, 'Moved');
    const task = await configure<TaskBody>('POST', '/tasks', {
      token: orgA.token,
      payload: { leadId, title: 'Call', dueAt: inHours(2) },
    });

    const noReason = await api('POST', `/tasks/${task.body.data.id}/reschedule`, {
      token: orgA.token,
      payload: { dueAt: inHours(26) },
    });
    expect(noReason.statusCode).toBe(400);
    expect(JSON.stringify(noReason.body)).toMatch(/reasonId/);

    const noTime = await api('POST', `/tasks/${task.body.data.id}/reschedule`, {
      token: orgA.token,
      payload: { reasonId: config.rescheduleReasons[0]!.id },
    });
    expect(noTime.statusCode).toBe(400);
    expect(JSON.stringify(noTime.body)).toMatch(/dueAt/);
  });

  it('refuses a move to the time it is already due at', async () => {
    const leadId = await createLead(orgA, 'Unmoved');
    const dueAt = inHours(30);
    const task = await configure<TaskBody>('POST', '/tasks', {
      token: orgA.token,
      payload: { leadId, title: 'Call', dueAt },
    });
    const refused = await api('POST', `/tasks/${task.body.data.id}/reschedule`, {
      token: orgA.token,
      payload: { dueAt, reasonId: config.rescheduleReasons[0]!.id },
    });
    expect(refused.statusCode).toBe(400);
    expect(JSON.stringify(refused.body)).toMatch(/already due/i);
  });

  it('demands a note when the reason says so', async () => {
    const leadId = await createLead(orgA, 'Vague');
    const task = await configure<TaskBody>('POST', '/tasks', {
      token: orgA.token,
      payload: { leadId, title: 'Call', dueAt: inHours(2) },
    });
    const other = config.rescheduleReasons.find((reason) => reason.requiresNote)!;
    const refused = await api('POST', `/tasks/${task.body.data.id}/reschedule`, {
      token: orgA.token,
      payload: { dueAt: inHours(50), reasonId: other.id },
    });
    expect(refused.statusCode).toBe(400);
    expect(JSON.stringify(refused.body)).toMatch(/needs a note/);
  });

  it('moves the same task, counts the move, and keeps the reason readable', async () => {
    const leadId = await createLead(orgA, 'Pushed');
    const task = await configure<TaskBody>('POST', '/tasks', {
      token: orgA.token,
      payload: { leadId, title: 'Call', dueAt: inHours(2) },
    });
    const reason = config.rescheduleReasons.find((r) => r.name === 'Customer busy')!;

    let current = task.body.data;
    for (const hours of [26, 50, 74]) {
      const moved = await api<TaskBody>('POST', `/tasks/${current.id}/reschedule`, {
        token: orgA.token,
        payload: { dueAt: inHours(hours), reasonId: reason.id },
      });
      expect(moved.statusCode).toBe(200);
      // The *same* row: closing it and opening another would put two things on the Today list for
      // one call, and double the lead's open count.
      expect(moved.body.data.id).toBe(task.body.data.id);
      current = moved.body.data;
    }
    expect(current.rescheduleCount).toBe(3);

    const subject = await lead(orgA, leadId);
    expect(subject.openTasksCount).toBe(1);
    expect(subject.nextActionAt).toBe(current.dueAt);

    const history = await api<{ reason: { name: string }; reasonNote: string | null }[]>(
      'GET',
      `/tasks/${task.body.data.id}/reschedules`,
      { token: orgA.token },
    );
    expect(history.body.data).toHaveLength(3);
    expect(history.body.data.every((row) => row.reason.name === 'Customer busy')).toBe(true);

    const timeline = await api<{ type: string }[]>('GET', `/leads/${leadId}/timeline`, {
      token: orgA.token,
    });
    expect(timeline.body.data.filter((entry) => entry.type === 'task.rescheduled')).toHaveLength(3);
  });
});

describe('the Today view (FR-TSK-7)', () => {
  it('buckets by the clock, and counts the whole queue rather than the page', async () => {
    const tenant = await createTenant('today');
    const localConfig = await taskConfig(tenant);
    const leadId = await createLead(tenant, 'Today');

    // One in each bucket. The overdue one is created in the past, which is legitimate: somebody
    // logging yesterday's missed call plans it for yesterday.
    await configure('POST', '/tasks', {
      token: tenant.token,
      payload: { leadId, title: 'Missed yesterday', dueAt: hoursAgo(26) },
    });
    await configure('POST', '/tasks', {
      token: tenant.token,
      payload: {
        leadId,
        title: 'Right now',
        dueAt: new Date(Date.now() + 5 * 60_000).toISOString(),
      },
    });
    await configure('POST', '/tasks', {
      token: tenant.token,
      payload: { leadId, title: 'Next week', dueAt: inHours(24 * 8) },
    });
    const done = await configure<TaskBody>('POST', '/tasks', {
      token: tenant.token,
      payload: { leadId, title: 'Already done', dueAt: inHours(3) },
    });
    await configure('POST', `/tasks/${done.body.data.id}/complete`, {
      token: tenant.token,
      payload: { outcomeId: localConfig.outcomes[0]!.id },
    });

    const summary = await api<{ counts: Record<string, number>; noNextAction: number }>(
      'GET',
      '/tasks/summary',
      { token: tenant.token },
    );
    expect(summary.statusCode).toBe(200);
    expect(summary.body.data.counts['overdue']).toBe(1);
    expect(summary.body.data.counts['due_now']).toBe(1);
    expect(summary.body.data.counts['upcoming']).toBe(1);
    expect(summary.body.data.counts['completed']).toBe(1);

    // Every open task appears in exactly one bucket, so the counts add up to the list.
    const open = await api<TaskBody[]>('GET', '/tasks?open=true', { token: tenant.token });
    const bucketed =
      (summary.body.data.counts['overdue'] ?? 0) +
      (summary.body.data.counts['due_now'] ?? 0) +
      (summary.body.data.counts['due_today'] ?? 0) +
      (summary.body.data.counts['upcoming'] ?? 0);
    expect(bucketed).toBe(open.body.data.length);

    // And the row's own bucket agrees with the counter it was counted in.
    const overdue = await api<TaskBody[]>('GET', '/tasks?bucket=overdue', {
      token: tenant.token,
    });
    expect(overdue.body.data).toHaveLength(1);
    expect(overdue.body.data[0]?.bucket).toBe('overdue');
    expect(overdue.body.data[0]?.title).toBe('Missed yesterday');
  });

  it('sorts a queue by priority before time, because it is work and not a diary', async () => {
    const tenant = await createTenant('queue');
    const leadId = await createLead(tenant, 'Queued');
    await configure('POST', '/tasks', {
      token: tenant.token,
      payload: { leadId, title: 'Low but soon', dueAt: inHours(2), priority: 'low' },
    });
    await configure('POST', '/tasks', {
      token: tenant.token,
      payload: { leadId, title: 'Urgent but later', dueAt: inHours(20), priority: 'urgent' },
    });
    const sorted = await api<TaskBody[]>('GET', '/tasks?sort=priority&direction=asc', {
      token: tenant.token,
    });
    expect(sorted.body.data[0]?.title).toBe('Urgent but later');
  });
});

describe('the overdue sweep (task.overdue-sweep)', () => {
  it('reports a missed follow-up exactly once, however many times it runs', async () => {
    const tenant = await createTenant('sweep');
    const leadId = await createLead(tenant, 'Missed');
    const task = await configure<TaskBody>('POST', '/tasks', {
      token: tenant.token,
      payload: { leadId, title: 'Should have called', dueAt: hoursAgo(3) },
    });

    const { TasksService } = await import('../src/modules/tasks/tasks.service.js');
    const tasks = ctx.app.get(TasksService);
    const first = await tasks.sweepOverdue();
    expect(first.reported).toBeGreaterThan(0);
    const second = await tasks.sweepOverdue();

    const timeline = await api<{ type: string }[]>('GET', `/leads/${leadId}/timeline`, {
      token: tenant.token,
    });
    // Once. `overdue_notified_at` is what makes it once rather than every half hour, and running
    // the sweep twice is the only way to prove it.
    expect(timeline.body.data.filter((entry) => entry.type === 'task.overdue')).toHaveLength(1);
    expect(second.examined).toBeGreaterThanOrEqual(0);

    // The task is still open and still overdue: the sweep tells somebody, it does not change
    // what is true.
    const after = await api<TaskBody>('GET', `/tasks/${task.body.data.id}`, {
      token: tenant.token,
    });
    expect(after.body.data.status).toBe('pending');
    expect(after.body.data.bucket).toBe('overdue');
  });

  it('is allowed to report again once the follow-up has been moved and missed again', async () => {
    const tenant = await createTenant('again');
    const localConfig = await taskConfig(tenant);
    const leadId = await createLead(tenant, 'Twicemissed');
    const task = await configure<TaskBody>('POST', '/tasks', {
      token: tenant.token,
      payload: { leadId, title: 'Call', dueAt: hoursAgo(4) },
    });

    const { TasksService } = await import('../src/modules/tasks/tasks.service.js');
    const tasks = ctx.app.get(TasksService);
    await tasks.sweepOverdue();

    await configure('POST', `/tasks/${task.body.data.id}/reschedule`, {
      token: tenant.token,
      payload: { dueAt: hoursAgo(1), reasonId: localConfig.rescheduleReasons[0]!.id },
    });
    await tasks.sweepOverdue();

    const timeline = await api<{ type: string }[]>('GET', `/leads/${leadId}/timeline`, {
      token: tenant.token,
    });
    // The next miss is news again, which is why the reschedule clears the flag.
    expect(timeline.body.data.filter((entry) => entry.type === 'task.overdue')).toHaveLength(2);
  });

  it('does not declare a task late that was finished between the read and the write', async () => {
    const tenant = await createTenant('raced');
    const localConfig = await taskConfig(tenant);
    const leadId = await createLead(tenant, 'Raced');
    const task = await configure<TaskBody>('POST', '/tasks', {
      token: tenant.token,
      payload: { leadId, title: 'Call', dueAt: hoursAgo(2) },
    });
    await configure('POST', `/tasks/${task.body.data.id}/complete`, {
      token: tenant.token,
      payload: { outcomeId: localConfig.outcomes[0]!.id },
    });

    const { TasksService } = await import('../src/modules/tasks/tasks.service.js');
    await ctx.app.get(TasksService).sweepOverdue();

    const timeline = await api<{ type: string }[]>('GET', `/leads/${leadId}/timeline`, {
      token: tenant.token,
    });
    expect(timeline.body.data.filter((entry) => entry.type === 'task.overdue')).toHaveLength(0);
  });
});

describe('reminders (task.reminder-dispatch)', () => {
  it('writes a row per offset, drops one whose moment has already gone, and sends once', async () => {
    const tenant = await createTenant('remind');
    const leadId = await createLead(tenant, 'Reminded');

    // Due in twenty minutes, asking for an hour before and ten minutes before. The hour-before
    // reminder's moment is already in the past, and a reminder arriving with the overdue notice is
    // noise — so only one row should exist.
    const task = await configure<TaskBody>('POST', '/tasks', {
      token: tenant.token,
      payload: {
        leadId,
        title: 'Call shortly',
        dueAt: new Date(Date.now() + 20 * 60_000).toISOString(),
        reminderOffsets: [60, 10],
      },
    });
    const rows = await ctx.db.taskReminder.findMany({ where: { taskId: task.body.data.id } });
    expect(rows.map((row) => row.offsetMinutes)).toEqual([10]);

    // Move its moment into the past so the dispatcher picks it up, which is what a minute of
    // waiting would otherwise do.
    await ctx.db.taskReminder.updateMany({
      where: { taskId: task.body.data.id },
      data: { remindAt: new Date(Date.now() - 60_000) },
    });

    const { TasksService } = await import('../src/modules/tasks/tasks.service.js');
    const tasks = ctx.app.get(TasksService);
    const first = await tasks.dispatchDueReminders();
    expect(first.sent).toBeGreaterThan(0);
    await tasks.dispatchDueReminders();

    // The envelope lifts `items` to `data`, so the list *is* the array.
    const notifications = await api<{ type: string; title: string }[]>('GET', '/notifications', {
      token: tenant.token,
    });
    const reminders = notifications.body.data.filter((row) => row.type === 'task.reminder');
    expect(reminders).toHaveLength(1);
    expect(reminders[0]?.title).toMatch(/Call shortly/);

    const sent = await ctx.db.taskReminder.findMany({ where: { taskId: task.body.data.id } });
    expect(sent.every((row) => row.sentAt !== null)).toBe(true);
  });

  it('rewrites the rows when the follow-up moves, and clears them when it is finished', async () => {
    const tenant = await createTenant('rewrite');
    const localConfig = await taskConfig(tenant);
    const leadId = await createLead(tenant, 'Rewritten');
    const task = await configure<TaskBody>('POST', '/tasks', {
      token: tenant.token,
      payload: { leadId, title: 'Call', dueAt: inHours(5), reminderOffsets: [60] },
    });
    const before = await ctx.db.taskReminder.findFirstOrThrow({
      where: { taskId: task.body.data.id },
    });

    await configure('POST', `/tasks/${task.body.data.id}/reschedule`, {
      token: tenant.token,
      payload: { dueAt: inHours(30), reasonId: localConfig.rescheduleReasons[0]!.id },
    });
    const after = await ctx.db.taskReminder.findFirstOrThrow({
      where: { taskId: task.body.data.id },
    });
    // The whole reason a reminder is a row and not a delayed job: moving the task rewrites it
    // inside the same transaction, and nothing has to be cancelled.
    expect(after.remindAt.getTime()).toBeGreaterThan(before.remindAt.getTime());

    await configure('POST', `/tasks/${task.body.data.id}/complete`, {
      token: tenant.token,
      payload: { outcomeId: localConfig.outcomes[0]!.id },
    });
    const left = await ctx.db.taskReminder.findMany({ where: { taskId: task.body.data.id } });
    expect(left).toHaveLength(0);
  });
});

describe('the lead’s next action is recomputed, not incremented', () => {
  it('survives four follow-ups created at the same instant', async () => {
    // The trap scoring already paid for, applied to a count: two writers that read the same
    // "before" value and both write their own increment lose one of the two. The recompute takes
    // `SELECT … FOR UPDATE` on the lead first, so the four writes serialize and the count is four.
    const leadId = await createLead(orgA, 'Concurrent');
    const hours = [4, 8, 12, 16];
    const created = await Promise.all(
      hours.map((hour) =>
        api<TaskBody>('POST', '/tasks', {
          token: orgA.token,
          payload: { leadId, title: `Call ${hour}`, dueAt: inHours(hour) },
        }),
      ),
    );
    expect(
      created.map((response) => `${response.statusCode} ${JSON.stringify(response.body)}`),
    ).toEqual(created.map(() => expect.stringMatching(/^201 /)));

    const subject = await lead(orgA, leadId);
    expect(subject.openTasksCount).toBe(4);
    // And the pointer is the soonest, not whichever write happened to land last.
    const soonest = created.find((response) => response.body.data.title === 'Call 4')!;
    expect(subject.nextActionTaskId).toBe(soonest.body.data.id);
  });

  it('agrees with the tasks that exist after every kind of write', async () => {
    const leadId = await createLead(orgA, 'Reconciled');
    const ids: string[] = [];
    for (const hour of [6, 10, 14]) {
      const created = await configure<TaskBody>('POST', '/tasks', {
        token: orgA.token,
        payload: { leadId, title: `Call ${hour}`, dueAt: inHours(hour) },
      });
      ids.push(created.body.data.id);
    }
    await configure('POST', `/tasks/${ids[0]}/complete`, {
      token: orgA.token,
      payload: { outcomeId: config.outcomes[0]!.id, note: 'done' },
    });
    await configure('POST', `/tasks/${ids[1]}/cancel`, { token: orgA.token, payload: {} });
    await configure('DELETE', `/tasks/${ids[2]}`, { token: orgA.token });

    const subject = await lead(orgA, leadId);
    // The authoritative answer is the tasks, and the columns are a cache of it. This is the
    // assertion that catches a write path that forgot to recompute.
    const open = await ctx.db.task.count({
      where: { leadId, deletedAt: null, status: { in: ['pending', 'in_progress'] } },
    });
    expect(subject.openTasksCount).toBe(open);
    expect(subject.openTasksCount).toBe(0);
    expect(subject.nextActionTaskId).toBeNull();
  });
});

describe('cancelling and deleting', () => {
  it('cancels without destroying, and takes the task off the lead’s next action', async () => {
    const leadId = await createLead(orgA, 'Cancelled');
    const task = await configure<TaskBody>('POST', '/tasks', {
      token: orgA.token,
      payload: { leadId, title: 'Call', dueAt: inHours(4) },
    });
    const cancelled = await api<TaskBody>('POST', `/tasks/${task.body.data.id}/cancel`, {
      token: orgA.token,
      payload: { reason: 'They asked us to stop calling' },
    });
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.body.data.status).toBe('cancelled');
    expect(cancelled.body.data.cancelledAt).not.toBeNull();

    const subject = await lead(orgA, leadId);
    expect(subject.openTasksCount).toBe(0);
    expect(subject.nextActionTaskId).toBeNull();

    const timeline = await api<{ type: string }[]>('GET', `/leads/${leadId}/timeline`, {
      token: orgA.token,
    });
    expect(timeline.body.data.map((entry) => entry.type)).toContain('task.cancelled');
  });

  it('deletes a mistake without writing it into the lead’s history', async () => {
    const leadId = await createLead(orgA, 'Mistaken');
    const task = await configure<TaskBody>('POST', '/tasks', {
      token: orgA.token,
      payload: { leadId, title: 'Wrong lead entirely', dueAt: inHours(4) },
    });
    const removed = await api('DELETE', `/tasks/${task.body.data.id}`, { token: orgA.token });
    expect(removed.statusCode).toBe(200);

    const subject = await lead(orgA, leadId);
    expect(subject.openTasksCount).toBe(0);

    const timeline = await api<{ type: string }[]>('GET', `/leads/${leadId}/timeline`, {
      token: orgA.token,
    });
    // A task created on the wrong lead and removed a minute later is not part of that lead's
    // history. Writing "task deleted" would make the mistake permanent on the one screen the
    // business owner reads.
    expect(timeline.body.data.some((entry) => entry.type === 'task.cancelled')).toBe(false);
  });
});

describe('tenancy', () => {
  it('answers 404 for another workspace’s task, and for its vocabulary', async () => {
    const leadId = await createLead(orgA, 'Private');
    const task = await configure<TaskBody>('POST', '/tasks', {
      token: orgA.token,
      payload: { leadId, title: 'Private call', dueAt: inHours(4) },
    });

    // Each route gets a body its *own* schema accepts. A payload the schema refuses would come
    // back 400 before authorization ever ran, and the assertion would pass for the wrong reason.
    const attempts: {
      method: 'GET' | 'PATCH' | 'POST' | 'DELETE';
      url: string;
      payload?: unknown;
    }[] = [
      { method: 'GET', url: `/tasks/${task.body.data.id}` },
      { method: 'GET', url: `/tasks/${task.body.data.id}/reschedules` },
      { method: 'PATCH', url: `/tasks/${task.body.data.id}`, payload: { title: 'Hijacked' } },
      { method: 'POST', url: `/tasks/${task.body.data.id}/cancel`, payload: {} },
      { method: 'DELETE', url: `/tasks/${task.body.data.id}` },
    ];
    for (const attempt of attempts) {
      const response = await api(attempt.method, attempt.url, {
        token: orgB.token,
        ...(attempt.payload === undefined ? {} : { payload: attempt.payload }),
      });
      expect(response.statusCode, `${attempt.method} ${attempt.url}`).toBe(404);
    }

    // And a task cannot be created about another workspace's lead.
    const refused = await api('POST', '/tasks', {
      token: orgB.token,
      payload: { leadId, title: 'Reaching across', dueAt: inHours(4) },
    });
    expect(refused.statusCode).toBe(404);
  });

  it('refuses another workspace’s outcome on a completion', async () => {
    const leadId = await createLead(orgB, 'Foreign');
    const task = await configure<TaskBody>('POST', '/tasks', {
      token: orgB.token,
      payload: { leadId, title: 'Call', dueAt: inHours(4) },
    });
    const refused = await api('POST', `/tasks/${task.body.data.id}/complete`, {
      token: orgB.token,
      payload: { outcomeId: config.outcomes[0]!.id },
    });
    expect(refused.statusCode).toBe(404);
  });
});
