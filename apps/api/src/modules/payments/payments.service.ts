import { Injectable } from '@nestjs/common';
import {
  ACTIVITY_TYPES,
  AppError,
  PERMISSIONS,
  newId,
  tenantContext,
  type ActorType,
} from '@leados/shared';
import { DbService } from '../../infra/db/db.service.js';
import { AuditService } from '../../infra/audit/audit.service.js';
import { OutboxService, type TransactionClient } from '../../infra/outbox/outbox.service.js';
import { TimelineService } from '../../infra/timeline/timeline.service.js';
import { DataScopeService, applyScopeFilter } from '../../infra/authz/data-scope.service.js';
import { NUMBER_SERIES_KINDS, NumberSeriesService } from '../quotations/number-series.service.js';
import { PaymentRollupsService } from './payment-rollups.service.js';
import type {
  ConfirmPaymentInput,
  FailPaymentInput,
  ListPaymentsQuery,
  RecordPaymentInput,
  RefundPaymentInput,
  UpdatePaymentInput,
} from './payments.dto.js';

/**
 * Payments (`FR-DEAL-3`).
 *
 * **The ledger, and the only legitimate writer of every revenue figure in the product.** A deal's
 * value is what was agreed; a payment is what was received. Keeping them apart is what lets a
 * business owner ask "₹1,15,050 agreed, ₹50,000 received, what is outstanding?" — which is the
 * question a collections call is about, and which no single column can answer.
 *
 * Four decisions shape this file:
 *
 *  * **Partial payments are rows.** Three instalments are three rows, so "when did each arrive, by
 *    what method, against which cheque number" has an answer. Nothing caps the total at the deal's
 *    value: an advance for next year's work, or an overpayment somebody has to refund, are both
 *    real, and refusing them would make the system disagree with the bank statement.
 *  * **A refund is a status, not a negative row.** `amount_minor > 0` is a constraint, so a negative
 *    payment cannot exist; reversing one sets `refunded_at` and takes it out of every total while
 *    leaving the record of having received it.
 *  * **Totals are recomputed from the ledger, never incremented.** `PaymentRollupsService` takes the
 *    row lock and then sums — the trap the scoring queue already paid for, except that here the
 *    drift would be money.
 *  * **Rule 6 on every subject.** A payment is written to the deal's timeline and to the party's,
 *    because "they paid" is the single most important thing on a lead's history.
 */
@Injectable()
export class PaymentsService {
  constructor(
    private readonly db: DbService,
    private readonly scopes: DataScopeService,
    private readonly series: NumberSeriesService,
    private readonly rollups: PaymentRollupsService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly timeline: TimelineService,
  ) {}

  // ── Reading ───────────────────────────────────────────────────────────────

  async list(query: ListPaymentsQuery) {
    const filter = this.scopes.filterFor(PERMISSIONS.PAYMENT_READ, {
      userColumn: 'ownerUserId',
      teamColumn: 'teamId',
      branchColumn: 'branchId',
    });

    const baseWhere: Record<string, unknown> = {
      deletedAt: query.deleted === true ? { not: null } : null,
      ...(query.dealId ? { dealId: query.dealId } : {}),
      ...(query.quotationId ? { quotationId: query.quotationId } : {}),
      ...(query.leadId ? { leadId: query.leadId } : {}),
      ...(query.customerId ? { customerId: query.customerId } : {}),
      ...(query.methodId ? { methodId: query.methodId } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.receivedFrom || query.receivedTo
        ? {
            paidAt: {
              ...(query.receivedFrom ? { gte: query.receivedFrom } : {}),
              ...(query.receivedTo ? { lte: query.receivedTo } : {}),
            },
          }
        : {}),
    };
    const where = applyScopeFilter(baseWhere, filter);
    if (where === null) {
      return {
        items: [],
        meta: { totalMinor: 0, receivedMinor: 0 },
        pagination: { limit: query.limit, nextCursor: null, hasMore: false, total: 0 },
      };
    }

    const orderBy =
      query.sort === 'amount'
        ? { amountMinor: query.direction }
        : query.sort === 'created_at'
          ? { createdAt: query.direction }
          : { paidAt: query.direction };

    const [total, rows, sums, received] = await Promise.all([
      this.db.client.payment.count({ where }),
      this.db.client.payment.findMany({
        where,
        orderBy,
        take: query.limit + 1,
        ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
        include: this.listInclude(),
      }),
      this.db.client.payment.aggregate({ where, _sum: { amountMinor: true } }),
      /**
       * Two totals, not one. The filter's sum answers "what is on this list"; the succeeded sum
       * answers "how much money do we actually have" — and a screen that showed only the first
       * would count a bounced cheque as revenue.
       */
      this.db.client.payment.aggregate({
        where: { ...where, status: 'succeeded' },
        _sum: { amountMinor: true },
      }),
    ]);

    const page = rows.slice(0, query.limit);
    const hasMore = rows.length > query.limit;
    return {
      items: page.map((row) => this.present(row)),
      meta: {
        totalMinor: Number(sums._sum.amountMinor ?? 0),
        receivedMinor: Number(received._sum.amountMinor ?? 0),
      },
      pagination: {
        limit: query.limit,
        nextCursor: hasMore ? (page.at(-1)?.id ?? null) : null,
        hasMore,
        total,
      },
    };
  }

