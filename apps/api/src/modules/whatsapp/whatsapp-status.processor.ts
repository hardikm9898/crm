import { Inject, Injectable } from '@nestjs/common';
import {
  newId,
  parseWhatsAppStatuses,
  systemPrincipal,
  tenantContext,
  withPlatformScope,
  type InboundWhatsAppStatus,
} from '@leados/shared';
import type { Job } from 'bullmq';
import type { Logger } from 'pino';
import { DbService } from '../../infra/db/db.service.js';
import { LOGGER } from '../../infra/observability/logger.module.js';
import { JOBS, QUEUES } from '../../infra/queue/queue.constants.js';
import type { JobProcessor } from '../../infra/queue/job-processor.js';
import type { JobPayload } from '../../infra/queue/queue.service.js';
import { WhatsAppStatusService } from './whatsapp-status.service.js';
import { WhatsAppTemplatesService } from './whatsapp-templates.service.js';

/**
 * One status receipt out of a stored delivery (`FR-WA-4`).
 *
 * The ledger row holds the **whole** delivery and its `external_event_id` is `<wamid>:<status>`,
 * which is what makes a redelivered receipt a duplicate rather than a second event. The receipt is
 * found again by parsing the payload, exactly as the inbound message job does: a job replayed after
 * a release parses with the code of that release.
 */
@Injectable()
export class WhatsAppIngestStatusProcessor implements JobProcessor {
  readonly queue = QUEUES.MAINTENANCE;
  readonly jobName = JOBS.WHATSAPP_INGEST_STATUS;

  constructor(
    private readonly db: DbService,
    private readonly statuses: WhatsAppStatusService,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  async process(payload: JobPayload, _job: Job): Promise<void> {
    const organizationId = payload.organizationId;
    const eventId = typeof payload['aggregateId'] === 'string' ? payload['aggregateId'] : null;
    if (!organizationId || !eventId) {
      this.logger.warn({ payload }, 'a whatsapp status job has no subject');
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
      this.logger.warn({ eventId }, 'a whatsapp status job has no ledger row');
      return;
    }
    if (row.status === 'processed' || row.status === 'duplicate') return;

    const receipt = this.receiptFor(row.raw, row.externalEventId);
    if (receipt === null) {
      await this.settle(organizationId, eventId, 'failed', 'the stored delivery no longer contains that receipt');
      return;
    }
    try {
      const applied = await this.statuses.record(organizationId, receipt);
      // `stale` and `ignored` are both honest outcomes rather than failures: a receipt that
      // overtook another, or one about a message we never sent, has been dealt with.
      await this.settle(organizationId, eventId, applied === 'applied' ? 'processed' : 'duplicate', null);
    } catch (error) {
      const message = error instanceof Error ? error.message.slice(0, 500) : 'unknown error';
      await this.settle(organizationId, eventId, 'failed', message);
      throw error;
    }
  }

  /**
   * The receipt this ledger row is about.
   *
   * The id is `<wamid>:<status>`, so a delivery carrying three receipts produces three jobs that
   * cannot read each other's receipt by accident — the same reasoning as the message pipeline's.
   */
  private receiptFor(raw: unknown, externalEventId: string): InboundWhatsAppStatus | null {
    const [providerMessageId, status] = splitEventId(externalEventId);
    return (
      parseWhatsAppStatuses((raw ?? {}) as Record<string, unknown>).find(
        (candidate) =>
          candidate.providerMessageId === providerMessageId && candidate.status === status,
      ) ?? null
    );
  }

  private async settle(
    organizationId: string,
    eventId: string,
    status: 'processed' | 'duplicate' | 'failed',
    error: string | null,
  ): Promise<void> {
    await this.inTenant(organizationId, async () => {
      await this.db.client.providerEvent.updateMany({
        where: { id: eventId },
        data: {
          status,
          ...(status === 'failed' ? { error } : { processedAt: new Date(), error: null }),
          attempts: { increment: 1 },
        },
      });
    });
  }

  private inTenant<T>(organizationId: string, fn: () => Promise<T>): Promise<T> {
    return tenantContext.run(systemPrincipal(organizationId, newId()), fn);
  }
}

/**
 * Reconciles every workspace's templates against Meta (`FR-WA-5`).
 *
 * Cross-tenant, so it reads the accounts platform-scoped and then enters each workspace's own
 * context to write — the quotation-expiry sweep's lesson, since `withPlatformScope` leaves
 * `tenantContext.organizationId()` unset and everything the sync writes is a tenant row.
 */
@Injectable()
export class WhatsAppSyncTemplatesProcessor implements JobProcessor {
  readonly queue = QUEUES.MAINTENANCE;
  readonly jobName = JOBS.WHATSAPP_SYNC_TEMPLATES;

  constructor(
    private readonly db: DbService,
    private readonly templates: WhatsAppTemplatesService,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  async process(): Promise<void> {
    // Read across tenants, written inside each one: `withPlatformScope` leaves
    // `tenantContext.organizationId()` unset, and everything the sync writes is a tenant row.
    const accounts = await withPlatformScope(
      'whatsapp: every connected account, for the template sync',
      async () =>
        this.db.client.whatsAppAccount.findMany({
          where: { status: 'connected' },
          select: { id: true, organizationId: true },
        }),
    );
    let synced = 0;
    for (const account of accounts) {
      try {
        await tenantContext.run(systemPrincipal(account.organizationId, newId()), async () => {
          await this.templates.sync(account.id);
        });
        synced += 1;
      } catch (error) {
        // One workspace's revoked token must not end the tick for everybody else.
        this.logger.warn(
          { err: error, accountId: account.id },
          'a whatsapp template sync failed for one account',
        );
      }
    }
    if (accounts.length > 0) {
      this.logger.info({ accounts: accounts.length, synced }, 'whatsapp templates reconciled');
    }
  }
}

/** `wamid.abc:read` → `['wamid.abc', 'read']`, splitting on the **last** colon. */
function splitEventId(externalEventId: string): [string, string] {
  const at = externalEventId.lastIndexOf(':');
  if (at === -1) return [externalEventId, ''];
  return [externalEventId.slice(0, at), externalEventId.slice(at + 1)];
}
