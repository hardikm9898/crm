import { Injectable } from '@nestjs/common';
import {
  ACTIVITY_TYPES,
  AppError,
  PERMISSIONS,
  documentTotals,
  newId,
  tenantContext,
  systemPrincipal,
  withPlatformScope,
  type ActorType,
} from '@leados/shared';
import { DbService } from '../../infra/db/db.service.js';
import { AuditService } from '../../infra/audit/audit.service.js';
import { OutboxService, type TransactionClient } from '../../infra/outbox/outbox.service.js';
import { TimelineService } from '../../infra/timeline/timeline.service.js';
import { DataScopeService, applyScopeFilter } from '../../infra/authz/data-scope.service.js';
import { LineBuilderService, type LineItemRequest } from '../deals/line-builder.service.js';
import { NUMBER_SERIES_KINDS, NumberSeriesService } from './number-series.service.js';
import type {
  AcceptQuotationInput,
  CreateQuotationInput,
  ListQuotationsQuery,
  RejectQuotationInput,
  ReviseQuotationInput,
  SendQuotationInput,
  SetQuotationItemsInput,
  UpdateQuotationInput,
} from './quotations.dto.js';

/**
 * Quotations (`FR-DEAL-2`).
 *
 * Four decisions shape this file, and all four come from one observation: a quotation is not a
 * record of what we think, it is **a copy of what the customer was told**.
 *
 *  * **A version is immutable; a revision is a new row.** `number` is what the customer quotes back
 *    at you and `version` is which one they are holding. Editing a sent quotation in place would
 *    make "what did we actually send on the 14th?" unanswerable — which is the one question a
 *    disputed quotation is about. See
 *    [ADR-0019](../../../../../docs/decisions/ADR-0019-quotation-versions-are-immutable.md).
 *  * **The number comes from a locked counter, not from `MAX(…) + 1`.** `NumberSeriesService` owns
 *    that, and it is allocated inside the same transaction as the insert so a rolled-back write
 *    cannot burn a number.
 *  * **The lines are copied from the deal, not referenced.** The deal goes on moving — a line
 *    added, a price renegotiated — and the document does not. `LineBuilderService` builds both, so
 *    the two can never price the same line differently.
 *  * **Accepting writes the agreed figure back onto the deal, while the deal is still open.** A
 *    pipeline forecast that disagrees with the quotation the customer signed is worse than no
 *    forecast. A won or lost deal is left alone: that sale is already settled.
 */
@Injectable()
export class QuotationsService {
  constructor(
    private readonly db: DbService,
    private readonly scopes: DataScopeService,
    private readonly lines: LineBuilderService,
    private readonly series: NumberSeriesService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly timeline: TimelineService,
  ) {}

  // ── Reading ───────────────────────────────────────────────────────────────

  async list(query: ListQuotationsQuery) {
    const filter = this.scopes.filterFor(PERMISSIONS.DEAL_READ, {
      userColumn: 'ownerUserId',
      teamColumn: 'teamId',
      branchColumn: 'branchId',
    });

    const baseWhere: Record<string, unknown> = {
      deletedAt: query.deleted === true ? { not: null } : null,
      ...(query.dealId ? { dealId: query.dealId } : {}),
      ...(query.leadId ? { leadId: query.leadId } : {}),
      ...(query.customerId ? { customerId: query.customerId } : {}),
      ...(query.ownerUserId ? { ownerUserId: query.ownerUserId } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.number ? { number: query.number } : {}),
      // A list of quotations means the current version of each, unless the history is asked for.
      ...(query.versions === 'current' ? { supersededAt: null } : {}),
    };
    const where = applyScopeFilter(baseWhere, filter);
    if (where === null) {
      return {
        items: [],
        meta: { totalMinor: 0 },
        pagination: { limit: query.limit, nextCursor: null, hasMore: false, total: 0 },
      };
    }

    const orderBy =
      query.sort === 'total'
        ? { totalMinor: query.direction }
        : query.sort === 'valid_until'
          ? { validUntil: query.direction }
          : { createdAt: query.direction };

    const [total, rows, sums] = await Promise.all([
      this.db.client.quotation.count({ where }),
      this.db.client.quotation.findMany({
        where,
        orderBy,
        take: query.limit + 1,
        ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
        include: this.listInclude(),
      }),
      this.db.client.quotation.aggregate({ where, _sum: { totalMinor: true } }),
    ]);

    const page = rows.slice(0, query.limit);
    const hasMore = rows.length > query.limit;
    return {
      items: page.map((row) => this.present(row)),
      /** The whole filter's value, not the page's — the same reason the deal list reports one. */
      meta: { totalMinor: Number(sums._sum.totalMinor ?? 0) },
      pagination: {
        limit: query.limit,
        nextCursor: hasMore ? (page.at(-1)?.id ?? null) : null,
        hasMore,
        total,
      },
    };
  }

