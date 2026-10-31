import { Injectable } from '@nestjs/common';
import {
  AppError,
  WEBHOOK_TEST_EVENT,
  buildWebhookPayload,
  generateWebhookSecret,
  newId,
  tenantContext,
  type WebhookEventType,
} from '@leados/shared';
import { DbService } from '../../infra/db/db.service.js';
import { AuditService } from '../../infra/audit/audit.service.js';
import { EncryptionService } from '../../infra/crypto/encryption.service.js';
import { JOBS, QUEUES } from '../../infra/queue/queue.constants.js';
import { QueueService } from '../../infra/queue/queue.service.js';
import { WebhookUrlService } from './webhook-url.service.js';
import type {
  CreateWebhookEndpointInput,
  ListDeliveriesQuery,
  UpdateWebhookEndpointInput,
} from './webhooks.dto.js';

/** The AAD binding a signing secret's ciphertext to its own endpoint row. */
export function webhookAad(endpointId: string): string {
  return `webhook:${endpointId}`;
}

/**
 * Endpoints, and the log of what we sent them (`FR-API-4`).
 *
 * Three decisions worth stating:
 *
 *  * **The secret is answered exactly once**, by `create` and `rotateSecret`. It is stored encrypted
 *    rather than hashed because signing needs it — ADR-0030's lesson in the other direction — and no
 *    endpoint reads it back: "I lost it" is answered by rotating, which is also the honest answer to
 *    "it may have leaked".
 *  * **Re-enabling clears the failure count.** An endpoint switched back on with fourteen failures
 *    still against it would disable itself again on the next bad afternoon, which reads as the
 *    product refusing to be fixed.
 *  * **Deleting an endpoint takes its delivery log with it** (the FK cascades). The log is a record
 *    of what we sent *that endpoint*; keeping it after the endpoint is gone would leave rows nothing
 *    can be read against, and the alternative — refusing the delete — makes a mistyped URL
 *    permanent.
 */
