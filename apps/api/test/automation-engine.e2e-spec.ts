import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { MAX_CAUSATION_DEPTH, newId, newToken } from '@leados/shared';
import { AutomationDispatchService } from '../src/modules/automation/automation-dispatch.service.js';
import { AutomationExecutorService } from '../src/modules/automation/automation-executor.service.js';
import { AutomationResumeSweepProcessor } from '../src/modules/automation/automation.processor.js';
import { bootTestApp, call, cleanupUsers, type EnvelopeBody, type TestApp } from './app-harness.js';

/**
 * THE AUTOMATION ENGINE SUITE — Phase 6, step 2 (`FR-AUT-6`, `FR-AUT-7`).
 *
 * The engine is driven through its **own services** rather than by waiting for a worker: the suite
 * boots the API, and a job enqueued here would be consumed by nothing. That is the arrangement the
 * webhook and SLA suites already use, and it is what lets a two-day wait be tested in a second —
 * the run's `resume_at` is a row, so the sweep can be asked to read it.
 *
 * What is asserted is the four things Phase 6's exit criteria name, plus the one the phase before
 * left unfinishable:
 *
 *  1. A retried delivery produces **one** run (Phase 5's third criterion, at last).
 *  2. Editing a live workflow does not alter an in-flight run — the run is pinned to its version.
 *  3. A dropped delayed job is recovered by the reconciliation sweep.
 *  4. Loop detection stops a self-triggering workflow; the daily cap is enforced; the kill switch
 *     stops a run before it acts.
 *  5. Every decision, **including "skipped because"**, is on the lead's timeline.
 */

const SUFFIX = newToken(4)
  .toLowerCase()
  .replace(/[^a-z0-9]/g, '');
const EMAIL_MARKER = `e2eeng${SUFFIX}`;
const PASSWORD = 'a quiet november harbour';

let ctx: TestApp;
let org: { token: string; organizationId: string; userId: string };
let dispatch: AutomationDispatchService;
let executor: AutomationExecutorService;
let sweep: AutomationResumeSweepProcessor;
let statuses: { id: string; name: string }[];