  async findOne(id: string) {
    const row = await this.db.client.quotation.findFirst({
      where: { id },
      include: { ...this.listInclude(), items: { orderBy: { position: 'asc' } } },
    });
    if (!row) throw AppError.notFound('Quotation');
    this.assertCanSee(row);

    // Every version of this number, so a screen can show the history without a second request.
    const versions = await this.db.client.quotation.findMany({
      where: { number: row.number },
      orderBy: { version: 'asc' },
      select: { id: true, version: true, status: true, totalMinor: true, createdAt: true },
    });

    return {
      ...this.present(row),
      items: row.items.map((item) => ({
        id: item.id,
        productId: item.productId,
        position: item.position,
        name: item.name,
        description: item.description,
        quantity: Number(item.quantity),
        unit: item.unit,
        unitPriceMinor: Number(item.unitPriceMinor),
        discountMinor: Number(item.discountMinor),
        taxPercent: Number(item.taxPercent),
        grossMinor: Number(item.grossMinor),
        netMinor: Number(item.netMinor),
        taxMinor: Number(item.taxMinor),
        totalMinor: Number(item.totalMinor),
      })),
      versions: versions.map((version) => ({
        id: version.id,
        version: version.version,
        status: version.status,
        totalMinor: Number(version.totalMinor),
        createdAt: version.createdAt,
      })),
    };
  }

  // ── Writing ───────────────────────────────────────────────────────────────

  async create(input: CreateQuotationInput) {
    const principal = tenantContext.require('quotations.create');
    const organization = await this.db.client.organization.findUniqueOrThrow({
      where: { id: principal.organizationId },
      select: { defaultCurrency: true },
    });

    const subject = await this.resolveSubject(input);
    const requests = input.items ?? subject.dealLines;
    const lines = await this.lines.build(requests);
    const totals = documentTotals(lines.map((line) => line.input));
    const currency = input.currency ?? subject.currency ?? organization.defaultCurrency;

    const id = newId();
    const now = new Date();

    await this.db.client.$transaction(async (tx) => {
      const allocated = await this.series.allocate(tx, NUMBER_SERIES_KINDS.QUOTATION);
      await tx.quotation.create({
        data: {
          id,
          organizationId: principal.organizationId,
          dealId: subject.dealId,
          leadId: subject.leadId,
          customerId: subject.customerId,
          branchId: subject.branchId,
          teamId: subject.teamId,
          ownerUserId: subject.ownerUserId,
          number: allocated.number,
          version: 1,
          status: 'draft',
          ...(input.title ? { title: input.title } : {}),
          ...(input.terms !== undefined && input.terms !== null ? { terms: input.terms } : {}),
          ...(input.validUntil ? { validUntil: input.validUntil } : {}),
          grossMinor: BigInt(totals.grossMinor),
          discountMinor: BigInt(totals.discountMinor),
          taxMinor: BigInt(totals.taxMinor),
          totalMinor: BigInt(totals.totalMinor),
          currency,
          createdById: principal.actorId ?? null,
        },
      });
      await this.lines.write(
        tx,
        { table: 'quotationItem', parentColumn: 'quotationId', parentId: id },
        principal.organizationId,
        lines,
      );
      await this.record(tx, subject, {
        type: ACTIVITY_TYPES.QUOTATION_CREATED,
        occurredAt: now,
        payload: {
          quotationId: id,
          number: allocated.number,
          version: 1,
          totalMinor: totals.totalMinor,
          currency,
          items: lines.length,
        },
      });
      await this.audit.recordInTransaction(tx, {
        action: 'quotation.created',
        resourceType: 'quotation',
        resourceId: id,
        after: { number: allocated.number, totalMinor: totals.totalMinor, currency },
      });
      await this.outbox.emit(tx, [
        {
          name: 'quotation.created',
          aggregateType: 'quotation',
          aggregateId: id,
          payload: {
            dealId: subject.dealId,
            number: allocated.number,
            totalMinor: totals.totalMinor,
            currency,
          },
        },
      ]);
    });

    return this.findOne(id);
  }

