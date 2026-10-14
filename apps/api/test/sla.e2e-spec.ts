import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newToken } from '@leados/shared';
import { bootTestApp, call, cleanupUsers, type EnvelopeBody, type TestApp } from './app-harness.js';

/**
 * THE SLA SUITE.
 *
 * `FR-TSK-8` asks for per-source/priority first-response targets, clocks that respect working
 * hours, and breach and near-breach escalation to the manager — reportably, and the phase's exit
 * criteria add two conditions that are the whole difficulty:
 *
 *  * **the clock respects working hours and holidays across timezones, with a DST case**, which is
 *    tested exhaustively as pure arithmetic in `@leados/shared` and here as the thing that actually
 *    reaches the database: a lead captured out of hours must come due in business hours;
 *  * **escalation happens exactly once**, which is asserted by running the sweep repeatedly and
 *    counting rows — the only way to tell a unique key from a hopeful `if`.
 *
 * Nothing is mocked. The sweep is the same method the five-minute cron calls, and the working
 * calendar is read from the `working_hours` rows provisioning writes.
 */

const SUFFIX = newToken(4)
  .toLowerCase()
  .replace(/[^a-z0-9]/g, '');
const EMAIL_MARKER = `e2esla${SUFFIX}`;
const PASSWORD = 'a quiet november harbour';

let ctx: TestApp;
let orgA: Tenant;
let orgB: Tenant;

interface Tenant {
  token: string;
  organizationId: string;
  userId: string;
}

interface PolicyBody {
  id: string;
  name: string;
  firstResponseMinutes: number;
  resolutionMinutes: number | null;
  businessHoursOnly: boolean;
  warnAtPercent: number;
  priority: number;
  isActive: boolean;
  clockCount: number;
}

interface ClockBody {
  id: string;
  target: string;
  state: string;
  health: string;
  startedAt: string;
  dueAt: string;
  warnAt: string;
  targetMinutes: number;
  satisfiedAt: string | null;
  satisfiedBy: string | null;
  metOnTime: boolean | null;
  leadId: string | null;
  policy: { id: string; name: string } | null;
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
      organizationName: `Sla ${label} ${SUFFIX}`,
    },
  });
  return {
    token: registered.body.data.tokens.accessToken,
    organizationId: registered.body.data.activeOrganizationId,
    userId: registered.body.data.user.id,
  };
}

async function createLead(tenant: Tenant, label: string, payload = {}): Promise<string> {
  const lead = await configure<{ id: string }>('POST', '/leads', {
    token: tenant.token,
    payload: {
      firstName: label,
      lastName: 'Enquirer',
      email: `${label.toLowerCase()}.${SUFFIX}@sla.test`,
      ...payload,
    },
  });
  return lead.body.data.id;
}

async function clocksFor(tenant: Tenant, leadId: string): Promise<ClockBody[]> {
  const response = await api<ClockBody[]>('GET', `/sla/clocks?leadId=${leadId}`, {
    token: tenant.token,
  });
  expect(response.statusCode, JSON.stringify(response.body)).toBe(200);
  return response.body.data;
}

async function sweep(): Promise<{ warned: number; breached: number }> {
  const { SlaService } = await import('../src/modules/sla/sla.service.js');
  return ctx.app.get(SlaService).sweep();
}

/**
 * Moves a clock's whole span into the past, which is what waiting an hour would do.
 *
 * **`started_at` moves too**, and it has to: `sla_clocks_instants_ordered` requires
 * `started_at <= warn_at <= due_at`, so a helper that only backdated the warning produced a clock
 * that started after it was due — which the database refused outright. The constraint was right and
 * the first version of this helper was wrong, which is the whole argument for having it.
 */
async function expire(clockId: string, options: { warnOnly?: boolean } = {}): Promise<void> {
  const now = Date.now();
  await ctx.db.slaClock.update({
    where: { id: clockId },
    data: options.warnOnly
      ? {
          startedAt: new Date(now - 3_600_000),
          warnAt: new Date(now - 60_000),
          dueAt: new Date(now + 3_600_000),
        }
      : {
          startedAt: new Date(now - 3_600_000),
          warnAt: new Date(now - 120_000),
          dueAt: new Date(now - 60_000),
        },
  });
}

beforeAll(async () => {
  ctx = await bootTestApp();
  orgA = await createTenant('orga');
  orgB = await createTenant('orgb');
}, 120_000);

