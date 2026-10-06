import { Injectable } from '@nestjs/common';
import { DbService } from '../../infra/db/db.service.js';
import type { TransactionClient } from '../../infra/outbox/outbox.service.js';

/**
 * The figures derived from the ledger: `deals.paid_minor` and the three `customers` rollups.
 *
 * **Recomputed from `payments`, never incremented.** A running total that is incremented is wrong
 * the first time two writers read it at once — the exact bug the scoring queue produced, where two
 * jobs read `score = 0` and both wrote 15. Here it would be worse: the number is money, and the
 * drift would be silent and permanent. So every one of these methods takes the row lock, then sums
 * the ledger, then writes the result.
 *
 * **Only `succeeded` rows count.** A pending cheque is not revenue and a refunded payment is not
 * either; both stay in the ledger, because "when did this fail" is a question somebody asks.
 *
 * The three `customers` columns were deliberately absent from step 6 until this existed
 * (`docs/database-design.md` §6.7): a money column with no writer reads as zero and lies to every
 * report that touches it.
 */
@Injectable()
export class PaymentRollupsService {
  constructor(private readonly db: DbService) {}

  /**
   * Recomputes every figure a payment can affect: its deal, and its customer.
   *
   * Called after any write that could change a total — recording, confirming, failing, refunding,
   * editing an amount, deleting. Cheap: two indexed aggregates over a handful of rows.
   */
  async refreshFor(
    tx: TransactionClient,
    organizationId: string,
    subject: { dealId?: string | null; customerId?: string | null; leadId?: string | null },
  ): Promise<void> {
    if (subject.dealId) await this.refreshDeal(tx, organizationId, subject.dealId);

    // A payment against a lead belongs to that lead's customer once they convert, so the customer's
    // lifetime value is the union of both — which is the same reasoning as the timeline union.
    const customerId = subject.customerId ?? (await this.customerOfLead(tx, subject.leadId));
    if (customerId) await this.refreshCustomer(tx, organizationId, customerId);
  }

  private async refreshDeal(
    tx: TransactionClient,
    organizationId: string,
    dealId: string,
  ): Promise<void> {
    // The lock first, then the sum. Reading the total before taking the lock is how two concurrent
    // payments both compute the same "before" figure.
    const locked = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM deals
       WHERE organization_id = ${organizationId}::uuid AND id = ${dealId}::uuid
       FOR UPDATE
    `;
    if (locked.length === 0) return;

    const [row] = await tx.$queryRaw<{ paid: bigint | null }[]>`
      SELECT COALESCE(SUM(amount_minor), 0) AS paid
        FROM payments
       WHERE organization_id = ${organizationId}::uuid
         AND deal_id = ${dealId}::uuid
         AND status = 'succeeded'
         AND deleted_at IS NULL
    `;
    await tx.$executeRaw`
      UPDATE deals SET paid_minor = ${Number(row?.paid ?? 0)}, updated_at = now()
       WHERE organization_id = ${organizationId}::uuid AND id = ${dealId}::uuid
    `;
  }

  private async refreshCustomer(
    tx: TransactionClient,
    organizationId: string,
    customerId: string,
  ): Promise<void> {
    const locked = await tx.$queryRaw<{ lead_id: string | null }[]>`
      SELECT lead_id FROM customers
       WHERE organization_id = ${organizationId}::uuid AND id = ${customerId}::uuid
       FOR UPDATE
    `;
    if (locked.length === 0) return;
    const leadId = locked[0]?.lead_id ?? null;

    /**
     * The union: payments recorded against the customer, and payments recorded against the lead
     * they came from. Conversion does not re-parent anything (`FR-DEAL-4`), so a deposit taken
     * before the sale closed is still on the lead — and it is still this customer's money.
     */
    const [row] = await tx.$queryRaw<
      { total: bigint | null; first_at: Date | null; last_at: Date | null }[]
    >`
      SELECT COALESCE(SUM(amount_minor), 0) AS total,
             MIN(paid_at) AS first_at,
             MAX(paid_at) AS last_at
        FROM payments
       WHERE organization_id = ${organizationId}::uuid
         AND status = 'succeeded'
         AND deleted_at IS NULL
         AND (
           customer_id = ${customerId}::uuid
           OR (${leadId}::uuid IS NOT NULL AND lead_id = ${leadId}::uuid)
         )
    `;

    await tx.$executeRaw`
      UPDATE customers
         SET lifetime_value_minor = ${Number(row?.total ?? 0)},
             first_purchase_at = ${row?.first_at ?? null},
             last_purchase_at = ${row?.last_at ?? null},
             updated_at = now()
       WHERE organization_id = ${organizationId}::uuid AND id = ${customerId}::uuid
    `;
  }

  /** The customer a lead converted into, if any — so a pre-conversion deposit still counts. */
  private async customerOfLead(
    tx: TransactionClient,
    leadId: string | null | undefined,
  ): Promise<string | null> {
    if (!leadId) return null;
    const customer = await tx.customer.findFirst({
      where: { leadId, deletedAt: null },
      select: { id: true },
    });
    return customer?.id ?? null;
  }
}