  async findOne(id: string) {
    const row = await this.db.client.payment.findFirst({
      where: { id },
      include: this.listInclude(),
    });
    if (!row) throw AppError.notFound('Payment');
    const allowed = this.scopes.canAct(PERMISSIONS.PAYMENT_READ, {
      userId: row.ownerUserId,
      teamId: row.teamId,
      branchId: row.branchId,
    });
    if (!allowed) throw AppError.notFound('Payment');
    return this.present(row);
  }

  // ── Writing ───────────────────────────────────────────────────────────────

  async record(input: RecordPaymentInput) {
    const principal = tenantContext.require('payments.record');
    const organization = await this.db.client.organization.findUniqueOrThrow({
      where: { id: principal.organizationId },
      select: { defaultCurrency: true },
    });

    const subject = await this.resolveSubject(input);
    const method = input.methodId ? await this.loadMethod(input.methodId) : null;
    if (method?.requiresReference && !input.reference) {
      // A UPI payment with no transaction id, or a cheque with no number, cannot be reconciled —
      // and the tenant said so by ticking the box on the method.
      throw AppError.validation('Some details need correcting', [
        {
          field: 'reference',
          code: 'REFERENCE_REQUIRED',
          message: `${method.name} payments need a reference — a transaction id or cheque number.`,
        },
      ]);
    }

    const currency = input.currency ?? subject.currency ?? organization.defaultCurrency;
    const status = input.status;
    const paidAt = status === 'succeeded' ? (input.paidAt ?? new Date()) : null;
    const id = newId();
    const now = new Date();

    await this.db.client.$transaction(async (tx) => {
      const allocated = await this.series.allocate(tx, NUMBER_SERIES_KINDS.PAYMENT);
      await tx.payment.create({
        data: {
          id,
          organizationId: principal.organizationId,
          dealId: subject.dealId,
          quotationId: subject.quotationId,
          leadId: subject.leadId,
          customerId: subject.customerId,
          branchId: subject.branchId,
          teamId: subject.teamId,
          ownerUserId: subject.ownerUserId,
          number: allocated.number,
          amountMinor: BigInt(input.amountMinor),
          currency,
          methodId: method?.id ?? null,
          ...(input.reference ? { reference: input.reference } : {}),
          status,
          paidAt,
          ...(input.note ? { outcomeNote: input.note } : {}),
          createdById: principal.actorId ?? null,
        },
      });

      await this.rollups.refreshFor(tx, principal.organizationId, subject);
      await this.record_(tx, subject, {
        type:
          status === 'succeeded'
            ? ACTIVITY_TYPES.PAYMENT_RECEIVED
            : ACTIVITY_TYPES.PAYMENT_RECORDED,
        occurredAt: paidAt ?? now,
        payload: {
          paymentId: id,
          number: allocated.number,
          amountMinor: input.amountMinor,
          currency,
          status,
          ...(method ? { method: method.name } : {}),
          ...(input.reference ? { reference: input.reference } : {}),
          ...(input.note ? { note: input.note } : {}),
        },
      });
      await this.audit.recordInTransaction(tx, {
        action: 'payment.recorded',
        resourceType: 'payment',
        resourceId: id,
        after: { number: allocated.number, amountMinor: input.amountMinor, currency, status },
      });
      await this.outbox.emit(tx, [
        {
          name: status === 'succeeded' ? 'payment.received' : 'payment.recorded',
          aggregateType: 'payment',
          aggregateId: id,
          payload: {
            dealId: subject.dealId,
            leadId: subject.leadId,
            customerId: subject.customerId,
            amountMinor: input.amountMinor,
            currency,
          },
        },
      ]);
    });

    return this.findOne(id);
  }

