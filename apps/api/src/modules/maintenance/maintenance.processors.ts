import { Inject, Injectable } from '@nestjs/common';
import { newId, withPlatformScope } from '@leados/shared';
import type { Job } from 'bullmq';
import type { Logger } from 'pino';
import { DbService } from '../../infra/db/db.service.js';
import { LOGGER } from '../../infra/observability/logger.module.js';
import { JOBS, QUEUES } from '../../infra/queue/queue.constants.js';
import type { JobProcessor } from '../../infra/queue/job-processor.js';
import type { JobPayload } from '../../infra/queue/queue.service.js';
import { EntitlementService } from '../../infra/entitlements/entitlement.service.js';

/**
 * Scheduled housekeeping (docs/queue-event-architecture.md §5).
 *
 * All of these are **platform-scoped**: they deliberately span tenants, so each says so through
 * `withPlatformScope` rather than running with an ambient context. All are idempotent, because a
 * schedule can fire twice and a failure is retried.
 */

const GRACE_PERIOD_DAYS = 3;
const SESSION_RETENTION_DAYS = 30;
const OUTBOX_STUCK_MINUTES = 15;

/** Expired and long-revoked sessions serve no purpose and make the table grow without bound. */
@Injectable()
export class SessionPruneProcessor implements JobProcessor {
  readonly queue = QUEUES.MAINTENANCE;
  readonly jobName = JOBS.SESSION_PRUNE;

  constructor(
    private readonly db: DbService,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  async process(_payload: JobPayload, _job: Job): Promise<void> {
    const cutoff = new Date(Date.now() - SESSION_RETENTION_DAYS * 86_400_000);
    const removed = await withPlatformScope('maintenance: prune sessions', async () =>
      this.db.client.session.deleteMany({
        where: {
          OR: [{ expiresAt: { lt: cutoff } }, { revokedAt: { lt: cutoff } }],
        },
      }),
    );
    if (removed.count > 0) {
      this.logger.info({ removed: removed.count, cutoff }, 'pruned expired sessions');
    }
  }
}

/**
 * Marks invitations past their expiry. The acceptance path already rejects an expired invitation,
 * so this is about the *list* an admin sees being truthful, and about seat accounting not being
 * held hostage by invitations nobody will ever accept.
 */
@Injectable()
export class InvitationExpiryProcessor implements JobProcessor {
  readonly queue = QUEUES.MAINTENANCE;
  readonly jobName = JOBS.INVITATION_EXPIRE;

  constructor(
    private readonly db: DbService,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  async process(_payload: JobPayload, _job: Job): Promise<void> {
    const expired = await withPlatformScope('maintenance: expire invitations', async () =>
      this.db.client.invitation.updateMany({
        where: { status: 'pending', revokedAt: null, expiresAt: { lte: new Date() } },
        data: { status: 'expired' },
      }),
    );
    if (expired.count > 0)
      this.logger.info({ expired: expired.count }, 'expired stale invitations');
  }
}

/**
 * Advances trial and subscription lifecycle (FR-BIL-3).
 *
 * The sequence is deliberately gentle: a trial that ends enters a grace period rather than
 * stopping work immediately, and only an expired grace makes the organization read-only. Nothing
 * is ever deleted — `SubscriptionGuard` restricts writes, and the data stays.
 */
@Injectable()
export class TrialCheckProcessor implements JobProcessor {
  readonly queue = QUEUES.MAINTENANCE;
  readonly jobName = JOBS.TRIAL_CHECK;

  constructor(
    private readonly db: DbService,
    private readonly entitlements: EntitlementService,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  async process(_payload: JobPayload, _job: Job): Promise<void> {
    const now = new Date();

    const started = await withPlatformScope('maintenance: begin grace periods', async () =>
      this.db.client.subscription.updateMany({
        where: { status: 'trialing', trialEndsAt: { lte: now }, graceEndsAt: null },
        data: { graceEndsAt: new Date(now.getTime() + GRACE_PERIOD_DAYS * 86_400_000) },
      }),
    );

    const lapsed = await withPlatformScope('maintenance: expire lapsed trials', async () => {
      const due = await this.db.client.subscription.findMany({
        where: { status: { in: ['trialing', 'grace'] }, graceEndsAt: { lte: now } },
        select: { id: true, organizationId: true },
      });

      for (const subscription of due) {
        await this.db.client.$transaction(async (tx) => {
          await tx.subscription.update({
            where: { id: subscription.id },
            data: { status: 'expired' },
          });
          await tx.outboxEvent.create({
            data: {
              id: newId(),
              eventId: newId(),
              organizationId: subscription.organizationId,
              eventName: 'trial.expired',
              aggregateType: 'subscription',
              aggregateId: subscription.id,
              payload: { organizationId: subscription.organizationId },
              actorType: 'system',
            },
          });
        });
        // The guard caches subscription state, and entitlements are cached too; clear both so the
        // transition takes effect on the next request rather than up to a minute later.
        await this.entitlements.invalidate(subscription.organizationId);
      }
      return due.length;
    });

    if (started.count > 0 || lapsed > 0) {
      this.logger.info(
        { graceStarted: started.count, expired: lapsed },
        'trial lifecycle advanced',
      );
    }
  }
}

/**
 * Surfaces outbox events that are not moving.
 *
 * Outbox lag is the most important internal signal in the system: if events stop flowing, nothing
 * visibly breaks — requests still return 200 — while follow-ups are not created and messages are
 * not sent. A stuck event is therefore mirrored into `job_failures`, where an operator sees it
 * alongside failed jobs (docs/queue-event-architecture.md §6).
 */
@Injectable()
export class OutboxReapProcessor implements JobProcessor {
  readonly queue = QUEUES.MAINTENANCE;
  readonly jobName = JOBS.OUTBOX_REAP;

  constructor(
    private readonly db: DbService,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  async process(_payload: JobPayload, _job: Job): Promise<void> {
    const cutoff = new Date(Date.now() - OUTBOX_STUCK_MINUTES * 60_000);

    const stuck = await withPlatformScope('maintenance: reap stuck outbox events', async () =>
      this.db.client.outboxEvent.findMany({
        where: { publishedAt: null, occurredAt: { lt: cutoff } },
        orderBy: { occurredAt: 'asc' },
        take: 100,
      }),
    );
    if (stuck.length === 0) return;

    this.logger.error(
      { count: stuck.length, oldest: stuck[0]?.occurredAt, cutoffMinutes: OUTBOX_STUCK_MINUTES },
      'outbox events are not being dispatched',
    );

    await withPlatformScope('maintenance: mirror stuck outbox events', async () => {
      for (const event of stuck) {
        const alreadyRecorded = await this.db.client.jobFailure.findFirst({
          where: { queue: 'outbox', jobId: event.eventId },
        });
        if (alreadyRecorded) continue; // idempotent: one row per stuck event
        await this.db.client.jobFailure.create({
          data: {
            id: newId(),
            queue: 'outbox',
            jobName: event.eventName,
            jobId: event.eventId,
            payload: { aggregateType: event.aggregateType, aggregateId: event.aggregateId },
            error: event.lastError ?? `undispatched for over ${OUTBOX_STUCK_MINUTES} minutes`,
            attempts: event.attempts,
          },
        });
      }
    });
  }
}