  async update(id: string, input: UpdateQuotationInput) {
    const row = await this.loadForWrite(id);
    this.assertDraft(row, 'change');

    await this.db.client.$transaction(async (tx) => {
      await tx.quotation.update({
        where: { id },
        data: {
          ...(input.title !== undefined ? { title: input.title } : {}),
          ...(input.terms !== undefined ? { terms: input.terms } : {}),
          ...(input.validUntil !== undefined ? { validUntil: input.validUntil } : {}),
        },
      });
      await this.audit.recordInTransaction(tx, {
        action: 'quotation.updated',
        resourceType: 'quotation',
        resourceId: id,
        after: { ...input },
      });
    });
    return this.findOne(id);
  }

  /**
   * Replaces the whole set of lines, and recomputes the header in the same transaction.
   *
   * Draft only. A sent quotation's lines are what the customer was told, and a revision is how they
   * change — which is the difference between a correction and a rewrite of history.
   */
  async setItems(id: string, input: SetQuotationItemsInput) {
    const principal = tenantContext.require('quotations.setItems');
    const row = await this.loadForWrite(id);
    this.assertDraft(row, 'reprice');

    const lines = await this.lines.build(input.items);
    const totals = documentTotals(lines.map((line) => line.input));

    await this.db.client.$transaction(async (tx) => {
      await tx.quotationItem.deleteMany({ where: { quotationId: id } });
      await this.lines.write(
        tx,
        { table: 'quotationItem', parentColumn: 'quotationId', parentId: id },
        principal.organizationId,
        lines,
      );
      await tx.quotation.update({
        where: { id },
        data: {
          grossMinor: BigInt(totals.grossMinor),
          discountMinor: BigInt(totals.discountMinor),
          taxMinor: BigInt(totals.taxMinor),
          totalMinor: BigInt(totals.totalMinor),
        },
      });
      await this.audit.recordInTransaction(tx, {
        action: 'quotation.items_replaced',
        resourceType: 'quotation',
        resourceId: id,
        before: { totalMinor: Number(row.totalMinor) },
        after: { totalMinor: totals.totalMinor, items: lines.length },
      });
    });
    return this.findOne(id);
  }

  /**
   * Draft → sent. The moment the document stops being ours and starts being theirs.
   *
   * It refuses an empty quotation — a priced offer with no lines is a blank page — and it is the
   * transition after which `setItems` and `update` stop working.
   */
  async send(id: string, input: SendQuotationInput) {
    const row = await this.loadForWrite(id);
    this.assertDraft(row, 'send');

    const itemCount = await this.db.client.quotationItem.count({ where: { quotationId: id } });
    if (itemCount === 0) {
      throw AppError.businessRule('Add at least one line before sending this quotation.');
    }

    const sentAt = input.sentAt ?? new Date();
    const subject = this.subjectOf(row);

    await this.db.client.$transaction(async (tx) => {
      await tx.quotation.update({
        where: { id },
        data: {
          status: 'sent',
          sentAt,
          sentVia: input.via,
          ...(input.to ? { sentTo: input.to } : {}),
        },
      });
      await this.record(tx, subject, {
        type: ACTIVITY_TYPES.QUOTATION_SENT,
        occurredAt: sentAt,
        payload: {
          quotationId: id,
          number: row.number,
          version: row.version,
          totalMinor: Number(row.totalMinor),
          currency: row.currency,
          via: input.via,
          ...(input.to ? { to: input.to } : {}),
          ...(row.validUntil ? { validUntil: row.validUntil.toISOString().slice(0, 10) } : {}),
        },
      });
      await this.audit.recordInTransaction(tx, {
        action: 'quotation.sent',
        resourceType: 'quotation',
        resourceId: id,
        after: { via: input.via, to: input.to ?? null, sentAt },
      });
      await this.outbox.emit(tx, [
        {
          name: 'quotation.sent',
          aggregateType: 'quotation',
          aggregateId: id,
          payload: {
            dealId: row.dealId,
            leadId: row.leadId,
            customerId: row.customerId,
            number: row.number,
            totalMinor: Number(row.totalMinor),
            currency: row.currency,
            via: input.via,
          },
        },
      ]);
    });

    return this.findOne(id);
  }

