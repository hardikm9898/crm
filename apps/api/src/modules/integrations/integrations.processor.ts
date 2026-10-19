import { Inject, Injectable } from '@nestjs/common';
import type { Job } from 'bullmq';
import type { Logger } from 'pino';
import { LOGGER } from '../../infra/observability/logger.module.js';
import { JOBS, QUEUES } from '../../infra/queue/queue.constants.js';
import type { JobProcessor } from '../../infra/queue/job-processor.js';
import type { JobPayload } from '../../infra/queue/queue.service.js';
import { IntegrationHealthService } from './integration-health.service.js';
import { IntegrationInboundService } from './integration-inbound.service.js';

/**
 * Every connection whose provider asks to be probed, probed (`integration.health-check`).
 *
 * On `maintenance` with the other platform-wide sweeps, and every ten minutes rather than every
 * minute: the cadence a provider declares is the cadence it is probed at, and a sweep that ran
 * every minute would reach a hundred workspaces a hundred times an hour for an answer that changes
 * once a quarter. Due-ness is computed inside the service from each provider's own
 * `probeEveryMinutes`, so the schedule here is only "how often we look".
 *
 * It is a **sweep over a durable state**, not a set of delayed jobs — the same argument the webhook
 * retry sweep makes: a connection's last check is a row, and a tick that is missed because a worker
 * was restarting costs ten minutes rather than a probe that never happens.
 */
@Injectable()
export class IntegrationHealthCheckProcessor implements JobProcessor {
  readonly queue = QUEUES.MAINTENANCE;
  readonly jobName = JOBS.INTEGRATION_HEALTH_CHECK;

  constructor(
    private readonly health: IntegrationHealthService,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  async process(_payload: JobPayload, _job: Job): Promise<void> {
    const result = await this.health.sweep();
    if (result.probed > 0) {
      this.logger.debug(result, 'integration connections probed');
    }
    if (result.revoked > 0) {
      // Worth a line at `warn`: a credential that has just been refused is somebody's email or
      // lead capture stopping, and the notification that says so is the only other trace.
      this.logger.warn({ revoked: result.revoked }, 'integration credentials were refused');
    }
  }
}

/**
 * One provider event, turned into a lead.
 *
 * Reads its subject from `payload.aggregateId`, not from a field inside the payload: the envelope
 * is stable and payload bodies change, and an event queued by an older release still has to
 * process. Idempotent on the ledger row — a row that is already `processed` is left alone — which
 * is what makes an at-least-once queue safe over the one guarantee this step exists for.
 */
@Injectable()
export class IntegrationIngestEventProcessor implements JobProcessor {
  readonly queue = QUEUES.MAINTENANCE;
  readonly jobName = JOBS.INTEGRATION_INGEST_EVENT;

  constructor(
    private readonly inbound: IntegrationInboundService,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  async process(payload: JobPayload, _job: Job): Promise<void> {
    const organizationId = payload.organizationId;
    const eventId = typeof payload['aggregateId'] === 'string' ? payload['aggregateId'] : null;
    if (!organizationId || !eventId) {
      this.logger.warn({ payload }, 'a provider event job has no subject');
      return;
    }
    await this.inbound.ingest(organizationId, eventId);
  }
}

/** The provider events that have not become leads, re-queued (`maintenance.integration-retry`). */
@Injectable()
export class IntegrationRetrySweepProcessor implements JobProcessor {
  readonly queue = QUEUES.MAINTENANCE;
  readonly jobName = JOBS.INTEGRATION_RETRY_SWEEP;

  constructor(
    private readonly inbound: IntegrationInboundService,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  async process(_payload: JobPayload, _job: Job): Promise<void> {
    const queued = await this.inbound.sweepUnresolved();
    if (queued > 0) this.logger.debug({ queued }, 'provider events re-queued');
  }
}
