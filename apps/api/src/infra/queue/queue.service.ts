import { Inject, Injectable, type OnApplicationShutdown } from '@nestjs/common';
import { Queue } from 'bullmq';
import { tenantContext } from '@leados/shared';
import { APP_CONFIG } from '../config/config.module.js';
import type { AppConfig } from '../config/config.schema.js';
import {
  DEFAULT_JOB_OPTIONS,
  QUEUE_NAMES,
  QUEUE_POLICIES,
  type JobName,
  type QueueName,
} from './queue.constants.js';

/**
 * Owns the BullMQ `Queue` handles and is the only way work is enqueued.
 *
 * Every job payload carries `organizationId` and `correlationId`, because a processor's first
 * act is to restore the tenant context — a job without one must not be able to run
 * (docs/queue-event-architecture.md §3).
 */

export interface JobPayload {
  /** `null` only for genuinely platform-wide work (maintenance sweeps). */
  readonly organizationId: string | null;
  /** The request or event this job descends from, for tracing a chain end to end. */
  readonly correlationId?: string;
  /** Derived from the triggering event, never from the attempt, so retries are one effect. */
  readonly idempotencyKey?: string;
  readonly [key: string]: unknown;
}

export interface EnqueueOptions {
  readonly delayMs?: number;
  readonly attempts?: number;
  /** Deduplicates at the queue level: two jobs with the same id collapse into one. */
  readonly jobId?: string;
  readonly priority?: number;
}

@Injectable()
export class QueueService implements OnApplicationShutdown {
  private readonly queues = new Map<QueueName, Queue>();

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {
    for (const name of QUEUE_NAMES) {
      this.queues.set(
        name,
        new Queue(name, {
          connection: { url: this.config.REDIS_URL },
          defaultJobOptions: {
            ...DEFAULT_JOB_OPTIONS,
            attempts: QUEUE_POLICIES[name].attempts,
            backoff: { type: 'exponential', delay: QUEUE_POLICIES[name].backoffDelayMs },
          },
        }),
      );
    }
  }

  queue(name: QueueName): Queue {
    const queue = this.queues.get(name);
    if (!queue) throw new Error(`Queue not registered: ${name}`);
    return queue;
  }

  async enqueue(
    queueName: QueueName,
    jobName: JobName,
    payload: JobPayload,
    options: EnqueueOptions = {},
  ): Promise<string> {
    const principal = tenantContext.get();
    const job = await this.queue(queueName).add(
      jobName,
      {
        ...payload,
        correlationId: payload.correlationId ?? principal?.requestId ?? null,
      },
      {
        ...(options.delayMs === undefined ? {} : { delay: options.delayMs }),
        ...(options.attempts === undefined ? {} : { attempts: options.attempts }),
        ...(options.jobId === undefined ? {} : { jobId: options.jobId }),
        ...(options.priority === undefined ? {} : { priority: options.priority }),
      },
    );
    return job.id ?? 'unknown';
  }

  /** Registers a repeatable job. Idempotent: re-registering replaces the schedule. */
  async schedule(
    queueName: QueueName,
    jobName: JobName,
    cron: string,
    payload: JobPayload = { organizationId: null },
  ): Promise<void> {
    await this.queue(queueName).upsertJobScheduler(
      jobName,
      { pattern: cron },
      { name: jobName, data: payload },
    );
  }

  /** Queue depth and failure counts, for the health endpoint and the operator console. */
  async counts(): Promise<Record<string, Record<string, number>>> {
    const result: Record<string, Record<string, number>> = {};
    for (const [name, queue] of this.queues) {
      result[name] = await queue.getJobCounts(
        'waiting',
        'active',
        'delayed',
        'failed',
        'completed',
      );
    }
    return result;
  }

  /** Age of the oldest waiting job, which is the signal that consumers are falling behind. */
  async oldestWaitingAgeSeconds(): Promise<number | null> {
    let oldest: number | null = null;
    for (const queue of this.queues.values()) {
      const [job] = await queue.getJobs(['waiting'], 0, 0, true);
      if (job?.timestamp) {
        const age = Math.round((Date.now() - job.timestamp) / 1_000);
        oldest = oldest === null ? age : Math.max(oldest, age);
      }
    }
    return oldest;
  }

  async onApplicationShutdown(): Promise<void> {
    await Promise.all([...this.queues.values()].map((queue) => queue.close()));
  }
}
