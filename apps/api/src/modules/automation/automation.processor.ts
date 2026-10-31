import { Inject, Injectable } from '@nestjs/common';
import type { Job } from 'bullmq';
import type { Logger } from 'pino';
import { withPlatformScope } from '@leados/shared';
import { DbService } from '../../infra/db/db.service.js';
import { LOGGER } from '../../infra/observability/logger.module.js';
import { JOBS, QUEUES } from '../../infra/queue/queue.constants.js';
import type { JobProcessor } from '../../infra/queue/job-processor.js';
import type { JobPayload } from '../../infra/queue/queue.service.js';
import { AutomationDispatchService } from './automation-dispatch.service.js';
import { AutomationExecutorService } from './automation-executor.service.js';

/**
 * One domain event, offered to the workflows listening for it (`FR-AUT-6`).
 *
 * Reads its subject from `payload.aggregateId` — the **lead** — rather than from a field inside
 * the payload, because the envelope is stable and payload bodies change: an event queued by an
 * older release still has to process.
 */
@Injectable()
export class AutomationTriggerProcessor implements JobProcessor {
  readonly queue = QUEUES.AUTOMATION;
  readonly jobName = JOBS.AUTOMATION_TRIGGER;

  constructor(
    private readonly dispatch: AutomationDispatchService,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  async process(payload: JobPayload, _job: Job): Promise<void> {
    const organizationId = payload.organizationId;
    const leadId = typeof payload['aggregateId'] === 'string' ? payload['aggregateId'] : null;
    const eventName = typeof payload['eventName'] === 'string' ? payload['eventName'] : null;
    if (!organizationId || !leadId || !eventName) {
      this.logger.warn({ payload }, 'an automation trigger job has no subject');
      return;
    }
    const inner = payload['payload'];
    await this.dispatch.dispatch({
      organizationId,
      leadId,
      eventName,
      eventId: typeof payload['eventId'] === 'string' ? payload['eventId'] : null,
      payload:
        typeof inner === 'object' && inner !== null ? (inner as Record<string, unknown>) : {},
      causationDepth: typeof payload['causationDepth'] === 'number' ? payload['causationDepth'] : 0,
      ...(typeof payload['workflowId'] === 'string' ? { workflowId: payload['workflowId'] } : {}),
    });
  }
}

/** One step of one run (`FR-AUT-7`). Each step enqueues the next, so a wait costs no worker. */
@Injectable()
export class AutomationStepProcessor implements JobProcessor {
  readonly queue = QUEUES.AUTOMATION;
  readonly jobName = JOBS.AUTOMATION_STEP;

  constructor(
    private readonly executor: AutomationExecutorService,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  async process(payload: JobPayload, _job: Job): Promise<void> {
    const organizationId = payload.organizationId;
    const runId = typeof payload['aggregateId'] === 'string' ? payload['aggregateId'] : null;
    if (!organizationId || !runId) {
      this.logger.warn({ payload }, 'an automation step job has no run');
      return;
    }
    await this.executor.advance(organizationId, runId);
  }
}

/**
 * The waiting runs whose moment has come (`maintenance.automation-resume`).
 *
 * Phase 6's third exit criterion, and the only thing that satisfies it: **"a deliberately dropped
 * delayed job is recovered by the reconciliation sweep."** `automation_runs.resume_at` is what is
 * owed; the delayed job is only the fast path, and a workspace whose Redis restarted must not find
 * its nurture sequences stopped half way through with nothing to say so.
 *
 * Cross-tenant, like every sweep here, which is why the partial index it reads
 * (`automation_runs_resumable`) is keyed on `resume_at` alone.
 */
@Injectable()
export class AutomationResumeSweepProcessor implements JobProcessor {
  readonly queue = QUEUES.MAINTENANCE;
  readonly jobName = JOBS.AUTOMATION_RESUME_SWEEP;

  constructor(
    private readonly db: DbService,
    private readonly executor: AutomationExecutorService,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  async process(_payload: JobPayload, _job: Job): Promise<void> {
    await this.sweep();
  }

  /** Exposed so the suite can drive it without waiting for a tick. */
  async sweep(limit = 200): Promise<{ examined: number; resumed: number }> {
    const due = await withPlatformScope('automation: resume waiting runs', async () =>
      this.db.client.automationRun.findMany({
        where: { status: 'waiting', resumeAt: { lte: new Date() } },
        orderBy: [{ resumeAt: 'asc' }],
        take: limit,
        select: { id: true, organizationId: true },
      }),
    );

    let resumed = 0;
    for (const run of due) {
      try {
        // `advance` re-reads the run and leaves anything that is no longer waiting alone, so the
        // sweep racing the delayed job costs a query rather than a double step.
        const outcome = await this.executor.advance(run.organizationId, run.id);
        if (outcome.status !== 'waiting') resumed += 1;
      } catch (error) {
        // One stuck run must not stop the sweep: the rest of the workspace's workflows are owed
        // their turn, and this row will be read again in a minute.
        this.logger.warn(
          { runId: run.id, error: error instanceof Error ? error.message : 'unknown' },
          'a waiting automation run could not be resumed',
        );
      }
    }
    if (due.length > 0)
      this.logger.info({ examined: due.length, resumed }, 'automation runs resumed');
    return { examined: due.length, resumed };
  }
}
