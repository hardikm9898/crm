import { Inject, Injectable } from '@nestjs/common';
import {
  ACTIVITY_TYPES,
  consentAcknowledgement,
  consentKeyword,
  type ConsentKeyword,
} from '@leados/shared';
import type { Logger } from 'pino';
import { AuditService } from '../../infra/audit/audit.service.js';
import { DbService } from '../../infra/db/db.service.js';
import { LOGGER } from '../../infra/observability/logger.module.js';
import { TimelineService } from '../../infra/timeline/timeline.service.js';

/** What one inbound message did to consent, for the log and for a test. */
export interface ConsentOutcome {
  readonly keyword: ConsentKeyword;
  readonly changed: boolean;
  /** What the workspace should say back, so a `STOP` is acknowledged rather than silent. */
  readonly acknowledgement: string;
}

/**
 * `STOP` and `START`, as the customer writes them (`FR-WA-10`).
 *
 * Four decisions:
 *
 *  * **It is written in the ingestion, not by a job.** The requirement says consent revocation
 *    "MUST immediately suppress marketing sends". A queue hop is a window in which a campaign
 *    reads the old value, and the person who typed `STOP` gets the thing they asked to stop. So
 *    the write happens in the request that received the message, before it answers.
 *  * **The keyword list is short and the words on it are unambiguous.** `consentKeyword` matches
 *    the **whole** message, and `no`, `cancel`, `end` and `quit` are deliberately not on it: each
 *    is a word somebody uses mid-conversation, and a false positive silences a customer invisibly
 *    — nothing on any screen would say why.
 *  * **It is on the lead's timeline and in the audit log.** "Why did we stop messaging her?" has
 *    to have an answer, and `consent.revoked` carries the word she actually sent.
 *  * **Nothing is sent back from here.** The acknowledgement is a sentence this service *returns*;
 *    whether to send it is the caller's decision, because an automatic reply to `STOP` is itself a
 *    message and the 24-hour window rules still apply to it. Returning the words rather than
 *    sending them keeps the one rule about sending in the one service that owns it.
 */
@Injectable()
export class WhatsAppConsentService {
  constructor(
    private readonly db: DbService,
    private readonly timeline: TimelineService,
    private readonly audit: AuditService,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  /**
   * Applies whatever this message says about consent, or nothing at all.
   *
   * `null` for almost every message, which is the point: a rule that guesses takes away somebody's
   * ability to be contacted and leaves no trace a colleague could find.
   */
  async apply(input: {
    organizationId: string;
    conversationId: string;
    leadId: string | null;
    customerId: string | null;
    body: string | null;
    occurredAt: Date;
  }): Promise<ConsentOutcome | null> {
    const keyword = consentKeyword(input.body);
    if (keyword === null) return null;
    const granted = keyword === 'opt_in';
    const acknowledgement = consentAcknowledgement(keyword);

    // Nothing to write consent against: a message from a number with no lead yet cannot revoke a
    // consent nobody holds. The ingestion creates the lead first, so this is the customer-only and
    // the no-subject case, and it is honest to say the keyword was seen and did nothing.
    if (input.leadId === null && input.customerId === null) {
      this.logger.info(
        { conversationId: input.conversationId, keyword },
        'a consent keyword arrived with no lead or customer to apply it to',
      );
      return { keyword, changed: false, acknowledgement };
    }

    const subject =
      input.leadId !== null
        ? await this.db.client.lead.findFirst({
            where: { id: input.leadId },
            select: { id: true, consentWhatsapp: true },
          })
        : null;
    const customer =
      subject === null && input.customerId !== null
        ? await this.db.client.customer.findFirst({
            where: { id: input.customerId },
            select: { id: true, consentWhatsapp: true },
          })
        : null;
    const before = subject?.consentWhatsapp ?? customer?.consentWhatsapp ?? null;
    if (before === null) return { keyword, changed: false, acknowledgement };
    if (before === granted) {
      // Already where they asked to be. Not an error and not a timeline row: a second `STOP` is
      // somebody making sure, and a product that logged it twice would read as not having listened
      // the first time.
      return { keyword, changed: false, acknowledgement };
    }

    await this.db.client.$transaction(async (tx) => {
      if (subject !== null) {
        await tx.lead.update({ where: { id: subject.id }, data: { consentWhatsapp: granted } });
      } else if (customer !== null) {
        await tx.customer.update({
          where: { id: customer.id },
          data: { consentWhatsapp: granted },
        });
      }
      await this.timeline.recordInTransaction(tx, {
        type: granted ? ACTIVITY_TYPES.CONSENT_GRANTED : ACTIVITY_TYPES.CONSENT_REVOKED,
        ...(subject !== null ? { leadId: subject.id } : { customerId: customer!.id }),
        occurredAt: input.occurredAt,
        payload: {
          channel: 'whatsapp',
          conversationId: input.conversationId,
          // The word they actually sent, trimmed. "Why did we stop messaging her?" is answered by
          // the message, not by a code.
          keyword: (input.body ?? '').trim().slice(0, 64),
        },
        actorType: 'system',
      });
      await this.audit.recordInTransaction(tx, {
        action: granted ? 'consent.granted' : 'consent.revoked',
        resourceType: subject !== null ? 'lead' : 'customer',
        resourceId: subject?.id ?? customer?.id ?? null,
        before: { consentWhatsapp: before },
        after: { consentWhatsapp: granted, via: 'whatsapp_keyword' },
        actorType: 'system',
      });
    });

    this.logger.info(
      {
        organizationId: input.organizationId,
        conversationId: input.conversationId,
        keyword,
        leadId: subject?.id ?? null,
        customerId: customer?.id ?? null,
      },
      granted ? 'a customer opted back in over whatsapp' : 'a customer opted out over whatsapp',
    );
    return { keyword, changed: true, acknowledgement };
  }
}
