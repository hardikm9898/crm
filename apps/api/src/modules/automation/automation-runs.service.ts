import { Injectable } from '@nestjs/common';
import {
  AppError,
  MAX_STEPS_PER_RUN,
  newId,
  type WorkflowDefinition,
} from '@leados/shared';
import { DbService } from '../../infra/db/db.service.js';
import { DataScopeService } from '../../infra/authz/data-scope.service.js';
import { JOBS, QUEUES } from '../../infra/queue/queue.constants.js';
import { QueueService } from '../../infra/queue/queue.service.js';
import { AutomationDispatchService } from './automation-dispatch.service.js';
import { AutomationExecutorService } from './automation-executor.service.js';
import { AutomationService } from './automation.service.js';
import type { ListRunsQuery } from './automation.dto.js';

/**
 * What the engine did, readable per lead and per workflow (`FR-AUT-7`).
 *
 * The read that matters is **per lead**: "why did this customer get this message?" and "why
 * didn't they?" are the two questions this phase exists to answer, and both are asked while
 * looking at a lead. The timeline already carries the sentence; this carries the step-by-step
 * detail behind it — each step's input, output, decision and error.
 *
 * Behind `automation:manage` rather than `lead:read`, and the reason is the same one the webhook
 * delivery log gives: a run's step log carries the parameters a workflow was configured with,
 * which is workspace configuration rather than a fact about the lead.
 */
@Injectable()
export class AutomationRunsService {
  constructor(
    private readonly db: DbService,
    private readonly scopes: DataScopeService,
    private readonly dispatch: AutomationDispatchService,
    private readonly executor: AutomationExecutorService,
    private readonly workflows: AutomationService,
    private readonly queues: QueueService,
  ) {}

  async list(query: ListRunsQuery) {
    const filters = {
      ...(query.leadId === undefined ? {} : { leadId: query.leadId }),
      ...(query.workflowId === undefined ? {} : { workflowId: query.workflowId }),
      ...(query.status === undefined ? {} : { status: query.status }),
      ...(query.dryRun === undefined ? {} : { dryRun: query.dryRun }),
    };

    const [rows, total] = await Promise.all([
      this.db.client.automationRun.findMany({
        where: { ...filters, ...keysetFrom(query.cursor) },
        orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
        take: query.limit + 1,
        include: {
          workflow: { select: { id: true, name: true } },
          lead: { select: { id: true, fullName: true } },
          enrollment: { select: { cycle: true } },
          version: { select: { version: true } },
          /**
           * The **steps**, in the list.
           *
           * Not an optimisation left out: the screens that read this list exist to answer "why",
           * and a run row with no steps renders a disclosure with nothing behind it — which is
           * exactly what the first version did, on both screens, invisibly. What bounds the cost
           * is the list's own `limit` (25 by default, 10 on the panels) and `MAX_STEPS_PER_RUN`;
           * the alternative, a detail request per row, is the N+1 that made it tempting to leave
           * them out in the first place.
           */
          steps: { orderBy: [{ startedAt: 'asc' }] },
        },
      }),
      // The same predicate as the page, minus the cursor: a total that counted every run beside a
      // filtered list is the recurring bug in this codebase.
      this.db.client.automationRun.count({ where: filters }),
    ]);

    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    return {
      items: page.map((row) => this.presentRow(row)),
      pagination: {
        limit: query.limit,
        nextCursor:
          rows.length > query.limit && last
            ? `${last.startedAt.toISOString()}_${last.id}`
            : null,
        hasMore: rows.length > query.limit,
        total,
      },
    };
  }

  /** One run, with every step it took — the screen a person opens when they ask "why". */
  async findOne(id: string) {
    const run = await this.db.client.automationRun.findFirst({
      where: { id },
      include: {
        workflow: { select: { id: true, name: true } },
        lead: { select: { id: true, fullName: true } },
        enrollment: { select: { cycle: true, status: true, exitReason: true } },
        version: { select: { version: true, definition: true } },
        steps: { orderBy: [{ startedAt: 'asc' }] },
      },
    });
    if (!run) throw AppError.notFound('Run');

    return {
      ...this.presentSummary(run),
      /** The graph as it was published, which is what this run is pinned to (`FR-AUT-5`). */
      definition: run.version.definition,
      exitReason: run.enrollment?.exitReason ?? null,
      // The detail carries `input` and `output` as well, which the list deliberately does not:
      // a step's parameters are the one part of this somebody opens a single run to read.
      steps: run.steps.map((step) => ({
        ...presentStep(step),
        input: step.input,
        output: step.output,
      })),
    };
  }