  /**
   * Corrects a payment somebody typed wrong.
   *
   * The amount is editable — a transposed figure is the commonest data-entry error, and forcing a
   * delete-and-retype loses the receipt number — but the **status is not**: that is what `confirm`,
   * `fail` and `refund` are for, each with its own preconditions and its own timeline entry.
   */
  async update(id: string, input: UpdatePaymentInput) {
    const row = await this.loadForWrite(id);
    if (row.status === 'refunded') {
      throw AppError.businessRule(
        'This payment has been refunded, so it cannot be edited. Record a new one if money arrived again.',
      );
    }
    if (input.methodId) {
      const method = await this.loadMethod(input.methodId);
      const reference = input.reference ?? row.reference;
      if (method.requiresReference && !reference) {
        throw AppError.validation('Some details need correcting', [
          {
            field: 'reference',
            code: 'REFERENCE_REQUIRED',
            message: `${method.name} payments need a reference — a transaction id or cheque number.`,
          },
        ]);
      }
    }

    await this.db.client.$transaction(async (tx) => {
      await tx.payment.update({
        where: { id },
        data: {
          ...(input.amountMinor === undefined ? {} : { amountMinor: BigInt(input.amountMinor) }),
          ...(input.methodId === undefined ? {} : { methodId: input.methodId }),
          ...(input.reference === undefined ? {} : { reference: input.reference }),
          // Only a payment that has succeeded has a date to move.
          ...(input.paidAt && row.status === 'succeeded' ? { paidAt: input.paidAt } : {}),
          ...(input.note === undefined ? {} : { outcomeNote: input.note }),
        },
      });
      await this.rollups.refreshFor(tx, row.organizationId, row);
      await this.audit.recordInTransaction(tx, {
        action: 'payment.updated',
        resourceType: 'payment',
        resourceId: id,
        before: { amountMinor: Number(row.amountMinor), reference: row.reference },
        after: { ...input },
      });
    });
    return this.findOne(id);
  }

  /** Pending → succeeded. The cheque cleared. */
  async confirm(id: string, input: ConfirmPaymentInput) {
    const row = await this.loadForWrite(id);
    if (row.status === 'succeeded') return this.findOne(id);
    if (row.status !== 'pending') {
      throw AppError.businessRule(`A ${row.status} payment cannot be confirmed.`);
    }

    const paidAt = input.paidAt ?? new Date();
    await this.db.client.$transaction(async (tx) => {
      await tx.payment.update({
        where: { id },
        data: {
          status: 'succeeded',
          paidAt,
          failedAt: null,
          ...(input.note ? { outcomeNote: input.note } : {}),
        },
      });
      await this.rollups.refreshFor(tx, row.organizationId, row);
      await this.record_(tx, row, {
        type: ACTIVITY_TYPES.PAYMENT_RECEIVED,
        occurredAt: paidAt,
        payload: {
          paymentId: id,
          number: row.number,
          amountMinor: Number(row.amountMinor),
          currency: row.currency,
          status: 'succeeded',
          ...(input.note ? { note: input.note } : {}),
        },
      });
      await this.audit.recordInTransaction(tx, {
        action: 'payment.confirmed',
        resourceType: 'payment',
        resourceId: id,
        after: { amountMinor: Number(row.amountMinor), paidAt },
      });
      await this.outbox.emit(tx, [
        {
          name: 'payment.received',
          aggregateType: 'payment',
          aggregateId: id,
          payload: {
            dealId: row.dealId,
            leadId: row.leadId,
            customerId: row.customerId,
            amountMinor: Number(row.amountMinor),
            currency: row.currency,
          },
        },
      ]);
    });
    return this.findOne(id);
  }

