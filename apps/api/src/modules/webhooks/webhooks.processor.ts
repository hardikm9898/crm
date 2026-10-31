import { Inject, Injectable } from '@nestjs/common';
import type { Job } from 'bullmq';
import type { Logger } from 'pino';
import { LOGGER } from '../../infra/observability/logger.module.js';
import { JOBS, QUEUES } from '../../infra/queue/queue.constants.js';
import type { JobProcessor } from '../../infra/queue/job-processor.js';
import type { JobPayload } from '../../infra/queue/queue.service.js';
import { WebhookDispatchService } from './webhook-dispatch.service.js';

/**
 * One event, fanned out to the endpoints that asked for it (`FR-API-4`).
 *
 * Reads its subject from the envelope (`eventId`, `eventName`), not from inside `payload`: the
 * envelope is stable and payload bodies change, and an event emitted by an older release still has
 * to fan out.
 */
@Injectable()
export class WebhookFanoutProcessor implements JobProcessor {
  readonly queue = QUEUES.WEBHOOKS;
  readonly jobName = JOBS.WEBHOOK_FANOUT;

  constructor(
    private readonly dispatch: WebhookDispatchService,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  async process(payload: JobPayload, _job: Job): Promise<void> {
    const organizationId = payload.organizationId;
    const eventId = typeof payload['eventId'] === 'string' ? payload['eventId'] : null;
    const eventName = typeof payload['eventName'] === 'string' ? payload['eventName'] : null;
    // A platform-scoped event (there are none today that webhooks carry) has no workspace to
    // deliver for, and an envelope missing its own identity is a bug worth seeing rather than a
    // silent no-op.
    if (!organizationId || !eventId || !eventName) {
      this.logger.warn({ payload }, 'webhook fan-out skipped: no workspace or no event identity');
      return;
    }

    const result = await this.dispatch.fanOut({
      organizationId,
      eventId,
      eventName,
      payload: (payload['payload'] ?? {}) as Record<string, unknown>,
    });
    if (result.created > 0) {
      this.logger.debug({ eventName, deliveries: result.created }, 'webhook deliveries created');
    }
  }
}

/** One attempt at one delivery. Idempotent: a delivery that already succeeded is left alone. */
@Injectable()
export class WebhookDeliverProcessor implements JobProcessor {
  readonly queue = QUEUES.WEBHOOKS;
  readonly jobName = JOBS.WEBHOOK_DELIVER;

  constructor(
    private readonly dispatch: WebhookDispatchService,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  async process(payload: JobPayload, _job: Job): Promise<void> {
    const organizationId = payload.organizationId;
    const deliveryId = typeof payload['aggregateId'] === 'string' ? payload['aggregateId'] : null;
    if (!organizationId || !deliveryId) {
      this.logger.warn({ payload }, 'webhook delivery job has no subject');
      return;
    }
    await this.dispatch.deliver(organizationId, deliveryId);
  }
}

/**
 * Enqueues the deliveries whose next attempt is due (`maintenance.webhook-retry`).
 *
 * Every minute, because the first retry is ten seconds out: a five-minute sweep would make
 * "retried at 10 s" into "retried at five minutes", which is a different promise. The work is one
 * indexed read of the due set (`webhook_deliveries_due`).
 */
@Injectable()
export class WebhookRetrySweepProcessor implements JobProcessor {
  readonly queue = QUEUES.WEBHOOKS;
  readonly jobName = JOBS.WEBHOOK_RETRY_SWEEP;

  constructor(
    private readonly dispatch: WebhookDispatchService,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  async process(_payload: JobPayload, _job: Job): Promise<void> {
    const queued = await this.dispatch.sweepDue();
    if (queued > 0) this.logger.debug({ queued }, 'webhook deliveries due and queued');
  }
}