async function api<T>(
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
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

/**
 * Every workflow this suite publishes, archived after each test.
 *
 * Without this each test's workflow goes on listening to `lead.created`, so the next test's lead
 * triggers all of them: `dispatch` answers `started: 8`, the daily-cap test's cap is eaten by
 * somebody else's workflow, and every count in the file is suite-wide. The same lesson as "a test
 * that reaches for a fixture another test created depends on the order the file runs in", one
 * layer along — here the shared fixture is the *listener*, and archiving is what unsubscribes it.
 */
const published: string[] = [];

afterEach(async () => {
  for (const workflowId of published.splice(0)) {
    await api('PATCH', `/automation/workflows/${workflowId}`, {
      token: org.token,
      payload: { status: 'archived' },
    });
  }
});

/** A published workflow with the steps given, and its id. */
async function publish(
  steps: Record<string, unknown>[],
  options: { conditions?: Record<string, unknown>; reentry?: Record<string, unknown> } = {},
): Promise<string> {
  const created = await setup<{ id: string }>('POST', '/automation/workflows', {
    token: org.token,
    payload: { name: `Engine ${newId().slice(-8)}`, ...(options.reentry ?? {}) },
  });
  await setup('PUT', `/automation/workflows/${created.id}/definition`, {
    token: org.token,
    payload: {
      definition: {
        trigger: { type: 'lead.created' },
        ...(options.conditions === undefined ? {} : { conditions: options.conditions }),
        steps,
      },
    },
  });
  await setup('POST', `/automation/workflows/${created.id}/publish`, { token: org.token });
  published.push(created.id);
  return created.id;
}

/**
 * A captured lead. `fullName` is **derived** by the capture path from the parts, so it is not a
 * field this schema accepts — the first draft sent it and every test failed on
 * `UNRECOGNIZED_KEYS`, which is the strict schema doing its job.
 */
async function lead(overrides: Record<string, unknown> = {}): Promise<string> {
  const created = await setup<{ id: string }>('POST', '/leads', {
    token: org.token,
    payload: {
      firstName: 'Engine',
      lastName: `Lead ${newId().slice(-6)}`,
      phone: `+9198450${String(Math.floor(Math.random() * 90000) + 10000)}`,
      ...overrides,
    },
  });
  return created.id;
}

/** Runs the whole chain: each step enqueues the next, so the suite drives `advance` until done. */
async function drive(runId: string, limit = 20): Promise<string> {
  let status = 'running';
  for (let step = 0; step < limit; step += 1) {
    const outcome = await executor.advance(org.organizationId, runId);
    status = outcome.status;
    if (status !== 'running') break;
  }
  return status;
}

async function runFor(workflowId: string, leadId: string) {
  return ctx.db.automationRun.findFirst({
    where: { workflowId, leadId },
    orderBy: [{ startedAt: 'desc' }],
  });
}

async function timelineFor(leadId: string) {
  return setup<{ type: string; payload: Record<string, unknown> }[]>(
    'GET',
    `/leads/${leadId}/timeline`,
    { token: org.token },
  );
}

beforeAll(async () => {
  ctx = await bootTestApp();
  const registered = await setup<{
    organization: { id: string };
    user: { id: string };
    tokens: { accessToken: string };
  }>('POST', '/auth/register', {
    payload: {
      email: `${EMAIL_MARKER}@test.local`,
      password: PASSWORD,
      name: 'Engine Owner',
      organizationName: `ENGINE ${SUFFIX}`,
    },
  });
  org = {
    token: registered.tokens.accessToken,
    organizationId: registered.organization.id,
    userId: registered.user.id,
  };
  dispatch = ctx.app.get(AutomationDispatchService);
  executor = ctx.app.get(AutomationExecutorService);
  sweep = ctx.app.get(AutomationResumeSweepProcessor);
  statuses = await setup<{ id: string; name: string }[]>('GET', '/crm/statuses', {
    token: org.token,
  });
}, 120_000);

afterAll(async () => {
  await cleanupUsers(ctx.db, `${EMAIL_MARKER}%`);
  await ctx.close();
});

describe('a workflow that runs', () => {
  it('enrols the lead, acts, and writes every decision to the timeline', async () => {
    const workflowId = await publish([
      { id: 'note', action: 'add_note', params: { body: 'Hello {{lead.fullName}} — call them.' } },
    ]);
    const leadId = await lead({ firstName: 'Asha', lastName: 'Rao' });

    const outcome = await dispatch.dispatch({
      organizationId: org.organizationId,
      leadId,
      eventName: 'lead.created',
      eventId: newId(),
    });
    expect(outcome.started).toBe(1);

    const run = await runFor(workflowId, leadId);
    expect(run?.status).toBe('running');
    expect(await drive(run!.id)).toBe('completed');

    const steps = await ctx.db.automationRunStep.findMany({ where: { runId: run!.id } });
    expect(steps).toHaveLength(1);
    expect(steps[0]?.status).toBe('succeeded');

    const timeline = await timelineFor(leadId);
    // Rule six, and `FR-AUT-7`: the enrolment, the action, and the note itself.
    expect(timeline.some((entry) => entry.type === 'automation.enrolled')).toBe(true);
    expect(timeline.some((entry) => entry.type === 'automation.action_executed')).toBe(true);
    const note = timeline.find((entry) => entry.type === 'note.added');
    // The placeholder was filled from the lead's own facts, which is what makes a workflow's
    // message readable rather than a template nobody edited.
    expect(note?.payload['note']).toBe('Hello Asha Rao — call them.');
  });

  it('produces one run from a delivery that arrives twice (Phase 5’s third criterion)', async () => {
    const workflowId = await publish([
      { id: 'note', action: 'add_note', params: { body: 'Once only.' } },
    ]);
    const leadId = await lead();
    const eventId = newId();

    const first = await dispatch.dispatch({
      organizationId: org.organizationId,
      leadId,
      eventName: 'lead.created',
      eventId,
    });
    const second = await dispatch.dispatch({
      organizationId: org.organizationId,
      leadId,
      eventName: 'lead.created',
      eventId,
    });
    expect(first.started).toBe(1);
    // The partial unique is what makes this true, not a check the second call passed.
    expect(second.started).toBe(0);
    expect(await ctx.db.automationRun.count({ where: { workflowId, leadId } })).toBe(1);
  });

  it('changes the status through the real path, so the history and the event happen too', async () => {
    const target = statuses.find((status) => status.name !== statuses[0]?.name) ?? statuses[0]!;
    const workflowId = await publish([
      { id: 'move', action: 'change_status', params: { statusId: target.id } },
    ]);
    const leadId = await lead();
    await dispatch.dispatch({
      organizationId: org.organizationId,
      leadId,
      eventName: 'lead.created',
      eventId: newId(),
    });
    const run = await runFor(workflowId, leadId);
    expect(await drive(run!.id)).toBe('completed');

    // The detail presenter answers `status` as an object, not `statusId` — reading the field a
    // *create* response happens to carry is how a test asserts against something that is not
    // there and passes for the wrong reason.
    const after = await setup<{ status: { id: string } }>('GET', `/leads/${leadId}`, {
      token: org.token,
    });
    expect(after.status.id).toBe(target.id);
    // The history row `LeadsService` writes — which a workflow reaching Prisma directly would have
    // skipped, leaving a lead that moved with no record of why.
    const history = await ctx.db.leadStatusHistory.findMany({ where: { leadId } });
    expect(history.length).toBeGreaterThanOrEqual(1);
  });
});

describe('conditions and branches', () => {
  it('skips a lead the entry conditions exclude, and says why on the timeline', async () => {
    const workflowId = await publish(
      [{ id: 'note', action: 'add_note', params: { body: 'Only for Mumbai.' } }],
      { conditions: { all: [{ field: 'lead.city', operator: 'equals', value: 'Mumbai' }] } },
    );
    const leadId = await lead({ city: 'Pune' });

    const outcome = await dispatch.dispatch({
      organizationId: org.organizationId,
      leadId,
      eventName: 'lead.created',
      eventId: newId(),
    });
    expect(outcome.started).toBe(0);
    expect(outcome.skipped).toBe(1);
    // No enrolment at all: a row for a lead the conditions exclude would make the re-entry count
    // wrong for ever.
    expect(await ctx.db.automationEnrollment.count({ where: { workflowId, leadId } })).toBe(0);

    const timeline = await timelineFor(leadId);
    const skip = timeline.find((entry) => entry.type === 'automation.skipped');
    expect(skip).toBeDefined();
    // The sentence, not a code — this is the answer to "why didn't they get the message".
    expect(skip?.payload['reason']).toBe('lead.city is Pune, not is Mumbai');
  });

  it('takes one arm of a branch and skips the other wholesale', async () => {
    const workflowId = await publish([
      {
        id: 'decide',
        action: 'branch',
        conditions: { all: [{ field: 'lead.city', operator: 'equals', value: 'Pune' }] },
        then: [{ id: 'hot', action: 'add_note', params: { body: 'Pune lead.' } }],
        otherwise: [{ id: 'cold', action: 'add_note', params: { body: 'Somewhere else.' } }],
      },
      { id: 'after', action: 'add_note', params: { body: 'Either way.' } },
    ]);
    const leadId = await lead({ city: 'Pune' });
    await dispatch.dispatch({
      organizationId: org.organizationId,
      leadId,
      eventName: 'lead.created',
      eventId: newId(),
    });
    const run = await runFor(workflowId, leadId);
    expect(await drive(run!.id)).toBe('completed');

    const steps = await ctx.db.automationRunStep.findMany({
      where: { runId: run!.id },
      orderBy: [{ startedAt: 'asc' }],
    });
    expect(steps.map((step) => step.stepId)).toEqual(['decide', 'hot', 'after']);
    expect(steps[0]?.decision).toBe('then');
    const notes = (await timelineFor(leadId))
      .filter((entry) => entry.type === 'note.added')
      .map((entry) => entry.payload['note']);
    expect(notes).toContain('Pune lead.');
    expect(notes).not.toContain('Somewhere else.');
  });
});

describe('waiting, and the sweep that recovers a dropped job', () => {
  it('suspends on a wait with the instant it is owed, and resumes when the sweep reads it', async () => {
    const workflowId = await publish([
      { id: 'hold', action: 'wait', params: { minutes: 120 } },
      { id: 'note', action: 'add_note', params: { body: 'After the wait.' } },
    ]);
    const leadId = await lead();
    await dispatch.dispatch({
      organizationId: org.organizationId,
      leadId,
      eventName: 'lead.created',
      eventId: newId(),
    });
    const run = await runFor(workflowId, leadId);
    expect(await executor.advance(org.organizationId, run!.id)).toEqual({ status: 'waiting' });

    const waiting = await ctx.db.automationRun.findFirstOrThrow({ where: { id: run!.id } });
    expect(waiting.status).toBe('waiting');
    expect(waiting.currentStepId).toBe('hold');
    expect(waiting.resumeAt).not.toBeNull();
    // Roughly two hours away: the arithmetic is the pure runtime's, and this is the row.
    expect(waiting.resumeAt!.getTime() - Date.now()).toBeGreaterThan(100 * 60_000);

    // The sweep finds nothing while the wait is real — which is what stops it resuming everything
    // on every tick.
    expect((await sweep.sweep()).resumed).toBe(0);

    // Now the delayed job is **deliberately dropped**: nothing is enqueued, and the moment is
    // moved into the past. Only `resume_at` is left, which is the exit criterion exactly.
    await ctx.db.automationRun.update({
      where: { id: run!.id },
      data: { resumeAt: new Date(Date.now() - 60_000) },
    });
    const swept = await sweep.sweep();
    expect(swept.examined).toBeGreaterThanOrEqual(1);
    expect(swept.resumed).toBeGreaterThanOrEqual(1);

    expect(await drive(run!.id)).toBe('completed');
    const notes = (await timelineFor(leadId))
      .filter((entry) => entry.type === 'note.added')
      .map((entry) => entry.payload['note']);
    expect(notes).toContain('After the wait.');
  });

  it('leaves a run alone that is no longer waiting, so a racing job is a no-op', async () => {
    const workflowId = await publish([
      { id: 'note', action: 'add_note', params: { body: 'Done already.' } },
    ]);
    const leadId = await lead();
    await dispatch.dispatch({
      organizationId: org.organizationId,
      leadId,
      eventName: 'lead.created',
      eventId: newId(),
    });
    const run = await runFor(workflowId, leadId);
    await drive(run!.id);

    const before = await ctx.db.automationRunStep.count({ where: { runId: run!.id } });
    // The delayed job arriving after the sweep already advanced the run: `advance` re-reads it and
    // declines, which is what makes a duplicated job cost a query rather than a double step.
    await executor.advance(org.organizationId, run!.id);
    expect(await ctx.db.automationRunStep.count({ where: { runId: run!.id } })).toBe(before);
  });
});

describe('the guardrails (`FR-AUT-6`)', () => {
  it('runs once per lead under the default policy, and says so the second time', async () => {
    const workflowId = await publish([
      { id: 'note', action: 'add_note', params: { body: 'Once.' } },
    ]);
    const leadId = await lead();
    await dispatch.dispatch({
      organizationId: org.organizationId,
      leadId,
      eventName: 'lead.created',
      eventId: newId(),
    });
    const run = await runFor(workflowId, leadId);
    await drive(run!.id);

    const again = await dispatch.dispatch({
      organizationId: org.organizationId,
      leadId,
      eventName: 'lead.created',
      eventId: newId(),
    });
    expect(again.started).toBe(0);
    expect(again.skipped).toBe(1);
    const skip = (await timelineFor(leadId)).find((entry) => entry.type === 'automation.skipped');
    expect(skip?.payload['reason']).toContain('runs once per lead');
  });

  it('lets a lead in again when the policy says always', async () => {
    const workflowId = await publish(
      [{ id: 'note', action: 'add_note', params: { body: 'Again.' } }],
      { reentry: { reentryPolicy: 'always' } },
    );
    const leadId = await lead();
    for (const _ of [1, 2]) {
      await dispatch.dispatch({
        organizationId: org.organizationId,
        leadId,
        eventName: 'lead.created',
        eventId: newId(),
      });
      const run = await runFor(workflowId, leadId);
      await drive(run!.id);
    }
    const cycles = await ctx.db.automationEnrollment.findMany({
      where: { workflowId, leadId },
      orderBy: [{ cycle: 'asc' }],
    });
    expect(cycles.map((row) => row.cycle)).toEqual([1, 2]);
  });

  it('never starts a second run while one is live, whatever the policy', async () => {
    const workflowId = await publish(
      [
        { id: 'hold', action: 'wait', params: { minutes: 60 } },
        { id: 'note', action: 'add_note', params: { body: 'Later.' } },
      ],
      { reentry: { reentryPolicy: 'always' } },
    );
    const leadId = await lead();
    await dispatch.dispatch({
      organizationId: org.organizationId,
      leadId,
      eventName: 'lead.created',
      eventId: newId(),
    });
    const run = await runFor(workflowId, leadId);
    await executor.advance(org.organizationId, run!.id);

    const again = await dispatch.dispatch({
      organizationId: org.organizationId,
      leadId,
      eventName: 'lead.created',
      eventId: newId(),
    });
    expect(again.started).toBe(0);
    const skip = (await timelineFor(leadId)).find(
      (entry) =>
        entry.type === 'automation.skipped' &&
        String(entry.payload['reason'] ?? '').includes('already running'),
    );
    expect(skip).toBeDefined();
  });

  it('stops at the loop ceiling rather than triggering itself for ever', async () => {
    const workflowId = await publish([
      { id: 'note', action: 'add_note', params: { body: 'Deep.' } },
    ]);
    const leadId = await lead();
    const outcome = await dispatch.dispatch({
      organizationId: org.organizationId,
      leadId,
      eventName: 'lead.created',
      eventId: newId(),
      causationDepth: MAX_CAUSATION_DEPTH,
    });
    expect(outcome.started).toBe(0);
    const skip = (await timelineFor(leadId)).find((entry) => entry.type === 'automation.skipped');
    // The sentence says what is happening, not a code: somebody needs to know their workflows are
    // triggering each other.
    expect(String(skip?.payload['reason'])).toContain('triggering itself');
    expect(await ctx.db.automationRun.count({ where: { workflowId, leadId } })).toBe(0);
  });

  it('carries the depth onto every event an action causes, so a chain climbs', async () => {
    const target = statuses[1] ?? statuses[0]!;
    const workflowId = await publish([
      { id: 'move', action: 'change_status', params: { statusId: target.id } },
    ]);
    const leadId = await lead();
    await dispatch.dispatch({
      organizationId: org.organizationId,
      leadId,
      eventName: 'lead.created',
      eventId: newId(),
      causationDepth: 1,
    });
    const run = await runFor(workflowId, leadId);
    expect(run?.causationDepth).toBe(1);
    await drive(run!.id);

    // `LeadsService.changeStatus` emitted `lead.status_changed` through its own outbox call, with
    // no idea automation existed — and the event carries depth 2, from the principal.
    const events = await ctx.db.outboxEvent.findMany({
      where: { organizationId: org.organizationId, eventName: 'lead.status_changed' },
      orderBy: [{ occurredAt: 'desc' }],
      take: 5,
    });
    const caused = events.find((event) => event.causationId === run!.id);
    expect(caused).toBeDefined();
    expect(caused?.causationDepth).toBe(2);
    expect(caused?.actorType).toBe('automation');
  });

  it('stops a workflow somebody has switched off, before it acts', async () => {
    const workflowId = await publish([
      { id: 'note', action: 'add_note', params: { body: 'Should not happen.' } },
    ]);
    await setup('PATCH', `/automation/workflows/${workflowId}`, {
      token: org.token,
      payload: { killSwitch: true },
    });
    const leadId = await lead();
    const outcome = await dispatch.dispatch({
      organizationId: org.organizationId,
      leadId,
      eventName: 'lead.created',
      eventId: newId(),
    });
    expect(outcome.started).toBe(0);
    // Silent, deliberately: a workspace does not want a timeline entry per event about a workflow
    // they stopped on purpose.
    expect(outcome.skipped).toBe(0);
    expect(await ctx.db.automationRun.count({ where: { workflowId } })).toBe(0);
  });

  it('enforces the daily action cap, and says so on the timeline', async () => {
    // The workspace's own cap, set to one so the second action is refused — and the counter
    // cleared **first**, because the day's window is shared with every other test in this file
    // and a cap of one would otherwise already be spent.
    await ctx.db.automationCounter.deleteMany({ where: { organizationId: org.organizationId } });
    await ctx.db.organization.update({
      where: { id: org.organizationId },
      data: { settings: { automationDailyActionCap: 1 } },
    });
    try {
      const workflowId = await publish([
        { id: 'one', action: 'add_note', params: { body: 'First.' } },
        { id: 'two', action: 'add_note', params: { body: 'Second.' } },
      ]);
      const leadId = await lead();
      await dispatch.dispatch({
        organizationId: org.organizationId,
        leadId,
        eventName: 'lead.created',
        eventId: newId(),
      });
      const run = await runFor(workflowId, leadId);
      expect(await drive(run!.id)).toBe('completed');

      const steps = await ctx.db.automationRunStep.findMany({
        where: { runId: run!.id },
        orderBy: [{ startedAt: 'asc' }],
      });
      expect(steps[0]?.status).toBe('succeeded');
      expect(steps[1]?.status).toBe('skipped');
      expect(steps[1]?.reason).toContain('which is the limit');
      const notes = (await timelineFor(leadId))
        .filter((entry) => entry.type === 'note.added')
        .map((entry) => entry.payload['note']);
      expect(notes).toContain('First.');
      expect(notes).not.toContain('Second.');
    } finally {
      await ctx.db.organization.update({
        where: { id: org.organizationId },
        data: { settings: {} },
      });
      await ctx.db.automationCounter.deleteMany({ where: { organizationId: org.organizationId } });
    }
  });
});

describe('editing a live workflow does not alter an in-flight run (`FR-AUT-5`)', () => {
  it('runs the version it started on, whatever has been published since', async () => {
    const workflowId = await publish([
      { id: 'hold', action: 'wait', params: { minutes: 60 } },
      { id: 'note', action: 'add_note', params: { body: 'The original wording.' } },
    ]);
    const leadId = await lead();
    await dispatch.dispatch({
      organizationId: org.organizationId,
      leadId,
      eventName: 'lead.created',
      eventId: newId(),
    });
    const run = await runFor(workflowId, leadId);
    await executor.advance(org.organizationId, run!.id);
    expect((await ctx.db.automationRun.findFirstOrThrow({ where: { id: run!.id } })).status).toBe(
      'waiting',
    );

    // The workflow is rewritten and published again while the run sits waiting.
    await setup('PUT', `/automation/workflows/${workflowId}/definition`, {
      token: org.token,
      payload: {
        definition: {
          trigger: { type: 'lead.created' },
          steps: [{ id: 'note', action: 'add_note', params: { body: 'Changed my mind.' } }],
        },
      },
    });
    await setup('POST', `/automation/workflows/${workflowId}/publish`, { token: org.token });

    await ctx.db.automationRun.update({
      where: { id: run!.id },
      data: { resumeAt: new Date(Date.now() - 1_000) },
    });
    await sweep.sweep();
    await drive(run!.id);

    const notes = (await timelineFor(leadId))
      .filter((entry) => entry.type === 'note.added')
      .map((entry) => entry.payload['note']);
    // The run is pinned to version 1, so it wrote the wording that was live when it started.
    expect(notes).toContain('The original wording.');
    expect(notes).not.toContain('Changed my mind.');
  });
});

describe('a step that cannot act', () => {
  it('skips with a reason rather than failing the run', async () => {
    const workflowId = await publish([
      // Nobody owns a lead this suite creates with no assignee, so there is nobody to tell.
      { id: 'tell', action: 'notify', params: { recipient: 'lead_owner', title: 'A hot lead' } },
      { id: 'note', action: 'add_note', params: { body: 'Carried on anyway.' } },
    ]);
    const leadId = await lead();
    await setup('POST', `/leads/${leadId}/assign`, {
      token: org.token,
      payload: { assignedUserId: null },
    });
    await dispatch.dispatch({
      organizationId: org.organizationId,
      leadId,
      eventName: 'lead.created',
      eventId: newId(),
    });
    const run = await runFor(workflowId, leadId);
    expect(await drive(run!.id)).toBe('completed');

    const steps = await ctx.db.automationRunStep.findMany({
      where: { runId: run!.id },
      orderBy: [{ startedAt: 'asc' }],
    });
    expect(steps[0]?.status).toBe('skipped');
    expect(steps[0]?.reason).toContain('nobody owns this lead');
    // A skip is a decision, not the end: the note two steps later still happened.
    expect(steps[1]?.status).toBe('succeeded');
  });

  it('fails the run with a sentence when a placeholder cannot be filled', async () => {
    const workflowId = await publish([
      { id: 'note', action: 'add_note', params: { body: 'Hello {{lead.nickname}}' } },
    ]);
    const leadId = await lead();
    await dispatch.dispatch({
      organizationId: org.organizationId,
      leadId,
      eventName: 'lead.created',
      eventId: newId(),
    });
    const run = await runFor(workflowId, leadId);
    expect(await drive(run!.id)).toBe('failed');

    const finished = await ctx.db.automationRun.findFirstOrThrow({ where: { id: run!.id } });
    // A template rendered with `undefined` is worse than no message, so the run fails and says
    // which placeholder — on the timeline, where somebody will see it.
    expect(finished.error).toContain('lead.nickname');
    expect(finished.finishedAt).not.toBeNull();
    const failure = (await timelineFor(leadId)).find((entry) => entry.type === 'automation.failed');
    expect(String(failure?.payload['reason'])).toContain('lead.nickname');
  });

  it('stops where the workflow says stop, with the reason on the timeline', async () => {
    const workflowId = await publish([
      { id: 'halt', action: 'stop', params: { reason: 'they are not ready yet' } },
      { id: 'never', action: 'add_note', params: { body: 'Unreachable.' } },
    ]);
    const leadId = await lead();
    await dispatch.dispatch({
      organizationId: org.organizationId,
      leadId,
      eventName: 'lead.created',
      eventId: newId(),
    });
    const run = await runFor(workflowId, leadId);
    expect(await drive(run!.id)).toBe('completed');

    const exited = (await timelineFor(leadId)).find((entry) => entry.type === 'automation.exited');
    expect(exited?.payload['reason']).toBe('they are not ready yet');
    const notes = (await timelineFor(leadId)).filter((entry) => entry.type === 'note.added');
    expect(notes).toHaveLength(0);
    const enrollment = await ctx.db.automationEnrollment.findFirstOrThrow({
      where: { workflowId, leadId },
    });
    expect(enrollment.exitReason).toBe('they are not ready yet');
  });
});

describe('the run log (`FR-AUT-7`)', () => {
  it('answers what happened, step by step, with the version it was pinned to', async () => {
    const workflowId = await publish([
      { id: 'note', action: 'add_note', params: { body: 'For the log.' } },
    ]);
    const leadId = await lead();
    await dispatch.dispatch({
      organizationId: org.organizationId,
      leadId,
      eventName: 'lead.created',
      eventId: newId(),
    });
    const run = await runFor(workflowId, leadId);
    await drive(run!.id);

    const detail = await setup<{
      status: string;
      version: number;
      steps: { stepId: string; action: string; status: string; reason: string | null }[];
      definition: unknown;
    }>('GET', `/automation/runs/${run!.id}`, { token: org.token });
    expect(detail.status).toBe('completed');
    expect(detail.version).toBe(1);
    expect(detail.steps).toHaveLength(1);
    expect(detail.steps[0]?.action).toBe('add_note');
    expect(detail.definition).toBeTruthy();

    const list = await api<{ id: string; steps: { action: string }[] }[]>(
      'GET',
      `/automation/runs?leadId=${leadId}`,
      { token: org.token },
    );
    expect(list.statusCode).toBe(200);
    const listed = list.body.data.find((row) => row.id === run!.id);
    expect(listed).toBeDefined();
    // The **list** carries the steps, not only the detail. It did not at first, and both screens
    // rendered a run row with an empty disclosure behind it — on the panels whose whole job is
    // answering "why". Asserted here because a screen that renders nothing looks like a screen
    // with nothing to render.
    expect(listed?.steps.map((step) => step.action)).toEqual(['add_note']);
    const pagination = list.body.meta?.['pagination'] as { total: number };
    expect(pagination.total).toBe(list.body.data.length);
  });

  it('refuses a run belonging to another workspace', async () => {
    const other = await setup<{ tokens: { accessToken: string } }>('POST', '/auth/register', {
      payload: {
        email: `${EMAIL_MARKER}other@test.local`,
        password: PASSWORD,
        name: 'Another Owner',
        organizationName: `ENGINE OTHER ${SUFFIX}`,
      },
    });
    const workflowId = await publish([
      { id: 'note', action: 'add_note', params: { body: 'Private.' } },
    ]);
    const leadId = await lead();
    await dispatch.dispatch({
      organizationId: org.organizationId,
      leadId,
      eventName: 'lead.created',
      eventId: newId(),
    });
    const run = await runFor(workflowId, leadId);
    const refused = await api('GET', `/automation/runs/${run!.id}`, {
      token: other.tokens.accessToken,
    });
    expect(refused.statusCode).toBe(404);
  });

  it('starts a workflow on one lead by hand, through the same guards', async () => {
    const workflowId = await publish([
      { id: 'note', action: 'add_note', params: { body: 'By hand.' } },
    ]);
    const leadId = await lead();
    const queued = await api('POST', `/automation/workflows/${workflowId}/start`, {
      token: org.token,
      payload: { leadId },
    });
    expect(queued.statusCode).toBe(202);
    // Queued rather than run inline: the first step may send a message, and a button must not wait
    // for a provider. The dispatch itself is driven here, as a worker would.
    await dispatch.dispatch({
      organizationId: org.organizationId,
      leadId,
      eventName: 'manual',
      workflowId,
    });
    const run = await runFor(workflowId, leadId);
    expect(run).not.toBeNull();
    expect(run?.triggerEventId).toBeNull();
  });
});
