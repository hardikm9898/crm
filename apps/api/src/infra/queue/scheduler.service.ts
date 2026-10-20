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
    jobName: JOBS.API_LOG_PARTITIONS,
    // Early, and before the activity partitions: tomorrow's day partition has to exist before
    // midnight, and the retention drop is the one scheduled statement in this product that deletes
    // a million rows — which is also why it is a partition drop and not a `DELETE`.
    cron: '13 2 * * *',
    description: 'Pre-create upcoming api-log day partitions and drop the ones past retention',
  },
  {
    queue: QUEUES.MAINTENANCE,
    jobName: JOBS.IDEMPOTENCY_PRUNE,
    // Hourly, not daily: the window is 48 hours, so an hourly sweep keeps the table within an
    // hour of the truth and each run deletes a small set rather than a day's worth.
    cron: '17 * * * *',
    description: 'Forget the idempotency keys whose replay window has closed',
  },
  {
    queue: QUEUES.MAINTENANCE,
    jobName: JOBS.INTEGRATION_HEALTH_CHECK,
    // Every ten minutes, which is the cadence the one probeable provider declares. The sweep
    // decides per connection whether its own interval has elapsed, so this is "how often we look"
    // and the catalogue is "how often each is asked" — one definition of the cadence, in the place
    // a provider is described.
    cron: '*/10 * * * *',
    description: 'Probe the connected providers whose credential can be checked',
  },
  {
    queue: QUEUES.MAINTENANCE,
    jobName: JOBS.INTEGRATION_RETRY_SWEEP,
    // Every five minutes: a provider event that failed is usually waiting on the provider itself
    // (a rate limit, a lead not yet readable), and the three-attempt ceiling means a minute-by-
    // minute sweep would spend all three inside the same bad minute.
    cron: '*/5 * * * *',
    description: 'Re-queue the provider events that have not become leads',
  },
  {
    queue: QUEUES.WEBHOOKS,
    jobName: JOBS.WEBHOOK_RETRY_SWEEP,
    // Every minute, because the first retry is ten seconds out and a schedule whose first step is
    // ten seconds cannot be served by a five-minute sweep. Cheap: one indexed read of the due set.
    cron: '* * * * *',
    description: 'Enqueue the webhook deliveries whose next attempt is due',
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
    jobName: JOBS.CALL_OUTCOME_SWEEP,
    // Every ten minutes. The grace period is fifteen, so a call gets its question between fifteen
    // and twenty-five minutes after it was dialled — soon enough that the person still remembers
    // the conversation, late enough that it never arrives while they are still on the phone.
    cron: '*/10 * * * *',
    description: 'Ask what happened on the calls that were dialled and never recorded',
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
    queue: QUEUES.MAINTENANCE,
    jobName: JOBS.NOTIFICATION_RELEASE,
    // Every minute, like the reminder dispatcher and for the same reason: a quiet window that
    // closes at 07:00 has to deliver at 07:00, and a five-minute sweep would make the promise
    // "some time in the first five minutes of your morning". An indexed read of nothing on almost
    // every tick (`notifications_awaiting_release`).
    cron: '* * * * *',
    description: 'Release the notifications quiet hours held, dropping the ones now out of date',
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
  {
    queue: QUEUES.MAINTENANCE,
    jobName: JOBS.WHATSAPP_SEND_RETRY,
    // Every two minutes. A message queued and never handed to Meta is a customer waiting for an
    // answer, so this is the shortest sweep in the product after the notification release — and
    // the read is an indexed scan of nothing (`messages_queued`) on almost every tick.
    cron: '*/2 * * * *',
    description: 'Re-queue the WhatsApp messages a worker never handed to Meta',
  },
  {
    queue: QUEUES.MAINTENANCE,
    jobName: JOBS.WHATSAPP_MEDIA_RETRY,
    // Every five minutes rather than every two: an attachment nobody has fetched yet is a photo
    // the thread says is coming, which is a worse wait than no message at all but a better one
    // than a reply that never went. The sweep ignores rows younger than a minute, so it never
    // races the job the ingestion already queued.
    cron: '*/5 * * * *',
    description: 'Re-fetch the WhatsApp attachments a worker never got',
  },
  {
    queue: QUEUES.MAINTENANCE,
    jobName: JOBS.WHATSAPP_SYNC_TEMPLATES,
    // Every six hours. Meta reviews a template in hours rather than minutes, and its own
    // notification of the verdict is a webhook field this product does not subscribe to yet — so
    // this sweep is how an approval becomes a sendable template without anybody pressing anything.
    cron: '23 */6 * * *',
    description: 'Reconcile every workspace’s WhatsApp templates against Meta',
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
