import { Inject, Injectable } from '@nestjs/common';
import type { Job } from 'bullmq';
import type { Logger } from 'pino';
import { LOGGER } from '../../infra/observability/logger.module.js';
import { JOBS, QUEUES } from '../../infra/queue/queue.constants.js';
import type { JobProcessor } from '../../infra/queue/job-processor.js';
import type { JobPayload } from '../../infra/queue/queue.service.js';
import { ExportGeneratorService } from './export-generator.service.js';

interface ExportJobPayload extends JobPayload {
  readonly exportJobId?: string;
  readonly aggregateId?: string;
}

/** Generates an export file in the background. Thin, for the same reason the import processor is. */
@Injectable()
export class ExportGenerateProcessor implements JobProcessor<ExportJobPayload> {
  readonly queue = QUEUES.IMPORTS_EXPORTS;
  readonly jobName = JOBS.EXPORT_GENERATE;

  constructor(
    private readonly generator: ExportGeneratorService,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  async process(payload: ExportJobPayload, _job: Job): Promise<void> {
    const organizationId = payload.organizationId;
    const exportJobId = payload.exportJobId ?? payload.aggregateId;
    if (!organizationId || !exportJobId) {
      this.logger.error({ payload }, 'export job has no organization or export id');
      return;
    }
    await this.generator.run(organizationId, exportJobId);
  }
}