afterAll(async () => {
  await cleanupUsers(ctx.db, EMAIL_MARKER);
  await ctx.close();
});

describe('the promise a workspace starts with (FR-TSK-8, database-design §17)', () => {
  it('seeds one catch-all policy of sixty working minutes', async () => {
    const policies = await api<PolicyBody[]>('GET', '/sla/policies', { token: orgA.token });
    expect(policies.statusCode).toBe(200);
    expect(policies.body.data).toHaveLength(1);
    const policy = policies.body.data[0]!;
    expect(policy.firstResponseMinutes).toBe(60);
    expect(policy.businessHoursOnly).toBe(true);
    expect(policy.warnAtPercent).toBe(80);
    // No resolution target: most businesses have no such promise, and one invented on their behalf
    // would breach all week and teach them to ignore the board.
    expect(policy.resolutionMinutes).toBeNull();
  });

  it('gives the workspace its own working hours, not only the owner’s', async () => {
    // `working_hours` has had one reader since Phase 1 — the assignment engine, asking "is this
    // person on shift". A *workspace* calendar is a different fact, and without these rows the SLA
    // clock would silently run through the night.
    const rows = await ctx.db.workingHours.findMany({
      where: { organizationId: orgA.organizationId, userId: null, branchId: null },
    });
    expect(rows).toHaveLength(6);
    expect(rows.every((row) => row.startMinute === 570 && row.endMinute === 1110)).toBe(true);
  });
});

describe('starting a clock (FR-TSK-8)', () => {
  it('starts a first-response clock when a lead is captured, due inside working hours', async () => {
    const leadId = await createLead(orgA, 'Started');
    const clocks = await clocksFor(orgA, leadId);
    expect(clocks).toHaveLength(1);

    const clock = clocks[0]!;
    expect(clock.target).toBe('first_response');
    expect(clock.state).toBe('running');
    expect(clock.targetMinutes).toBe(60);
    expect(clock.policy?.name).toBe('First response within an hour');

    // The headline guarantee: whenever this test runs — 03:00 on a Sunday included — the due
    // instant falls inside a working window, which is what "60 working minutes" means.
    const { SlaCalendarService } = await import('../src/modules/sla/sla-calendar.service.js');
    const { isWithinBusinessHours, tenantContext, systemPrincipal, newId } =
      await import('@leados/shared');
    const calendars = ctx.app.get(SlaCalendarService);
    const calendar = await tenantContext.run(
      systemPrincipal(orgA.organizationId, newId()),
      async () => calendars.forBranch('Asia/Kolkata', null, new Date(clock.startedAt)),
    );
    // The due instant is the *end* of the minute's work, so the window is open at the minute before.
    const justBefore = new Date(new Date(clock.dueAt).getTime() - 60_000);
    expect(isWithinBusinessHours(justBefore, calendar), `${clock.startedAt} → ${clock.dueAt}`).toBe(
      true,
    );
    // And the warning comes strictly before the breach.
    expect(new Date(clock.warnAt).getTime()).toBeLessThan(new Date(clock.dueAt).getTime());
  });

  it('does not start a clock twice for the same lead and target', async () => {
    const leadId = await createLead(orgA, 'Once');
    // The unique key on (organization, subject_type, subject_id, target) is what makes a replayed
    // capture safe; this is the assertion that it is actually in place.
    await expect(
      ctx.db.slaClock.create({
        data: {
          id: (await import('@leados/shared')).newId(),
          organizationId: orgA.organizationId,
          policyId: (
            await ctx.db.slaPolicy.findFirstOrThrow({
              where: { organizationId: orgA.organizationId },
            })
          ).id,
          subjectType: 'lead',
          subjectId: leadId,
          leadId,
          target: 'first_response',
          startedAt: new Date(),
          dueAt: new Date(Date.now() + 3_600_000),
          warnAt: new Date(Date.now() + 1_800_000),
          targetMinutes: 60,
        },
      }),
    ).rejects.toThrow(/unique|duplicate key/i);
  });

  it('starts a resolution clock too when the policy promises one', async () => {
    const tenant = await createTenant('resolve');
    const policy = await ctx.db.slaPolicy.findFirstOrThrow({
      where: { organizationId: tenant.organizationId },
    });
    await configure('PATCH', `/sla/policies/${policy.id}`, {
      token: tenant.token,
      payload: { resolutionMinutes: 2880 },
    });

    const leadId = await createLead(tenant, 'Resolved');
    const clocks = await clocksFor(tenant, leadId);
    expect(clocks.map((clock) => clock.target).sort()).toEqual(['first_response', 'resolution']);
  });

  it('starts nothing when no policy applies, rather than inventing a promise', async () => {
    const tenant = await createTenant('nopolicy');
    const policy = await ctx.db.slaPolicy.findFirstOrThrow({
      where: { organizationId: tenant.organizationId },
    });
    await configure('PATCH', `/sla/policies/${policy.id}`, {
      token: tenant.token,
      payload: { appliesTo: { priorities: ['urgent'] } },
    });

    const ordinary = await createLead(tenant, 'Ordinary', { priority: 'low' });
    expect(await clocksFor(tenant, ordinary)).toHaveLength(0);

    const urgent = await createLead(tenant, 'Urgentone', { priority: 'urgent' });
    expect(await clocksFor(tenant, urgent)).toHaveLength(1);
  });

  it('picks the narrower policy when two apply at the same priority', async () => {
    const tenant = await createTenant('narrow');
    await configure('POST', '/sla/policies', {
      token: tenant.token,
      payload: {
        name: 'Urgent leads in ten minutes',
        appliesTo: { priorities: ['urgent'] },
        firstResponseMinutes: 10,
        priority: 0,
      },
    });
    const leadId = await createLead(tenant, 'Narrowed', { priority: 'urgent' });
    const clocks = await clocksFor(tenant, leadId);
    expect(clocks[0]?.targetMinutes).toBe(10);
  });
});

