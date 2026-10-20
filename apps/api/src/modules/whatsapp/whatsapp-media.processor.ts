import { Inject, Injectable } from '@nestjs/common';
import { newId, withPlatformScope } from '@leados/shared';
import type { Job } from 'bullmq';
import type { Logger } from 'pino';
import { LOGGER } from '../../infra/observability/logger.module.js';
import { JOBS, QUEUES } from '../../infra/queue/queue.constants.js';
import type { JobProcessor } from '../../infra/queue/job-processor.js';
import type { JobPayload } from '../../infra/queue/queue.service.js';
import { QueueService } from '../../infra/queue/queue.service.js';
import { DbService } from '../../infra/db/db.service.js';
import { WhatsAppMediaService } from './whatsapp-media.service.js';

/**
 * One inbound attachment, fetched and stored (`FR-WA-3`).
 *
 * Reads its subject from `payload.aggregateId` — the **message's** id, because that is what the
 * attachment belongs to and what the ingestion knows. Idempotent on the row's own status: a job
 * delivered twice finds it `stored` and does nothing, which matters because the alternative is
 * paying Meta's bandwidth twice.
 *
 * A failure is recorded on the row and then **rethrown**, so BullMQ's backoff applies and the queue
 * shows a failing job rather than looking idle; the sweep is what catches one lost to a restart.
 */
@Injectable()
export class WhatsAppDownloadMediaProcessor implements JobProcessor {
  readonly queue = QUEUES.MAINTENANCE;
  readonly jobName = JOBS.WHATSAPP_DOWNLOAD_MEDIA;

  constructor(
    private readonly media: WhatsAppMediaService,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  async process(payload: JobPayload, _job: Job): Promise<void> {
    const organizationId = payload.organizationId;
    const messageId = typeof payload['aggregateId'] === 'string' ? payload['aggregateId'] : null;
    if (!organizationId || !messageId) {
      this.logger.warn({ payload }, 'a whatsapp media job has no subject');
      return;
    }
    try {
      await this.media.download(organizationId, messageId);
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'unknown error';
      // The row carries the reason so the screen can say what happened; the throw is what makes
      // the job retry and the failure visible in the queue.
      await this.media.recordFailure(organizationId, messageId, reason);
      throw error;
    }
  }
}

/**
 * Re-fetches the attachments a worker never got (`FR-WA-3`).
 *
 * The shape the send retry and the webhook retry already have: a sweep over a row, because a job
 * lost while a worker was down must not be a customer's photo lost. Cross-tenant, so the read is
 * platform-scoped and each re-queue carries the row's own workspace.
 */
@Injectable()
export class WhatsAppMediaRetryProcessor implements JobProcessor {
  readonly queue = QUEUES.MAINTENANCE;
  readonly jobName = JOBS.WHATSAPP_MEDIA_RETRY;

  constructor(
    private readonly db: DbService,
    private readonly media: WhatsAppMediaService,
    private readonly queues: QueueService,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  async process(): Promise<void> {
    const waiting = await withPlatformScope(
      'whatsapp: re-fetch the attachments a worker never got',
      async () => this.media.pending(100),
    );
    for (const row of waiting) {
      await this.queues.enqueue(
        QUEUES.MAINTENANCE,
        JOBS.WHATSAPP_DOWNLOAD_MEDIA,
        { organizationId: row.organizationId, aggregateId: row.messageId },
        // A fresh id each sweep: BullMQ will not accept an id it has already seen, and the row's
        // own status is what stops a second download rather than the id.
        { jobId: `whatsapp-media-${row.messageId}-sweep${newId().slice(-8)}` },
      );
    }
    if (waiting.length > 0) {
      this.logger.info({ requeued: waiting.length }, 'whatsapp attachments re-queued by the sweep');
    }
  }
}
