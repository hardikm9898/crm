import { Inject, Injectable } from '@nestjs/common';
import {
  ACTIVITY_TYPES,
  AppError,
  describeMessagePreview,
  newId,
  parseWhatsAppMessages,
  systemPrincipal,
  tenantContext,
  waIdToE164,
  windowExpiryFrom,
  withPlatformScope,
  type InboundWhatsAppMessage,
} from '@leados/shared';
import type { Logger } from 'pino';
import { DbService } from '../../infra/db/db.service.js';
import { LOGGER } from '../../infra/observability/logger.module.js';
import { TimelineService } from '../../infra/timeline/timeline.service.js';
import { LeadsService } from '../leads/leads.service.js';
import { deterministicEventId } from './whatsapp-ids.js';
import { WhatsAppConsentService } from './whatsapp-consent.service.js';
import { WhatsAppMediaService } from './whatsapp-media.service.js';

/** What one inbound message did, for the log and for a test. */
export interface InboundResult {
  readonly conversationId: string;
  readonly messageId: string;
  readonly leadId: string | null;
  /** True when this message is why the lead exists at all. */
  readonly leadCreated: boolean;
  /** True when the row was already there — a redelivery that got past the ledger. */
  readonly alreadyHad: boolean;
  /**
   * What this message said about consent (`FR-WA-10`), or null for the almost-every-message case.
   *
   * `changed: false` with a keyword is the honest "they said `STOP` and were already stopped" —
   * distinguishable from "they said nothing about it", which matters to a test and to a log.
   */
  readonly consent?: { readonly keyword: string; readonly changed: boolean } | null;
}

/**
 * An inbound WhatsApp message, turned into a conversation, a message and a timeline entry
 * (`FR-WA-3`, `FR-WA-6`, `FR-CAP-1`'s "WhatsApp inbound").
 *
 * The order of the four writes is the decision in this file:
 *
 *  1. **The number resolves the workspace.** A delivery carries only `metadata.phone_number_id`, so
 *     that is read across tenants — the same necessity the public lead API's path key has — and
 *     everything after it happens inside that workspace's context.
 *  2. **The lead is found or created**, by the sender's number, through `LeadsService.create` — the
 *     one ingestion path `FR-CAP-4` asks for, with the duplicate rules, the assignment engine, the
 *     SLA clock and the outbox events that come with it. A WhatsApp message from a number nobody
 *     recognises is a lead the business has already paid for; refusing it because there is no lead
 *     yet would lose exactly the enquiries this product exists to catch.
 *  3. **The conversation is found or created** for `(number, contact)`, and its 24-hour window is
 *     written from this message.
 *  4. **The message row**, then **the timeline entry**, because rule six: a business owner opening
 *     a lead must see that they messaged, and a feature that skips the timeline is unfinished.
 *
 * Every one of those is idempotent on the provider's own message id. The ledger
 * (`provider_events`) stops a redelivery before this service is reached; the partial unique on
 * `messages` stops one that races it; and this method answers `alreadyHad` rather than throwing,
 * because the second delivery of a message is the normal case and not an error.
 */
