import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { INDUSTRY_TEMPLATES, newId, newToken } from '@leados/shared';
import { AutomationDispatchService } from '../src/modules/automation/automation-dispatch.service.js';
import { AutomationExecutorService } from '../src/modules/automation/automation-executor.service.js';
import { bootTestApp, call, cleanupUsers, type EnvelopeBody, type TestApp } from './app-harness.js';

/**
 * THE PREVIEW, THE RETRY AND THE STARTERS — Phase 6, step 3 (`FR-AUT-3`, `FR-AUT-6`, `FR-AUT-7`).
 *
 * Its own file, and its own workspace, for the reason the engine suite's `afterEach` exists: a
 * test whose fixture is a **listener** leaks into every later test, and a `started` count read in
 * a file that publishes eight `lead.created` workflows is suite-wide rather than this test's.
 *
 * Three things are asserted, and each has a half that is easy to believe without checking:
 *
 *  1. A dry run **executes nothing** — no handler, no enrolment, no timeline entry, no cap spent —
 *     while still recording every decision. "It ran and nothing happened" and "it did not run"
 *     look identical on a screen, so the absences are asserted one by one.
 *  2. A retry starts at the **failed** step and not at the beginning, which means the step before
 *     it must still have exactly one attempt.
 *  3. An industry template's starter workflows arrive as **drafts** whose references are this
 *     workspace's own ids — a draft naming another workspace's task type is one that can never be
 *     published, and nothing else in the product would notice.
 */

const SUFFIX = newToken(4)
  .toLowerCase()
  .replace(/[^a-z0-9]/g, '');
const EMAIL_MARKER = `e2eprev${SUFFIX}`;
const PASSWORD = 'a quiet november harbour';

let ctx: TestApp;
let org: { token: string; organizationId: string; userId: string };
let dispatch: AutomationDispatchService;
let executor: AutomationExecutorService;

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

/** Every setup call's status is asserted: one that fails silently takes the real assertion with it. */
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

const published: string[] = [];

afterEach(async () => {
  for (const workflowId of published.splice(0)) {
    await api('PATCH', `/automation/workflows/${workflowId}`, {
      token: org.token,
      payload: { status: 'archived' },
    });
  }
});

/** A workflow with a saved definition and **no publish** — which is what a preview is for. */
async function draft(steps: Record<string, unknown>[]): Promise<string> {
  const created = await setup<{ id: string }>('POST', '/automation/workflows', {
    token: org.token,
    payload: { name: `Preview ${newId().slice(-8)}` },
  });
  await setup('PUT', `/automation/workflows/${created.id}/definition`, {
    token: org.token,
    payload: { definition: { trigger: { type: 'lead.created' }, steps } },
  });
  published.push(created.id);
  return created.id;
}

async function publish(steps: Record<string, unknown>[]): Promise<string> {
  const id = await draft(steps);
  await setup('POST', `/automation/workflows/${id}/publish`, { token: org.token });
  return id;
}

async function lead(overrides: Record<string, unknown> = {}): Promise<string> {
  const created = await setup<{ id: string }>('POST', '/leads', {
    token: org.token,
    payload: {
      firstName: 'Preview',
      lastName: `Lead ${newId().slice(-6)}`,
      phone: `+9198450${String(Math.floor(Math.random() * 90000) + 10000)}`,
      ...overrides,
    },
  });
  return created.id;
}

async function drive(runId: string, limit = 20): Promise<string> {
  let status = 'running';
  for (let step = 0; step < limit; step += 1) {
    const outcome = await executor.advance(org.organizationId, runId);
    status = outcome.status;
    if (status !== 'running') break;
  }
  return status;
}

interface RunBody {
  id: string;
  status: string;
  dryRun: boolean;
  cycle: number | null;
  stepsRun: number;
  error: string | null;
  steps: {
    stepId: string;
    action: string;
    attempt: number;
    status: string;
    reason: string | null;
    error: string | null;
    output: Record<string, unknown> | null;
  }[];
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
      name: 'Preview Owner',
      organizationName: `PREVIEW ${SUFFIX}`,
    },
  });
  org = {
    token: registered.tokens.accessToken,
    organizationId: registered.organization.id,
    userId: registered.user.id,
  };
  dispatch = ctx.app.get(AutomationDispatchService);
  executor = ctx.app.get(AutomationExecutorService);
}, 120_000);

