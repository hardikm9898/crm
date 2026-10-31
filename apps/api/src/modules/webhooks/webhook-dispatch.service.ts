import { Inject, Injectable } from '@nestjs/common';
import {
  MAX_CONSECUTIVE_FAILURES,
  RESPONSE_BODY_LIMIT,
  WEBHOOK_TIMEOUT_MS,
  buildWebhookPayload,
  isDeliveredStatus,
  isPermanentRejection,
  newId,
  nextAttemptAt,
  signWebhook,
  systemPrincipal,
  tenantContext,
  webhookHeaders,
  withPlatformScope,
} from '@leados/shared';
import type { Logger } from 'pino';
import { DbService } from '../../infra/db/db.service.js';
import { EncryptionService } from '../../infra/crypto/encryption.service.js';
import { LOGGER } from '../../infra/observability/logger.module.js';
import { JOBS, QUEUES } from '../../infra/queue/queue.constants.js';
import { QueueService } from '../../infra/queue/queue.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { WebhookUrlService } from './webhook-url.service.js';
import { webhookAad } from './webhooks.service.js';

/** How many due deliveries one sweep tick picks up. */
const SWEEP_BATCH = 200;

/**
 * Fan-out and delivery (`FR-API-4`, `docs/api-architecture.md` §8).
 *
 * The shape mirrors the inbound direction on purpose. There, a payload is stored **before** anything
 * is attempted so a crash cannot lose it; here, a `webhook_deliveries` row is written before the
 * first attempt, carrying the exact body that will be signed — so a worker that dies mid-send leaves
 * a row the sweep finishes rather than an event nobody was told about.
 *
 * Retries are the schedule in that row (`next_attempt_at`), not BullMQ's: the schedule reaches 24
 * hours, a delayed job is a promise held in Redis, and two retry mechanisms over one row would
 * deliver the same event three times for every failure.
 */