@Injectable()
export class WebhooksService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly encryption: EncryptionService,
    private readonly urls: WebhookUrlService,
    private readonly queues: QueueService,
  ) {}

  async list() {
    const rows = await this.db.client.webhookEndpoint.findMany({
      orderBy: [{ createdAt: 'desc' }],
      take: 100,
    });
    return { items: rows.map((row) => this.present(row)), pagination: null };
  }

  async findOne(id: string) {
    const row = await this.db.client.webhookEndpoint.findFirst({ where: { id } });
    if (!row) throw AppError.notFound('Endpoint');
    return this.present(row);
  }

  async create(input: CreateWebhookEndpointInput) {
    const principal = tenantContext.require('webhooks.create');
    this.urls.assertStorable(input.url);

    const secret = generateWebhookSecret();
    const id = newId();
    await this.db.client.$transaction(async (tx) => {
      await tx.webhookEndpoint.create({
        data: {
          id,
          organizationId: principal.organizationId,
          url: input.url,
          description: input.description ?? null,
          secretEncrypted: this.encryption.encrypt(secret, webhookAad(id)),
          eventTypes: input.eventTypes,
          createdById: principal.actorId ?? null,
        },
      });
      await this.audit.recordInTransaction(tx, {
        action: 'webhook_endpoint.created',
        resourceType: 'webhook_endpoint',
        resourceId: id,
        // The URL and the events, never the secret: an audit log is read by more people.
        after: { url: input.url, eventTypes: input.eventTypes },
      });
    });

    return {
      ...(await this.findOne(id)),
      secret,
      // Said in the payload as well as in the message, because "shown once" has to be unmistakable.
      secretShownOnce: true as const,
    };
  }

  async update(id: string, input: UpdateWebhookEndpointInput) {
    const existing = await this.db.client.webhookEndpoint.findFirst({ where: { id } });
    if (!existing) throw AppError.notFound('Endpoint');
    if (input.url !== undefined && input.url !== existing.url) this.urls.assertStorable(input.url);

    const reviving = input.isActive === true && !existing.isActive;
    await this.db.client.$transaction(async (tx) => {
      await tx.webhookEndpoint.update({
        where: { id },
        data: {
          ...(input.url !== undefined ? { url: input.url } : {}),
          ...(input.description !== undefined ? { description: input.description } : {}),
          ...(input.eventTypes !== undefined ? { eventTypes: input.eventTypes } : {}),
          ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
          // `disabled_at` and `disabled_reason` are written together with `is_active = false`, and
          // a CHECK refuses half of it — so switching on clears both.
          ...(reviving ? { failureCount: 0, disabledAt: null, disabledReason: null } : {}),
          ...(input.isActive === false
            ? { disabledAt: new Date(), disabledReason: 'Switched off by the workspace' }
            : {}),
        },
      });
      await this.audit.recordInTransaction(tx, {
        action: input.isActive === false ? 'webhook_endpoint.disabled' : 'webhook_endpoint.updated',
        resourceType: 'webhook_endpoint',
        resourceId: id,
        before: { url: existing.url, eventTypes: existing.eventTypes, isActive: existing.isActive },
        after: input as Record<string, unknown>,
      });
    });
    return this.findOne(id);
  }

  /** A new secret for the same endpoint. The old one stops verifying the moment this returns. */
  async rotateSecret(id: string) {
    const existing = await this.db.client.webhookEndpoint.findFirst({ where: { id } });
    if (!existing) throw AppError.notFound('Endpoint');

    const secret = generateWebhookSecret();
    await this.db.client.$transaction(async (tx) => {
      await tx.webhookEndpoint.update({
        where: { id },
        data: { secretEncrypted: this.encryption.encrypt(secret, webhookAad(id)) },
      });
      await this.audit.recordInTransaction(tx, {
        action: 'webhook_endpoint.secret_rotated',
        resourceType: 'webhook_endpoint',
        resourceId: id,
      });
    });
    return { ...(await this.findOne(id)), secret, secretShownOnce: true as const };
  }

  async remove(id: string) {
    const existing = await this.db.client.webhookEndpoint.findFirst({ where: { id } });
    if (!existing) throw AppError.notFound('Endpoint');
    await this.db.client.$transaction(async (tx) => {
      await tx.webhookEndpoint.delete({ where: { id } });
      await this.audit.recordInTransaction(tx, {
        action: 'webhook_endpoint.deleted',
        resourceType: 'webhook_endpoint',
        resourceId: id,
        before: { url: existing.url, eventTypes: existing.eventTypes },
      });
    });
    return { id, deleted: true };
  }

  // ── The delivery log ──────────────────────────────────────────────────────

  async deliveries(query: ListDeliveriesQuery) {
    const where = {
      ...(query.endpointId ? { endpointId: query.endpointId } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.eventType ? { eventType: query.eventType } : {}),
    };
    const [total, rows] = await Promise.all([
      this.db.client.webhookDelivery.count({ where }),
      this.db.client.webhookDelivery.findMany({
        where,
        // Both halves of the key: a cursor over a partitioned table that carries only the id
        // selects the wrong page, which is the `activities` lesson.
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: query.limit + 1,
        include: {
          endpoint: { select: { id: true, url: true, description: true } },
          attempts: { orderBy: { attemptNo: 'desc' }, take: 5 },
        },
      }),
    ]);
    const page = rows.slice(0, query.limit);
    return {
      items: page.map((row) => ({
        id: row.id,
        endpoint: row.endpoint,
        eventId: row.eventId,
        eventType: row.eventType,
        status: row.status,
        attemptCount: row.attemptCount,
        nextAttemptAt: row.nextAttemptAt,
        lastStatusCode: row.lastStatusCode,
        lastResponseBody: row.lastResponseBody,
        lastError: row.lastError,
        deliveredAt: row.deliveredAt,
        createdAt: row.createdAt,
        payload: row.payload,
        attempts: row.attempts.map((attempt) => ({
          attemptNo: attempt.attemptNo,
          statusCode: attempt.statusCode,
          durationMs: attempt.durationMs,
          responseBody: attempt.responseBody,
          error: attempt.error,
          attemptedAt: attempt.attemptedAt,
        })),
      })),
      pagination: {
        limit: query.limit,
        nextCursor: rows.length > query.limit ? (page.at(-1)?.id ?? null) : null,
        hasMore: rows.length > query.limit,
        total,
      },
    };
  }

  /**
   * Sends it again, now (`FR-API-4`'s manual retry).
   *
   * Allowed from any state, including `succeeded`: "send me that one again" is a thing an
   * integrator asks for while rebuilding their own database, and the consumer is told to deduplicate
   * on the event id anyway. The attempt count keeps rising rather than resetting, because the log
   * is a record of what happened and not of what somebody wishes had.
   */
  async retry(id: string) {
    const row = await this.db.client.webhookDelivery.findFirst({ where: { id } });
    if (!row) throw AppError.notFound('Delivery');
    const endpoint = await this.db.client.webhookEndpoint.findFirst({
      where: { id: row.endpointId },
    });
    if (!endpoint) throw AppError.notFound('Endpoint');
    if (!endpoint.isActive) {
      throw AppError.businessRule(
        'That endpoint is switched off. Switch it back on first, or nothing will be sent.',
      );
    }

    await this.db.client.webhookDelivery.updateMany({
      where: { id },
      // `failed`, not `pending`: `pending` means "never attempted", which a CHECK enforces.
      data: { status: 'failed', nextAttemptAt: new Date(), deliveredAt: null },
    });
    await this.enqueueDelivery(row.organizationId, row.id, row.attemptCount + 1);
    return { id: row.id, status: 'queued' as const };
  }

  /**
   * The ping (`FR-API-4`'s "is this wired up at all").
   *
   * A real delivery with the reserved `webhook.test` type: it is signed the same way, logged the
   * same way, and retried the same way, because a test that took a different path would be a test
   * of the wrong thing. The endpoint receives it whether or not it subscribed to anything.
   */
  async sendTest(id: string) {
    const endpoint = await this.db.client.webhookEndpoint.findFirst({ where: { id } });
    if (!endpoint) throw AppError.notFound('Endpoint');
    if (!endpoint.isActive) {
      throw AppError.businessRule('That endpoint is switched off, so nothing would be sent.');
    }

    const deliveryId = newId();
    const eventId = newId();
    const createdAt = new Date();
    await this.db.client.webhookDelivery.create({
      data: {
        id: deliveryId,
        organizationId: endpoint.organizationId,
        endpointId: endpoint.id,
        eventId,
        eventType: WEBHOOK_TEST_EVENT,
        payload: buildWebhookPayload({
          eventId,
          type: WEBHOOK_TEST_EVENT,
          occurredAt: createdAt,
          organizationId: endpoint.organizationId,
          data: {
            message: 'This is a test delivery from Lead OS. Nothing in your workspace changed.',
          },
        }) as never,
        nextAttemptAt: createdAt,
        // Written by the service, never left to the column default: it is half of the primary key
        // of a partitioned table, and a microsecond instant is one a `Date` cannot write back.
        createdAt,
      },
    });
    await this.enqueueDelivery(endpoint.organizationId, deliveryId, 1);
    return { deliveryId, status: 'queued' as const };
  }

  private async enqueueDelivery(
    organizationId: string,
    deliveryId: string,
    attemptNo: number,
  ): Promise<void> {
    await this.queues.enqueue(
      QUEUES.WEBHOOKS,
      JOBS.WEBHOOK_DELIVER,
      { organizationId, aggregateId: deliveryId, attemptNo },
      // The attempt number is in the job id, so the same attempt cannot be queued twice while a
      // different attempt still can. BullMQ rejects ':' in a custom id.
      { jobId: `webhook-deliver-${deliveryId}-${attemptNo}` },
    );
  }

  private present(row: {
    id: string;
    url: string;
    description: string | null;
    eventTypes: string[];
    isActive: boolean;
    failureCount: number;
    lastSuccessAt: Date | null;
    lastFailureAt: Date | null;
    lastStatusCode: number | null;
    disabledAt: Date | null;
    disabledReason: string | null;
    createdAt: Date;
  }) {
    return {
      id: row.id,
      url: row.url,
      description: row.description,
      eventTypes: row.eventTypes as WebhookEventType[],
      isActive: row.isActive,
      failureCount: row.failureCount,
      lastSuccessAt: row.lastSuccessAt,
      lastFailureAt: row.lastFailureAt,
      lastStatusCode: row.lastStatusCode,
      disabledAt: row.disabledAt,
      disabledReason: row.disabledReason,
      createdAt: row.createdAt,
    };
  }
}
