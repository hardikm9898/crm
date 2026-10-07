import { Inject, Injectable } from '@nestjs/common';
import { newId, withPlatformScope } from '@leados/shared';
import type { Logger } from 'pino';
import { DbService } from '../db/db.service.js';
import { LOGGER } from '../observability/logger.module.js';
import { JOBS, QUEUES, type JobName, type QueueName } from './queue.constants.js';
import { QueueService } from './queue.service.js';

/**
 * Registers the repeatable jobs (docs/queue-event-architecture.md §5).
 *
 * Schedules live in one table below rather than being scattered across modules, so "what runs and
 * when" is answerable by reading one file. Registration is idempotent (BullMQ upserts the
 * scheduler), which means several scheduler replicas may run: the last one to register wins and
 * they agree, so this process is replaceable without a leader election.
 *
 * A heartbeat is written to the database because the failure mode of a scheduler is silence — the
 * only symptom is that something which should have happened did not. `/health/deep` reports the
 * heartbeat age so that silence is detectable.
 */
export interface ScheduleDefinition {
  readonly queue: QueueName;
  readonly jobName: JobName;
  readonly cron: string;
  readonly description: string;
}

export const SCHEDULES: readonly ScheduleDefinition[] = [
  {
    queue: QUEUES.MAINTENANCE,
    jobName: JOBS.SESSION_PRUNE,
    cron: '17 3 * * *',
    description: 'Delete long-expired and long-revoked sessions',
  },
  {
    queue: QUEUES.MAINTENANCE,
    jobName: JOBS.INVITATION_EXPIRE,
    cron: '*/30 * * * *',
    description: 'Mark invitations past their expiry',
  },
  {
    queue: QUEUES.MAINTENANCE,
    jobName: JOBS.TRIAL_CHECK,
    cron: '23 8 * * *',
    description: 'Advance trial grace periods and expire lapsed subscriptions',
  },
  {
    queue: QUEUES.MAINTENANCE,
    jobName: JOBS.OUTBOX_REAP,
    // Frequent on purpose: undispatched events are the signal that nothing is reacting to
    // anything, and every minute of silence is a minute of missed follow-ups.
    cron: '*/5 * * * *',
    description: 'Surface outbox events that are not being dispatched',
  },
  {
    queue: QUEUES.MAINTENANCE,
    jobName: JOBS.ACTIVITY_PARTITIONS,
    // Daily, well ahead of need. `activities` is partitioned monthly, and a month with no partition
    // sends every timeline write to the default partition — which then blocks attaching the real
    // one. Cheap to run, expensive to have forgotten.
    cron: '41 2 * * *',
    description: 'Pre-create upcoming activity partitions and report rows in the default one',
  },
  {
    queue: QUEUES.MAINTENANCE,
    jobName: JOBS.LEAD_RECYCLE,
    // Early morning, before the working day: a lead returned to the pool at 6am is one somebody
    // can pick up at 9, which is the whole point.
    cron: '53 5 * * *',
    description: 'Return leads nobody has touched in N days to the unassigned pool',
  },
  {
    queue: QUEUES.MAINTENANCE,
    jobName: JOBS.DOCUMENT_EXPIRY,
    // Hourly, because the promise an export link makes is "this stops working after N hours" and a
    // daily sweep would make that "after N hours, give or take a day" (`FR-IO-3`).
    cron: '31 * * * *',
    description: 'Drop the bytes of expired exports and import files',
  },
  {
    queue: QUEUES.MAINTENANCE,
    jobName: JOBS.QUOTATION_EXPIRY,
    // Early, and daily, because `valid_until` is a date: a quotation valid "until the 20th" is
    // valid for all of the 20th, and expiring it at 00:49 on the 21st is exactly on time. A price
    // from April that still reads "sent" is one somebody honours by accident.
    cron: '49 0 * * *',
    description: 'Mark sent quotations expired once their validity has run out',
  },
  {
    queue: QUEUES.MAINTENANCE,
    jobName: JOBS.TASK_REMINDER_DISPATCH,
    // Every minute, which is what `docs/queue-event-architecture.md` §5 specifies and what a
    // reminder is worth: a warning an hour before a call is only useful if it arrives at the hour
    // and not at the half hour. An indexed read of nothing on almost every tick
    // (`task_reminders_pending`).
    cron: '* * * * *',
    description: 'Send the task reminders whose moment has come',
  },
  {
    queue: QUEUES.MAINTENANCE,
    jobName: JOBS.TASK_OVERDUE_SWEEP,
    // Every half hour. Overdue itself is read from the clock, so this is only about *telling*
    // somebody, and a notification eleven minutes after the fact is as useful as one at the minute.
    cron: '*/30 * * * *',
    description: 'Tell the assignee and their manager about follow-ups that were missed',
  },
  {
    queue: QUEUES.MAINTENANCE,
    jobName: JOBS.SLA_SWEEP,
    // Every five minutes, which `docs/queue-event-architecture.md` §5 specifies. Frequent on
    // purpose: the near-breach warning is only worth sending while there is still time to act on
    // it, and a half-hourly sweep would turn a sixty-minute promise's warning into a breach notice.
    cron: '*/5 * * * *',
    description: 'Warn on SLA clocks running out and escalate the ones that have breached',
  },
  {
    queue: QUEUES.SCORING,
    jobName: JOBS.SCORE_DECAY_SWEEP,
    // Overnight, before anyone opens the app: a score that decayed at 1am is right when the first
    // executive looks at their list, and the sweep's own cost lands when nothing else is running
    // (docs/queue-event-architecture.md §6 puts it at 01:00).
    cron: '7 1 * * *',
    description: 'Take points off leads nobody has touched, so a stale score cannot look hot',
  },
];

const HEARTBEAT_INTERVAL_MS = 30_000;

@Injectable()
export class SchedulerService {
  private readonly instanceId = `scheduler-${newId()}`;
  private heartbeatTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly queues: QueueService,
    private readonly db: DbService,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  async start(): Promise<void> {
    for (const schedule of SCHEDULES) {
      await this.queues.schedule(schedule.queue, schedule.jobName, schedule.cron, {
        organizationId: null,
      });
    }

    this.logger.info(
      { instanceId: this.instanceId, schedules: SCHEDULES.map((s) => `${s.jobName} @ ${s.cron}`) },
      'scheduler registered repeatable jobs',
    );

    await this.beat();
    this.heartbeatTimer = setInterval(() => {
      void this.beat();
    }, HEARTBEAT_INTERVAL_MS);
    // A heartbeat timer must not be the reason the process cannot exit.
    this.heartbeatTimer.unref();
  }

  async stop(): Promise<void> {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  private async beat(): Promise<void> {
    try {
      await withPlatformScope('scheduler: heartbeat', async () => {
        await this.db.client.schedulerHeartbeat.upsert({
          where: { instanceId: this.instanceId },
          create: {
            id: newId(),
            instanceId: this.instanceId,
            lastBeatAt: new Date(),
            registered: SCHEDULES.map((schedule) => ({
              job: schedule.jobName,
              cron: schedule.cron,
            })),
          },
          update: { lastBeatAt: new Date() },
        });
      });
    } catch (error) {
      // A missed heartbeat is reported by the health endpoint; it must not stop the scheduler.
      this.logger.warn(
        { err: error instanceof Error ? error.message : error },
        'scheduler heartbeat failed',
      );
    }
  }
}
