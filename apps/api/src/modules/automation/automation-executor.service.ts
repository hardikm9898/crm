import { Inject, Injectable } from '@nestjs/common';
import type { Logger } from 'pino';
import {
  ACTIVITY_TYPES,
  MAX_STEPS_PER_RUN,
  addBusinessMinutes,
  automationPrincipal,
  evaluateAutomationConditions,
  newId,
  nextStep,
  tenantContext,
  withPlatformScope,
  type WorkflowDefinition,
  type WorkflowStep,
} from '@leados/shared';
import { DbService } from '../../infra/db/db.service.js';
import { ENGINE_PERMISSIONS } from './automation-authority.js';
import { LOGGER } from '../../infra/observability/logger.module.js';
import { TimelineService } from '../../infra/timeline/timeline.service.js';
import { JOBS, QUEUES } from '../../infra/queue/queue.constants.js';
import { QueueService } from '../../infra/queue/queue.service.js';
import { SlaCalendarService } from '../sla/sla-calendar.service.js';
import { AutomationFactsService } from './automation-facts.service.js';
import { AutomationGuardrailsService } from './automation-guardrails.service.js';
import { AutomationHandlersService, type StepOutcome } from './automation-handlers.service.js';

/** How long a step may be behind before the sweep rather than the job picks it up. */
export const RESUME_GRACE_MS = 30_000;

/**
 * The interpreter (`FR-AUT-7`).
 *
 * One step per job, each enqueueing the next. That shape is the whole design:
 *
 *  * A **wait** is a delayed job plus a `resume_at`, not a worker sitting still for two days.
 *  * A **worker restart** loses a job and not a run, because `automation_runs` carries where it
 *    got to and the reconciliation sweep reads `resume_at`.
 *  * A **failure** is recorded against the step that failed, which is what makes retrying from
 *    there possible later rather than starting the whole run again.
 *
 * Every step runs inside `automationPrincipal`, which is how `actorType: 'automation'` reaches the
 * audit log and — more importantly — how the **causation depth** reaches every event the step
 * causes. A handler calls `LeadsService.changeStatus`, which emits `lead.status_changed` through
 * its own outbox call; that event carries `depth + 1` without `LeadsService` knowing automation
 * exists, and the dispatcher refuses it at the ceiling. That is loop detection, and there is
 * nothing to forget at a call site.
 */
