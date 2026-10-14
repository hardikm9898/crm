import { Inject, Injectable } from '@nestjs/common';
import type { Job } from 'bullmq';
import type { Logger } from 'pino';
import { LOGGER } from '../../infra/observability/logger.module.js';
import { JOBS, QUEUES } from '../../infra/queue/queue.constants.js';
import type { JobProcessor } from '../../infra/queue/job-processor.js';
import type { JobPayload } from '../../infra/queue/queue.service.js';
import { IngestionService } from './ingestion.service.js';

/**
 * Forgets the idempotency keys whose window has closed (`maintenance.idempotency-prune`).
 *
 * A key is remembered for 48 hours — long enough for any client's retries and short enough that
 * the table does not become a permanent record of every request ever made. Without this sweep the
 * guarantee is still correct and the table grows forever, which is the quiet kind of failure:
 * nothing breaks until a year later.
 */
@Injectable()
export class IdempotencyPruneProcessor implements JobProcessor {
  readonly queue = QUEUES.MAINTENANCE;
  readonly jobName = JOBS.IDEMPOTENCY_PRUNE;

  constructor(
    private readonly ingestion: IngestionService,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  async process(_payload: JobPayload, _job: Job): Promise<void> {
    const removed = await this.ingestion.pruneIdempotencyKeys();
    if (removed > 0) this.logger.info({ removed }, 'expired idempotency keys pruned');
  }
}