  async accept(id: string, input: AcceptQuotationInput) {
    const row = await this.loadForWrite(id);
    if (row.status === 'accepted') return this.findOne(id);
    if (row.status !== 'sent') {
      throw AppError.businessRule(
        row.status === 'expired'
          ? 'That quotation has expired. Revise it to re-issue the price, then send it again.'
          : `A ${row.status} quotation cannot be accepted.`,
      );
    }
    if (row.supersededAt) {
      throw AppError.businessRule(
        'A newer version of this quotation has been raised. Accept that one instead.',
      );
    }

    const acceptedAt = input.acceptedAt ?? new Date();
    const subject = this.subjectOf(row);

    await this.db.client.$transaction(async (tx) => {
      await tx.quotation.update({
        where: { id },
        data: {
          status: 'accepted',
          acceptedAt,
          ...(input.note ? { outcomeNote: input.note } : {}),
        },
      });

      /**
       * The accepted figure becomes the deal's, **while the deal is still open**.
       *
       * A forecast that disagrees with the document the customer signed is worse than no forecast.
       * A won or lost deal is left alone: that sale is settled, and quietly rewriting a closed
       * deal's value would change a revenue report that has already been read.
       */
      const sync = await this.syncDealValue(tx, row.dealId, id);

      await this.record(tx, subject, {
        type: ACTIVITY_TYPES.QUOTATION_ACCEPTED,
        occurredAt: acceptedAt,
        payload: {
          quotationId: id,
          number: row.number,
          version: row.version,
          totalMinor: Number(row.totalMinor),
          currency: row.currency,
          dealValueUpdated: sync === 'updated',
          /**
           * Why it was *not* updated, when it was not.
           *
           * Found by accepting a quotation on a lost deal: the figure quietly did not move and the
           * timeline said nothing, so the only way to notice was to go and look at the deal. A
           * refusal nobody can see is indistinguishable from a bug.
           */
          ...(sync === 'deal-closed' ? { dealClosed: true } : {}),
          ...(input.note ? { note: input.note } : {}),
        },
      });
      await this.audit.recordInTransaction(tx, {
        action: 'quotation.accepted',
        resourceType: 'quotation',
        resourceId: id,
        after: { totalMinor: Number(row.totalMinor), acceptedAt, dealValue: sync },
      });
      await this.outbox.emit(tx, [
        {
          name: 'quotation.accepted',
          aggregateType: 'quotation',
          aggregateId: id,
          payload: {
            dealId: row.dealId,
            number: row.number,
            totalMinor: Number(row.totalMinor),
            currency: row.currency,
          },
        },
      ]);
    });

    return this.findOne(id);
  }