afterAll(async () => {
  await cleanupUsers(ctx.db, `${EMAIL_MARKER}%`);
  await ctx.close();
});

describe('the dry run (`FR-AUT-6`)', () => {
  it('previews an unpublished draft, which is the whole point of having one', async () => {
    const workflowId = await draft([
      { id: 'note', action: 'add_note', params: { body: 'Call {{lead.fullName}} back.' } },
      { id: 'wait', action: 'wait', params: { minutes: 2880 } },
      { id: 'second', action: 'add_note', params: { body: 'Still nothing — try again.' } },
    ]);
    const leadId = await lead({ firstName: 'Asha', lastName: 'Rao' });

    const response = await api<RunBody>('POST', `/automation/workflows/${workflowId}/test-run`, {
      token: org.token,
      payload: { leadId },
    });
    expect(response.statusCode, JSON.stringify(response.body)).toBe(200);
    const run = response.body.data;

    // Inline and finished: the answer is the point of the button, so there is nothing to wait for.
    expect(run.dryRun).toBe(true);
    expect(run.status).toBe('completed');
    // Null rather than 1: "this lead's first time through" is a different fact from "this never
    // counted", and a 1 here would state the first of them falsely.
    expect(run.cycle).toBeNull();
    // The **wait** was walked rather than suspended on — a preview that slept for two days would
    // answer nothing anybody asked — so all three steps are in the log.
    expect(run.steps.map((step) => step.stepId)).toEqual(['note', 'wait', 'second']);
    expect(run.steps.every((step) => step.status === 'succeeded')).toBe(true);
    expect(run.steps[0]?.reason).toBe('would add a note');
    expect(run.steps[0]?.output?.['wouldRun']).toBe('add_note');
    // The wait's arithmetic is the real one: the instant it would have resumed at is recorded.
    expect(typeof run.steps[1]?.output?.['resumeAt']).toBe('string');
  });

  it('executes nothing: no note, no enrolment, no timeline entry and no cap spent', async () => {
    const workflowId = await draft([
      { id: 'note', action: 'add_note', params: { body: 'This note must not exist.' } },
    ]);
    const leadId = await lead();

    const countersBefore = await ctx.db.automationCounter.aggregate({
      where: { organizationId: org.organizationId, scopeKey: 'actions' },
      _sum: { count: true },
    });

    await setup<RunBody>('POST', `/automation/workflows/${workflowId}/test-run`, {
      token: org.token,
      payload: { leadId },
    });

    // The handler was never called, so the thing it writes is absent. A lead's note **is** a
    // timeline row in this product — there is no `notes` table — which is why this counts
    // `note.added` rather than looking for one.
    expect(await ctx.db.activity.count({ where: { leadId, type: 'note.added' } })).toBe(0);
    // No enrolment, which is what keeps the `once` policy intact for the real run.
    expect(await ctx.db.automationEnrollment.count({ where: { workflowId, leadId } })).toBe(0);
    // Nothing on the lead's own history: a timeline row claiming a workflow acted when it did not
    // is the one lie that would make the rest of the timeline unusable.
    const timeline = await setup<{ type: string }[]>('GET', `/leads/${leadId}/timeline`, {
      token: org.token,
    });
    expect(timeline.some((entry) => entry.type.startsWith('automation.'))).toBe(false);
    expect(timeline.some((entry) => entry.type === 'note.added')).toBe(false);
    // And the daily action cap is untouched, because no action was taken.
    const countersAfter = await ctx.db.automationCounter.aggregate({
      where: { organizationId: org.organizationId, scopeKey: 'actions' },
      _sum: { count: true },
    });
    expect(countersAfter._sum.count ?? 0).toBe(countersBefore._sum.count ?? 0);
  });

  it('shows up in the run list, labelled, and can be filtered out of it', async () => {
    const workflowId = await draft([
      { id: 'note', action: 'add_note', params: { body: 'Listed.' } },
    ]);
    const leadId = await lead();
    await setup<RunBody>('POST', `/automation/workflows/${workflowId}/test-run`, {
      token: org.token,
      payload: { leadId },
    });

    // The envelope lifts `items` into `data`, so a list's `data` **is** the array.
    const all = await setup<RunBody[]>('GET', `/automation/runs?workflowId=${workflowId}`, {
      token: org.token,
    });
    expect(all).toHaveLength(1);
    expect(all[0]?.dryRun).toBe(true);
    // Three-way: absent means both, so `dryRun=false` is the only thing that hides a preview.
    const real = await setup<RunBody[]>(
      'GET',
      `/automation/runs?workflowId=${workflowId}&dryRun=false`,
      { token: org.token },
    );
    expect(real).toHaveLength(0);
  });

  it('refuses a definition with problems, naming the field rather than the feature', async () => {
    // A `create_task` with no `dueInMinutes`: previewing a graph the engine cannot execute would
    // answer with a failure about this endpoint instead of about the workflow.
    const workflowId = await draft([
      { id: 'task', action: 'create_task', params: { title: 'Call them' } },
    ]);
    const leadId = await lead();
    const refused = await api('POST', `/automation/workflows/${workflowId}/test-run`, {
      token: org.token,
      payload: { leadId },
    });
    expect(refused.statusCode).toBe(400);
    const details = (refused.body as { error?: { details?: { field: string }[] } }).error?.details;
    expect(details?.some((detail) => detail.field.includes('dueInMinutes'))).toBe(true);
  });

  it('refuses a workflow with nothing in it yet', async () => {
    const created = await setup<{ id: string }>('POST', '/automation/workflows', {
      token: org.token,
      payload: { name: `Empty ${newId().slice(-8)}` },
    });
    published.push(created.id);
    const leadId = await lead();
    const refused = await api('POST', `/automation/workflows/${created.id}/test-run`, {
      token: org.token,
      payload: { leadId },
    });
    // 400 with the field list, because an untouched workflow has no trigger and no steps — the
    // same refusal publishing gives, from the same validator.
    expect(refused.statusCode).toBe(400);
  });

  it('is not the live run that stops a real one from starting', async () => {
    const workflowId = await publish([
      { id: 'note', action: 'add_note', params: { body: 'For real.' } },
    ]);
    const leadId = await lead();
    const workflow = await ctx.db.workflow.findFirstOrThrow({ where: { id: workflowId } });

    // A preview left mid-flight — the inline driver interrupted, a process restarted. Written
    // directly because the endpoint cannot leave one behind, and that is exactly the state the
    // guardrail's `dry_run = false` exists for: without it this row would answer "this lead is
    // already in this workflow" and refuse the real event for ever.
    await ctx.db.automationRun.create({
      data: {
        id: newId(),
        organizationId: org.organizationId,
        workflowId,
        versionId: workflow.currentVersionId!,
        enrollmentId: null,
        leadId,
        dryRun: true,
        triggerType: 'lead.created',
        status: 'running',
      },
    });

    const outcome = await dispatch.dispatch({
      organizationId: org.organizationId,
      leadId,
      eventName: 'lead.created',
      eventId: newId(),
    });
    expect(outcome.started).toBe(1);
  });

  it('refuses a preview on another workspace’s workflow with a 404', async () => {
    const workflowId = await draft([
      { id: 'note', action: 'add_note', params: { body: 'Private.' } },
    ]);
    const other = await setup<{ tokens: { accessToken: string } }>('POST', '/auth/register', {
      payload: {
        email: `other.${EMAIL_MARKER}@test.local`,
        password: PASSWORD,
        name: 'Other Owner',
        organizationName: `OTHER ${SUFFIX}`,
      },
    });
    const refused = await api('POST', `/automation/workflows/${workflowId}/test-run`, {
      token: other.tokens.accessToken,
      payload: { leadId: newId() },
    });
    expect(refused.statusCode).toBe(404);
  });
});

