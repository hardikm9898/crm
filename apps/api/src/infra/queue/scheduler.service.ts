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
