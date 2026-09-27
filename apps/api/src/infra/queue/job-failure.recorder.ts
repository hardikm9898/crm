import { Inject, Injectable } from '@nestjs/common';
import { newId, withPlatformScope } from '@leados/shared';
import type { Job } from 'bullmq';
import type { Logger } from 'pino';
import { DbService } from '../db/db.service.js';
import { LOGGER } from '../observability/logger.module.js';

/**
 * The dead-letter mirror (docs/queue-event-architecture.md §6).
 *
 * BullMQ keeps failed jobs in Redis, which is fine for a developer with redis-cli and useless
 * for an operator. Exhausted jobs are therefore copied into `job_failures`, where the Super
 * Admin console can list, inspect and retry them (FR-SA-4).
 *
 * Payloads are redacted before storage: a job's data can contain a customer's phone number or
 * a single-use token, and a failure table is exactly the place such values would linger.
 */
const REDACTED_KEYS = new Set([
  'token',
  'password',
  'passwordHash',
  'secret',
  'accessToken',
  'refreshToken',
  'credentials',
  'signature',
  'otp',
  'code',
  'email',
  'phone',
  'phoneE164',
  'body',
  'text',
]);

@Injectable()
export class JobFailureRecorder {
  constructor(
    private readonly db: DbService,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  /** Called when a job has exhausted its attempts. Never throws. */
  async record(queueName: string, job: Job | undefined, error: Error): Promise<void> {
    const attempts = job?.attemptsMade ?? 0;
    const payload = {
      queue: queueName,
      jobId: job?.id ?? null,
      jobName: job?.name ?? 'unknown',
      attempts,
      error: error.message,
    };

    this.logger.error(payload, 'job exhausted its retries — recorded for operator retry');

    try {
      await withPlatformScope('dlq: record exhausted job', async () => {
        await this.db.client.jobFailure.create({
          data: {
            id: newId(),
            queue: queueName,
            jobName: job?.name ?? 'unknown',
            jobId: job?.id ?? null,
            payload: redact(job?.data) as object,
            error: error.message.slice(0, 2_000),
            stack: error.stack?.slice(0, 4_000) ?? null,
            attempts,
          },
        });
      });
    } catch (recordingError) {
      // Losing the mirror row must not mask the original failure, which is already logged.
      this.logger.error(
        { err: recordingError, original: payload },
        'failed to record job failure in job_failures',
      );
    }
  }
}

export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value === null || typeof value !== 'object') return value;

  const result: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    result[key] = REDACTED_KEYS.has(key) ? '[redacted]' : redact(nested);
  }
  return result;
}