describe('retry from the failed step (`FR-AUT-7`)', () => {
  /** A run whose second step fails: an unknown placeholder is refused rather than sent empty. */
  async function failedRun(): Promise<{ workflowId: string; leadId: string; runId: string }> {
    const workflowId = await publish([
      { id: 'ok', action: 'add_note', params: { body: 'This one works.' } },
      { id: 'broken', action: 'add_note', params: { body: 'Hello {{lead.nickname}}.' } },
    ]);
    const leadId = await lead();
    await dispatch.dispatch({
      organizationId: org.organizationId,
      leadId,
      eventName: 'lead.created',
      eventId: newId(),
    });
    const run = await ctx.db.automationRun.findFirstOrThrow({
      where: { workflowId, leadId },
      orderBy: [{ startedAt: 'desc' }],
    });
    expect(await drive(run.id)).toBe('failed');
    return { workflowId, leadId, runId: run.id };
  }

  it('re-runs the step that failed and nothing before it', async () => {
    const { leadId, runId } = await failedRun();

    const before = await setup<RunBody>('GET', `/automation/runs/${runId}`, { token: org.token });
    expect(before.status).toBe('failed');
    expect(before.error).toMatch(/nickname/);
    expect(before.steps.filter((step) => step.stepId === 'ok')).toHaveLength(1);

    const retried = await api('POST', `/automation/runs/${runId}/retry`, { token: org.token });
    expect(retried.statusCode, JSON.stringify(retried.body)).toBe(202);
    expect(await drive(runId)).toBe('failed');

    const after = await setup<RunBody>('GET', `/automation/runs/${runId}`, { token: org.token });
    // The step before the failure is **not** repeated, which is the whole requirement: its side
    // effect already happened, and one note is one note.
    expect(after.steps.filter((step) => step.stepId === 'ok')).toHaveLength(1);
    expect(await ctx.db.activity.count({ where: { leadId, type: 'note.added' } })).toBe(1);
    // A new attempt rather than an overwritten failure: the first attempt is still readable.
    const attempts = after.steps
      .filter((step) => step.stepId === 'broken')
      .map((step) => step.attempt)
      .sort();
    expect(attempts).toEqual([1, 2]);
    // And the enrolment was reopened and closed again, rather than left `completed` mid-run.
    const enrollment = await ctx.db.automationEnrollment.findFirstOrThrow({
      where: { leadId },
      orderBy: [{ enrolledAt: 'desc' }],
    });
    expect(enrollment.status).toBe('failed');
  });

  it('refuses a run that has not failed, saying what state it is in', async () => {
    const workflowId = await publish([
      { id: 'note', action: 'add_note', params: { body: 'Fine.' } },
    ]);
    const leadId = await lead();
    await dispatch.dispatch({
      organizationId: org.organizationId,
      leadId,
      eventName: 'lead.created',
      eventId: newId(),
    });
    const run = await ctx.db.automationRun.findFirstOrThrow({ where: { workflowId, leadId } });
    await drive(run.id);

    const refused = await api('POST', `/automation/runs/${run.id}/retry`, { token: org.token });
    expect(refused.statusCode).toBe(422);
    expect((refused.body as { error: { message: string } }).error.message).toContain('completed');
  });

  it('refuses a retry while the workflow is stopped', async () => {
    const { workflowId, runId } = await failedRun();
    await setup('PATCH', `/automation/workflows/${workflowId}`, {
      token: org.token,
      payload: { killSwitch: true },
    });
    const refused = await api('POST', `/automation/runs/${runId}/retry`, { token: org.token });
    // The kill switch is the one guard a retry has to re-ask: a failed run must not be the way a
    // stopped workflow's actions happen anyway.
    expect(refused.statusCode).toBe(422);
    expect((refused.body as { error: { message: string } }).error.message).toMatch(/stopped/);
  });

  it('refuses a retry on a preview, because a preview is tested again rather than retried', async () => {
    const workflowId = await draft([
      { id: 'note', action: 'add_note', params: { body: 'Preview.' } },
    ]);
    const leadId = await lead();
    const preview = await setup<RunBody>('POST', `/automation/workflows/${workflowId}/test-run`, {
      token: org.token,
      payload: { leadId },
    });
    // Force it into the one terminal state a retry would accept, so the refusal being asserted is
    // the dry-run one rather than the status one.
    await ctx.db.automationRun.update({
      where: { id: preview.id },
      data: { status: 'failed', error: 'pretend' },
    });
    const refused = await api('POST', `/automation/runs/${preview.id}/retry`, {
      token: org.token,
    });
    expect(refused.statusCode).toBe(422);
    expect((refused.body as { error: { message: string } }).error.message).toMatch(/preview/);
  });
});

