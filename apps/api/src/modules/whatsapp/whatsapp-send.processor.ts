import { Inject, Injectable } from '@nestjs/common';
import {
  ACTIVITY_TYPES,
  newId,
  systemPrincipal,
  tenantContext,
  withPlatformScope,
  type MessageType,
} from '@leados/shared';
import type { Job } from 'bullmq';
import type { Logger } from 'pino';
import { DbService } from '../../infra/db/db.service.js';
import { LOGGER } from '../../infra/observability/logger.module.js';
import { JOBS, QUEUES } from '../../infra/queue/queue.constants.js';
import type { JobProcessor } from '../../infra/queue/job-processor.js';
import type { JobPayload } from '../../infra/queue/queue.service.js';
import { QueueService } from '../../infra/queue/queue.service.js';
import { TimelineService } from '../../infra/timeline/timeline.service.js';
import { IntegrationsService } from '../integrations/integrations.service.js';
import { WhatsAppCloudAdapter } from '../integrations/adapters/whatsapp-cloud.adapter.js';
import { WhatsAppRateLimiter } from './whatsapp-rate-limiter.service.js';
import { WhatsAppStatusService } from './whatsapp-status.service.js';
import { deterministicEventId } from './whatsapp-ids.js';

/** How many times a message is handed to Meta before it is called failed. */
const MAX_SEND_ATTEMPTS = 5;

/**
 * One queued message, handed to Meta (`FR-WA-9`).
 *
 * The decisions worth knowing:
 *
 *  * **A retryable failure leaves the message `queued`**, counts the attempt and re-queues with a
 *    delay. A permanent one marks it `failed` with Meta's own sentence. The difference is the
 *    adapter's `retryable`, and it is the difference between "it is still on its way" and "somebody
 *    has to do something" — which is the whole of `FR-WA-9`'s "never silent".
 *  * **Rate limiting is checked here**, because this is the only place sends are serialised. Over
 *    the limit is not a failure: the job comes back in the next second, and the attempt is not
 *    counted against the message.
 *  * **`accepted`, not `sent`.** Meta taking the message means it is queued at Meta; the `sent`
 *    receipt is what says it left. Writing `sent` here would make every message look delivered to
 *    an agent whose customer has a flat battery.
 */
@Injectable()
export class WhatsAppSendMessageProcessor implements JobProcessor {
  readonly queue = QUEUES.MAINTENANCE;
  readonly jobName = JOBS.WHATSAPP_SEND_MESSAGE;