  async reject(id: string, input: RejectQuotationInput) {
    const row = await this.loadForWrite(id);
    if (row.status === 'rejected') return this.findOne(id);
    if (row.status !== 'sent') {
      throw AppError.businessRule(`A ${row.status} quotation cannot be rejected.`);
    }
    if (input.reasonId) await this.assertReason(input.reasonId);

    const rejectedAt = input.rejectedAt ?? new Date();
    const subject = this.subjectOf(row);

    await this.db.client.$transaction(async (tx) => {
      await tx.quotation.update({
        where: { id },
        data: {
          status: 'rejected',
          rejectedAt,
          ...(input.reasonId ? { rejectedReasonId: input.reasonId } : {}),
          ...(input.note ? { outcomeNote: input.note } : {}),
        },
      });
      await this.record(tx, subject, {
        type: ACTIVITY_TYPES.QUOTATION_REJECTED,
        occurredAt: rejectedAt,
        payload: {
          quotationId: id,
          number: row.number,
          version: row.version,
          totalMinor: Number(row.totalMinor),
          currency: row.currency,
          ...(input.reasonId ? { reasonId: input.reasonId } : {}),
          ...(input.note ? { note: input.note } : {}),
        },
      });
      await this.audit.recordInTransaction(tx, {
        action: 'quotation.rejected',
        resourceType: 'quotation',
        resourceId: id,
        after: { reasonId: input.reasonId ?? null, rejectedAt },
      });
      await this.outbox.emit(tx, [
        {
          name: 'quotation.rejected',
          aggregateType: 'quotation',
          aggregateId: id,
          payload: { dealId: row.dealId, number: row.number, reasonId: input.reasonId ?? null },
        },
      ]);
    });

    return this.findOne(id);
  }

  /**
   * A new version of the same number, superseding this one.
   *
   * A draft is refused: there is nothing to preserve, so editing it is the right move and a second
   * version would be a version of a document nobody has seen.
   */
  async revise(id: string, input: ReviseQuotationInput) {
    const principal = tenantContext.require('quotations.revise');
    const row = await this.loadForWrite(id);
    if (row.status === 'draft') {
      throw AppError.businessRule(
        'This quotation is still a draft — edit it instead of revising it. A revision exists to preserve what was already sent.',
      );
    }
    if (row.supersededAt) {
      throw AppError.businessRule(
        'This version has already been revised. Revise the latest version instead.',
      );
    }

    const existing = await this.db.client.quotationItem.findMany({
      where: { quotationId: id },
      orderBy: { position: 'asc' },
    });
    const requests: LineItemRequest[] = input.items ?? LineBuilderService.asRequests(existing);
    const lines = await this.lines.build(requests);
    const totals = documentTotals(lines.map((line) => line.input));

    const newVersionId = newId();
    const now = new Date();
    const subject = this.subjectOf(row);

    await this.db.client.$transaction(async (tx) => {
      await tx.quotation.create({
        data: {
          id: newVersionId,
          organizationId: principal.organizationId,
          dealId: row.dealId,
          leadId: row.leadId,
          customerId: row.customerId,
          branchId: row.branchId,
          teamId: row.teamId,
          ownerUserId: row.ownerUserId,
          // Same number: it is the same quotation, at a later price.
          number: row.number,
          version: row.version + 1,
          status: 'draft',
          title: input.title !== undefined ? input.title : row.title,
          terms: input.terms !== undefined ? input.terms : row.terms,
          validUntil: input.validUntil !== undefined ? input.validUntil : row.validUntil,
          grossMinor: BigInt(totals.grossMinor),
          discountMinor: BigInt(totals.discountMinor),
          taxMinor: BigInt(totals.taxMinor),
          totalMinor: BigInt(totals.totalMinor),
          currency: row.currency,
          createdById: principal.actorId ?? null,
        },
      });
      await this.lines.write(
        tx,
        { table: 'quotationItem', parentColumn: 'quotationId', parentId: newVersionId },
        principal.organizationId,
        lines,
      );
      // The old row keeps its status — it *was* sent, and that remains true — and gains a pointer
      // to what replaced it. Nothing about what the customer received is edited.
      await tx.quotation.update({
        where: { id },
        data: { supersededById: newVersionId, supersededAt: now },
      });
      await this.record(tx, subject, {
        type: ACTIVITY_TYPES.QUOTATION_REVISED,
        occurredAt: now,
        payload: {
          quotationId: newVersionId,
          supersededId: id,
          number: row.number,
          fromVersion: row.version,
          version: row.version + 1,
          fromTotalMinor: Number(row.totalMinor),
          totalMinor: totals.totalMinor,
          currency: row.currency,
        },
      });
      await this.audit.recordInTransaction(tx, {
        action: 'quotation.revised',
        resourceType: 'quotation',
        resourceId: newVersionId,
        before: { version: row.version, totalMinor: Number(row.totalMinor) },
        after: { version: row.version + 1, totalMinor: totals.totalMinor },
      });
    });

    return this.findOne(newVersionId);
  }