@Injectable()
export class WebhookDispatchService {
  constructor(
    private readonly db: DbService,
    private readonly encryption: EncryptionService,
    private readonly urls: WebhookUrlService,
    private readonly queues: QueueService,
    private readonly notifications: NotificationsService,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  /**
   * One event, aimed at the endpoints that asked for it.
   *
   * Idempotent on `(endpoint, event)`: the outbox is at-least-once, so a re-dispatched event must
   * not become a second delivery. The read is a point lookup on
   * `(organization_id, endpoint_id, event_id)` rather than an upsert, because the table's unique
   * constraint has to carry the partition key and is therefore a guard within the month rather than
   * a key you can upsert on — the same shape as `inbound_payloads`.
   */
  async fanOut(input: {
    organizationId: string;
    eventId: string;
    eventName: string;
    occurredAt?: Date;
    payload: Record<string, unknown>;
  }): Promise<{ created: number }> {
    return tenantContext.run(
      systemPrincipal(input.organizationId, newId()),
      async (): Promise<{ created: number }> => {
        const endpoints = await this.db.client.webhookEndpoint.findMany({
          where: { isActive: true, eventTypes: { has: input.eventName } },
        });
        if (endpoints.length === 0) return { created: 0 };

        const occurredAt = input.occurredAt ?? new Date();
        const body = buildWebhookPayload({
          eventId: input.eventId,
          type: input.eventName,
          occurredAt,
          organizationId: input.organizationId,
          data: input.payload,
        });

        let created = 0;
        for (const endpoint of endpoints) {
          const existing = await this.db.client.webhookDelivery.findFirst({
            where: { endpointId: endpoint.id, eventId: input.eventId },
            select: { id: true },
          });
          if (existing) continue;

          const deliveryId = newId();
          const createdAt = new Date();
          await this.db.client.webhookDelivery.create({
            data: {
              id: deliveryId,
              organizationId: input.organizationId,
              endpointId: endpoint.id,
              eventId: input.eventId,
              eventType: input.eventName,
              // The body as it will be signed, stored before the attempt: a retry sends the same
              // bytes, and the log shows what the endpoint was actually sent.
              payload: body as never,
              nextAttemptAt: createdAt,
              createdAt,
            },
          });
          await this.queues.enqueue(
            QUEUES.WEBHOOKS,
            JOBS.WEBHOOK_DELIVER,
            { organizationId: input.organizationId, aggregateId: deliveryId, attemptNo: 1 },
            { jobId: `webhook-deliver-${deliveryId}-1` },
          );
          created += 1;
        }
        return { created };
      },
    );
  }

  /**
   * One delivery to **one named** endpoint, for a workflow's `call_webhook` step (`FR-AUT-4`).
   *
   * Not `fanOut`: that answers "who subscribed to this event", and an automation step names the
   * endpoint it wants. It is the same delivery row, the same signature, the same retry schedule and
   * the same log — a second delivery path would be a second set of retry rules over one contract,
   * which is how an event ends up sent three times.
   *
   * The event type is the step's own, so an endpoint does not have to subscribe to receive what a
   * workflow was explicitly told to send it.
   */
  async deliverToEndpoint(input: {
    organizationId: string;
    endpointId: string;
    eventId: string;
    eventName: string;
    payload: Record<string, unknown>;
  }): Promise<{ created: number }> {
    return tenantContext.run(
      systemPrincipal(input.organizationId, newId()),
      async (): Promise<{ created: number }> => {
        const endpoint = await this.db.client.webhookEndpoint.findFirst({
          where: { id: input.endpointId, isActive: true },
          select: { id: true },
        });
        if (endpoint === null) return { created: 0 };

        // Idempotent on the step's own key, exactly as the fan-out is on the event's: a retried
        // job must not deliver twice.
        const existing = await this.db.client.webhookDelivery.findFirst({
          where: { endpointId: endpoint.id, eventId: input.eventId },
          select: { id: true },
        });
        if (existing) return { created: 0 };

        const occurredAt = new Date();
        const body = buildWebhookPayload({
          eventId: input.eventId,
          type: input.eventName,
          occurredAt,
          organizationId: input.organizationId,
          data: input.payload,
        });
        const deliveryId = newId();
        await this.db.client.webhookDelivery.create({
          data: {
            id: deliveryId,
            organizationId: input.organizationId,
            endpointId: endpoint.id,
            eventId: input.eventId,
            eventType: input.eventName,
            payload: body as never,
            nextAttemptAt: occurredAt,
            createdAt: occurredAt,
          },
        });
        await this.queues.enqueue(
          QUEUES.WEBHOOKS,
          JOBS.WEBHOOK_DELIVER,
          { organizationId: input.organizationId, aggregateId: deliveryId, attemptNo: 1 },
          { jobId: `webhook-deliver-${deliveryId}-1` },
        );
        return { created: 1 };
      },
    );
  }

  /**
   * One attempt at one delivery.
   *
   * Everything about the outcome is written whatever happens: the attempt row, the delivery's
   * status, the endpoint's consecutive-failure count. A send with no record is a send nobody can
   * count, which is the lesson the double verification email paid for.
   */
  async deliver(organizationId: string, deliveryId: string): Promise<void> {
    await tenantContext.run(systemPrincipal(organizationId, newId()), async () => {
      const delivery = await this.db.client.webhookDelivery.findFirst({
        where: { id: deliveryId },
        include: { endpoint: true },
      });
      if (!delivery) {
        this.logger.warn({ deliveryId }, 'webhook delivery vanished before it could be sent');
        return;
      }
      if (delivery.status === 'succeeded') return;

      const endpoint = delivery.endpoint;
      if (!endpoint.isActive) {
        // Switched off (or auto-disabled) after this was queued. Finishing it quietly would post to
        // an endpoint the workspace has stopped, so it is marked spent with the reason said out loud.
        await this.finish(deliveryId, {
          status: 'exhausted',
          // Not attempted, and the count says so: `attempt_count` is what happened, and this
          // delivery was abandoned rather than tried.
          attemptCount: delivery.attemptCount,
          lastError: 'The endpoint was switched off before this could be delivered.',
        });
        return;
      }

      const attemptNo = delivery.attemptCount + 1;
      const timestamp = Math.floor(Date.now() / 1000);
      const rawBody = JSON.stringify(delivery.payload);

      // Re-checked **per attempt**: a hostname that resolved publicly when the endpoint was saved
      // can resolve to 127.0.0.1 now, which is DNS rebinding and the whole reason this is not a
      // save-time-only check.
      const refusal = await this.urls.refusalFor(endpoint.url);
      if (refusal !== null) {
        await this.recordAttempt({
          organizationId,
          delivery,
          attemptNo,
          durationMs: 0,
          error: refusal,
        });
        await this.afterFailure(delivery, attemptNo, { error: refusal });
        return;
      }

      const secret = this.encryption.decrypt(endpoint.secretEncrypted, webhookAad(endpoint.id));
      const startedAt = Date.now();
      let statusCode: number | null = null;
      let responseBody: string | null = null;
      let error: string | null = null;

      try {
        const response = await fetch(endpoint.url, {
          method: 'POST',
          headers: webhookHeaders({
            eventType: delivery.eventType,
            eventId: delivery.eventId,
            deliveryId: delivery.id,
            timestamp,
            signature: signWebhook(secret, timestamp, rawBody),
          }),
          body: rawBody,
          // **Never** followed: a redirect is not an acknowledgement, and following one sends a
          // signed payload to an address the SSRF check never saw.
          redirect: 'manual',
          signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
        });
        statusCode = response.status;
        responseBody = (await response.text().catch(() => '')).slice(0, RESPONSE_BODY_LIMIT);
      } catch (cause) {
        error =
          cause instanceof Error
            ? cause.name === 'TimeoutError' || cause.name === 'AbortError'
              ? `No answer within ${WEBHOOK_TIMEOUT_MS / 1_000} seconds.`
              : cause.message.slice(0, 500)
            : 'The request failed.';
      }

      const durationMs = Date.now() - startedAt;
      await this.recordAttempt({
        organizationId,
        delivery,
        attemptNo,
        durationMs,
        statusCode,
        responseBody,
        error,
      });

      if (statusCode !== null && isDeliveredStatus(statusCode)) {
        await this.finish(deliveryId, {
          status: 'succeeded',
          attemptCount: attemptNo,
          statusCode,
          responseBody,
        });
        await this.db.client.webhookEndpoint.update({
          where: { id: endpoint.id },
          // Reset, not decremented: the threshold is **consecutive** failures, so one success
          // means the endpoint is simply flaky rather than gone.
          data: { failureCount: 0, lastSuccessAt: new Date(), lastStatusCode: statusCode },
        });
        return;
      }

      await this.afterFailure(delivery, attemptNo, {
        statusCode: statusCode ?? undefined,
        responseBody: responseBody ?? undefined,
        error: error ?? undefined,
      });
    });
  }

  /**
   * The deliveries whose next attempt is due, across every workspace.
   *
   * Read under `withPlatformScope` and then **delivered inside each tenant's own context**: the
   * quotation expiry sweep paid for that distinction, where a cross-tenant read followed by a
   * tenant-scoped write threw on its first row.
   */
  async sweepDue(now = new Date()): Promise<number> {
    const due = await withPlatformScope('webhooks: sweep due deliveries', async () =>
      this.db.client.webhookDelivery.findMany({
        where: { status: { in: ['pending', 'failed'] }, nextAttemptAt: { lte: now } },
        orderBy: { nextAttemptAt: 'asc' },
        take: SWEEP_BATCH,
        select: { id: true, organizationId: true, attemptCount: true },
      }),
    );

    for (const row of due) {
      await this.queues.enqueue(
        QUEUES.WEBHOOKS,
        JOBS.WEBHOOK_DELIVER,
        {
          organizationId: row.organizationId,
          aggregateId: row.id,
          attemptNo: row.attemptCount + 1,
        },
        { jobId: `webhook-deliver-${row.id}-${row.attemptCount + 1}` },
      );
    }
    return due.length;
  }

  // ── Writing down what happened ────────────────────────────────────────────

  private async recordAttempt(input: {
    organizationId: string;
    delivery: { id: string; createdAt: Date };
    attemptNo: number;
    durationMs: number;
    statusCode?: number | null;
    responseBody?: string | null;
    error?: string | null;
  }): Promise<void> {
    try {
      await this.db.client.webhookAttempt.create({
        data: {
          id: newId(),
          organizationId: input.organizationId,
          deliveryId: input.delivery.id,
          // The parent's own instant: the composite FK spans three columns because the parent is
          // partitioned, which is why the service is the only thing that writes `created_at`.
          deliveryCreatedAt: input.delivery.createdAt,
          attemptNo: input.attemptNo,
          statusCode: input.statusCode ?? null,
          durationMs: input.durationMs,
          responseBody: input.responseBody ?? null,
          // A CHECK refuses an attempt with neither a status code nor a reason, so an attempt that
          // somehow has neither is recorded as what it is: unexplained.
          error:
            input.error ?? (input.statusCode === null ? 'No answer, and no reason given.' : null),
        },
      });
    } catch (cause) {
      // A recorder of outcomes must not fail the thing it is recording — the lesson
      // `IngestionService.recordFailure` paid for, where its own throw replaced the real error.
      this.logger.error(
        { err: cause, deliveryId: input.delivery.id, attemptNo: input.attemptNo },
        'could not record a webhook attempt; the delivery outcome still stands',
      );
    }
  }

  /** The delivery's own row, keyed on the id alone (the partition-key precision trap). */
  private async finish(
    deliveryId: string,
    outcome: {
      status: 'succeeded' | 'exhausted';
      /** What happened, not what was hoped: the attempt this outcome belongs to. */
      attemptCount: number;
      statusCode?: number | null;
      responseBody?: string | null;
      lastError?: string | null;
    },
  ): Promise<void> {
    await this.db.client.webhookDelivery.updateMany({
      where: { id: deliveryId },
      data: {
        status: outcome.status,
        attemptCount: outcome.attemptCount,
        // A finished delivery has nothing due, which a CHECK enforces: an `exhausted` row with a
        // `next_attempt_at` would be swept forever.
        nextAttemptAt: null,
        ...(outcome.status === 'succeeded' ? { deliveredAt: new Date() } : {}),
        ...(outcome.statusCode !== undefined ? { lastStatusCode: outcome.statusCode } : {}),
        ...(outcome.responseBody !== undefined ? { lastResponseBody: outcome.responseBody } : {}),
        ...(outcome.lastError !== undefined ? { lastError: outcome.lastError } : {}),
      },
    });
  }

  private async afterFailure(
    delivery: {
      id: string;
      organizationId: string;
      endpointId: string;
      eventType: string;
      createdAt: Date;
    },
    attemptNo: number,
    outcome: { statusCode?: number; responseBody?: string; error?: string },
  ): Promise<void> {
    const due = nextAttemptAt(attemptNo);
    const spent = due === null;

    await this.db.client.webhookDelivery.updateMany({
      where: { id: delivery.id },
      data: {
        status: spent ? 'exhausted' : 'failed',
        attemptCount: attemptNo,
        nextAttemptAt: due,
        lastStatusCode: outcome.statusCode ?? null,
        lastResponseBody: outcome.responseBody ?? null,
        lastError: outcome.error ?? null,
      },
    });

    const endpoint = await this.db.client.webhookEndpoint.update({
      where: { id: delivery.endpointId },
      data: {
        failureCount: { increment: 1 },
        lastFailureAt: new Date(),
        lastStatusCode: outcome.statusCode ?? null,
      },
    });

    // `410 Gone` is the one answer that means "stop, permanently": a 404 is a deployment that has
    // not finished and a 500 is a bad afternoon, and disabling on either would cost a workspace its
    // integration over a blip.
    if (outcome.statusCode !== undefined && isPermanentRejection(outcome.statusCode)) {
      await this.disable(
        endpoint,
        'Your endpoint answered 410 Gone, which means "stop sending". Switch it back on when it is ready.',
      );
      return;
    }
    if (endpoint.failureCount >= MAX_CONSECUTIVE_FAILURES && endpoint.isActive) {
      await this.disable(
        endpoint,
        `${endpoint.failureCount} deliveries failed in a row, so we stopped sending. Fix the endpoint and switch it back on.`,
      );
    }
  }

  /**
   * Switching an endpoint off, and **telling somebody** (`FR-API-4`'s failure alert).
   *
   * An auto-disabled endpoint means the workspace's integration has stopped receiving everything,
   * silently, which is exactly the shape of failure a notification exists for — and the type is not
   * opt-out, because the person who would have to fix it is the one who would have switched the
   * notice off.
   */
  private async disable(
    endpoint: { id: string; organizationId: string; url: string },
    reason: string,
  ): Promise<void> {
    await this.db.client.webhookEndpoint.update({
      where: { id: endpoint.id },
      // All three together: a CHECK refuses an endpoint that is disabled without a reason.
      data: { isActive: false, disabledAt: new Date(), disabledReason: reason },
    });

    const recipients = await this.notifications.recipientsWithPermission(
      endpoint.organizationId,
      'webhook:manage',
    );
    for (const userId of recipients) {
      await this.notifications.create({
        organizationId: endpoint.organizationId,
        userId,
        type: 'webhook.disabled',
        title: 'We stopped sending to one of your integrations',
        body: `${endpoint.url} — ${reason}`,
        link: '/settings/webhooks',
        // One notification per endpoint per disabling, whatever re-delivers the job.
        dedupeKey: `webhook-disabled:${endpoint.id}:${new Date().toISOString().slice(0, 10)}`,
      });
    }
    this.logger.warn(
      { endpointId: endpoint.id, organizationId: endpoint.organizationId, reason },
      'webhook endpoint auto-disabled',
    );
  }
}