  /** Pending → failed. The cheque bounced. */
  async fail(id: string, input: FailPaymentInput) {
    const row = await this.loadForWrite(id);
    if (row.status === 'failed') return this.findOne(id);
    if (row.status === 'refunded') {
      throw AppError.businessRule('A refunded payment cannot be marked failed.');
    }

    const failedAt = input.failedAt ?? new Date();
    await this.db.client.$transaction(async (tx) => {
      await tx.payment.update({
        where: { id },
        // `payments_received_has_timestamp` requires `paid_at` to be null for a pending or failed
        // payment, so a cheque that bounced loses the date it appeared to arrive on. A *refund*
        // keeps its date, because the money really did arrive before it went back.
        data: {
          status: 'failed',
          failedAt,
          paidAt: null,
          ...(input.note ? { outcomeNote: input.note } : {}),
        },
      });
      await this.rollups.refreshFor(tx, row.organizationId, row);
      await this.record_(tx, row, {
        type: ACTIVITY_TYPES.PAYMENT_FAILED,
        occurredAt: failedAt,
        payload: {
          paymentId: id,
          number: row.number,
          amountMinor: Number(row.amountMinor),
          currency: row.currency,
          ...(input.note ? { note: input.note } : {}),
        },
      });
      await this.audit.recordInTransaction(tx, {
        action: 'payment.failed',
        resourceType: 'payment',
        resourceId: id,
        after: { failedAt, note: input.note ?? null },
      });
    });
    return this.findOne(id);
  }

  /** Succeeded → refunded. The money went back, and the record of receiving it stays. */
  async refund(id: string, input: RefundPaymentInput) {
    const row = await this.loadForWrite(id);
    if (row.status === 'refunded') return this.findOne(id);
    if (row.status !== 'succeeded') {
      throw AppError.businessRule(`A ${row.status} payment cannot be refunded.`);
    }

    const refundedAt = input.refundedAt ?? new Date();
    await this.db.client.$transaction(async (tx) => {
      await tx.payment.update({
        where: { id },
        data: {
          status: 'refunded',
          refundedAt,
          ...(input.note ? { outcomeNote: input.note } : {}),
        },
      });
      await this.rollups.refreshFor(tx, row.organizationId, row);
      await this.record_(tx, row, {
        type: ACTIVITY_TYPES.PAYMENT_REFUNDED,
        occurredAt: refundedAt,
        payload: {
          paymentId: id,
          number: row.number,
          amountMinor: Number(row.amountMinor),
          currency: row.currency,
          ...(input.note ? { note: input.note } : {}),
        },
      });
      await this.audit.recordInTransaction(tx, {
        action: 'payment.refunded',
        resourceType: 'payment',
        resourceId: id,
        after: { refundedAt, note: input.note ?? null },
      });
      await this.outbox.emit(tx, [
        {
          name: 'payment.refunded',
          aggregateType: 'payment',
          aggregateId: id,
          payload: {
            dealId: row.dealId,
            customerId: row.customerId,
            amountMinor: Number(row.amountMinor),
            currency: row.currency,
          },
        },
      ]);
    });
    return this.findOne(id);
  }