describe('a new action needs no engine change (Phase 6’s first exit criterion)', () => {
  it('runs change_priority, which the editor and the validator read as data', async () => {
    const workflowId = await publish([
      { id: 'raise', action: 'change_priority', params: { priority: 'urgent' } },
    ]);
    const leadId = await lead();
    await dispatch.dispatch({
      organizationId: org.organizationId,
      leadId,
      eventName: 'lead.created',
      eventId: newId(),
    });
    const run = await ctx.db.automationRun.findFirstOrThrow({ where: { workflowId, leadId } });
    expect(await drive(run.id)).toBe('completed');

    const after = await setup<{ priority: string }>('GET', `/leads/${leadId}`, {
      token: org.token,
    });
    expect(after.priority).toBe('urgent');
    // And it is declared in the catalogue the editor renders from, which is the other half of
    // "no frontend release": the screen draws a select because the API said `select`.
    const catalogue = await setup<{
      actions: { key: string; params: { key: string; type: string }[] }[];
    }>('GET', '/automation/catalogue', { token: org.token });
    const spec = catalogue.actions.find((action) => action.key === 'change_priority');
    expect(spec?.params.find((param) => param.key === 'priority')?.type).toBe('select');
  });

  it('skips rather than acts when the lead is already at that priority', async () => {
    const workflowId = await publish([
      { id: 'raise', action: 'change_priority', params: { priority: 'medium' } },
    ]);
    const leadId = await lead();
    await dispatch.dispatch({
      organizationId: org.organizationId,
      leadId,
      eventName: 'lead.created',
      eventId: newId(),
    });
    const run = await ctx.db.automationRun.findFirstOrThrow({ where: { workflowId, leadId } });
    await drive(run.id);
    const detail = await setup<RunBody>('GET', `/automation/runs/${run.id}`, { token: org.token });
    // `medium` is the default a captured lead arrives at, so this is the "nothing to do" path —
    // and a skip with a sentence is what `FR-AUT-7` asks for, not a silent success.
    expect(detail.steps[0]?.status).toBe('skipped');
    expect(detail.steps[0]?.reason).toMatch(/already medium priority/);
  });
});