describe('satisfying a clock', () => {
  it('is satisfied by a completed follow-up, which also records the first contact', async () => {
    const tenant = await createTenant('answered');
    const leadId = await createLead(tenant, 'Answered');
    const config = await api<{ outcomes: { id: string }[] }>('GET', '/tasks/config', {
      token: tenant.token,
    });
    const task = await configure<{ id: string }>('POST', '/tasks', {
      token: tenant.token,
      payload: {
        leadId,
        title: 'Call the enquiry back',
        dueAt: new Date(Date.now() + 3_600_000).toISOString(),
      },
    });
    await configure('POST', `/tasks/${task.body.data.id}/complete`, {
      token: tenant.token,
      payload: { outcomeId: config.body.data.outcomes[0]!.id },
    });

    const clocks = await clocksFor(tenant, leadId);
    expect(clocks[0]?.state).toBe('satisfied');
    expect(clocks[0]?.health).toBe('met');
    expect(clocks[0]?.metOnTime).toBe(true);
    // The sentence a report reads, rather than an id.
    expect(clocks[0]?.satisfiedBy).toContain('Call the enquiry back');

    // `leads.first_contacted_at` has existed since step 1 with no writer at all — the same shape as
    // a money column that reads as zero and lies to every report touching it.
    const lead = await api<{ firstContactedAt: string | null; lastContactedAt: string | null }>(
      'GET',
      `/leads/${leadId}`,
      { token: tenant.token },
    );
    expect(lead.body.data.firstContactedAt).not.toBeNull();
  });

  it('is satisfied by a terminal status for the resolution target, and cancelled by an invalid one', async () => {
    const tenant = await createTenant('closed');
    const policy = await ctx.db.slaPolicy.findFirstOrThrow({
      where: { organizationId: tenant.organizationId },
    });
    await configure('PATCH', `/sla/policies/${policy.id}`, {
      token: tenant.token,
      payload: { resolutionMinutes: 2880 },
    });
    const statuses = await api<{ id: string; name: string; category: string }[]>(
      'GET',
      '/crm/statuses',
      { token: tenant.token },
    );
    const won = statuses.body.data.find((status) => status.category === 'won')!;
    const invalid = statuses.body.data.find((status) => status.category === 'invalid')!;

    const wonLead = await createLead(tenant, 'Wonone');
    await configure('POST', `/leads/${wonLead}/status`, {
      token: tenant.token,
      payload: { statusId: won.id },
    });
    const wonClocks = await clocksFor(tenant, wonLead);
    const resolution = wonClocks.find((clock) => clock.target === 'resolution')!;
    expect(resolution.state).toBe('satisfied');
    // The first-response clock is untouched: winning a sale is not getting back to somebody.
    expect(wonClocks.find((clock) => clock.target === 'first_response')?.state).toBe('running');

    const junkLead = await createLead(tenant, 'Junkone');
    await configure('POST', `/leads/${junkLead}/status`, {
      token: tenant.token,
      payload: { statusId: invalid.id },
    });
    const junkClocks = await clocksFor(tenant, junkLead);
    // Cancelled, not satisfied. Counting a wrong number as a kept promise is how an SLA report
    // becomes flattering and useless.
    expect(junkClocks.every((clock) => clock.state === 'cancelled')).toBe(true);
  });

  it('stops the clocks on a deleted lead, and on one absorbed by a merge', async () => {
    const tenant = await createTenant('stopped');
    const deleted = await createLead(tenant, 'Deletedone');
    await configure('DELETE', `/leads/${deleted}`, { token: tenant.token });
    const stopped = await ctx.db.slaClock.findMany({ where: { leadId: deleted } });
    expect(stopped.every((clock) => clock.state === 'cancelled')).toBe(true);

    // A merge absorbs the duplicate and soft-deletes it; without cancelling, its clock would
    // breach forever on a lead nobody can open.
    const survivor = await createLead(tenant, 'Survivor', { phone: '9845000111' });
    const absorbed = await createLead(tenant, 'Absorbed', { phone: '9845000222' });
    await configure('POST', '/duplicates/merge', {
      token: tenant.token,
      payload: { survivingLeadId: survivor, mergedLeadId: absorbed, fieldChoices: {} },
    });
    const merged = await ctx.db.slaClock.findMany({ where: { leadId: absorbed } });
    expect(merged.every((clock) => clock.state === 'cancelled')).toBe(true);
    // And the survivor keeps its own promise.
    const kept = await ctx.db.slaClock.findMany({ where: { leadId: survivor } });
    expect(kept.every((clock) => clock.state === 'running')).toBe(true);
  });
});

