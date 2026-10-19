import { Inject, Injectable } from '@nestjs/common';
import {
  ACTIVITY_TYPES,
  AppError,
  newId,
  statusesBeatenBy,
  systemPrincipal,
  tenantContext,
  withPlatformScope,
  type InboundWhatsAppStatus,
  type MessageStatus,
} from '@leados/shared';
import type { Logger } from 'pino';
import { DbService } from '../../infra/db/db.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { LOGGER } from '../../infra/observability/logger.module.js';
import { TimelineService } from '../../infra/timeline/timeline.service.js';
import { deterministicEventId } from './whatsapp-ids.js';

/**
 * What Meta says became of a message we sent (`FR-WA-4`).
 *
 * Three things make this harder than it looks, and each is a decision in this file:
 *
 *  * **Receipts arrive out of order.** `read` before `delivered` is routine, so the message's own
 *    `status` column only ever moves **forward** (`statusAdvances`), while every receipt is kept in
 *    `message_status_events` with Meta's own instant. Without the first rule an agent watches a
 *    message go backwards; without the second, "it says delivered and she never got it" is
 *    unanswerable.
 *  * **A failure must be impossible to miss.** `FR-WA-9` asks for visible, retryable and never
 *    silent: the message carries Meta's own sentence, the lead's timeline gets an entry, and
 *    whoever sent it gets a notification that is **not** held for quiet hours.
 *  * **A receipt for a message we do not have is not an error.** A number that was reconnected, a
 *    message sent by another tool on the same WABA, a receipt for something pruned: recorded as
 *    ignored and acknowledged, because a provider that gets an error learns to stop delivering.
 */
