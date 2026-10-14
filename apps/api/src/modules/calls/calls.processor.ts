import { Inject, Injectable } from '@nestjs/common';
import type { Job } from 'bullmq';
import type { Logger } from 'pino';
import { LOGGER } from '../../infra/observability/logger.module.js';
import { JOBS, QUEUES } from '../../infra/queue/queue.constants.js';
import type { JobProcessor } from '../../infra/queue/job-processor.js';
import type { JobPayload } from '../../infra/queue/queue.service.js';
import { CallsService } from './calls.service.js';

/**
 * Asks what happened on the calls that were dialled and never recorded (`call.outcome-sweep`).
 *
 * Thin, like every other processor here: the sweep is a method on the domain service, which is what
 * makes it callable from a test over real HTTP rather than only from a cron tick.
 */
@Injectable()
export class CallOutcomeSweepProcessor implements JobProcessor {
  readonly queue = QUEUES.MAINTENANCE;
  readonly jobName = JOBS.CALL_OUTCOME_SWEEP;

  constructor(
    private readonly calls: CallsService,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  async process(_payload: JobPayload, _job: Job): Promise<void> {
    const result = await this.calls.sweepUnrecordedOutcomes();
    if (result.asked > 0) this.logger.info(result, 'call outcome sweep complete');
  }
}