describe('the sweep escalates exactly once (the phase exit criterion)', () => {
  it('warns once and breaches once, however many times it runs', async () => {
    const tenant = await createTenant('swept');
    const leadId = await createLead(tenant, 'Swept');
    const [clock] = await clocksFor(tenant, leadId);
    expect(clock).toBeDefined();

    // Near-breach first.
    await expire(clock!.id, { warnOnly: true });
    await sweep();
    await sweep();
    await sweep();
    const warnings = await ctx.db.escalation.findMany({ where: { clockId: clock!.id, level: 1 } });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.reason).toBe('at_risk');
    // Still running: a warning is not a breach.
    expect((await ctx.db.slaClock.findUniqueOrThrow({ where: { id: clock!.id } })).state).toBe(
      'running',
    );

    // Then the breach.
    await expire(clock!.id);
    await sweep();
    await sweep();
    const breaches = await ctx.db.escalation.findMany({ where: { clockId: clock!.id, level: 2 } });
    expect(breaches).toHaveLength(1);
    expect(breaches[0]?.reason).toBe('breached');

    const after = await ctx.db.slaClock.findUniqueOrThrow({ where: { id: clock!.id } });
    expect(after.state).toBe('breached');
    expect(after.breachedAt).not.toBeNull();

    // And the lead's timeline tells the story, once per level.
    const timeline = await api<{ type: string }[]>('GET', `/leads/${leadId}/timeline`, {
      token: tenant.token,
    });
    const types = timeline.body.data.map((entry) => entry.type);
    expect(types.filter((type) => type === 'sla.at_risk')).toHaveLength(1);
    expect(types.filter((type) => type === 'sla.breached')).toHaveLength(1);
  });

  it('refuses a second escalation at the same level even from a parallel sweep', async () => {
    const tenant = await createTenant('parallel');
    const leadId = await createLead(tenant, 'Parallel');
    const [clock] = await clocksFor(tenant, leadId);
    await expire(clock!.id);

    // Two sweeps at once. A read-then-write would let both through; the unique key is what makes
    // this safe, and running them together is the only way to tell the two apart.
    const [first, second] = await Promise.all([sweep(), sweep()]);
    expect(first.breached + second.breached).toBe(1);
    expect(await ctx.db.escalation.count({ where: { clockId: clock!.id } })).toBe(1);
  });

  it('tells the assignee and whoever holds task:manage_others', async () => {
    const tenant = await createTenant('told');
    const leadId = await createLead(tenant, 'Told');
    await configure('POST', `/leads/${leadId}/assign`, {
      token: tenant.token,
      payload: { assignedUserId: tenant.userId },
    });
    const [clock] = await clocksFor(tenant, leadId);
    await expire(clock!.id);
    await sweep();

    const escalation = await ctx.db.escalation.findFirstOrThrow({ where: { clockId: clock!.id } });
    // The owner holds every permission, so they are both the assignee and the escalation target
    // here; what matters is that the row records *who was told* rather than leaving it to be
    // recomputed later, when a role change would make the row and the notifications disagree.
    expect(escalation.notifiedUserIds).toContain(tenant.userId);
    expect(escalation.notifiedUserIds.length).toBeGreaterThan(0);
  });

  it('does not breach a clock that was satisfied before the sweep ran', async () => {
    const tenant = await createTenant('intime');
    const leadId = await createLead(tenant, 'Intime');
    const config = await api<{ outcomes: { id: string }[] }>('GET', '/tasks/config', {
      token: tenant.token,
    });
    const [clock] = await clocksFor(tenant, leadId);
    await expire(clock!.id);

    const task = await configure<{ id: string }>('POST', '/tasks', {
      token: tenant.token,
      payload: { leadId, title: 'Call', dueAt: new Date(Date.now() + 3_600_000).toISOString() },
    });
    await configure('POST', `/tasks/${task.body.data.id}/complete`, {
      token: tenant.token,
      payload: { outcomeId: config.body.data.outcomes[0]!.id },
    });
    await sweep();

    const after = await ctx.db.slaClock.findUniqueOrThrow({ where: { id: clock!.id } });
    expect(after.state).toBe('satisfied');
    expect(await ctx.db.escalation.count({ where: { clockId: clock!.id } })).toBe(0);
    // Answered, but after the deadline — which the report has to be able to say.
    expect(after.satisfiedAt!.getTime()).toBeGreaterThan(after.dueAt.getTime());
  });

  it('does not breach a clock on a lead that has been deleted', async () => {
    const tenant = await createTenant('gone');
    const leadId = await createLead(tenant, 'Goneone');
    const [clock] = await clocksFor(tenant, leadId);
    await expire(clock!.id);
    // Cancelled by the delete; the sweep's own predicate skips deleted leads too, which is what
    // makes a future call site that forgets unable to produce a phantom breach.
    await configure('DELETE', `/leads/${leadId}`, { token: tenant.token });
    await sweep();
    expect(await ctx.db.escalation.count({ where: { clockId: clock!.id } })).toBe(0);
  });
});