@Injectable()
export class WhatsAppInboundService {
  constructor(
    private readonly db: DbService,
    private readonly leads: LeadsService,
    private readonly timeline: TimelineService,
    private readonly media: WhatsAppMediaService,
    private readonly consent: WhatsAppConsentService,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  /**
   * The workspace a delivery belongs to, from the number it arrived at.
   *
   * Platform-scoped by necessity: the delivery names a `phone_number_id` and nothing else, and
   * `whatsapp_numbers.phone_number_id` is globally unique precisely so this is a lookup rather than
   * a guess. An unknown number is a 404 — the same answer a made-up connection id gets, because the
   * shape of an id must not become an oracle.
   */
  async resolveNumber(phoneNumberId: string): Promise<{
    organizationId: string;
    numberId: string;
    displayPhoneE164: string;
    defaultAgentUserId: string | null;
  }> {
    const row = await withPlatformScope(
      'whatsapp: resolve the business number a delivery arrived at',
      async () =>
        this.db.client.whatsAppNumber.findFirst({
          where: { phoneNumberId, isActive: true },
          select: {
            id: true,
            organizationId: true,
            displayPhoneE164: true,
            defaultAgentUserId: true,
          },
        }),
    );
    if (!row) throw AppError.notFound('Number');
    return {
      organizationId: row.organizationId,
      numberId: row.id,
      displayPhoneE164: row.displayPhoneE164,
      defaultAgentUserId: row.defaultAgentUserId,
    };
  }

  /**
   * One message out of a stored delivery.
   *
   * The ledger row holds the **whole** delivery, so the message is found again by the id the ledger
   * is keyed on rather than being handed over by the controller. Two things follow: a job replayed
   * after a release parses the payload with the code of that release, and a delivery carrying three
   * messages produces three jobs that cannot read each other's message by accident.
   */
  async ingest(
    organizationId: string,
    delivery: Record<string, unknown>,
    providerMessageId: string,
  ): Promise<InboundResult | null> {
    const message = parseWhatsAppMessages(delivery).find(
      (candidate) => candidate.providerMessageId === providerMessageId,
    );
    if (message === undefined) {
      this.logger.warn(
        { organizationId, providerMessageId },
        'a stored whatsapp delivery no longer contains the message its ledger row names',
      );
      return null;
    }
    return this.store(organizationId, message);
  }

  /** The pipeline itself, from a message somebody has already parsed. */
  async store(organizationId: string, message: InboundWhatsAppMessage): Promise<InboundResult> {
    const number = await this.resolveNumber(message.phoneNumberId);
    if (number.organizationId !== organizationId) {
      // The ledger row and the number disagree about whose message this is, which can only happen
      // if a number moved between workspaces mid-flight. Refused rather than reconciled: delivering
      // somebody's customer's message to the wrong business is the one outcome worth a 404.
      throw AppError.notFound('Number');
    }

    return tenantContext.run(systemPrincipal(organizationId, newId()), async () => {
      const existing = await this.db.client.message.findFirst({
        where: { providerMessageId: message.providerMessageId },
        select: { id: true, conversationId: true },
      });
      if (existing) {
        const conversation = await this.db.client.conversation.findFirst({
          where: { id: existing.conversationId },
          select: { leadId: true },
        });
        return {
          conversationId: existing.conversationId,
          messageId: existing.id,
          leadId: conversation?.leadId ?? null,
          leadCreated: false,
          alreadyHad: true,
        };
      }

      const contactE164 = waIdToE164(message.fromWaId);
      // Two instants, and the difference matters. `created_at` is **ours** — when the delivery
      // reached us — because it is the partition key and the inbox's sort order: Meta's timestamp
      // is in whole seconds, so two messages in one second tie and "the latest message" becomes
      // whichever row the planner happened to return. `sent_at` is the customer's own instant,
      // which is also what the timeline and the 24-hour window are measured from.
      const receivedAt = new Date();
      const sentAt = message.occurredAt;
      const conversation = await this.conversationFor(number, message, contactE164, receivedAt);
      const messageId = newId();

      await this.db.client.message.create({
        data: {
          id: messageId,
          organizationId,
          conversationId: conversation.id,
          direction: 'inbound',
          type: message.type,
          body: message.body,
          payload: message.raw as never,
          provider: 'whatsapp_cloud',
          providerMessageId: message.providerMessageId,
          replyToProviderId: message.replyToProviderId,
          // Inbound: it is in our hands, and there is nothing further to wait for. A CHECK refuses
          // a sender on an inbound row, which is what stops a colleague's name on a customer's words.
          status: 'delivered',
          sentAt,
          deliveredAt: receivedAt,
          createdAt: receivedAt,
        },
      });

      // The conversation's own counters, after the message rather than with it: `unread_count` is
      // derived from what is there, and a value written alongside the insert would be a second
      // answer to a question the rows already answer.
      await this.db.client.conversation.update({
        where: { id: conversation.id },
        data: {
          lastMessageAt: receivedAt,
          // The window is measured from the customer's own instant, never from ours: Meta's clock
          // is the one that closes it, and a window computed from a later instant would let an
          // agent write a free-form reply Meta then refuses.
          lastInboundAt: sentAt,
          // Written from this message, by the one function that owns the arithmetic. A CHECK
          // refuses a window with no inbound message to count from.
          windowExpiresAt: windowExpiryFrom(sentAt),
          unreadCount: { increment: 1 },
          // A customer who messages a closed conversation has reopened it. Silently leaving it
          // closed is how a reply never comes.
          ...(conversation.wasClosed ? { status: 'open', closedAt: null, closedById: null } : {}),
        },
      });

      // The file, if there is one: recorded in the same breath as the message so the screen never
      // flickers between "no attachment" and "a photo", and fetched by a job because the bytes are
      // a second request over somebody else's CDN.
      if (message.media !== null) {
        await this.media.expect({
          organizationId,
          messageId,
          messageCreatedAt: receivedAt,
          type: message.type,
          media: message.media,
        });
      }

      // `STOP` and `START`, applied in **this** request (`FR-WA-10`). Not a job: the requirement
      // says a revocation suppresses marketing sends *immediately*, and a queue hop is a window in
      // which a campaign reads the old value and sends the person the thing they asked to stop.
      const consent = await this.consent.apply({
        organizationId,
        conversationId: conversation.id,
        leadId: conversation.leadId,
        customerId: null,
        body: message.body,
        occurredAt: sentAt,
      });

      if (conversation.leadId !== null) {
        await this.timeline.record({
          type: ACTIVITY_TYPES.WHATSAPP_RECEIVED,
          leadId: conversation.leadId,
          // The customer's own instant, and never `now()`: the timeline deduplicates on
          // `(organization_id, source_event_id, occurred_at)`, so a replayed job has to compute
          // the same pair it did the first time.
          occurredAt: sentAt,
          // The provider's own id, so a replayed job writes no second row — the idempotency the
          // timeline's unique on `(organization_id, source_event_id, occurred_at)` provides, and
          // the reason `occurredAt` is the message's instant and never `now()`.
          sourceEventId: deterministicEventId(message.providerMessageId),
          payload: {
            conversationId: conversation.id,
            messageId,
            preview: describeMessagePreview(message.type, message.body),
            messageType: message.type,
            from: contactE164 ?? message.fromWaId,
            profileName: message.profileName,
          },
          actorType: 'system',
        });
      }

      this.logger.info(
        {
          organizationId,
          conversationId: conversation.id,
          messageId,
          type: message.type,
          leadCreated: conversation.leadCreated,
        },
        'a whatsapp message arrived',
      );

      return {
        conversationId: conversation.id,
        messageId,
        leadId: conversation.leadId,
        leadCreated: conversation.leadCreated,
        alreadyHad: false,
        consent: consent === null ? null : { keyword: consent.keyword, changed: consent.changed },
      };
    });
  }

  /**
   * The conversation this message belongs to, created if it is the first.
   *
   * Keyed on `(channel_account_id, contact_e164)` rather than on the lead: one person messaging two
   * of a business's numbers is two conversations, which is what the agents answering each number
   * expect, and a lead with two numbers is still one lead.
   */
  private async conversationFor(
    number: { numberId: string; defaultAgentUserId: string | null },
    message: InboundWhatsAppMessage,
    contactE164: string | null,
    receivedAt: Date,
  ): Promise<{ id: string; leadId: string | null; leadCreated: boolean; wasClosed: boolean }> {
    const existing =
      contactE164 === null
        ? null
        : await this.db.client.conversation.findFirst({
            where: { channelAccountId: number.numberId, contactE164 },
            orderBy: { lastMessageAt: 'desc' },
            select: { id: true, leadId: true, status: true },
          });
    if (existing) {
      return {
        id: existing.id,
        leadId: existing.leadId,
        leadCreated: false,
        wasClosed: existing.status === 'closed',
      };
    }

    const lead = await this.leadFor(message, contactE164);
    const id = newId();
    await this.db.client.conversation.create({
      data: {
        id,
        organizationId: tenantContext.organizationId('whatsapp.conversationFor'),
        channel: 'whatsapp',
        channelAccountId: number.numberId,
        contactE164,
        leadId: lead.id,
        // The number's own default agent, when it has one. Assignment proper — a rule, a pool, a
        // round robin — is the shared inbox's step; this is the one answer the schema already has.
        assignedUserId: number.defaultAgentUserId,
        status: 'open',
        lastMessageAt: receivedAt,
      },
    });
    return { id, leadId: lead.id, leadCreated: lead.created, wasClosed: false };
  }

  /**
   * The lead this person is, or a new one.
   *
   * Through `LeadsService.create`, which runs the workspace's own duplicate rules — so a number
   * that is already a lead attaches a touchpoint to the lead they had rather than making a second
   * one, and the reply the agent sends lands on the right history. A refusal is **not** fatal to
   * the message: the conversation is stored with no lead, because losing a customer's words
   * because our own rules refused to make a record is the worse outcome by a long way.
   */
  private async leadFor(
    message: InboundWhatsAppMessage,
    contactE164: string | null,
  ): Promise<{ id: string | null; created: boolean }> {
    if (contactE164 === null) return { id: null, created: false };
    const existing = await this.db.client.lead.findFirst({
      where: { OR: [{ phoneE164: contactE164 }, { whatsappE164: contactE164 }], deletedAt: null },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    });
    if (existing) return { id: existing.id, created: false };

    try {
      // WhatsApp's profile name is a **display** name — "Asha Rao", not "Asha" — so putting it in
      // `firstName` whole makes every template greet her "Hello Asha Rao". Split on the first
      // space, which is as much as a display name can honestly be read for.
      const [profileFirst, ...profileRest] = (message.profileName ?? '').trim().split(/\s+/);
      const created = await this.leads.create({
        firstName: profileFirst === '' ? undefined : profileFirst,
        ...(profileRest.length > 0 ? { lastName: profileRest.join(' ') } : {}),
        whatsapp: contactE164,
        phone: contactE164,
        createdVia: 'whatsapp',
        // What they said, onto the lead's own timeline through the capture path: a lead whose first
        // record does not include the question they asked is a lead somebody has to go and find.
        ...(message.body !== null
          ? { formAnswers: [{ label: 'WhatsApp message', value: message.body.slice(0, 2000) }] }
          : {}),
      } as never);
      return { id: created.id, created: true };
    } catch (error) {
      this.logger.warn(
        { err: error, from: contactE164 },
        'a whatsapp message could not be made into a lead; the conversation is stored without one',
      );
      return { id: null, created: false };
    }
  }
}