describe('the industry starter workflows (`FR-AUT-3`)', () => {
  it('installs them as drafts, with this workspace’s own ids in them', async () => {
    const tenant = await setup<{ tokens: { accessToken: string } }>('POST', '/auth/register', {
      payload: {
        email: `starters.${EMAIL_MARKER}@test.local`,
        password: PASSWORD,
        name: 'Starter Owner',
        organizationName: `STARTER ${SUFFIX}`,
      },
    });
    const token = tenant.tokens.accessToken;
    const applied = await setup<{ workflows: number }>('POST', '/organization/industry-template', {
      token,
      payload: { key: 'real_estate' },
    });
    const expected = INDUSTRY_TEMPLATES.find((entry) => entry.key === 'real_estate')!.workflows!;
    expect(applied.workflows).toBe(expected.length);

    const workflows = await setup<
      { id: string; name: string; status: string; currentVersionId: string | null }[]
    >('GET', '/automation/workflows', { token });
    expect(workflows.map((row) => row.name).sort()).toEqual(expected.map((row) => row.name).sort());
    // Drafts, every one: publishing into somebody's workspace during onboarding would start it
    // creating follow-ups on their customers before they had read what it does.
    expect(workflows.every((row) => row.status === 'draft')).toBe(true);
    expect(workflows.every((row) => row.currentVersionId === null)).toBe(true);

    // And the references resolve to rows this workspace has, which is what makes the draft
    // publishable the moment somebody opens it.
    // `/settings/task-types`, which is what `REFERENCE_SOURCES` names — the editor's own picker
    // reads the same path, so a test aimed elsewhere would be testing a route nothing uses.
    const taskTypes = await setup<{ id: string; name: string }[]>('GET', '/settings/task-types', {
      token,
    });
    const statuses = await setup<{ id: string; name: string }[]>('GET', '/crm/statuses', { token });
    const ids = new Set([...taskTypes, ...statuses].map((row) => row.id));

    for (const summary of workflows) {
      const detail = await setup<{
        problems: unknown[];
        draft: {
          definition: {
            trigger: { params?: Record<string, unknown> };
            steps: { params?: Record<string, unknown> }[];
          };
        };
      }>('GET', `/automation/workflows/${summary.id}`, { token });
      // No problems means Publish is enabled: a starter somebody has to debug is worse than none.
      expect(detail.problems, summary.name).toEqual([]);
      const params = [
        detail.draft.definition.trigger.params ?? {},
        ...detail.draft.definition.steps.map((step) => step.params ?? {}),
      ];
      for (const entry of params) {
        for (const [key, value] of Object.entries(entry)) {
          if (key.endsWith('Id')) expect(ids, `${summary.name}.${key}`).toContain(value);
        }
      }
    }
  });
});