describe('the board (GET /sla/board)', () => {
  it('counts the whole filter rather than the loaded page', async () => {
    const tenant = await createTenant('board');
    const config = await api<{ outcomes: { id: string }[] }>('GET', '/tasks/config', {
      token: tenant.token,
    });

    const breached: string[] = [];
    for (const label of ['Boardone', 'Boardtwo', 'Boardthree']) {
      const leadId = await createLead(tenant, label);
      const [clock] = await clocksFor(tenant, leadId);
      await expire(clock!.id);
      breached.push(clock!.id);
    }
    const atRiskLead = await createLead(tenant, 'Boardrisk');
    const [atRiskClock] = await clocksFor(tenant, atRiskLead);
    await expire(atRiskClock!.id, { warnOnly: true });

    const answeredLead = await createLead(tenant, 'Boardmet');
    const task = await configure<{ id: string }>('POST', '/tasks', {
      token: tenant.token,
      payload: {
        leadId: answeredLead,
        title: 'Call',
        dueAt: new Date(Date.now() + 3_600_000).toISOString(),
      },
    });
    await configure('POST', `/tasks/${task.body.data.id}/complete`, {
      token: tenant.token,
      payload: { outcomeId: config.body.data.outcomes[0]!.id },
    });

    const board = await api<{
      counts: Record<string, number>;
      items: ClockBody[];
      unacknowledged: number;
    }>('GET', '/sla/board', { token: tenant.token });
    expect(board.statusCode).toBe(200);
    // Three breached before any sweep has run: the board reads the clock, not the stored state.
    expect(board.body.data.counts['breached']).toBe(breached.length);
    expect(board.body.data.counts['at_risk']).toBe(1);
    expect(board.body.data.counts['met']).toBe(1);
    // The clocks it lists are the ones running out soonest, and each carries its own reading.
    expect(board.body.data.items.every((clock) => clock.health !== 'met')).toBe(true);

    await sweep();
    const afterSweep = await api<{ counts: Record<string, number>; unacknowledged: number }>(
      'GET',
      '/sla/board',
      { token: tenant.token },
    );
    // The same count after the sweep as before it. That is the point of deriving health from the
    // clock: a board is never a cron tick behind the truth.
    expect(afterSweep.body.data.counts['breached']).toBe(breached.length);
    expect(afterSweep.body.data.unacknowledged).toBeGreaterThan(0);
  });

  it('lets somebody say they have seen an escalation, once', async () => {
    const tenant = await createTenant('seen');
    const leadId = await createLead(tenant, 'Seenone');
    const [clock] = await clocksFor(tenant, leadId);
    await expire(clock!.id);
    await sweep();

    const escalations = await api<{ id: string; acknowledgedAt: string | null }[]>(
      'GET',
      '/sla/escalations?unacknowledgedOnly=true',
      { token: tenant.token },
    );
    const escalation = escalations.body.data[0]!;
    expect(escalation.acknowledgedAt).toBeNull();

    const first = await api<{ alreadyAcknowledged: boolean }>(
      'POST',
      `/sla/escalations/${escalation.id}/acknowledge`,
      { token: tenant.token, payload: {} },
    );
    expect(first.statusCode).toBe(200);
    expect(first.body.data.alreadyAcknowledged).toBe(false);

    const again = await api<{ alreadyAcknowledged: boolean }>(
      'POST',
      `/sla/escalations/${escalation.id}/acknowledge`,
      { token: tenant.token, payload: {} },
    );
    expect(again.body.data.alreadyAcknowledged).toBe(true);
  });
});