  constructor(
    private readonly db: DbService,
    private readonly integrations: IntegrationsService,
    private readonly adapter: WhatsAppCloudAdapter,
    private readonly limiter: WhatsAppRateLimiter,
    private readonly timeline: TimelineService,
    private readonly status: WhatsAppStatusService,
    private readonly queues: QueueService,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  async process(payload: JobPayload, _job: Job): Promise<void> {
    const organizationId = payload.organizationId;
    const messageId = typeof payload['aggregateId'] === 'string' ? payload['aggregateId'] : null;
    if (!organizationId || !messageId) {
      this.logger.warn({ payload }, 'a whatsapp send job has no subject');
      return;
    }
    await this.handle(organizationId, messageId);
  }

  /** Exposed so the suite can drive a send without waiting for a worker. */
  async handle(organizationId: string, messageId: string): Promise<void> {
    const prepared = await this.inTenant(organizationId, async () =>
      this.db.client.message.findFirst({
        where: { id: messageId, direction: 'outbound' },
        select: {
          id: true,
          createdAt: true,
          status: true,
          type: true,
          body: true,
          payload: true,
          senderUserId: true,
          sendAttempts: true,
          templateId: true,
          conversation: {
            select: {
              id: true,
              leadId: true,
              contactE164: true,
              number: { select: { phoneNumberId: true, accountId: true, isActive: true } },
            },
          },
        },
      }),
    );
    if (!prepared) {
      this.logger.warn({ messageId }, 'a whatsapp send job names a message that is not there');
      return;
    }
    // Already sent, already failed, or already accepted: at-least-once delivery means this job can
    // arrive twice, and the second one must not send the message again.
    if (prepared.status !== 'queued') return;

    const number = prepared.conversation.number;
    const to = prepared.conversation.contactE164;
    if (number === null || !number.isActive || to === null) {
      await this.fail(organizationId, prepared, {
        code: 'NUMBER_UNAVAILABLE',
        message:
          'The number this conversation belongs to is no longer connected, so this message cannot be sent.',
      });
      return;
    }

    const allowance = await this.limiter.take(number.phoneNumberId);
    if (!allowance.allowed) {
      // Not an attempt: the message has not been handed to anybody. Re-queued with a fresh id,
      // because BullMQ will not accept the same custom id twice.
      await this.queues.enqueue(
        QUEUES.MAINTENANCE,
        JOBS.WHATSAPP_SEND_MESSAGE,
        { organizationId, aggregateId: messageId },
        { jobId: `whatsapp-send-${messageId}-r${Date.now()}`, delayMs: allowance.retryInMs },
      );
      return;
    }

    const account = await this.inTenant(organizationId, async () =>
      this.db.client.whatsAppAccount.findFirst({
        where: { id: number.accountId },
        select: { integrationConnectionId: true },
      }),
    );
    if (!account) {
      await this.fail(organizationId, prepared, {
        code: 'ACCOUNT_UNAVAILABLE',
        message: 'The WhatsApp account this number belongs to is no longer connected.',
      });
      return;
    }

    const connection = await this.inTenant(organizationId, async () =>
      this.integrations.openForSending('whatsapp_cloud', account.integrationConnectionId),
    );
    const body = sendBody(prepared.type as MessageType, prepared.payload, prepared.body);
    const outcome = await this.adapter.sendMessage(
      {
        connectionId: connection.connectionId,
        organizationId,
        secrets: connection.secrets,
        settings: connection.settings,
        externalAccountId: connection.externalAccountId,
      },
      { phoneNumberId: number.phoneNumberId, toE164: to, body },
    );

    if (outcome.ok) {
      await this.accept(organizationId, prepared, outcome.providerMessageId);
      return;
    }

    const attempts = prepared.sendAttempts + 1;
    if (outcome.retryable && attempts < MAX_SEND_ATTEMPTS) {
      await this.inTenant(organizationId, async () => {
        await this.db.client.message.updateMany({
          where: { id: messageId },
          data: { sendAttempts: attempts, errorCode: outcome.code, errorMessage: outcome.message },
        });
      });
      // Thrown so BullMQ's own exponential backoff applies, and so a failing send is visible as a
      // failing job rather than as a queue that looks idle.
      throw new Error(`whatsapp send failed (retryable): ${outcome.code} ${outcome.message}`);
    }

    await this.fail(organizationId, { ...prepared, sendAttempts: attempts }, outcome);
  }

  /** Meta took it. The `sent` receipt is what will say it left. */
  private async accept(
    organizationId: string,
    message: {
      id: string;
      type: string;
      body: string | null;
      createdAt: Date;
      sendAttempts: number;
      templateId: string | null;
      conversation: { id: string; leadId: string | null };
    },
    providerMessageId: string,
  ): Promise<void> {
    await this.inTenant(organizationId, async () => {
      await this.db.client.message.updateMany({
        where: { id: message.id },
        data: {
          status: 'accepted',
          providerMessageId,
          sendAttempts: message.sendAttempts + 1,
          errorCode: null,
          errorMessage: null,
        },
      });

      if (message.conversation.leadId !== null) {
        await this.timeline.record({
          type:
            message.type === 'template'
              ? ACTIVITY_TYPES.WHATSAPP_TEMPLATE_SENT
              : ACTIVITY_TYPES.WHATSAPP_SENT,
          leadId: message.conversation.leadId,
          // The message's own instant, not now: the timeline deduplicates on
          // `(organization, source_event_id, occurred_at)`, so a replayed job has to recompute the
          // same pair — which `now()` could not.
          occurredAt: message.createdAt,
          sourceEventId: deterministicEventId(`${message.id}:sent`),
          payload: {
            conversationId: message.conversation.id,
            messageId: message.id,
            preview: message.body ?? '',
            messageType: message.type,
            templateId: message.templateId,
          },
          actorType: 'system',
        });
      }
    });
    this.logger.info({ messageId: message.id, providerMessageId }, 'a whatsapp message was accepted by meta');
  }

  /** It will not send. Said on the message, on the lead, and to whoever sent it. */
  private async fail(
    organizationId: string,
    message: {
      id: string;
      createdAt: Date;
      senderUserId: string | null;
      sendAttempts: number;
      conversation: { id: string; leadId: string | null };
    },
    outcome: { code: string; message: string },
  ): Promise<void> {
    const failedAt = new Date();
    await this.inTenant(organizationId, async () => {
      await this.db.client.message.updateMany({
        where: { id: message.id },
        data: {
          status: 'failed',
          errorCode: outcome.code,
          errorMessage: outcome.message.slice(0, 500),
          failedAt,
          sendAttempts: message.sendAttempts,
        },
      });
    });
    // Inside the workspace's context: `TimelineService` takes the organization from the context by
    // design, and `announceFailure` writes a timeline entry — so calling it outside one throws
    // `TenantContextMissingError`, which this processor would then report as a failed send of a
    // message that had already failed. Found by the suite's "tells the sender" case.
    await this.inTenant(organizationId, async () =>
      this.status.announceFailure(organizationId, {
        messageId: message.id,
        conversationId: message.conversation.id,
        leadId: message.conversation.leadId,
        occurredAt: message.createdAt,
        senderUserId: message.senderUserId,
        errorCode: outcome.code,
        errorMessage: outcome.message,
        sourceEventId: deterministicEventId(`${message.id}:failed`),
      }),
    );
    this.logger.warn(
      { messageId: message.id, code: outcome.code },
      'a whatsapp message could not be sent',
    );
  }

  private inTenant<T>(organizationId: string, fn: () => Promise<T>): Promise<T> {
    return tenantContext.run(systemPrincipal(organizationId, newId()), fn);
  }
}

/**
 * Re-queues a message a worker never sent (`FR-WA-9`).
 *
 * The shape the webhook and integration retries already have, and for the same reason: a job lost
 * while a worker was down must not be a message lost. Cross-tenant, so the read is platform-scoped
 * and each re-queue carries the row's own workspace.
 */
@Injectable()
export class WhatsAppSendRetryProcessor implements JobProcessor {
  readonly queue = QUEUES.MAINTENANCE;
  readonly jobName = JOBS.WHATSAPP_SEND_RETRY;

