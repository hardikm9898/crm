import { Injectable } from '@nestjs/common';
import type { TransactionClient } from '../../infra/outbox/outbox.service.js';
import { SlaService } from '../sla/sla.service.js';

/**
 * The **one** writer of "somebody actually got hold of this lead".
 *
 * `leads.first_contacted_at` and `last_contacted_at` are read by `/today`, `/oversight`, the
 * uncontacted filter and every "time to first call" figure, and the first-response SLA clock is
 * satisfied at the same instant — so the two must never be able to disagree. They were written by
 * `TasksService` alone until calls arrived; a second copy inside `CallsService` is exactly the shape
 * of the `telHref` trap (two implementations, different null-handling, one of them wrong), with the
 * added cost that a lead could end up marked contacted with no clock satisfied.
 *
 * So the rule is: **a channel that reaches a person calls this, and nothing writes those two columns
 * directly.** Completing a follow-up does it, logging a connected call does it, and when WhatsApp
 * and email arrive they will too.
 *
 * Three properties the callers depend on:
 *
 *  * **It runs inside the caller's transaction.** The contact and the thing that caused it commit
 *    together or not at all.
 *  * **`at` is the instant the contact happened, not `now()`.** Logging yesterday's call today
 *    records it where it happened, which is what makes "time to first response" answerable rather
 *    than merely plausible.
 *  * **It never moves `last_contacted_at` backwards.** Logging an older call afterwards must not
 *    make the lead look staler than the most recent contact really was.
 */
@Injectable()
export class LeadContactService {
  constructor(private readonly sla: SlaService) {}

  async record(
    tx: TransactionClient,
    subject: { readonly organizationId: string; readonly leadId: string | null },
    at: Date,
    /** What satisfied the promise, in the words a business owner would recognise. */
    reason: string,
  ): Promise<void> {
    if (!subject.leadId) return;

    await tx.lead.updateMany({
      // Never moves **forwards**: the earliest contact anybody knows about is the true first one.
      // Somebody logging Monday's call on Wednesday is recording that the business responded on
      // Monday, and a column that kept Wednesday would tell every "time to first response" report
      // the business took two days longer than it did.
      where: {
        id: subject.leadId,
        OR: [{ firstContactedAt: null }, { firstContactedAt: { gt: at } }],
      },
      data: { firstContactedAt: at },
    });
    await tx.lead.updateMany({
      where: {
        id: subject.leadId,
        OR: [{ lastContactedAt: null }, { lastContactedAt: { lt: at } }],
      },
      data: { lastContactedAt: at },
    });
    // Idempotent on the clock's own state, which is what lets several channels do this without
    // coordinating with each other.
    await this.sla.satisfy(
      tx,
      { organizationId: subject.organizationId, leadId: subject.leadId },
      'first_response',
      at,
      reason,
    );
  }
}