describe('policies are configuration, not code', () => {
  it('refuses to delete a policy that clocks have run against, and names the count', async () => {
    const tenant = await createTenant('inuse');
    await createLead(tenant, 'Inuse');
    const policy = await ctx.db.slaPolicy.findFirstOrThrow({
      where: { organizationId: tenant.organizationId },
    });
    const refused = await api('DELETE', `/sla/policies/${policy.id}`, { token: tenant.token });
    expect(refused.statusCode).toBe(422);
    expect(JSON.stringify(refused.body)).toMatch(/Deactivate it instead/);
  });

  it('does not move the clocks already running when a target is edited', async () => {
    const tenant = await createTenant('edited');
    const leadId = await createLead(tenant, 'Edited');
    const before = (await clocksFor(tenant, leadId))[0]!;
    const policy = await ctx.db.slaPolicy.findFirstOrThrow({
      where: { organizationId: tenant.organizationId },
    });

    await configure('PATCH', `/sla/policies/${policy.id}`, {
      token: tenant.token,
      payload: { firstResponseMinutes: 600 },
    });
    const after = (await clocksFor(tenant, leadId))[0]!;
    // A promise made at 09:00 under a 60-minute policy was made. Retargeting it afterwards would
    // let a breach un-breach itself because somebody relaxed the policy.
    expect(after.dueAt).toBe(before.dueAt);
    expect(after.targetMinutes).toBe(60);

    // The next lead gets the new promise.
    const next = await createLead(tenant, 'Afteredit');
    expect((await clocksFor(tenant, next))[0]?.targetMinutes).toBe(600);
  });

  it('refuses a warning threshold that is not strictly inside the target', async () => {
    const refused = await api('POST', '/sla/policies', {
      token: orgA.token,
      payload: { name: `Silly ${SUFFIX}`, firstResponseMinutes: 60, warnAtPercent: 100 },
    });
    expect(refused.statusCode).toBe(400);
  });

  it('runs round the clock when the policy says business hours do not apply', async () => {
    const tenant = await createTenant('alwayson');
    const policy = await ctx.db.slaPolicy.findFirstOrThrow({
      where: { organizationId: tenant.organizationId },
    });
    await configure('PATCH', `/sla/policies/${policy.id}`, {
      token: tenant.token,
      payload: { businessHoursOnly: false, firstResponseMinutes: 60 },
    });
    const leadId = await createLead(tenant, 'Alwayson');
    const clock = (await clocksFor(tenant, leadId))[0]!;
    // Sixty elapsed minutes, to the minute, whenever this test runs.
    const elapsed =
      (new Date(clock.dueAt).getTime() - new Date(clock.startedAt).getTime()) / 60_000;
    expect(Math.round(elapsed)).toBe(60);
  });
});