@Injectable()
export class WhatsAppStatusService {
  constructor(
    private readonly db: DbService,
    private readonly timeline: TimelineService,
    private readonly notifications: NotificationsService,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  /**
   * One receipt, applied.
   *
   * Platform-scoped only to resolve the number — the same necessity the inbound pipeline has, for
   * the same reason: a delivery names a `phone_number_id` and nothing else.
   */
  async record(organizationId: string, status: InboundWhatsAppStatus): Promise<'applied' | 'ignored' | 'stale'> {
    const number = await withPlatformScope(
      'whatsapp: resolve the business number a status receipt arrived at',
      async () =>
        this.db.client.whatsAppNumber.findFirst({
          where: { phoneNumberId: status.phoneNumberId },
          select: { organizationId: true },
        }),
    );
    if (!number) throw AppError.notFound('Number');
    if (number.organizationId !== organizationId) throw AppError.notFound('Number');

    return tenantContext.run(systemPrincipal(organizationId, newId()), async () => {
      const message = await this.db.client.message.findFirst({
        where: { providerMessageId: status.providerMessageId, direction: 'outbound' },
        select: {
          id: true,
          createdAt: true,
          status: true,
          type: true,
          body: true,
          senderUserId: true,
          conversationId: true,
          sendAttempts: true,
          conversation: { select: { id: true, leadId: true } },
        },
      });
      if (!message) {
        this.logger.debug(
          { providerMessageId: status.providerMessageId, status: status.status },
          'a whatsapp status receipt names a message this workspace did not send',
        );
        return 'ignored';
      }

      // The history, always — even for a receipt that does not move the status. The unique on
      // `(organization, message, status)` makes a redelivered receipt a no-op rather than a second
      // row, which is why this is `createMany` with `skipDuplicates` and not an `upsert`.
      await this.db.client.messageStatusEvent.createMany({
        data: [
          {
            id: newId(),
            organizationId,
            messageId: message.id,
            // Both halves of the parent's key: `messages` is partitioned, so the composite FK needs
            // the instant as well as the id.
            messageCreatedAt: message.createdAt,
            status: status.status,
            occurredAt: status.occurredAt,
            errorCode: status.errorCode,
            errorMessage: status.errorMessage,
            conversationCategory: status.conversationCategory,
            billable: status.billable,
            raw: status.raw as never,
          },
        ],
        skipDuplicates: true,
      });

      // The **timestamp** is written either way, and only the summary `status` is ordered. A
      // `delivered` receipt that arrives after `read` still means the message was delivered at
      // 11:02, and dropping that instant because its summary had been overtaken would leave
      // `delivered_at` null on a message everybody can see was delivered.
      await this.db.client.message.updateMany({
        where: { id: message.id },
        data: {
          ...stampFor(status.status, status.occurredAt),
          ...(status.conversationCategory === null
            ? {}
            : { conversationCategory: status.conversationCategory }),
          ...(status.billable ? { billable: true } : {}),
        },
      });

      // The summary status, moved **conditionally in one statement** rather than by reading it and
      // deciding: these jobs run at the queue's concurrency, and three receipts for one message
      // arrive together — so a read-then-write loses the race and a late `delivered` overwrote
      // `read` about one time in three. The row count is what says whether it advanced.
      const moved = await this.db.client.message.updateMany({
        where: { id: message.id, status: { in: statusesBeatenBy(status.status) } },
        data: {
          status: status.status,
          ...(status.status === 'failed'
            ? { errorCode: status.errorCode, errorMessage: status.errorMessage }
            : {}),
        },
      });
      if (moved.count === 0) {
        // Routine, not an error: Meta's receipts overtake each other.
        return 'stale';
      }

      if (status.status === 'sent') {
        // The conversation's own outbound marks, written when Meta actually took it rather than
        // when we queued it: `first_response_at` is a figure about the business's answer, and
        // counting a queued message would flatter it by however long the queue was.
        await this.db.client.conversation.updateMany({
          where: { id: message.conversationId, firstResponseAt: null },
          data: { firstResponseAt: status.occurredAt },
        });
        await this.db.client.conversation.updateMany({
          where: { id: message.conversationId },
          data: { lastOutboundAt: status.occurredAt },
        });
      }

      if (status.status === 'failed') {
        await this.announceFailure(organizationId, {
          messageId: message.id,
          conversationId: message.conversationId,
          leadId: message.conversation.leadId,
          occurredAt: status.occurredAt,
          senderUserId: message.senderUserId,
          errorCode: status.errorCode,
          errorMessage: status.errorMessage,
          sourceEventId: deterministicEventId(`${status.providerMessageId}:failed`),
        });
      }

      // `delivered` and `read` are deliberately **not** on the timeline. A business owner opening a
      // lead wants the conversation, not four rows per message — the status is on the message in
      // the thread, where somebody looking at that message is already looking.
      return 'applied';
    });
  }

  /** A failure, said out loud three times: on the message, on the lead, and to the sender. */
  async announceFailure(
    organizationId: string,
    input: {
      messageId: string;
      conversationId: string;
      leadId: string | null;
      occurredAt: Date;
      senderUserId: string | null;
      errorCode: string | null;
      errorMessage: string | null;
      sourceEventId: string;
    },
  ): Promise<void> {
    const reason = input.errorMessage ?? 'WhatsApp did not say why.';
    if (input.leadId !== null) {
      await this.timeline.record({
        type: ACTIVITY_TYPES.WHATSAPP_FAILED,
        leadId: input.leadId,
        occurredAt: input.occurredAt,
        sourceEventId: input.sourceEventId,
        payload: {
          conversationId: input.conversationId,
          messageId: input.messageId,
          errorCode: input.errorCode,
          // Meta's own words. A paraphrase of "more than 24 hours have passed since the customer
          // last replied" would lose the one sentence that says what to do instead.
          reason,
        },
        actorType: 'system',
      });
    }
    if (input.senderUserId !== null) {
      await this.notifications.create({
        organizationId,
        userId: input.senderUserId,
        type: 'whatsapp.send_failed',
        title: 'A WhatsApp message did not send',
        body: reason,
        link: `/inbox?c=${input.conversationId}`,
        data: { conversationId: input.conversationId, messageId: input.messageId },
        // One notification per message, however many times a receipt is redelivered.
        dedupeKey: `whatsapp-send-failed:${input.messageId}`,
      });
    }
  }
}

/** Which timestamp column a status writes. `queued` and `accepted` have none: they are ours. */
function stampFor(status: MessageStatus, at: Date): Record<string, Date> {
  switch (status) {
    case 'sent':
      return { sentAt: at };
    case 'delivered':
      return { deliveredAt: at };
    case 'read':
      return { readAt: at };
    case 'failed':
      return { failedAt: at };
    default:
      return {};
  }
}
