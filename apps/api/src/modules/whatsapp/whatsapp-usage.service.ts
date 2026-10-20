import { Injectable } from '@nestjs/common';
import { tenantContext } from '@leados/shared';
import { DbService } from '../../infra/db/db.service.js';

/**
 * What WhatsApp cost this workspace (`FR-BIL-4`).
 *
 * **Why this exists at all, and why it is a read rather than a counter.** `messages.billable` and
 * `conversation_category` have been written from Meta's own receipts since step 2, and nothing read
 * them — two columns with no reader, which is the same shape of problem as a column with no writer
 * and said as plainly. A meter that incremented a running total on every receipt would be a second
 * answer to a question the messages already answer, and the first time the two disagreed nobody
 * would know which to believe. So this counts the rows.
 *
 * Three decisions:
 *
 *  * **Meta bills per *conversation*, not per message**, and marks exactly one message in each as
 *    the billable one with the category it was billed under. Counting billable messages is
 *    therefore counting conversations, which is why the figure is labelled that way rather than
 *    "messages".
 *  * **It is grouped by category, because the prices differ.** A `marketing` conversation and a
 *    `service` one cost different amounts, and a single total would be a number nobody could
 *    reconcile with an invoice. The prices themselves are **not** here: they are per-country, Meta
 *    changes them, and a rate card in this codebase would be wrong within a quarter and wrong
 *    silently.
 *  * **Raw SQL, so the tenant scope is written out by hand.** A `groupBy` over a partitioned table
 *    with a date range is expressible in Prisma, but the window predicate has to reach the
 *    partition pruning to be worth anything — and raw SQL passes through neither the tenant-scoping
 *    extension nor the data scope, which is the trap `/oversight`'s median paid for. Both are
 *    written out below.
 */
@Injectable()
export class WhatsAppUsageService {
  constructor(private readonly db: DbService) {}

  async summary(input: { from: Date; to: Date }) {
    const organizationId = tenantContext.organizationId('whatsapp.usage');
    const rows = await this.db.client.$queryRaw<
      { conversation_category: string | null; conversations: bigint }[]
    >`
      SELECT conversation_category, count(*)::bigint AS conversations
        FROM messages
       WHERE organization_id = ${organizationId}::uuid
         AND billable
         AND created_at >= ${input.from}
         AND created_at < ${input.to}
       GROUP BY conversation_category
       ORDER BY conversations DESC
    `;
    const byCategory = rows.map((row) => ({
      // Meta sends no category on some older receipts. `unknown` rather than dropping the row: a
      // total that silently omits what it could not classify is a total nobody can reconcile.
      category: row.conversation_category ?? 'unknown',
      conversations: Number(row.conversations),
    }));
    const total = byCategory.reduce((sum, row) => sum + row.conversations, 0);

    // Everything sent in the window, billable or not, so the screen can say what proportion was
    // inside a free service window — which is the one number an owner can act on.
    const sent = await this.db.client.message.count({
      where: {
        direction: 'outbound',
        createdAt: { gte: input.from, lt: input.to },
        status: { in: ['accepted', 'sent', 'delivered', 'read'] },
      },
    });

    return {
      from: input.from,
      to: input.to,
      /** Billable **conversations**, which is Meta's unit — one message in each is marked. */
      billableConversations: total,
      byCategory,
      messagesSent: sent,
      /**
       * No cost. Meta's prices are per-country and change; a rate card in this codebase would be
       * wrong within a quarter, and wrong silently on somebody's invoice.
       */
      note: 'Counts only. WhatsApp prices vary by country and change, so this does not estimate cost.',
    };
  }
}
