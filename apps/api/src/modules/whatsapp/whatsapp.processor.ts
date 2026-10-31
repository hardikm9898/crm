import { Inject, Injectable } from '@nestjs/common';
import { AppError, newId, systemPrincipal, tenantContext } from '@leados/shared';
import type { Job } from 'bullmq';
import type { Logger } from 'pino';
import { DbService } from '../../infra/db/db.service.js';
import { LOGGER } from '../../infra/observability/logger.module.js';
import { JOBS, QUEUES } from '../../infra/queue/queue.constants.js';
import type { JobProcessor } from '../../infra/queue/job-processor.js';
import type { JobPayload } from '../../infra/queue/queue.service.js';
import { WhatsAppInboundService } from './whatsapp-inbound.service.js';

/**
 * One inbound WhatsApp message, turned into a conversation and a message (`FR-WA-6`).
 *
 * Reads its subject from `payload.aggregateId` — the `provider_events` row — rather than from a
 * field inside the payload: the envelope is stable and payload bodies change, and an event queued
 * by an older release still has to process. Idempotent twice over: a ledger row already
 * `processed` is left alone, and the pipeline itself answers "already had it" rather than writing
 * a second message, because the second delivery of a message is the normal case.
 */
@Injectable()
export class WhatsAppIngestMessageProcessor implements JobProcessor {
  readonly queue = QUEUES.MAINTENANCE;
  readonly jobName = JOBS.WHATSAPP_INGEST_MESSAGE;

  constructor(
    private readonly db: DbService,
    private readonly inbound: WhatsAppInboundService,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  async process(payload: JobPayload, _job: Job): Promise<void> {
    const organizationId = payload.organizationId;
    const eventId = typeof payload['aggregateId'] === 'string' ? payload['aggregateId'] : null;
    if (!organizationId || !eventId) {
      this.logger.warn({ payload }, 'a whatsapp message job has no subject');
      return;
    }
    await this.handle(organizationId, eventId);
  }

  /** Exposed so the suite can drive the pipeline without waiting for a worker. */
  async handle(organizationId: string, eventId: string): Promise<void> {
    const row = await this.inTenant(organizationId, async () =>
      this.db.client.providerEvent.findFirst({ where: { id: eventId } }),
    );
    if (!row) {
      this.logger.warn({ eventId }, 'a whatsapp message job has no ledger row');
      return;
    }
    if (row.status === 'processed' || row.status === 'duplicate') return;

    try {
      const result = await this.inbound.ingest(
        organizationId,
        (row.raw ?? {}) as Record<string, unknown>,
        row.externalEventId,
      );
      await this.inTenant(organizationId, async () => {
        await this.db.client.providerEvent.updateMany({
          where: { id: eventId },
          data: {
            // `duplicate` when the message was already here: the row this event would have created
            // exists, which is the ledger's own word for "accepted and produced nothing new".
            status: result?.alreadyHad === true ? 'duplicate' : 'processed',
            processedAt: new Date(),
            // The **lead**, not the message: `provider_events.lead_id` is the column that answers
            // "which lead did this become", and a message id there would be a pointer into a
            // partitioned table nothing could follow. Written whenever the message landed on a
            // lead, not only when it created one — unlike the ad connectors, where an attached
            // delivery belongs to a lead that existed before it. Here the message belongs to that
            // person's conversation either way, and the row is `processed`, which is what the
            // CHECK on this column requires.
            ...(result?.alreadyHad === false && result.leadId !== null
              ? { leadId: result.leadId }
              : {}),
            attempts: { increment: 1 },
            error: null,
          },
        });
      });
    } catch (error) {
      const message = error instanceof Error ? error.message.slice(0, 500) : 'unknown error';
      await this.inTenant(organizationId, async () => {
        await this.db.client.providerEvent.updateMany({
          where: { id: eventId },
          data: { status: 'failed', error: message, attempts: { increment: 1 } },
        });
      });
      // A number that has been removed from the workspace is not worth retrying; anything else is,
      // and the retry sweep reads the row.
      if (error instanceof AppError && error.status === 404) {
        this.logger.warn(
          { eventId, err: error },
          'a whatsapp message names a number we do not have',
        );
        return;
      }
      throw error;
    }
  }

  private inTenant<T>(organizationId: string, fn: () => Promise<T>): Promise<T> {
    return tenantContext.run(systemPrincipal(organizationId, newId()), fn);
  }
}
