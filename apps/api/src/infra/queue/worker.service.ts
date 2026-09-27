import { Inject, Injectable, type OnApplicationShutdown } from '@nestjs/common';
import { Worker, type Job } from 'bullmq';
import { systemPrincipal, tenantContext } from '@leados/shared';
import type { Logger } from 'pino';
import { APP_CONFIG } from '../config/config.module.js';
import type { AppConfig } from '../config/config.schema.js';
import { LOGGER } from '../observability/logger.module.js';
import { JobFailureRecorder } from './job-failure.recorder.js';
import type { JobProcessor } from './job-processor.js';
import { QUEUE_POLICIES, type QueueName } from './queue.constants.js';
import type { JobPayload } from './queue.service.js';

/**
 * Runs the BullMQ workers.
 *
 * Two responsibilities that every processor would otherwise have to remember:
 *
 *  • **Tenant context.** A job payload carries `organizationId`, and the handler runs inside
 *    `tenantContext.run(...)`. A tenant-scoped job with no organization is refused rather than
 *    running unscoped — the same default as an HTTP request (docs/security.md §3).
 *
 *  • **Failure handling.** Retries are BullMQ's; what matters here is that a job which exhausts
 *    them is mirrored into `job_failures` so an operator can see and retry it, instead of dying
 *    in Redis (docs/queue-event-architecture.md §6).
 */
@Injectable()
export class WorkerService implements OnApplicationShutdown {
  private readonly workers: Worker[] = [];

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(LOGGER) private readonly logger: Logger,
    private readonly failures: JobFailureRecorder,
  ) {}

  /**
   * @param processors Resolved by the bootstrap from `PROCESSOR_TYPES`, rather than injected.
   *   Processors live in the domain modules that own them, and those modules import this queue
   *   infrastructure — so injecting them here would be a dependency cycle. Passing the list in
   *   keeps the direction one-way.
   * @param only Restricts this process to a subset of queues, so a noisy queue can be scaled alone.
   */
  start(processors: readonly JobProcessor[], only?: readonly QueueName[]): void {
    const byQueue = new Map<QueueName, Map<string, JobProcessor>>();
    for (const processor of processors) {
      if (only && !only.includes(processor.queue)) continue;
      const queueProcessors = byQueue.get(processor.queue) ?? new Map<string, JobProcessor>();
      if (queueProcessors.has(processor.jobName)) {
        throw new Error(`Duplicate processor for ${processor.queue}/${processor.jobName}`);
      }
      queueProcessors.set(processor.jobName, processor);
      byQueue.set(processor.queue, queueProcessors);
    }

    for (const [queueName, queueProcessors] of byQueue) {
      const worker = new Worker(
        queueName,
        async (job: Job) => this.run(queueName, queueProcessors, job),
        {
          connection: { url: this.config.REDIS_URL },
          concurrency: QUEUE_POLICIES[queueName].concurrency,
        },
      );

      worker.on('failed', (job, error) => {
        const attempts = job?.attemptsMade ?? 0;
        const allowed = job?.opts.attempts ?? QUEUE_POLICIES[queueName].attempts;
        if (attempts >= allowed) {
          void this.failures.record(queueName, job, error);
        } else {
          this.logger.warn(
            { queue: queueName, jobId: job?.id, jobName: job?.name, attempts, err: error.message },
            'job failed; will retry',
          );
        }
      });

      worker.on('error', (error) => {
        this.logger.error({ queue: queueName, err: error.message }, 'worker error');
      });

      this.workers.push(worker);
      this.logger.info(
        {
          queue: queueName,
          jobs: [...queueProcessors.keys()],
          concurrency: QUEUE_POLICIES[queueName].concurrency,
        },
        'worker started',
      );
    }

    if (this.workers.length === 0) {
      // Silence here would look like a healthy worker doing nothing at all.
      this.logger.warn({ only }, 'no processors matched: this worker will consume nothing');
    }
  }

  private async run(
    queueName: QueueName,
    processors: Map<string, JobProcessor>,
    job: Job,
  ): Promise<void> {
    const processor = processors.get(job.name);
    if (!processor) {
      // An unknown job name means a deploy skew (a producer newer than this worker). Failing is
      // right: the job stays in the queue for a worker that understands it.
      throw new Error(`No processor registered for ${queueName}/${job.name}`);
    }

    const payload = job.data as JobPayload;
    const startedAt = performance.now();

    const execute = async (): Promise<void> => {
      await processor.process(payload, job);
    };

    if (payload.organizationId) {
      await tenantContext.run(
        systemPrincipal(
          payload.organizationId,
          payload.correlationId ?? `job:${job.id ?? 'unknown'}`,
        ),
        execute,
      );
    } else {
      // Platform-scoped work (maintenance sweeps). Processors that need a tenant will throw when
      // they touch scoped data, which is the intended default.
      await execute();
    }

    this.logger.debug(
      {
        queue: queueName,
        jobName: job.name,
        jobId: job.id,
        organizationId: payload.organizationId,
        durationMs: Math.round(performance.now() - startedAt),
      },
      'job processed',
    );
  }

  async onApplicationShutdown(): Promise<void> {
    // Closing waits for in-flight jobs, so a rolling deploy does not abandon work mid-flight.
    await Promise.all(this.workers.map((worker) => worker.close()));
  }
}