describe('tenancy', () => {
  it('answers 404 for another workspace’s policy and shows none of its clocks', async () => {
    const leadId = await createLead(orgA, 'Private');
    const policy = await ctx.db.slaPolicy.findFirstOrThrow({
      where: { organizationId: orgA.organizationId },
    });

    for (const [method, url] of [
      ['PATCH', `/sla/policies/${policy.id}`],
      ['DELETE', `/sla/policies/${policy.id}`],
    ] as const) {
      const response = await api(method, url, {
        token: orgB.token,
        payload: method === 'PATCH' ? { firstResponseMinutes: 5 } : undefined,
      });
      expect(response.statusCode, `${method} ${url}`).toBe(404);
    }

    const clocks = await api<ClockBody[]>('GET', `/sla/clocks?leadId=${leadId}`, {
      token: orgB.token,
    });
    // Not a 404: a list of nothing is the honest answer to "show me the clocks on a lead I cannot
    // see", and it must not leak that the lead exists.
    expect(clocks.body.data).toHaveLength(0);
  });
});

describe('the clock across timezones, including a clock change (the phase exit criterion)', () => {
  /**
   * The exit criterion asks that **clocks** respect working hours and holidays across timezones
   * with a DST case — and the pure arithmetic in `@leados/shared` already covers a clock change
   * exhaustively. What has never been exercised is everything *between*: the workspace's own
   * `working_hours` rows, `SlaCalendarService` turning them into a calendar, the holiday date-key
   * conversion, and the `due_at` that ends up stored on the row.
   *
   * A bug in any of those would be invisible to a calendar-level test. The holiday read is the
   * clearest example: `holidays.date` is a `date` column whose instant is midnight **UTC**, and
   * reading its key in the workspace's own zone shifts it a day west of Greenwich — a closure the
   * clock would apply to the wrong day, in exactly the timezones this block uses.
   *
   * So each case builds a real workspace, writes real hours, and asserts the stored instant.
   */
  const NINE_TO_SIX = [1, 2, 3, 4, 5].map((dayOfWeek) => ({
    dayOfWeek,
    startMinute: 9 * 60,
    endMinute: 18 * 60,
  }));

  /** A workspace in a named timezone, with Mon–Fri 09:00–18:00 and nothing else. */
  async function workspaceIn(label: string, timeZone: string): Promise<Tenant> {
    const tenant = await createTenant(label);
    const { newId } = await import('@leados/shared');
    await ctx.db.organization.update({
      where: { id: tenant.organizationId },
      data: { timezone: timeZone },
    });
    // Provisioning writes the *owner's* hours and a workspace-wide set; replace the workspace-wide
    // rows so the calendar under test is exactly the one this test describes.
    await ctx.db.workingHours.deleteMany({
      where: { organizationId: tenant.organizationId, userId: null },
    });
    await ctx.db.workingHours.createMany({
      data: NINE_TO_SIX.map((window) => ({
        id: newId(),
        organizationId: tenant.organizationId,
        userId: null,
        branchId: null,
        dayOfWeek: window.dayOfWeek,
        startMinute: window.startMinute,
        endMinute: window.endMinute,
        isWorking: true,
      })),
    });
    return tenant;
  }

  /**
   * Starts a first-response clock at a chosen instant and answers the row.
   *
   * Through `SlaService.startForLead`, which is the method capture calls — the difference being
   * that capture passes `now()` and a DST case needs a specific Friday.
   */
  async function clockStartedAt(tenant: Tenant, leadId: string, startedAt: Date) {
    const { SlaService } = await import('../src/modules/sla/sla.service.js');
    const { DbService } = await import('../src/infra/db/db.service.js');
    const { tenantContext, systemPrincipal, newId } = await import('@leados/shared');
    const lead = await ctx.db.lead.findFirstOrThrow({ where: { id: leadId } });
    // The clock the capture wrote was started at `now()`; this block is about a chosen instant.
    await ctx.db.slaClock.deleteMany({ where: { subjectId: leadId } });

    // Through the **app's** client, not the harness's unscoped one. `startForLead` reads the
    // active policies off the transaction it is handed, so an unscoped `tx` reads every
    // workspace's policies and matches one belonging to somebody else — which the composite FK
    // `sla_clocks_policy_same_org_fk` then refuses. The production caller always passes a scoped
    // transaction, and so must this.
    const db = ctx.app.get(DbService);
    await tenantContext.run(systemPrincipal(tenant.organizationId, newId()), async () => {
      await db.client.$transaction(async (tx) => {
        await ctx.app.get(SlaService).startForLead(tx as never, lead as never, startedAt);
      });
    });
    return ctx.db.slaClock.findFirstOrThrow({
      where: { subjectId: leadId, target: 'first_response' },
    });
  }

  it('carries a promise across the spring clock change without losing an hour', async () => {
    const berlin = await workspaceIn('berlin', 'Europe/Berlin');
    const leadId = await createLead(berlin, 'Springforward');

    // Friday 2026-03-27 at 17:30 CET (UTC+1). 60 working minutes = 30 before closing and 30 on the
    // next working morning — Monday the 30th, by which time the clocks have gone forward and local
    // 09:30 is 07:30 UTC rather than 08:30. An offset read once, on the start day, would be an
    // hour out; this is the assertion that it is not.
    const clock = await clockStartedAt(berlin, leadId, new Date('2026-03-27T16:30:00.000Z'));
    expect(clock.targetMinutes).toBe(60);
    expect(clock.dueAt.toISOString()).toBe('2026-03-30T07:30:00.000Z');
  });

  it('and the same in the autumn, when they go back', async () => {
    const berlin = await workspaceIn('berlinautumn', 'Europe/Berlin');
    const leadId = await createLead(berlin, 'Fallback');
    // Friday 2026-10-23 at 17:30 CEST (UTC+2) → Monday the 26th at 09:30 CET (UTC+1).
    const clock = await clockStartedAt(berlin, leadId, new Date('2026-10-23T15:30:00.000Z'));
    expect(clock.dueAt.toISOString()).toBe('2026-10-26T08:30:00.000Z');
  });

  it('gives the same local answer in two timezones, which is a different instant in each', async () => {
    const kolkata = await workspaceIn('kolkata', 'Asia/Kolkata');
    const newYork = await workspaceIn('newyork', 'America/New_York');
    const kolkataLead = await createLead(kolkata, 'Kolkataclock');
    const newYorkLead = await createLead(newYork, 'Newyorkclock');

    // Both captured at 10:00 local on Tuesday 2026-06-16, both promised 60 working minutes, both
    // due at 11:00 local — which is 05:30 UTC in Kolkata (UTC+5:30, no DST) and 15:00 UTC in New
    // York (UTC-4, on EDT). One calendar, two instants: that is what "across timezones" means.
    const kolkataClock = await clockStartedAt(
      kolkata,
      kolkataLead,
      new Date('2026-06-16T04:30:00.000Z'),
    );
    const newYorkClock = await clockStartedAt(
      newYork,
      newYorkLead,
      new Date('2026-06-16T14:00:00.000Z'),
    );
    expect(kolkataClock.dueAt.toISOString()).toBe('2026-06-16T05:30:00.000Z');
    expect(newYorkClock.dueAt.toISOString()).toBe('2026-06-16T15:00:00.000Z');
  });

  it('skips a holiday the workspace declared, on the day the workspace means', async () => {
    const newYork = await workspaceIn('holiday', 'America/New_York');
    const leadId = await createLead(newYork, 'Holidayclock');
    const { newId } = await import('@leados/shared');
    // Thursday 2026-07-02 is a working day; Friday the 3rd is declared closed. A promise started at
    // 17:30 EDT on the Thursday therefore lands on **Monday** the 6th, not the Friday.
    //
    // The date is written as midnight UTC, which is how a `date` column stores it — and reading
    // that key back in New York's zone would call it the 2nd and close the wrong day. This is the
    // assertion that it does not.
    await ctx.db.holiday.create({
      data: {
        id: newId(),
        organizationId: newYork.organizationId,
        branchId: null,
        date: new Date('2026-07-03T00:00:00.000Z'),
        name: 'Independence Day (observed)',
        isWorking: false,
      },
    });

    const clock = await clockStartedAt(newYork, leadId, new Date('2026-07-02T21:30:00.000Z'));
    expect(clock.dueAt.toISOString()).toBe('2026-07-06T13:30:00.000Z'); // 09:30 EDT Monday
  });

  it('starts the clock at the next opening when the lead arrives at the weekend', async () => {
    const berlin = await workspaceIn('weekend', 'Europe/Berlin');
    const leadId = await createLead(berlin, 'Weekend');
    // Sunday 2026-06-14 at 11:00 CEST. The first working minute is Monday 09:00, so the promise is
    // due at 10:00 local — 08:00 UTC. A clock that counted from the capture instant would have
    // come due while the business was closed, which is the whole reason the calendar exists.
    const clock = await clockStartedAt(berlin, leadId, new Date('2026-06-14T09:00:00.000Z'));
    expect(clock.dueAt.toISOString()).toBe('2026-06-15T08:00:00.000Z');
  });
});