  /**
   * Starts a workflow for one lead, by hand (`manual`).
   *
   * The same path an event takes, so every guard applies: a manual start is a person asking, not
   * a way around the re-entry policy. Queued rather than run inline, because the first step may
   * send a message and a button must not wait for a provider.
   */
  async startManually(workflowId: string, leadId: string) {
    const workflow = await this.db.client.workflow.findFirst({
      where: { id: workflowId, deletedAt: null },
      select: { id: true, currentVersionId: true, status: true },
    });
    if (!workflow) throw AppError.notFound('Workflow');
    if (workflow.currentVersionId === null) {
      throw AppError.businessRule('Publish this workflow before starting it on a lead.');
    }
    const lead = await this.db.client.lead.findFirst({
      where: { id: leadId, deletedAt: null },
      select: { id: true },
    });
    if (!lead) throw AppError.notFound('Lead');

    const organizationId = (
      await this.db.client.workflow.findFirstOrThrow({
        where: { id: workflowId },
        select: { organizationId: true },
      })
    ).organizationId;

    await this.queues.enqueue(QUEUES.AUTOMATION, JOBS.AUTOMATION_TRIGGER, {
      organizationId,
      aggregateId: leadId,
      eventName: 'manual',
      workflowId,
      // A manual start has no event id, so nothing deduplicates it but the re-entry policy — which
      // is the right answer: pressing the button twice is a person asking twice.
      causationDepth: 0,
    });
    return { workflowId, leadId, queued: true as const };
  }

  /**
   * The dry run (`FR-AUT-6`): every decision recorded, nothing executed.
   *
   * Driven **inline**, which is the opposite of the manual start's 202 and for the opposite reason:
   * a preview takes no action, so there is no provider to wait for, and somebody who presses
   * "Test it" wants the answer rather than a row that appears in a moment.
   *
   * It previews the version the *next* run would use — the unsaved draft when there is one, the
   * published version otherwise. That is what makes it a tool for checking a workflow before
   * turning it on, rather than a tool for checking one that is already running. A definition with
   * problems is refused with the list, printed against the rows it names: executing a graph whose
   * step has no body would answer with a failure about this feature rather than about the workflow.
   */
  async testRun(workflowId: string, leadId: string) {
    const workflow = await this.db.client.workflow.findFirst({
      where: { id: workflowId, deletedAt: null },
      select: { id: true, organizationId: true, currentVersionId: true },
    });
    if (!workflow) throw AppError.notFound('Workflow');

    const version =
      (await this.db.client.workflowVersion.findFirst({
        where: { workflowId, publishedAt: null },
        orderBy: [{ version: 'desc' }],
        select: { id: true, definition: true },
      })) ??
      (workflow.currentVersionId === null
        ? null
        : await this.db.client.workflowVersion.findFirst({
            where: { id: workflow.currentVersionId },
            select: { id: true, definition: true },
          }));
    if (version === null) {
      throw AppError.businessRule('There is nothing to test yet — add this workflow’s steps first.');
    }

    const problems = await this.workflows.problemsFor(version.definition, workflowId);
    if (problems.length > 0) {
      throw AppError.validation('Some details need filling in before this can be tested.', problems);
    }

    const lead = await this.db.client.lead.findFirst({
      where: { id: leadId, deletedAt: null },
      select: { id: true },
    });
    if (!lead) throw AppError.notFound('Lead');

    const definition = version.definition as unknown as WorkflowDefinition;
    const runId = newId();
    await this.db.client.automationRun.create({
      data: {
        id: runId,
        organizationId: workflow.organizationId,
        workflowId,
        versionId: version.id,
        // No enrolment, which is what "executes nothing" has to mean: a preview that spent the
        // lead's one allowed cycle would be refused by the policy it was there to check.
        enrollmentId: null,
        leadId,
        dryRun: true,
        triggerEventId: null,
        triggerType: definition.trigger.type,
        causationDepth: 0,
      },
    });

    // The same interpreter, one step at a time, until it stops. Bounded by the engine's own step
    // ceiling plus one: `advance` answers a terminal status at the ceiling, and a loop that trusted
    // only the status would be a request that never returned if that ever stopped being true.
    for (let step = 0; step < MAX_STEPS_PER_RUN + 1; step += 1) {
      const outcome = await this.executor.advance(workflow.organizationId, runId);
      if (outcome.status !== 'running') break;
    }

    return this.findOne(runId);
  }

