import { Inject, Injectable } from '@nestjs/common';
import type { Job } from 'bullmq';
import type { Logger } from 'pino';
import { LOGGER } from '../../infra/observability/logger.module.js';
import { JOBS, QUEUES } from '../../infra/queue/queue.constants.js';
import type { JobProcessor } from '../../infra/queue/job-processor.js';
import type { JobPayload } from '../../infra/queue/queue.service.js';
import { ImportRunnerService } from './import-runner.service.js';

interface ImportJobPayload extends JobPayload {
  readonly importJobId?: string;
  readonly aggregateId?: string;
}

/**
 * Runs an import in the background.
 *
 * Thin on purpose: the processor's only job is to find out *which* import and hand over. Everything
 * about resumption, counters and per-row outcomes lives in `ImportRunnerService`, which is also
 * what the integration tests drive — a processor that owned that logic could only be tested through
 * a queue.
 *
 * The subject is read from `payload.aggregateId` as well as `importJobId`: the envelope is the
 * stable part of a job, and a job enqueued by an older release still has to process.
 */
@Injectable()
export class ImportProcessProcessor implements JobProcessor<ImportJobPayload> {
  readonly queue = QUEUES.IMPORTS_EXPORTS;
  readonly jobName = JOBS.IMPORT_PROCESS;

  constructor(
    private readonly runner: ImportRunnerService,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  async process(payload: ImportJobPayload, _job: Job): Promise<void> {
    const organizationId = payload.organizationId;
    const importJobId = payload.importJobId ?? payload.aggregateId;
    if (!organizationId || !importJobId) {
      this.logger.error({ payload }, 'import job has no organization or import id');
      return;
    }
    await this.runner.run(organizationId, importJobId);
  }
}