@Injectable()
export class AutomationExecutorService {
  constructor(
    private readonly db: DbService,
    private readonly facts: AutomationFactsService,
    private readonly guardrails: AutomationGuardrailsService,
    private readonly handlers: AutomationHandlersService,
    private readonly timeline: TimelineService,
    private readonly queues: QueueService,
    private readonly calendar: SlaCalendarService,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  /**
   * Runs the step a run is on, decides the next one, and enqueues it.
   *
   * Called by the step processor and by the resume sweep, and safe to call twice: a run that is no
   * longer `running` or `waiting` is left alone, which is what makes a duplicated job a no-op.
   */
  async advance(organizationId: string, runId: string): Promise<{ status: string }> {
    const run = await withPlatformScope('automation: load the run to advance', async () =>
      this.db.client.automationRun.findFirst({
        where: { id: runId, organizationId },
        include: { version: { select: { definition: true } } },
      }),
    );
    if (!run) {
      this.logger.warn({ runId }, 'automation run vanished before it could advance');
      return { status: 'gone' };
    }
    if (run.status !== 'running' && run.status !== 'waiting') return { status: run.status };

    return tenantContext.run(
      automationPrincipal(
        organizationId,
        newId(),
        { runId: run.id, workflowId: run.workflowId, causationDepth: run.causationDepth },
        // What a workflow may do, enumerated in one place. Without it every action that goes
        // through a service answers "Lead not found": the data scope defaults to `own` and a
        // workflow is nobody.
        ENGINE_PERMISSIONS,
      ),
      async () => {
        const definition = run.version.definition as unknown as WorkflowDefinition;
        const decisions = await this.branchDecisions(run.id);
        const step = nextStep(definition, {
          after: run.currentStepId,
          branchDecisions: decisions,
        });

        if (step === null) return this.finish(run.id, run.enrollmentId, 'completed', null);

        if (run.stepsRun >= MAX_STEPS_PER_RUN) {
          // A graph cannot be this long — `MAX_STEPS` refuses it at publish — so reaching this is
          // a loop inside one run rather than a long workflow. Stopping with a sentence beats
          // running for ever.
          return this.finish(
            run.id,
            run.enrollmentId,
            'failed',
            `this run executed ${MAX_STEPS_PER_RUN} steps, which is the limit`,
          );
        }

        return this.runStep(run, step.step);
      },
    );
  }

  private async runStep(
    run: {
      id: string;
      organizationId: string;
      workflowId: string;
      leadId: string;
      enrollmentId: string;
      stepsRun: number;
      context: unknown;
    },
    step: WorkflowStep,
  ): Promise<{ status: string }> {
    const attempt = (await this.attemptsFor(run.id, step.id)) + 1;
    const idempotencyKey = `wf:${run.id}:${step.id}:${attempt}`;
    const startedAt = new Date();
    const facts = await this.facts.forLead(run.leadId, {
      ...((run.context ?? {}) as Record<string, unknown>),
    });

    const record = async (outcome: {
      status: 'succeeded' | 'skipped' | 'failed';
      decision?: string | null;
      reason?: string | null;
      output?: Record<string, unknown> | null;
      error?: string | null;
    }) => {
      await this.db.client.automationRunStep.create({
        data: {
          id: newId(),
          organizationId: run.organizationId,
          runId: run.id,
          stepId: step.id,
          action: step.action,
          attempt,
          status: outcome.status,
          decision: outcome.decision ?? null,
          reason: outcome.reason ?? null,
          input: { params: step.params ?? {} } as never,
          output: (outcome.output ?? null) as never,
          error: outcome.error ?? null,
          startedAt,
          finishedAt: new Date(),
        },
      });
    };

    // ── The four shapes the engine owns ──────────────────────────────────────

    if (step.action === 'branch') {
      const outcome = evaluateAutomationConditions(step.conditions, facts);
      const arm = outcome.passed ? 'then' : 'otherwise';
      await record({ status: 'succeeded', decision: arm, reason: outcome.reason });
      await this.timeline.record({
        type: ACTIVITY_TYPES.AUTOMATION_ACTION_EXECUTED,
        leadId: run.leadId,
        occurredAt: startedAt,
        payload: {
          runId: run.id,
          workflowId: run.workflowId,
          action: 'branch',
          decision: arm,
          reason: outcome.reason,
          summary: outcome.passed ? 'the condition matched' : 'the condition did not match',
        },
        visibility: 'internal',
        actorType: 'automation',
      });
      return this.continueAfter(run, step.id);
    }

    if (step.action === 'stop') {
      const reason =
        typeof step.params?.['reason'] === 'string' && step.params['reason'].trim() !== ''
          ? String(step.params['reason'])
          : 'the workflow said to stop here';
      await record({ status: 'succeeded', reason });
      await this.db.client.automationRun.update({
        where: { id: run.id },
        data: { currentStepId: step.id, stepsRun: { increment: 1 } },
      });
      await this.timeline.record({
        type: ACTIVITY_TYPES.AUTOMATION_EXITED,
        leadId: run.leadId,
        occurredAt: startedAt,
        payload: { runId: run.id, workflowId: run.workflowId, reason },
        visibility: 'internal',
        actorType: 'automation',
      });
      return this.finish(run.id, run.enrollmentId, 'completed', null, reason);
    }

    if (step.action === 'wait') {
      const minutes = Number(step.params?.['minutes'] ?? 0);
      const workingHoursOnly = step.params?.['workingHoursOnly'] === true;
      const resumeAt = await this.resumeInstant(run.leadId, minutes, workingHoursOnly);
      await record({
        status: 'succeeded',
        output: { resumeAt: resumeAt.toISOString(), workingHoursOnly },
        reason: workingHoursOnly ? 'counted in working hours' : 'counted on the clock',
      });
      await this.db.client.automationRun.update({
        where: { id: run.id },
        data: {
          status: 'waiting',
          currentStepId: step.id,
          resumeAt,
          stepsRun: { increment: 1 },
        },
      });
      // The delayed job is the fast path; `resume_at` is the promise. A job lost while Redis was
      // restarting is picked up by the sweep, which is the exit criterion in one sentence.
      await this.queues.enqueue(
        QUEUES.AUTOMATION,
        JOBS.AUTOMATION_STEP,
        { organizationId: run.organizationId, aggregateId: run.id },
        {
          jobId: `automation-step-${run.id}-${step.id}-${attempt}`,
          delayMs: Math.max(0, resumeAt.getTime() - Date.now()),
        },
      );
      return { status: 'waiting' };
    }

    if (step.action === 'enroll') {
      // Enrolment in another workflow goes through the **dispatcher's** own guards, which is why
      // this is a control shape rather than a handler: the re-entry policy, the daily cap and the
      // depth ceiling all have to apply, and they belong to the thing that starts runs.
      const workflowId =
        typeof step.params?.['workflowId'] === 'string' ? String(step.params['workflowId']) : null;
      if (workflowId === null) {
        await record({ status: 'skipped', reason: 'no workflow was chosen' });
        return this.continueAfter(run, step.id);
      }
      await record({
        status: 'succeeded',
        output: { workflowId },
        reason: 'handed to the other workflow’s own guards',
      });
      await this.queues.enqueue(
        QUEUES.AUTOMATION,
        JOBS.AUTOMATION_TRIGGER,
        {
          organizationId: run.organizationId,
          aggregateId: run.leadId,
          eventName: 'manual',
          // Named, so only that workflow is offered the lead — and depth + 1, so a pair of
          // workflows enrolling each other climbs to the ceiling and stops.
          workflowId,
          causationDepth: (await this.depthOf(run.id)) + 1,
        },
        { jobId: `automation-enroll-${run.id}-${step.id}-${attempt}` },
      );
      return this.continueAfter(run, step.id);
    }

    // ── A handler ────────────────────────────────────────────────────────────

    const cap = await this.guardrails.capFor(run.organizationId);
    const counted = await this.guardrails.countAction({
      organizationId: run.organizationId,
      timeZone: cap.timeZone,
      scopeKey: 'actions',
      cap: cap.cap,
    });
    if (!counted.allowed) {
      await record({ status: 'skipped', reason: counted.refusal ?? 'the daily limit was reached' });
      await this.writeTimeline(run, step, {
        status: 'skipped',
        reason: counted.refusal ?? 'the daily limit was reached',
      });
      // The cap stops the **run**, not just the step: a workflow whose next action is also
      // refused would otherwise write a skip per step until the graph ran out.
      return this.finish(
        run.id,
        run.enrollmentId,
        'completed',
        null,
        counted.refusal ?? 'the daily limit was reached',
      );
    }

    let outcome: StepOutcome;
    try {
      outcome = await this.handlers.execute(step.action, {
        organizationId: run.organizationId,
        runId: run.id,
        workflowId: run.workflowId,
        leadId: run.leadId,
        facts,
        params: step.params ?? {},
        idempotencyKey,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Something went wrong.';
      await record({ status: 'failed', error: message });
      await this.writeTimeline(run, step, { status: 'failed', reason: message });
      this.logger.warn(
        { runId: run.id, stepId: step.id, action: step.action, error: message },
        'automation step failed',
      );
      return this.finish(run.id, run.enrollmentId, 'failed', message);
    }

    if (outcome.status === 'skipped') {
      await record({ status: 'skipped', reason: outcome.reason });
      await this.writeTimeline(run, step, { status: 'skipped', reason: outcome.reason });
      // A skip is not the end of the run: "there was nobody to tell" should not stop the
      // follow-up two steps later.
      return this.continueAfter(run, step.id);
    }

    await record({ status: 'succeeded', output: outcome.output, reason: outcome.summary });
    await this.writeTimeline(run, step, { status: 'succeeded', reason: outcome.summary });
    return this.continueAfter(run, step.id, outcome.output);
  }

  // ── Moving on ──────────────────────────────────────────────────────────────

  private async continueAfter(
    run: { id: string; organizationId: string; enrollmentId: string },
    stepId: string,
    output: Record<string, unknown> = {},
  ): Promise<{ status: string }> {
    const updated = await this.db.client.automationRun.update({
      where: { id: run.id },
      data: {
        currentStepId: stepId,
        status: 'running',
        resumeAt: null,
        stepsRun: { increment: 1 },
        // Each step's output is readable by the next one's placeholders.
        ...(Object.keys(output).length === 0
          ? {}
          : { context: await this.mergedContext(run.id, stepId, output) }),
      },
      select: { id: true },
    });

    await this.queues.enqueue(
      QUEUES.AUTOMATION,
      JOBS.AUTOMATION_STEP,
      { organizationId: run.organizationId, aggregateId: updated.id },
      // The step id is in the job id, so "the next step after this one" is enqueued once however
      // many times this job is delivered — BullMQ refuses a duplicate custom id.
      { jobId: `automation-step-${run.id}-after-${stepId}` },
    );
    return { status: 'running' };
  }

  private async mergedContext(
    runId: string,
    stepId: string,
    output: Record<string, unknown>,
  ): Promise<never> {
    const run = await this.db.client.automationRun.findFirst({
      where: { id: runId },
      select: { context: true },
    });
    const current = (run?.context ?? {}) as Record<string, unknown>;
    // Flat and prefixed by step, so `{{steps.send.messageId}}` is reachable and two steps cannot
    // overwrite each other's output.
    const next = { ...current };
    for (const [key, value] of Object.entries(output)) next[`steps.${stepId}.${key}`] = value;
    return next as never;
  }

  private async finish(
    runId: string,
    enrollmentId: string,
    status: 'completed' | 'failed',
    error: string | null,
    reason: string | null = null,
  ): Promise<{ status: string }> {
    const finishedAt = new Date();
    await this.db.client.automationRun.update({
      where: { id: runId },
      // `resume_at` is left where it is: a run that was waiting and has been resumed keeps it as
      // the record of when it was due, which is why the CHECK is one-way.
      data: { status, finishedAt, error, currentStepId: undefined },
    });
    await this.db.client.automationEnrollment.update({
      where: { id: enrollmentId },
      data: {
        status: status === 'failed' ? 'failed' : 'completed',
        completedAt: finishedAt,
        ...(reason === null ? {} : { exitReason: reason }),
      },
    });
    return { status };
  }

  // ── Reading what has happened ──────────────────────────────────────────────

  private async branchDecisions(runId: string): Promise<Record<string, 'then' | 'otherwise'>> {
    const rows = await this.db.client.automationRunStep.findMany({
      where: { runId, action: 'branch' },
      orderBy: [{ startedAt: 'asc' }],
      select: { stepId: true, decision: true },
    });
    const decisions: Record<string, 'then' | 'otherwise'> = {};
    for (const row of rows) {
      if (row.decision === 'then' || row.decision === 'otherwise') decisions[row.stepId] = row.decision;
    }
    return decisions;
  }

  private async attemptsFor(runId: string, stepId: string): Promise<number> {
    return this.db.client.automationRunStep.count({ where: { runId, stepId } });
  }

  private async depthOf(runId: string): Promise<number> {
    const run = await this.db.client.automationRun.findFirst({
      where: { id: runId },
      select: { causationDepth: true },
    });
    return run?.causationDepth ?? 0;
  }

  /** `minutes` from now, on the clock or in working hours, as the step asked. */
  private async resumeInstant(
    leadId: string,
    minutes: number,
    workingHoursOnly: boolean,
  ): Promise<Date> {
    const now = new Date();
    const safeMinutes = Number.isFinite(minutes) && minutes > 0 ? Math.floor(minutes) : 1;
    if (!workingHoursOnly) return new Date(now.getTime() + safeMinutes * 60_000);

    const lead = await this.db.client.lead.findFirst({
      where: { id: leadId },
      select: { branchId: true, organizationId: true },
    });
    const organization = await this.db.client.organization.findFirst({
      where: { id: lead?.organizationId },
      select: { timezone: true },
    });
    const calendar = await this.calendar.forBranch(
      organization?.timezone ?? 'Asia/Kolkata',
      lead?.branchId ?? null,
      now,
    );
    // "Two hours" at five in the afternoon means two **working** hours, which is what the registry
    // promises on the step itself — not overnight.
    const resumeAt = addBusinessMinutes(now, safeMinutes, calendar);
    // `addBusinessMinutes` answers null only for a negative duration, which `safeMinutes` has
    // already excluded; the fallback is written out rather than assumed because a wait that
    // silently became "now" would send a nurture message the moment the lead arrived.
    return resumeAt ?? new Date(now.getTime() + safeMinutes * 60_000);
  }

  private async writeTimeline(
    run: { id: string; workflowId: string; leadId: string },
    step: WorkflowStep,
    outcome: { status: 'succeeded' | 'skipped' | 'failed'; reason: string },
  ): Promise<void> {
    const type =
      outcome.status === 'succeeded'
        ? ACTIVITY_TYPES.AUTOMATION_ACTION_EXECUTED
        : outcome.status === 'skipped'
          ? ACTIVITY_TYPES.AUTOMATION_SKIPPED
          : ACTIVITY_TYPES.AUTOMATION_FAILED;
    await this.timeline.record({
      type,
      leadId: run.leadId,
      occurredAt: new Date(),
      payload: {
        runId: run.id,
        workflowId: run.workflowId,
        action: step.action,
        stepId: step.id,
        // The sentence, which is the whole of `FR-AUT-7`'s "including *skipped because*".
        reason: outcome.reason,
      },
      // Internal: this is the business talking to itself about its own machinery, which is exactly
      // what `internal` exists for.
      visibility: 'internal',
      actorType: 'automation',
    });
  }
}