  /** Soft delete, draft only. A sent quotation is a document that left the building. */
  async remove(id: string) {
    const row = await this.loadForWrite(id);
    if (row.deletedAt) return { deleted: true };
    if (row.status !== 'draft') {
      throw AppError.businessRule(
        'This quotation has already been sent, so it cannot be deleted. Revise it, or mark it rejected.',
      );
    }

    await this.db.client.$transaction(async (tx) => {
      await tx.quotation.update({
        where: { id },
        data: { deletedAt: new Date() },
      });
      await this.audit.recordInTransaction(tx, {
        action: 'quotation.deleted',
        resourceType: 'quotation',
        resourceId: id,
        before: { number: row.number, version: row.version, status: row.status },
      });
    });
    return { deleted: true };
  }

  /**
   * The expiry sweep (`maintenance.quotation-expiry`).
   *
   * Cross-tenant by nature, so it opts into platform scope explicitly. A quotation that has run out
   * of validity has to *say* so: a price from April that still reads "sent" is one somebody will
   * honour by accident.
   */
  async expireDue(limit = 500): Promise<{ examined: number; expired: number }> {
    const today = new Date();
    const due = await withPlatformScope('quotations: expiry sweep', async () =>
      this.db.client.quotation.findMany({
        where: {
          status: 'sent',
          validUntil: { lt: today },
          deletedAt: null,
        },
        select: {
          id: true,
          organizationId: true,
          number: true,
          version: true,
          totalMinor: true,
          currency: true,
          dealId: true,
          leadId: true,
          customerId: true,
        },
        orderBy: { validUntil: 'asc' },
        take: limit,
      }),
    );

    let expired = 0;
    for (const row of due) {
      /**
       * The *read* is cross-tenant; the *write* is not.
       *
       * A timeline entry belongs to one workspace, and `TimelineService` takes the organization
       * from the context rather than from an argument — deliberately, so no caller can write a row
       * into the wrong tenant. So the sweep enters each row's own tenant context as a system
       * principal, which is also what makes the entry say "system" rather than naming whoever
       * happened to deploy last.
       */
      await tenantContext.run(systemPrincipal(row.organizationId, newId()), async () => {
        await this.db.client.$transaction(async (tx) => {
          const updated = await tx.quotation.updateMany({
            // `status: 'sent'` in the predicate makes the sweep idempotent: a quotation accepted
            // between the read and the write is not quietly expired underneath the acceptance.
            where: { id: row.id, status: 'sent' },
            data: { status: 'expired', expiredAt: today },
          });
          if (updated.count === 0) return;
          expired += 1;
          await this.record(
            tx,
            {
              dealId: row.dealId,
              leadId: row.leadId,
              customerId: row.customerId,
            },
            {
              type: ACTIVITY_TYPES.QUOTATION_EXPIRED,
              occurredAt: today,
              payload: {
                quotationId: row.id,
                number: row.number,
                version: row.version,
                totalMinor: Number(row.totalMinor),
                currency: row.currency,
              },
              // The sweep is not a person.
              actorType: 'system',
            },
          );
        });
      });
    }
    return { examined: due.length, expired };
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  /** Loaded for writing, with the caller's authority on it checked. 404 either way. */
  private async loadForWrite(id: string) {
    const row = await this.db.client.quotation.findFirst({ where: { id } });
    if (!row) throw AppError.notFound('Quotation');
    const allowed = this.scopes.canAct(PERMISSIONS.DEAL_MANAGE, {
      userId: row.ownerUserId,
      teamId: row.teamId,
      branchId: row.branchId,
    });
    if (!allowed) throw AppError.notFound('Quotation');
    return row;
  }

  private assertCanSee(row: {
    ownerUserId: string | null;
    teamId: string | null;
    branchId: string | null;
  }): void {
    const allowed = this.scopes.canAct(PERMISSIONS.DEAL_READ, {
      userId: row.ownerUserId,
      teamId: row.teamId,
      branchId: row.branchId,
    });
    if (!allowed) throw AppError.notFound('Quotation');
  }

  private assertDraft(row: { status: string }, verb: string): void {
    if (row.status === 'draft') return;
    throw AppError.businessRule(
      `This quotation has already been sent, so it cannot be ${verb}d. Raise a revision instead — the customer keeps the version they were given.`,
    );
  }

  private async assertReason(reasonId: string): Promise<void> {
    const reason = await this.db.client.lostReason.findFirst({
      where: { id: reasonId, deletedAt: null },
    });
    if (!reason) throw AppError.notFound('Lost reason');
  }

  /**
   * Where the quotation hangs, and from whom it inherits ownership.
   *
   * A `dealId` is the normal case and supplies everything — party, branch, team, owner, currency
   * and the lines to copy. A lead or a customer on its own is the walk-in case.
   */
  private async resolveSubject(input: CreateQuotationInput) {
    if (input.dealId) {
      const deal = await this.db.client.deal.findFirst({
        where: { id: input.dealId, deletedAt: null },
        include: { items: { orderBy: { position: 'asc' } } },
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
        leadId: input.leadId ?? deal.leadId,
        customerId: input.customerId ?? deal.customerId,
        branchId: deal.branchId,
        teamId: deal.teamId,
        ownerUserId: deal.ownerUserId,
        currency: deal.currency,
        dealLines: LineBuilderService.asRequests(deal.items),
      };
    }

    let lead = null;
    let customer = null;
    if (input.leadId) {
      lead = await this.db.client.lead.findFirst({
        where: { id: input.leadId, deletedAt: null },
      });
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
      leadId: lead?.id ?? null,
      customerId: customer?.id ?? null,
      branchId: customer?.branchId ?? lead?.branchId ?? null,
      teamId: customer?.teamId ?? lead?.teamId ?? null,
      ownerUserId: customer?.ownerUserId ?? lead?.assignedUserId ?? null,
      currency: null as string | null,
      dealLines: [] as LineItemRequest[],
    };
  }

  private subjectOf(row: {
    dealId: string | null;
    leadId: string | null;
    customerId: string | null;
  }) {
    return { dealId: row.dealId, leadId: row.leadId, customerId: row.customerId };
  }

  /**
   * One timeline entry per subject the quotation touches — the deal it belongs to and the party it
   * is for — never two for the same party.
   *
   * A converted person's timeline is the union of their lead's entries and their customer's
   * (`FR-DEAL-4`), so writing against both columns when both are set would show the same sentence
   * twice on the customer's screen. The lead row is the one kept, because the union already carries
   * it across; the customer row is written only when it would not otherwise appear.
   */
  private async record(
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

  /**
   * Copies the accepted quotation's lines and totals onto its deal, if the deal is still open.
   *
   * Returns **why** it did or did not, not merely whether: a value that changed without anybody
   * seeing why erodes trust in a forecast, and a value that did *not* change when somebody expected
   * it to is worse — it looks like the acceptance did not register.
   */
  private async syncDealValue(
    tx: TransactionClient,
    dealId: string | null,
    quotationId: string,
  ): Promise<'updated' | 'no-deal' | 'deal-closed' | 'no-lines'> {
    if (!dealId) return 'no-deal';
    const deal = await tx.deal.findFirst({
      where: { id: dealId },
      select: { id: true, organizationId: true, wonAt: true, lostAt: true, deletedAt: true },
    });
    if (!deal) return 'no-deal';
    if (deal.deletedAt || deal.wonAt || deal.lostAt) return 'deal-closed';

    const items = await tx.quotationItem.findMany({
      where: { quotationId },
      orderBy: { position: 'asc' },
    });
    if (items.length === 0) return 'no-lines';

    const totals = documentTotals(
      items.map((item) => ({
        quantity: Number(item.quantity),
        unitPriceMinor: Number(item.unitPriceMinor),
        discountMinor: Number(item.discountMinor),
        taxPercent: Number(item.taxPercent),
      })),
    );

    await tx.dealItem.deleteMany({ where: { dealId } });
    await tx.dealItem.createMany({
      data: items.map((item) => ({
        id: newId(),
        organizationId: deal.organizationId,
        dealId,
        productId: item.productId,
        position: item.position,
        name: item.name,
        description: item.description,
        quantity: item.quantity,
        unit: item.unit,
        unitPriceMinor: item.unitPriceMinor,
        discountMinor: item.discountMinor,
        taxPercent: item.taxPercent,
        grossMinor: item.grossMinor,
        netMinor: item.netMinor,
        taxMinor: item.taxMinor,
        totalMinor: item.totalMinor,
      })),
    });
    await tx.deal.update({
      where: { id: dealId },
      data: {
        grossMinor: BigInt(totals.grossMinor),
        discountMinor: BigInt(totals.discountMinor),
        taxMinor: BigInt(totals.taxMinor),
        valueMinor: BigInt(totals.totalMinor),
        lastActivityAt: new Date(),
      },
    });
    return 'updated';
  }

  private listInclude() {
    return {
      deal: { select: { id: true, name: true } },
      lead: { select: { id: true, fullName: true } },
      customer: { select: { id: true, fullName: true } },
      rejectedReason: { select: { id: true, name: true } },
    };
  }

  private present(row: {
    id: string;
    number: string;
    version: number;
    status: string;
    title: string | null;
    terms?: string | null;
    validUntil: Date | null;
    grossMinor: bigint;
    discountMinor: bigint;
    taxMinor: bigint;
    totalMinor: bigint;
    currency: string;
    dealId: string | null;
    leadId: string | null;
    customerId: string | null;
    ownerUserId: string | null;
    supersededById: string | null;
    supersededAt: Date | null;
    sentAt: Date | null;
    sentVia: string | null;
    sentTo: string | null;
    acceptedAt: Date | null;
    rejectedAt: Date | null;
    expiredAt: Date | null;
    outcomeNote: string | null;
    pdfDocumentId: string | null;
    createdAt: Date;
    updatedAt: Date;
    deletedAt: Date | null;
    deal?: { id: string; name: string } | null;
    lead?: { id: string; fullName: string | null } | null;
    customer?: { id: string; fullName: string | null } | null;
    rejectedReason?: { id: string; name: string } | null;
  }) {
    return {
      id: row.id,
      number: row.number,
      version: row.version,
      /** `QTN-0007 v2` — what a person says out loud when there is more than one version. */
      label: row.version > 1 ? `${row.number} v${row.version}` : row.number,
      status: row.status,
      title: row.title,
      ...(row.terms !== undefined ? { terms: row.terms } : {}),
      validUntil: row.validUntil,
      grossMinor: Number(row.grossMinor),
      discountMinor: Number(row.discountMinor),
      taxMinor: Number(row.taxMinor),
      totalMinor: Number(row.totalMinor),
      currency: row.currency,
      dealId: row.dealId,
      deal: row.deal ?? null,
      leadId: row.leadId,
      lead: row.lead ?? null,
      customerId: row.customerId,
      customer: row.customer ?? null,
      ownerUserId: row.ownerUserId,
      supersededById: row.supersededById,
      supersededAt: row.supersededAt,
      /** True for the version anybody should be looking at. */
      isCurrent: row.supersededAt === null,
      sentAt: row.sentAt,
      sentVia: row.sentVia,
      sentTo: row.sentTo,
      acceptedAt: row.acceptedAt,
      rejectedAt: row.rejectedAt,
      rejectedReason: row.rejectedReason ?? null,
      expiredAt: row.expiredAt,
      outcomeNote: row.outcomeNote,
      hasPdf: row.pdfDocumentId !== null,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      deletedAt: row.deletedAt,
    };
  }
}