  constructor(
    private readonly db: DbService,
    private readonly queues: QueueService,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  async process(): Promise<void> {
    const stale = await withPlatformScope(
      'whatsapp: re-queue messages that were never handed to meta',
      async () =>
        this.db.client.message.findMany({
          where: {
            status: 'queued',
            direction: 'outbound',
            // Two minutes, which is long enough that a message in flight is not re-queued and short
            // enough that a worker restart costs a customer two minutes rather than for ever.
            createdAt: { lt: new Date(Date.now() - 120_000) },
            sendAttempts: { lt: MAX_SEND_ATTEMPTS },
          },
          select: { id: true, organizationId: true, sendAttempts: true },
          take: 200,
          orderBy: { createdAt: 'asc' },
        }),
    );
    for (const message of stale) {
      await this.queues.enqueue(
        QUEUES.MAINTENANCE,
        JOBS.WHATSAPP_SEND_MESSAGE,
        { organizationId: message.organizationId, aggregateId: message.id },
        { jobId: `whatsapp-send-${message.id}-sweep${message.sendAttempts}` },
      );
    }
    if (stale.length > 0) {
      this.logger.info({ requeued: stale.length }, 'whatsapp messages re-queued by the sweep');
    }
  }
}

/** What to hand the adapter, from what the row says it is. */
function sendBody(
  type: MessageType,
  payload: unknown,
  body: string | null,
):
  | { kind: 'text'; text: string }
  | { kind: 'template'; name: string; language: string; parameters: readonly string[] } {
  const stored = (payload ?? {}) as Record<string, unknown>;
  if (type === 'template') {
    return {
      kind: 'template',
      name: String(stored['name'] ?? ''),
      language: String(stored['language'] ?? 'en'),
      parameters: Array.isArray(stored['parameters'])
        ? stored['parameters'].map((value) => String(value))
        : [],
    };
  }
  // The stored payload rather than the body column, because the body is what the thread shows and
  // the payload is what was composed — the same distinction the inbound side keeps.
  return { kind: 'text', text: String(stored['text'] ?? body ?? '') };
}
