import { Inject, Injectable } from '@nestjs/common';
import { systemPrincipal, tenantContext, withPlatformScope } from '@leados/shared';
import type { Job } from 'bullmq';
import type { Logger } from 'pino';
import { DbService } from '../../infra/db/db.service.js';
import { LOGGER } from '../../infra/observability/logger.module.js';
import { JOBS, QUEUES } from '../../infra/queue/queue.constants.js';
import type { JobProcessor } from '../../infra/queue/job-processor.js';
import type { JobPayload } from '../../infra/queue/queue.service.js';
import { ScoringEngineService } from './scoring-engine.service.js';

/**
 * Scoring runs off the outbox, never on the write path (`docs/queue-event-architecture.md` §3).
 *
 * That is the point of putting it in a queue: creating a lead must not wait for a scoring pass, and
 * a scoring bug must not fail a capture. The price is at-least-once delivery, which the unique index
 * on `(lead, rule, source_event)` pays for — see `ScoringEngineService`.
 */
interface ScoreJobPayload extends JobPayload {
  readonly eventId?: string;
  readonly eventName?: string;
  readonly aggregateId?: string;
  readonly payload?: Record<string, unknown>;
}

/**
 * A system principal, not a person's. A scoring pass must not inherit whoever happened to trigger
 * it: the rules apply to the lead, not to the caller's data scope.
 */
function principalFor(organizationId: string, reason: string) {
  return systemPrincipal(organizationId, reason);
}

@Injectable()
export class LeadScoreProcessor implements JobProcessor<ScoreJobPayload> {
  readonly queue = QUEUES.SCORING;
  readonly jobName = JOBS.LEAD_SCORE;

  constructor(
    private readonly engine: ScoringEngineService,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  async process(payload: ScoreJobPayload, _job: Job): Promise<void> {
    const organizationId = payload.organizationId;
    const leadId = payload.aggregateId;
    const triggerEvent = payload.eventName;
    if (!organizationId || !leadId || !triggerEvent) {
      this.logger.error({ payload }, 'score job has no organization, lead or event name');
      return;
    }

    // The job runs outside any request, so it opens its own tenant scope — and a system one, so a
    // scoring pass cannot accidentally inherit a person's data scope.
    await tenantContext.run(principalFor(organizationId, 'scoring:lead-score'), async () => {
      const result = await this.engine.applyForEvent({
        leadId,
        triggerEvent,
        sourceEventId: payload.eventId ?? null,
        eventPayload: payload.payload ?? {},
      });
      if (result && !result.noop) {
        this.logger.debug(
          { leadId, from: result.scoreBefore, to: result.scoreAfter, band: result.bandAfter },
          'scored a lead',
        );
      }
    });
  }
}

/**
 * The nightly decay sweep (`FR-SCR-1`, daily 01:00).
 *
 * Runs across tenants, which is why it opts into platform scope explicitly and then re-enters a
 * per-tenant scope for the actual work: the decay arithmetic reads and writes that tenant's rows and
 * must be scoped like any other write.
 */
@Injectable()
export class ScoreDecaySweepProcessor implements JobProcessor<JobPayload> {
  readonly queue = QUEUES.SCORING;
  readonly jobName = JOBS.SCORE_DECAY_SWEEP;

  /** Per tenant, per night. A tenant with more stale leads than this catches up tomorrow. */
  private static readonly PER_TENANT_LIMIT = 2_000;

  constructor(
    private readonly db: DbService,
    private readonly engine: ScoringEngineService,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  async process(_payload: JobPayload, _job: Job): Promise<void> {
    const at = new Date();
    const organizations = await withPlatformScope('score decay sweep: list tenants', async () =>
      this.db.client.organization.findMany({
        where: { status: { in: ['active', 'trialing'] }, deletedAt: null },
        select: { id: true },
      }),
    );

    let decayed = 0;
    let examined = 0;
    for (const organization of organizations) {
      await tenantContext.run(principalFor(organization.id, 'scoring:decay-sweep'), async () => {
        const hasDecayRule = await this.db.client.scoringRule.findFirst({
          where: { triggerEvent: 'schedule.decay', isActive: true, deletedAt: null },
          select: { id: true },
        });
        // A tenant with no decay rule is not scanned at all: the sweep's cost should be paid by the
        // tenants who asked for it.
        if (!hasDecayRule) return;

        const candidates = await this.engine.decayCandidates(
          ScoreDecaySweepProcessor.PER_TENANT_LIMIT,
        );
        examined += candidates.length;
        for (const leadId of candidates) {
          const result = await this.engine.applyDecay({ leadId, at });
          if (result && !result.noop) decayed += 1;
        }
      });
    }

    this.logger.info(
      { organizations: organizations.length, examined, decayed },
      'score decay sweep complete',
    );
  }
}