  /**
   * Retries a failed run from the step that failed (`FR-AUT-7`), not from the beginning.
   *
   * `current_step_id` still points at the last step that *succeeded* — `finish` deliberately
   * leaves it alone — so `nextStep` returns the failed one and nothing before it runs again. The
   * new attempt writes a **new** step row rather than overwriting the failure, which is both the
   * record of what happened and what makes the handler's idempotency key different this time.
   */
  async retry(runId: string) {
    const run = await this.db.client.automationRun.findFirst({
      where: { id: runId },
      select: {
        id: true,
        organizationId: true,
        status: true,
        dryRun: true,
        enrollmentId: true,
        workflow: { select: { status: true, killSwitch: true } },
      },
    });
    if (!run) throw AppError.notFound('Run');
    if (run.dryRun) {
      throw AppError.businessRule('That was a preview, so there is nothing to retry — test it again.');
    }
    if (run.status !== 'failed') {
      throw AppError.businessRule(
        `Only a failed run can be tried again, and this one is ${run.status}.`,
      );
    }
    // The kill switch is the one guard a retry has to re-ask: a run that failed before somebody
    // stopped the workflow must not be the way its actions happen anyway.
    if (run.workflow.killSwitch) {
      throw AppError.businessRule('This workflow is stopped. Start it again before retrying a run.');
    }
    if (run.workflow.status !== 'active') {
      throw AppError.businessRule(
        `This workflow is ${run.workflow.status}, so its runs are not running.`,
      );
    }

    const attempts = await this.db.client.automationRunStep.count({ where: { runId } });
    await this.db.client.automationRun.update({
      where: { id: runId },
      data: { status: 'running', finishedAt: null, error: null },
    });
    if (run.enrollmentId !== null) {
      await this.db.client.automationEnrollment.update({
        where: { id: run.enrollmentId },
        data: { status: 'active', completedAt: null },
      });
    }

    await this.queues.enqueue(
      QUEUES.AUTOMATION,
      JOBS.AUTOMATION_STEP,
      { organizationId: run.organizationId, aggregateId: runId },
      // The step count is in the job id, so pressing the button twice before the first job runs is
      // one job: BullMQ refuses a duplicate custom id, and the count has not moved yet.
      { jobId: `automation-step-${runId}-retry-${attempts}` },
    );
    return { runId, queued: true as const };
  }

  /** The runs on one lead, for the panel on their screen. Scoped like every other lead read. */
  async forLead(leadId: string, query: ListRunsQuery) {
    const filter = this.scopes.filterFor('lead:read', { userColumn: 'assignedUserId' });
    if (filter.kind === 'none') return { items: [], pagination: emptyPage(query.limit) };
    const lead = await this.db.client.lead.findFirst({
      where: {
        id: leadId,
        ...(filter.kind === 'all' ? {} : (filter.where as Record<string, unknown>)),
      },
      select: { id: true },
    });
    if (!lead) throw AppError.notFound('Lead');
    return this.list({ ...query, leadId });
  }

  /** A run, with its steps when the caller asked for a list that carries them. */
  private presentRow(row: Parameters<AutomationRunsService['presentSummary']>[0] & {
    steps?: {
      id: string;
      stepId: string;
      action: string;
      attempt: number;
      status: string;
      decision: string | null;
      reason: string | null;
      error: string | null;
      startedAt: Date;
      finishedAt: Date | null;
    }[];
  }) {
    return {
      ...this.presentSummary(row),
      ...(row.steps === undefined ? {} : { steps: row.steps.map((step) => presentStep(step)) }),
    };
  }

  private presentSummary(row: {
    id: string;
    status: string;
    triggerType: string;
    currentStepId: string | null;
    resumeAt: Date | null;
    causationDepth: number;
    stepsRun: number;
    startedAt: Date;
    finishedAt: Date | null;
    error: string | null;
    dryRun: boolean;
    workflow: { id: string; name: string };
    lead: { id: string; fullName: string };
    /**
     * Null for a **dry run**, which is enrolled in nothing on purpose (`FR-AUT-6`): a preview that
     * took an enrolment slot would change the re-entry answer for the real run that follows it.
     */
    enrollment: { cycle: number } | null;
    version: { version: number };
  }) {
    return {
      id: row.id,
      status: row.status,
      trigger: row.triggerType,
      workflow: row.workflow,
      lead: row.lead,
      cycle: row.enrollment?.cycle ?? null,
      dryRun: row.dryRun,
      version: row.version.version,
      currentStepId: row.currentStepId,
      resumeAt: row.resumeAt?.toISOString() ?? null,
      causationDepth: row.causationDepth,
      stepsRun: row.stepsRun,
      startedAt: row.startedAt.toISOString(),
      finishedAt: row.finishedAt?.toISOString() ?? null,
      error: row.error,
    };
  }
}

/** One step, in the shape both the list and the detail answer. */
function presentStep(step: {
  id: string;
  stepId: string;
  action: string;
  attempt: number;
  status: string;
  decision: string | null;
  reason: string | null;
  error: string | null;
  startedAt: Date;
  finishedAt: Date | null;
}) {
  return {
    id: step.id,
    stepId: step.stepId,
    action: step.action,
    attempt: step.attempt,
    status: step.status,
    decision: step.decision,
    reason: step.reason,
    error: step.error,
    startedAt: step.startedAt.toISOString(),
    finishedAt: step.finishedAt?.toISOString() ?? null,
  };
}

function emptyPage(limit: number) {
  return { limit, nextCursor: null, hasMore: false, total: 0 };
}

/** Both halves of the sort key: `started_at` ties, and an instant alone skips what shares it. */
function keysetFrom(cursor: string | undefined): Record<string, unknown> {
  if (cursor === undefined) return {};
  const split = cursor.lastIndexOf('_');
  if (split <= 0) return {};
  const at = new Date(cursor.slice(0, split));
  const id = cursor.slice(split + 1);
  if (Number.isNaN(at.getTime())) return {};
  return { OR: [{ startedAt: { lt: at } }, { startedAt: at, id: { lt: id } }] };
}
