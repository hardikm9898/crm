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
import { DocumentsService } from '../documents/documents.service.js';

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

/**
 * Keeps the `activities` table's partitions ahead of the calendar.
 *
 * Two jobs in one, because they are two halves of the same invariant:
 *
 *  * **Create the next few months' partitions.** A month with no partition does not fail — rows land
 *    in `activities_default` — but that is the problem: the default then holds rows overlapping the
 *    month, and PostgreSQL refuses to attach the real partition until they are moved. Running daily,
 *    months ahead, means that never happens.
 *  * **Report what is sitting in the default partition.** Rows arrive there from backdated imports and
 *    from clock skew. They work, but they are un-prunable by the retention job and they block the
 *    attach above, so they are surfaced rather than left to be discovered during an incident.
 */
const PARTITION_MONTHS_AHEAD = 3;

@Injectable()
export class ActivityPartitionProcessor implements JobProcessor {
  readonly queue = QUEUES.MAINTENANCE;
  readonly jobName = JOBS.ACTIVITY_PARTITIONS;

  constructor(
    private readonly db: DbService,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  async process(_payload: JobPayload, _job: Job): Promise<void> {
    await withPlatformScope('maintenance: activity partitions', async () => {
      const created: string[] = [];
      for (let month = 0; month <= PARTITION_MONTHS_AHEAD; month += 1) {
        const target = new Date();
        target.setUTCMonth(target.getUTCMonth() + month, 1);
        const [row] = await this.db.client.$queryRaw<{ ensure_activity_partition: string }[]>`
          SELECT ensure_activity_partition(${target}::timestamptz)
        `;
        if (row) created.push(row.ensure_activity_partition);
      }

      const [stranded] = await this.db.client.$queryRaw<{ count: bigint }[]>`
        SELECT count(*)::bigint AS count FROM activities_default
      `;
      const strandedCount = Number(stranded?.count ?? 0n);

      if (strandedCount > 0) {
        // Warn, not error: the rows are readable and the product works. What they block is the next
        // attach, which is a scheduled problem rather than an outage.
        this.logger.warn(
          { strandedCount },
          'activities are sitting in the default partition; they block attaching the months they belong to',
        );
      }
      this.logger.info({ partitions: created, strandedCount }, 'activity partitions checked');
    });
  }
}

/**
 * Lead recycling (`FR-ASG-7`).
 *
 * A lead assigned to somebody who then did nothing with it for weeks is worse than an unassigned
 * one: it looks handled. This returns such leads to the pool so they show up in the "nobody is
 * working this" view a manager actually checks.
 *
 * Two deliberate restraints:
 *
 *  * **Only open leads, and only assigned ones.** A won or lost lead is finished; an unassigned one
 *    is already in the pool.
 *  * **It unassigns, it does not reassign.** Handing a stale lead straight to somebody else would
 *    start the same clock again without anybody deciding to. The pool plus a manager notification is
 *    the honest outcome; re-running the assignment rules is then one explicit call away.
 *
 * The threshold lives in the organization's settings (`settings.leadRecycleDays`) rather than in
 * code, because how long is "too long" differs between selling flats and selling tuition. Absent or
 * zero means the tenant has not asked for recycling, and nothing happens.
 */
const RECYCLE_BATCH = 200;

@Injectable()
export class LeadRecycleProcessor implements JobProcessor {
  readonly queue = QUEUES.MAINTENANCE;
  readonly jobName = JOBS.LEAD_RECYCLE;

  constructor(
    private readonly db: DbService,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  async process(_payload: JobPayload, _job: Job): Promise<void> {
    await withPlatformScope('maintenance: recycle stale leads', async () => {
      const organizations = await this.db.client.organization.findMany({
        where: { deletedAt: null, status: { in: ['active', 'trialing'] } },
        select: { id: true, settings: true },
      });

      for (const organization of organizations) {
        const settings = (organization.settings ?? {}) as Record<string, unknown>;
        const days = Number(settings['leadRecycleDays'] ?? 0);
        // Not configured is not a default of "30 days": silently unassigning a tenant's leads
        // because they never opted in would be a support call, not a feature.
        if (!Number.isFinite(days) || days < 1) continue;

        const cutoff = new Date(Date.now() - days * 86_400_000);
        const stale = await this.db.client.lead.findMany({
          where: {
            organizationId: organization.id,
            deletedAt: null,
            mergedIntoId: null,
            assignedUserId: { not: null },
            status: { category: 'open' },
            OR: [
              { lastActivityAt: { lt: cutoff } },
              { lastActivityAt: null, createdAt: { lt: cutoff } },
            ],
          },
          select: { id: true, assignedUserId: true, fullName: true, lastActivityAt: true },
          take: RECYCLE_BATCH,
        });
        if (stale.length === 0) continue;

        for (const lead of stale) {
          await this.db.client.$transaction(async (tx) => {
            await tx.lead.update({
              where: { id: lead.id },
              data: { assignedUserId: null, lastActivityAt: new Date() },
            });
            await tx.leadAssignment.create({
              data: {
                id: newId(),
                organizationId: organization.id,
                leadId: lead.id,
                fromUserId: lead.assignedUserId,
                toUserId: null,
                reason: `recycled after ${days} days without activity`,
              },
            });
            await tx.activity.create({
              data: {
                id: newId(),
                organizationId: organization.id,
                leadId: lead.id,
                type: 'lead.recycled',
                actorType: 'system',
                actorLabel: 'lead recycling',
                occurredAt: new Date(),
                payload: {
                  fromUserId: lead.assignedUserId,
                  idleDays: days,
                  lastActivityAt: lead.lastActivityAt?.toISOString() ?? null,
                } as never,
              },
            });
            await tx.outboxEvent.create({
              data: {
                id: newId(),
                organizationId: organization.id,
                eventId: newId(),
                eventName: 'lead.unassigned_pool',
                aggregateType: 'lead',
                aggregateId: lead.id,
                actorType: 'system',
                payload: {
                  leadId: lead.id,
                  fullName: lead.fullName,
                  ruleName: null,
                  explanation: `Recycled after ${days} days without activity.`,
                } as never,
              },
            });
          });
        }

        this.logger.info(
          { organizationId: organization.id, recycled: stale.length, idleDays: days },
          'recycled stale leads back to the unassigned pool',
        );
      }
    });
  }
}

/**
 * Drops the bytes of expired exports and import files (`FR-IO-3`).
 *
 * The promise an export link makes is "this stops working after N hours", and the `documents` row
 * is what enforces it on read — this sweep is what makes it true on disk as well, so an expired
 * export is not merely unreachable but gone. The row survives: who exported what is audit history,
 * and deleting the evidence along with the file would defeat the point of recording it.
 */
@Injectable()
export class DocumentExpiryProcessor implements JobProcessor {
  readonly queue = QUEUES.MAINTENANCE;
  readonly jobName = JOBS.DOCUMENT_EXPIRY;

  constructor(
    private readonly documents: DocumentsService,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  async process(_payload: JobPayload, _job: Job): Promise<void> {
    const result = await this.documents.sweepExpired();
    if (result.examined > 0) {
      this.logger.info(result, 'document expiry sweep complete');
    }
  }
}
