import { Inject, Injectable } from '@nestjs/common';
import type { Job } from 'bullmq';
import type { Logger } from 'pino';
import { LOGGER } from '../../infra/observability/logger.module.js';
import { JOBS, QUEUES } from '../../infra/queue/queue.constants.js';
import type { JobProcessor } from '../../infra/queue/job-processor.js';
import type { JobPayload } from '../../infra/queue/queue.service.js';
import { QuotationsService } from './quotations.service.js';

/**
 * Expires quotations whose validity has run out (`maintenance.quotation-expiry`).
 *
 * Thin, like every other processor here: the sweep itself is a method on the domain service, which
 * is what makes it callable from a test over real HTTP instead of only from a cron tick.
 */
@Injectable()
export class QuotationExpiryProcessor implements JobProcessor {
  readonly queue = QUEUES.MAINTENANCE;
  readonly jobName = JOBS.QUOTATION_EXPIRY;

  constructor(
    private readonly quotations: QuotationsService,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  async process(_payload: JobPayload, _job: Job): Promise<void> {
    const result = await this.quotations.expireDue();
    if (result.examined > 0) {
      this.logger.info(result, 'quotation expiry sweep complete');
    }
  }
}