  /**
   * Soft-deletes a payment entered by mistake, and recomputes the totals.
   *
   * A deleted payment leaves the rollups, which is the point: an entry for the wrong customer makes
   * two reports wrong until it is removed. The row stays, because somebody will ask what happened.
   */
  async remove(id: string) {
    const row = await this.loadForWrite(id);
    if (row.deletedAt) return { deleted: true };

    await this.db.client.$transaction(async (tx) => {
      await tx.payment.update({ where: { id }, data: { deletedAt: new Date() } });
      await this.rollups.refreshFor(tx, row.organizationId, row);
      await this.audit.recordInTransaction(tx, {
        action: 'payment.deleted',
        resourceType: 'payment',
        resourceId: id,
        before: {
          number: row.number,
          amountMinor: Number(row.amountMinor),
          status: row.status,
        },
      });
    });
    return { deleted: true };
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  private async loadForWrite(id: string) {
    const row = await this.db.client.payment.findFirst({ where: { id } });
    if (!row) throw AppError.notFound('Payment');
    const allowed = this.scopes.canAct(PERMISSIONS.PAYMENT_RECORD, {
      userId: row.ownerUserId,
      teamId: row.teamId,
      branchId: row.branchId,
    });
    if (!allowed) throw AppError.notFound('Payment');
    return row;
  }

  private async loadMethod(methodId: string) {
    const method = await this.db.client.paymentMethod.findFirst({
      where: { id: methodId, deletedAt: null },
    });
    if (!method) throw AppError.notFound('Payment method');
    return method;
  }

  /**
   * What the payment is against, and from whom it inherits ownership.
   *
   * A `quotationId` or a `dealId` supplies everything, which is the normal case: somebody is paying
   * an invoice against a quote. A lead or a customer on its own is a walk-in deposit.
   */
  private async resolveSubject(input: RecordPaymentInput) {
    if (input.quotationId) {
      const quotation = await this.db.client.quotation.findFirst({
        where: { id: input.quotationId, deletedAt: null },
      });
      if (!quotation) throw AppError.notFound('Quotation');
      const allowed = this.scopes.canAct(PERMISSIONS.DEAL_READ, {
        userId: quotation.ownerUserId,
        teamId: quotation.teamId,
        branchId: quotation.branchId,
      });
      if (!allowed) throw AppError.notFound('Quotation');
      return {
        dealId: input.dealId ?? quotation.dealId,
        quotationId: quotation.id,
        leadId: input.leadId ?? quotation.leadId,
        customerId: input.customerId ?? quotation.customerId,
        branchId: quotation.branchId,
        teamId: quotation.teamId,
        ownerUserId: quotation.ownerUserId,
        currency: quotation.currency as string | null,
      };
    }

    if (input.dealId) {
      const deal = await this.db.client.deal.findFirst({
        where: { id: input.dealId, deletedAt: null },
      });
      if (!deal) throw AppError.notFound('Deal');
      const allowed = this.scopes.canAct(PERMISSIONS.DEAL_READ, {
        userId: deal.ownerUserId,
        teamId: deal.teamId,
        branchId: deal.branchId,
      });
      if (!allowed) throw AppError.notFound('Deal');
      return {
        dealId: deal.id,
        quotationId: null,
        leadId: input.leadId ?? deal.leadId,
        customerId: input.customerId ?? deal.customerId,
        branchId: deal.branchId,
        teamId: deal.teamId,
        ownerUserId: deal.ownerUserId,
        currency: deal.currency as string | null,
      };
    }

    let lead = null;
    let customer = null;
    if (input.leadId) {
      lead = await this.db.client.lead.findFirst({ where: { id: input.leadId, deletedAt: null } });
      if (!lead) throw AppError.notFound('Lead');
      const allowed = this.scopes.canAct(PERMISSIONS.LEAD_READ, {
        userId: lead.assignedUserId,
        teamId: lead.teamId,
        branchId: lead.branchId,
      });
      if (!allowed) throw AppError.notFound('Lead');
    }
    if (input.customerId) {
      customer = await this.db.client.customer.findFirst({
        where: { id: input.customerId, deletedAt: null },
      });
      if (!customer) throw AppError.notFound('Customer');
      const allowed = this.scopes.canAct(PERMISSIONS.CUSTOMER_READ, {
        userId: customer.ownerUserId,
        teamId: customer.teamId,
        branchId: customer.branchId,
      });
      if (!allowed) throw AppError.notFound('Customer');
    }

    return {
      dealId: null,
      quotationId: null,
      leadId: lead?.id ?? null,
      customerId: customer?.id ?? null,
      branchId: customer?.branchId ?? lead?.branchId ?? null,
      teamId: customer?.teamId ?? lead?.teamId ?? null,
      ownerUserId: customer?.ownerUserId ?? lead?.assignedUserId ?? null,
      currency: null as string | null,
    };
  }

  /**
   * One timeline entry per subject, never two for the same party.
   *
   * Named with a trailing underscore because `record()` is already the public method that records a
   * payment — and a method that shadows an injected `timeline` is the trap this repository has
   * already paid for once.
   */
  private async record_(
    tx: TransactionClient,
    subject: { dealId: string | null; leadId: string | null; customerId: string | null },
    entry: {
      type: string;
      occurredAt: Date;
      payload: Record<string, unknown>;
      actorType?: ActorType;
    },
  ): Promise<void> {
    const principal = tenantContext.get();
    const common = {
      type: entry.type,
      occurredAt: entry.occurredAt,
      payload: entry.payload,
      actorType: entry.actorType ?? principal?.actorType,
      actorId: entry.actorType ? null : (principal?.actorId ?? null),
    };

    const customerLeadId = subject.customerId
      ? ((
          await tx.customer.findFirst({
            where: { id: subject.customerId },
            select: { leadId: true },
          })
        )?.leadId ?? null)
      : null;
    const partyAlreadyCovered = subject.leadId !== null && customerLeadId === subject.leadId;

    await this.timeline.recordManyInTransaction(tx, [
      ...(subject.dealId ? [{ ...common, dealId: subject.dealId }] : []),
      ...(subject.leadId ? [{ ...common, leadId: subject.leadId }] : []),
      ...(subject.customerId && !partyAlreadyCovered
        ? [{ ...common, customerId: subject.customerId }]
        : []),
    ] as never);
  }

  private listInclude() {
    return {
      method: { select: { id: true, name: true } },
      deal: { select: { id: true, name: true } },
      quotation: { select: { id: true, number: true, version: true } },
      lead: { select: { id: true, fullName: true } },
      customer: { select: { id: true, fullName: true } },
    };
  }

  private present(row: {
    id: string;
    number: string;
    amountMinor: bigint;
    currency: string;
    status: string;
    reference: string | null;
    paidAt: Date | null;
    failedAt: Date | null;
    refundedAt: Date | null;
    outcomeNote: string | null;
    methodId: string | null;
    dealId: string | null;
    quotationId: string | null;
    leadId: string | null;
    customerId: string | null;
    ownerUserId: string | null;
    createdAt: Date;
    updatedAt: Date;
    deletedAt: Date | null;
    method?: { id: string; name: string } | null;
    deal?: { id: string; name: string } | null;
    quotation?: { id: string; number: string; version: number } | null;
    lead?: { id: string; fullName: string | null } | null;
    customer?: { id: string; fullName: string | null } | null;
  }) {
    return {
      id: row.id,
      number: row.number,
      amountMinor: Number(row.amountMinor),
      currency: row.currency,
      status: row.status,
      reference: row.reference,
      paidAt: row.paidAt,
      failedAt: row.failedAt,
      refundedAt: row.refundedAt,
      outcomeNote: row.outcomeNote,
      methodId: row.methodId,
      method: row.method ?? null,
      dealId: row.dealId,
      deal: row.deal ?? null,
      quotationId: row.quotationId,
      quotation: row.quotation
        ? {
            id: row.quotation.id,
            number: row.quotation.number,
            version: row.quotation.version,
            label:
              row.quotation.version > 1
                ? `${row.quotation.number} v${row.quotation.version}`
                : row.quotation.number,
          }
        : null,
      leadId: row.leadId,
      lead: row.lead ?? null,
      customerId: row.customerId,
      customer: row.customer ?? null,
      ownerUserId: row.ownerUserId,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      deletedAt: row.deletedAt,
    };
  }
}
