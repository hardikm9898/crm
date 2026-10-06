import { Injectable } from '@nestjs/common';
import {
  ACTIVITY_TYPES,
  AppError,
  LineItemError,
  PERMISSIONS,
  documentTotals,
  lineTotals,
  newId,
  searchTextFor,
  tenantContext,
  validateCustomValues,
  weightedValueMinor,
  type CountryCode,
  type LineItemInput,
} from '@leados/shared';
import { DbService } from '../../infra/db/db.service.js';
import { AuditService } from '../../infra/audit/audit.service.js';
import { OutboxService, type TransactionClient } from '../../infra/outbox/outbox.service.js';
import { TimelineService } from '../../infra/timeline/timeline.service.js';
import { TimelineReadService } from '../../infra/timeline/timeline-read.service.js';
import { DataScopeService, applyScopeFilter } from '../../infra/authz/data-scope.service.js';
import { FieldRegistryService } from '../custom-fields/field-registry.service.js';
import type {
  CreateDealInput,
  DealBoardQuery,
  ListDealsQuery,
  LoseDealInput,
  MoveDealInput,
  SetDealItemsInput,
  UpdateDealInput,
  WinDealInput,
} from './deals.dto.js';

/**
 * Deals (`FR-DEAL-1`).
 *
 * A deal is money being discussed, and it is a separate record from the lead for a reason that shows
 * up immediately: one customer can have three deals running, and a lead that closed in March can
 * come back in September. A status column on the lead cannot represent either.
 *
 * Four decisions shape this file:
 *
 *  * **The total is the sum of the lines, whenever there are lines.** One source of truth, computed
 *    by `documentTotals()` in `@leados/shared` — the same function the quotation and its PDF will
 *    use, so the three can never disagree about what a customer owes. The database enforces the
 *    arithmetic (`deals_totals_add_up`, `deal_items_total_is_net_plus_tax`) rather than trusting it.
 *  * **A line states what was agreed.** Name, price and tax rate are copied from the product at
 *    write time, never read from the catalogue at display time: a price change today must not
 *    rewrite last quarter's quotations.
 *  * **Probability comes from the stage, and is overridable per deal.** A stage's probability is the
 *    business's rule of thumb; a particular deal is sometimes known to be better or worse.
 *  * **Rule 6 is satisfied on both subjects.** A deal's own history lives on the deal, and the
 *    entries a business owner needs — a deal opened, won, lost — are also written to the lead's or
 *    the customer's timeline, because that is the screen they actually open.
 */
@Injectable()
export class DealsService {
  constructor(
    private readonly db: DbService,
    private readonly scopes: DataScopeService,
    private readonly fields: FieldRegistryService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly timeline: TimelineService,
    private readonly reader: TimelineReadService,
  ) {}

  // ── Reading ───────────────────────────────────────────────────────────────

  async list(query: ListDealsQuery) {
    const filter = this.scopes.filterFor(PERMISSIONS.DEAL_READ, {
      userColumn: 'ownerUserId',
      teamColumn: 'teamId',
      branchColumn: 'branchId',
    });

    const baseWhere: Record<string, unknown> = {
      deletedAt: query.deleted === true ? { not: null } : null,
      ...(query.leadId ? { leadId: query.leadId } : {}),
      ...(query.customerId ? { customerId: query.customerId } : {}),
      ...(query.ownerUserId ? { ownerUserId: query.ownerUserId } : {}),
      ...(query.pipelineId ? { pipelineId: query.pipelineId } : {}),
      ...(query.stageId ? { stageId: query.stageId } : {}),
      ...(query.closingBefore ? { expectedCloseDate: { lte: query.closingBefore } } : {}),
      ...this.outcomeWhere(query.outcome),
    };
    const where = applyScopeFilter(baseWhere, filter);
    if (where === null) return this.emptyPage(query.limit);

    if (query.search) {
      const matched = await this.searchIds(query.search, query.limit * 4);
      if (matched.length === 0) return this.emptyPage(query.limit);
      where['id'] = { in: matched };
    }

    const orderBy =
      query.sort === 'value'
        ? { valueMinor: query.direction }
        : query.sort === 'expected_close_date'
          ? { expectedCloseDate: query.direction }
          : query.sort === 'updated_at'
            ? { updatedAt: query.direction }
            : { createdAt: query.direction };

    const [total, rows, sums] = await Promise.all([
      this.db.client.deal.count({ where }),
      this.db.client.deal.findMany({
        where,
        orderBy,
        take: query.limit + 1,
        ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
        include: this.listInclude(),
      }),
      this.db.client.deal.aggregate({ where, _sum: { valueMinor: true } }),
    ]);

    const page = rows.slice(0, query.limit);
    const hasMore = rows.length > query.limit;
    return {
      items: page.map((deal) => this.present(deal)),
      /**
       * The value of the whole filtered set, not of this page. A sales manager filtering to "closing
       * this month" is asking for the number, and a per-page sum would change as they paged.
       */
      meta: { totalValueMinor: Number(sums._sum.valueMinor ?? 0) },
      pagination: {
        limit: query.limit,
        nextCursor: hasMore ? (page.at(-1)?.id ?? null) : null,
        hasMore,
        total,
      },
    };
  }

  /**
   * The deal board (`FR-DEAL-1`), one page per column.
   *
   * The same shape as the lead kanban, and for the same reason: a column with four thousand deals
   * must return ten of them and say how many there are. The per-column total is what makes the board
   * a forecast rather than a list.
   */
  async board(query: DealBoardQuery) {
    const filter = this.scopes.filterFor(PERMISSIONS.DEAL_READ, {
      userColumn: 'ownerUserId',
      teamColumn: 'teamId',
      branchColumn: 'branchId',
    });

    const pipeline = await this.resolvePipeline(query.pipelineId);
    const stages = await this.db.client.pipelineStage.findMany({
      where: { pipelineId: pipeline.id, deletedAt: null },
      orderBy: { sortOrder: 'asc' },
    });

    const columns = await Promise.all(
      stages.map(async (stage) => {
        const baseWhere: Record<string, unknown> = {
          deletedAt: null,
          stageId: stage.id,
          // The board is about what is still in play: a won deal belongs in the revenue report.
          wonAt: null,
          lostAt: null,
        };
        const where = applyScopeFilter(baseWhere, filter);
        if (where === null) {
          return {
            stage: this.presentStage(stage),
            total: 0,
            valueMinor: 0,
            weightedMinor: 0,
            deals: [],
          };
        }

        const [total, sums, deals] = await Promise.all([
          this.db.client.deal.count({ where }),
          this.db.client.deal.aggregate({ where, _sum: { valueMinor: true } }),
          this.db.client.deal.findMany({
            where,
            orderBy: { updatedAt: 'desc' },
            take: query.limit,
            include: this.listInclude(),
          }),
        ]);
        const valueMinor = Number(sums._sum.valueMinor ?? 0);
        return {
          stage: this.presentStage(stage),
          total,
          valueMinor,
          /** What the stage's own probability says to expect, which is the honest forecast. */
          weightedMinor: weightedValueMinor(valueMinor, stage.probability ?? 0),
          deals: deals.map((deal) => this.present(deal)),
        };
      }),
    );

    return {
      pipeline: { id: pipeline.id, name: pipeline.name },
      columns,
      meta: {
        valueMinor: columns.reduce((sum, column) => sum + column.valueMinor, 0),
        weightedMinor: columns.reduce((sum, column) => sum + column.weightedMinor, 0),
      },
    };
  }

  async findOne(id: string) {
    const deal = await this.db.client.deal.findFirst({
      where: { id },
      include: {
        ...this.listInclude(),
        pipeline: { select: { id: true, name: true } },
        lostReason: { select: { id: true, name: true } },
        items: {
          orderBy: { position: 'asc' },
          include: { product: { select: { id: true, name: true } } },
        },
      },
    });
    if (!deal) throw AppError.notFound('Deal');
    this.assertCanSee(deal);

    const definitions = await this.fields.definitionsFor('deal');
    return {
      ...this.present(deal),
      pipeline: deal.pipeline,
      lostReason: deal.lostReason,
      lostNote: deal.lostNote,
      items: deal.items.map((item) => ({
        id: item.id,
        position: item.position,
        productId: item.productId,
        productName: item.product?.name ?? null,
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
      customValues: deal.customValues as Record<string, unknown>,
      customFields: definitions.map((definition) => ({
        key: definition.key,
        label: definition.label,
        type: definition.type,
        isRequired: definition.isRequired,
      })),
      createdAt: deal.createdAt,
      updatedAt: deal.updatedAt,
      deletedAt: deal.deletedAt,
    };
  }

  /** A deal's own history. Its entries on the lead or the customer are on their timelines. */
  async journey(id: string, query: { limit: number; cursor?: string | undefined }) {
    const deal = await this.db.client.deal.findFirst({
      where: { id },
      select: { id: true, ownerUserId: true, teamId: true, branchId: true },
    });
    if (!deal) throw AppError.notFound('Deal');
    this.assertCanSee(deal);
    return this.reader.page(
      { dealId: deal.id },
      { limit: query.limit, ...(query.cursor ? { cursor: query.cursor } : {}) },
    );
  }

  // ── Writing ───────────────────────────────────────────────────────────────

  async create(input: CreateDealInput) {
    const principal = tenantContext.require('deals.create');
    const organization = await this.db.client.organization.findUniqueOrThrow({
      where: { id: principal.organizationId },
      select: { defaultCurrency: true, defaultPhoneCountry: true },
    });

    const subject = await this.resolveSubject(input.leadId, input.customerId);
    const placement = await this.resolvePlacement(input.pipelineId, input.stageId);
    if (input.ownerUserId) await this.assertOwnable(input.ownerUserId);
    const custom = await this.resolveCustomValues(input.customValues ?? {}, 'create', organization);

    const currency = input.currency ?? organization.defaultCurrency;
    const lines = await this.buildLines(input.items ?? []);
    const totals =
      lines.length > 0
        ? documentTotals(lines.map((line) => line.input))
        : {
            grossMinor: input.valueMinor ?? 0,
            discountMinor: 0,
            netMinor: input.valueMinor ?? 0,
            taxMinor: 0,
            totalMinor: input.valueMinor ?? 0,
            taxBreakdown: [],
          };

    const id = newId();
    const now = new Date();
    await this.db.client.$transaction(async (tx) => {
      await tx.deal.create({
        data: {
          id,
          organizationId: principal.organizationId,
          leadId: subject.leadId,
          customerId: subject.customerId,
          // Ownership follows the party: whoever works the lead or holds the account owns the deal.
          branchId: subject.branchId,
          teamId: subject.teamId,
          ownerUserId: input.ownerUserId ?? subject.ownerUserId,
          name: input.name,
          pipelineId: placement.pipelineId,
          stageId: placement.stageId,
          probability: input.probability ?? placement.probability,
          valueMinor: BigInt(totals.totalMinor),
          grossMinor: BigInt(totals.grossMinor),
          discountMinor: BigInt(totals.discountMinor),
          taxMinor: BigInt(totals.taxMinor),
          currency,
          ...(input.expectedCloseDate ? { expectedCloseDate: input.expectedCloseDate } : {}),
          customValues: custom.values as never,
          customSearchText: custom.searchText,
          lastActivityAt: now,
          createdById: principal.actorId ?? null,
        },
      });
      if (lines.length > 0) await this.writeLines(tx, id, principal.organizationId, lines);

      await this.recordOnAllSubjects(tx, {
        dealId: id,
        subject,
        type: ACTIVITY_TYPES.DEAL_CREATED,
        occurredAt: now,
        payload: {
          name: input.name,
          valueMinor: totals.totalMinor,
          currency,
          stageId: placement.stageId,
          items: lines.length,
        },
      });
      await this.audit.recordInTransaction(tx, {
        action: 'deal.created',
        resourceType: 'deal',
        resourceId: id,
        after: { name: input.name, valueMinor: totals.totalMinor, currency },
      });
      await this.outbox.emit(tx, [
        {
          name: 'deal.created',
          aggregateType: 'deal',
          aggregateId: id,
          payload: {
            leadId: subject.leadId,
            customerId: subject.customerId,
            valueMinor: totals.totalMinor,
            currency,
          },
        },
      ]);
    });

    return this.findOne(id);
  }

  async update(id: string, input: UpdateDealInput) {
    const principal = tenantContext.require('deals.update');
    const deal = await this.loadForWrite(id);
    const organization = await this.db.client.organization.findUniqueOrThrow({
      where: { id: principal.organizationId },
      select: { defaultCurrency: true, defaultPhoneCountry: true },
    });
    if (input.ownerUserId) await this.assertOwnable(input.ownerUserId);

    const itemCount = await this.db.client.dealItem.count({ where: { dealId: id } });
    if (input.valueMinor !== undefined && itemCount > 0) {
      // Refusing rather than silently ignoring: a caller who sets a total on a deal with lines has
      // misunderstood which one is the source of truth, and a quiet no-op teaches them nothing.
      throw AppError.businessRule(
        'This deal’s value comes from its line items. Change the items, or remove them first.',
        { items: itemCount },
      );
    }

    const custom =
      input.customValues === undefined
        ? null
        : await this.resolveCustomValues(
            input.customValues,
            'patch',
            organization,
            deal.customValues,
          );

    const data: Record<string, unknown> = {};
    if (input.name !== undefined) data['name'] = input.name;
    if (input.ownerUserId !== undefined) data['ownerUserId'] = input.ownerUserId;
    if (input.probability !== undefined) data['probability'] = input.probability;
    if (input.expectedCloseDate !== undefined) {
      data['expectedCloseDate'] = input.expectedCloseDate ?? null;
    }
    if (input.valueMinor !== undefined) {
      data['valueMinor'] = BigInt(input.valueMinor);
      data['grossMinor'] = BigInt(input.valueMinor);
      data['discountMinor'] = 0n;
      data['taxMinor'] = 0n;
    }
    if (custom) {
      data['customValues'] = custom.values as never;
      data['customSearchText'] = custom.searchText;
    }

    const changed = Object.keys(data);
    const now = new Date();
    await this.db.client.$transaction(async (tx) => {
      await tx.deal.update({ where: { id }, data: { ...data, lastActivityAt: now } });
      await this.timeline.recordInTransaction(tx, {
        type: ACTIVITY_TYPES.DEAL_UPDATED,
        dealId: id,
        occurredAt: now,
        payload: { fields: changed },
        actorType: principal.actorType,
        actorId: principal.actorId ?? null,
      });
      await this.audit.recordInTransaction(tx, {
        action: 'deal.updated',
        resourceType: 'deal',
        resourceId: id,
        after: { fields: changed },
      });
    });

    return this.findOne(id);
  }

  /**
   * Replacing the line items, as a whole list.
   *
   * The deal's totals are recomputed from them in the same transaction — which is the only way the
   * header and the lines can be guaranteed to agree, and is what `deals_totals_add_up` checks.
   */
  async setItems(id: string, input: SetDealItemsInput) {
    const principal = tenantContext.require('deals.setItems');
    const deal = await this.loadForWrite(id);
    if (deal.wonAt || deal.lostAt) {
      throw AppError.businessRule(
        'This deal is closed. Reopen it before changing what was quoted.',
      );
    }

    const lines = await this.buildLines(input.items);
    const totals = documentTotals(lines.map((line) => line.input));
    const now = new Date();

    await this.db.client.$transaction(async (tx) => {
      await tx.dealItem.deleteMany({ where: { dealId: id } });
      if (lines.length > 0) await this.writeLines(tx, id, principal.organizationId, lines);
      await tx.deal.update({
        where: { id },
        data: {
          valueMinor: BigInt(totals.totalMinor),
          grossMinor: BigInt(totals.grossMinor),
          discountMinor: BigInt(totals.discountMinor),
          taxMinor: BigInt(totals.taxMinor),
          lastActivityAt: now,
        },
      });
      await this.timeline.recordInTransaction(tx, {
        type: ACTIVITY_TYPES.DEAL_UPDATED,
        dealId: id,
        occurredAt: now,
        payload: {
          items: lines.length,
          valueMinor: totals.totalMinor,
          previousValueMinor: Number(deal.valueMinor),
        },
        actorType: principal.actorType,
        actorId: principal.actorId ?? null,
      });
      await this.audit.recordInTransaction(tx, {
        action: 'deal.items_set',
        resourceType: 'deal',
        resourceId: id,
        before: { valueMinor: Number(deal.valueMinor) },
        after: { valueMinor: totals.totalMinor, items: lines.length },
      });
    });

    return this.findOne(id);
  }

  /** Moving a deal along the board. The stage's probability follows unless somebody overrode it. */
  async move(id: string, input: MoveDealInput) {
    const principal = tenantContext.require('deals.move');
    const deal = await this.loadForWrite(id);
    const placement = await this.resolvePlacement(
      input.pipelineId ?? deal.pipelineId,
      input.stageId,
    );
    if (placement.stageId === deal.stageId && placement.pipelineId === deal.pipelineId) {
      return this.findOne(id);
    }

    const now = new Date();
    await this.db.client.$transaction(async (tx) => {
      await tx.deal.update({
        where: { id },
        data: {
          pipelineId: placement.pipelineId,
          stageId: placement.stageId,
          probability: placement.probability,
          lastActivityAt: now,
        },
      });
      await this.timeline.recordInTransaction(tx, {
        type: ACTIVITY_TYPES.DEAL_STAGE_CHANGED,
        dealId: id,
        occurredAt: now,
        payload: {
          fromStageId: deal.stageId,
          toStageId: placement.stageId,
          toStageName: placement.stageName,
          probability: placement.probability,
        },
        actorType: principal.actorType,
        actorId: principal.actorId ?? null,
      });
      await this.audit.recordInTransaction(tx, {
        action: 'deal.stage_changed',
        resourceType: 'deal',
        resourceId: id,
        before: { stageId: deal.stageId },
        after: { stageId: placement.stageId },
      });
      await this.outbox.emit(tx, [
        {
          name: 'deal.stage_changed',
          aggregateType: 'deal',
          aggregateId: id,
          payload: { fromStageId: deal.stageId, toStageId: placement.stageId },
        },
      ]);
    });

    return this.findOne(id);
  }

  /**
   * Won.
   *
   * The event is what Phase 9's attribution reads to tie spend to revenue, so it carries the value
   * and the currency rather than only the id — a consumer should not have to read the deal back to
   * know how much was won.
   */
  async win(id: string, input: WinDealInput) {
    const deal = await this.loadForWrite(id);
    if (deal.wonAt) return this.findOne(id);
    if (deal.lostAt) {
      throw AppError.businessRule('This deal is marked lost. Reopen it before marking it won.');
    }

    const wonAt = input.wonAt ?? new Date();
    const wonStage = await this.db.client.pipelineStage.findFirst({
      where: { pipelineId: deal.pipelineId, isWon: true, deletedAt: null },
      orderBy: { sortOrder: 'asc' },
    });

    await this.db.client.$transaction(async (tx) => {
      await tx.deal.update({
        where: { id },
        data: {
          wonAt,
          probability: 100,
          lastActivityAt: wonAt,
          // Moved to the pipeline's own won stage when it has one, so the board stops showing it.
          ...(wonStage ? { stageId: wonStage.id } : {}),
        },
      });
      await this.recordOnAllSubjects(tx, {
        dealId: id,
        subject: {
          leadId: deal.leadId,
          customerId: deal.customerId,
          branchId: deal.branchId,
          teamId: deal.teamId,
          ownerUserId: deal.ownerUserId,
        },
        type: ACTIVITY_TYPES.DEAL_WON,
        occurredAt: wonAt,
        payload: {
          name: deal.name,
          valueMinor: Number(deal.valueMinor),
          currency: deal.currency,
          ...(input.note ? { note: input.note } : {}),
        },
      });
      await this.audit.recordInTransaction(tx, {
        action: 'deal.won',
        resourceType: 'deal',
        resourceId: id,
        after: { valueMinor: Number(deal.valueMinor), currency: deal.currency, wonAt },
      });
      await this.outbox.emit(tx, [
        {
          name: 'deal.won',
          aggregateType: 'deal',
          aggregateId: id,
          payload: {
            leadId: deal.leadId,
            customerId: deal.customerId,
            valueMinor: Number(deal.valueMinor),
            currency: deal.currency,
            wonAt: wonAt.toISOString(),
          },
        },
      ]);
    });

    return this.findOne(id);
  }

  /** Lost, with a reason from the tenant's own list — never a free-text field alone. */
  async lose(id: string, input: LoseDealInput) {
    const deal = await this.loadForWrite(id);
    if (deal.lostAt) return this.findOne(id);
    if (deal.wonAt) {
      throw AppError.businessRule('This deal is marked won. Reopen it before marking it lost.');
    }

    if (input.lostReasonId) {
      const reason = await this.db.client.lostReason.findFirst({
        where: { id: input.lostReasonId, deletedAt: null, isActive: true },
      });
      if (!reason) throw AppError.notFound('Lost reason');
    }

    const lostAt = input.lostAt ?? new Date();
    const lostStage = await this.db.client.pipelineStage.findFirst({
      where: { pipelineId: deal.pipelineId, isLost: true, deletedAt: null },
      orderBy: { sortOrder: 'asc' },
    });

    await this.db.client.$transaction(async (tx) => {
      await tx.deal.update({
        where: { id },
        data: {
          lostAt,
          probability: 0,
          lostReasonId: input.lostReasonId ?? null,
          lostNote: input.note ?? null,
          lastActivityAt: lostAt,
          ...(lostStage ? { stageId: lostStage.id } : {}),
        },
      });
      await this.recordOnAllSubjects(tx, {
        dealId: id,
        subject: {
          leadId: deal.leadId,
          customerId: deal.customerId,
          branchId: deal.branchId,
          teamId: deal.teamId,
          ownerUserId: deal.ownerUserId,
        },
        type: ACTIVITY_TYPES.DEAL_LOST,
        occurredAt: lostAt,
        payload: {
          name: deal.name,
          valueMinor: Number(deal.valueMinor),
          currency: deal.currency,
          ...(input.lostReasonId ? { lostReasonId: input.lostReasonId } : {}),
          ...(input.note ? { note: input.note } : {}),
        },
      });
      await this.audit.recordInTransaction(tx, {
        action: 'deal.lost',
        resourceType: 'deal',
        resourceId: id,
        after: { lostReasonId: input.lostReasonId ?? null, lostAt },
      });
      await this.outbox.emit(tx, [
        {
          name: 'deal.lost',
          aggregateType: 'deal',
          aggregateId: id,
          payload: {
            leadId: deal.leadId,
            customerId: deal.customerId,
            valueMinor: Number(deal.valueMinor),
            lostReasonId: input.lostReasonId ?? null,
          },
        },
      ]);
    });

    return this.findOne(id);
  }

  /**
   * Reopening a closed deal.
   *
   * Not an undo: the won or lost entry stays on the timeline, because it happened. What this clears
   * is the outcome, so the deal returns to the board — which is what a business means when a signed
   * deal falls through or a lost one comes back.
   */
  async reopen(id: string) {
    const principal = tenantContext.require('deals.reopen');
    const deal = await this.loadForWrite(id);
    if (!deal.wonAt && !deal.lostAt) return this.findOne(id);

    const now = new Date();
    const stage = await this.db.client.pipelineStage.findFirst({
      where: { pipelineId: deal.pipelineId, isWon: false, isLost: false, deletedAt: null },
      orderBy: { sortOrder: 'asc' },
    });

    await this.db.client.$transaction(async (tx) => {
      await tx.deal.update({
        where: { id },
        data: {
          wonAt: null,
          lostAt: null,
          lostReasonId: null,
          lostNote: null,
          lastActivityAt: now,
          ...(stage ? { stageId: stage.id, probability: stage.probability ?? 0 } : {}),
        },
      });
      await this.timeline.recordInTransaction(tx, {
        type: ACTIVITY_TYPES.DEAL_REOPENED,
        dealId: id,
        occurredAt: now,
        payload: {
          wasWon: deal.wonAt !== null,
          wasLost: deal.lostAt !== null,
          ...(stage ? { toStageId: stage.id } : {}),
        },
        actorType: principal.actorType,
        actorId: principal.actorId ?? null,
      });
      await this.audit.recordInTransaction(tx, {
        action: 'deal.reopened',
        resourceType: 'deal',
        resourceId: id,
        before: { wonAt: deal.wonAt, lostAt: deal.lostAt },
      });
    });

    return this.findOne(id);
  }

  async remove(id: string) {
    const principal = tenantContext.require('deals.remove');
    const deal = await this.loadForWrite(id);
    if (deal.deletedAt) return { id, deleted: true };
    const now = new Date();

    await this.db.client.$transaction(async (tx) => {
      await tx.deal.update({
        where: { id },
        data: { deletedAt: now, deletedById: principal.actorId ?? null },
      });
      await this.timeline.recordInTransaction(tx, {
        type: ACTIVITY_TYPES.DEAL_DELETED,
        dealId: id,
        occurredAt: now,
        payload: { name: deal.name, valueMinor: Number(deal.valueMinor) },
        actorType: principal.actorType,
        actorId: principal.actorId ?? null,
      });
      await this.audit.recordInTransaction(tx, {
        action: 'deal.deleted',
        resourceType: 'deal',
        resourceId: id,
        before: { name: deal.name },
      });
    });

    return { id, deleted: true };
  }

  async restore(id: string) {
    const deal = await this.loadForWrite(id);
    if (!deal.deletedAt) return this.findOne(id);
    await this.db.client.deal.update({
      where: { id },
      data: { deletedAt: null, deletedById: null },
    });
    await this.audit.record({
      action: 'deal.restored',
      resourceType: 'deal',
      resourceId: id,
      after: { name: deal.name },
    });
    return this.findOne(id);
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  /**
   * Turns the request's lines into stored lines, filling the blanks from the catalogue.
   *
   * A client that names a product and nothing else gets the product's name, price and tax rate. A
   * client that states them keeps what it stated — because a line records what was agreed, which is
   * not always what the catalogue says today.
   */
  private async buildLines(
    items: readonly {
      productId?: string | null | undefined;
      name?: string | undefined;
      description?: string | null | undefined;
      quantity: number;
      unit?: string | null | undefined;
      unitPriceMinor?: number | undefined;
      discountMinor: number;
      taxPercent?: number | undefined;
    }[],
  ) {
    const productIds = [
      ...new Set(items.map((item) => item.productId).filter((id): id is string => Boolean(id))),
    ];
    const products =
      productIds.length === 0
        ? []
        : await this.db.client.product.findMany({
            where: { id: { in: productIds }, deletedAt: null },
          });
    const byId = new Map(products.map((product) => [product.id, product]));

    const missing = productIds.filter((id) => !byId.has(id));
    if (missing.length > 0) throw AppError.notFound('Product');

    return items.map((item, index) => {
      const product = item.productId ? byId.get(item.productId) : undefined;
      const name = item.name ?? product?.name;
      const unitPriceMinor = item.unitPriceMinor ?? Number(product?.priceMinor ?? 0);
      const taxPercent = item.taxPercent ?? Number(product?.taxPercent ?? 0);
      if (!name) {
        throw AppError.validation('Some details need correcting', [
          { field: `items.${index}.name`, code: 'NAME_REQUIRED', message: 'Give the line a name.' },
        ]);
      }

      const input: LineItemInput = {
        quantity: item.quantity,
        unitPriceMinor,
        discountMinor: item.discountMinor,
        taxPercent,
      };
      let totals;
      try {
        totals = lineTotals(input);
      } catch (error) {
        // The shared arithmetic refuses impossible lines (a discount larger than the line, a
        // negative price); its message is already written for a person, so it is passed through
        // against the field the client sent rather than replaced with a generic one.
        if (error instanceof LineItemError) {
          throw AppError.validation('Some details need correcting', [
            {
              field: `items.${index}.${error.field}`,
              code: 'INVALID_LINE_ITEM',
              message: error.message,
            },
          ]);
        }
        throw error;
      }

      return {
        input,
        position: index + 1,
        productId: item.productId ?? null,
        name,
        description: item.description ?? null,
        unit: item.unit ?? product?.unit ?? null,
        unitPriceMinor,
        taxPercent,
        totals,
      };
    });
  }

  private async writeLines(
    tx: TransactionClient,
    dealId: string,
    organizationId: string,
    lines: Awaited<ReturnType<DealsService['buildLines']>>,
  ): Promise<void> {
    await tx.dealItem.createMany({
      data: lines.map((line) => ({
        id: newId(),
        organizationId,
        dealId,
        productId: line.productId,
        position: line.position,
        name: line.name,
        description: line.description,
        quantity: line.input.quantity,
        unit: line.unit,
        unitPriceMinor: BigInt(line.unitPriceMinor),
        discountMinor: BigInt(line.totals.discountMinor),
        taxPercent: line.taxPercent,
        grossMinor: BigInt(line.totals.grossMinor),
        netMinor: BigInt(line.totals.netMinor),
        taxMinor: BigInt(line.totals.taxMinor),
        totalMinor: BigInt(line.totals.totalMinor),
      })),
    });
  }

  /**
   * Writes one entry on the deal **and** one on whichever party it is with (rule 6).
   *
   * A deal opened, won or lost is exactly what a business owner wants to see on the lead or the
   * customer — and a timeline nobody opens is not rule 6 satisfied. The deal's own screen gets the
   * fuller history, including the stage moves nobody needs on a customer record.
   */
  private async recordOnAllSubjects(
    tx: TransactionClient,
    entry: {
      dealId: string;
      subject: {
        leadId: string | null;
        customerId: string | null;
        branchId: string | null;
        teamId: string | null;
        ownerUserId: string | null;
      };
      type: (typeof ACTIVITY_TYPES)[keyof typeof ACTIVITY_TYPES];
      occurredAt: Date;
      payload: Record<string, unknown>;
    },
  ): Promise<void> {
    const principal = tenantContext.get();
    const common = {
      type: entry.type,
      occurredAt: entry.occurredAt,
      payload: { ...entry.payload, dealId: entry.dealId },
      actorType: principal?.actorType,
      actorId: principal?.actorId ?? null,
    };
    await this.timeline.recordManyInTransaction(tx, [
      { ...common, dealId: entry.dealId },
      ...(entry.subject.leadId ? [{ ...common, leadId: entry.subject.leadId }] : []),
      ...(entry.subject.customerId ? [{ ...common, customerId: entry.subject.customerId }] : []),
    ]);
  }

  /** Where a deal lands when the caller does not say: the tenant's own default deal pipeline. */
  private async resolvePlacement(pipelineId: string | undefined, stageId: string | undefined) {
    const pipeline = await this.resolvePipeline(pipelineId);
    const stage = stageId
      ? await this.db.client.pipelineStage.findFirst({
          where: { id: stageId, pipelineId: pipeline.id, deletedAt: null },
        })
      : await this.db.client.pipelineStage.findFirst({
          where: { pipelineId: pipeline.id, deletedAt: null },
          orderBy: { sortOrder: 'asc' },
        });
    if (!stage) {
      // A stage id that belongs to a different pipeline lands here rather than in a foreign-key
      // error, because `deals_stage_in_pipeline_fk` would otherwise answer with a constraint name.
      throw AppError.notFound('Stage');
    }
    return {
      pipelineId: pipeline.id,
      stageId: stage.id,
      stageName: stage.name,
      probability: stage.probability ?? 0,
    };
  }

  private async resolvePipeline(pipelineId: string | undefined) {
    const pipeline = pipelineId
      ? await this.db.client.pipeline.findFirst({
          where: { id: pipelineId, entityType: 'deal', deletedAt: null },
        })
      : await this.db.client.pipeline.findFirst({
          where: { entityType: 'deal', isActive: true, deletedAt: null },
          orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
        });
    if (!pipeline) {
      throw AppError.businessRule(
        'This workspace has no deal pipeline yet. Add one in settings before creating deals.',
      );
    }
    return pipeline;
  }

  /**
   * Who the deal is with, and the ownership that follows from it.
   *
   * Authority is checked on the **party**, not only on the deal: creating a deal against a lead you
   * cannot see would be a way to read its branch and owner through the deal you just made.
   */
  private async resolveSubject(leadId: string | undefined, customerId: string | undefined) {
    let lead = null;
    let customer = null;

    if (leadId) {
      lead = await this.db.client.lead.findFirst({ where: { id: leadId, deletedAt: null } });
      if (!lead) throw AppError.notFound('Lead');
      const allowed = this.scopes.canAct(PERMISSIONS.LEAD_READ, {
        userId: lead.assignedUserId,
        teamId: lead.teamId,
        branchId: lead.branchId,
      });
      if (!allowed) throw AppError.notFound('Lead');
    }
    if (customerId) {
      customer = await this.db.client.customer.findFirst({
        where: { id: customerId, deletedAt: null },
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
      leadId: lead?.id ?? null,
      customerId: customer?.id ?? null,
      branchId: customer?.branchId ?? lead?.branchId ?? null,
      teamId: customer?.teamId ?? lead?.teamId ?? null,
      ownerUserId: customer?.ownerUserId ?? lead?.assignedUserId ?? null,
    };
  }

  private async assertOwnable(userId: string): Promise<void> {
    const membership = await this.db.client.membership.findFirst({
      where: { userId, status: 'active', deletedAt: null },
    });
    if (!membership) throw AppError.notFound('Member');
  }

  private async resolveCustomValues(
    input: Record<string, unknown>,
    mode: 'create' | 'patch',
    organization: { defaultPhoneCountry: string; defaultCurrency: string },
    existing?: unknown,
  ) {
    const definitions = await this.fields.definitionsFor('deal');
    const result = validateCustomValues(definitions, input, {
      mode,
      defaultPhoneCountry: organization.defaultPhoneCountry as CountryCode,
      defaultCurrency: organization.defaultCurrency,
    });
    if (mode === 'create') return result;
    const merged = { ...((existing ?? {}) as Record<string, unknown>), ...result.values };
    for (const key of result.cleared) delete merged[key];
    return { ...result, searchText: searchTextFor(definitions, merged) };
  }

  private outcomeWhere(outcome: ListDealsQuery['outcome']): Record<string, unknown> {
    switch (outcome) {
      case 'open':
        return { wonAt: null, lostAt: null };
      case 'won':
        return { wonAt: { not: null } };
      case 'lost':
        return { lostAt: { not: null } };
      default:
        return {};
    }
  }

  private async searchIds(term: string, limit: number): Promise<string[]> {
    const principal = tenantContext.require('deals.search');
    const rows = await this.db.client.$queryRaw<{ id: string }[]>`
      SELECT id FROM deals
       WHERE organization_id = ${principal.organizationId}::uuid
         AND deleted_at IS NULL
         AND (search_vector @@ plainto_tsquery('simple', ${term}) OR name ILIKE ${'%' + term + '%'})
       LIMIT ${limit}`;
    return rows.map((row) => row.id);
  }

  private assertCanSee(deal: {
    ownerUserId: string | null;
    teamId: string | null;
    branchId: string | null;
  }): void {
    const allowed = this.scopes.canAct(PERMISSIONS.DEAL_READ, {
      userId: deal.ownerUserId,
      teamId: deal.teamId,
      branchId: deal.branchId,
    });
    if (!allowed) throw AppError.notFound('Deal');
  }

  private async loadForWrite(id: string) {
    const deal = await this.db.client.deal.findFirst({ where: { id } });
    if (!deal) throw AppError.notFound('Deal');
    const allowed = this.scopes.canAct(PERMISSIONS.DEAL_MANAGE, {
      userId: deal.ownerUserId,
      teamId: deal.teamId,
      branchId: deal.branchId,
    });
    if (!allowed) throw AppError.notFound('Deal');
    return deal;
  }

  private listInclude() {
    return {
      stage: { select: { id: true, name: true, colour: true, isWon: true, isLost: true } },
      owner: { select: { userId: true, user: { select: { name: true } } } },
      lead: { select: { id: true, fullName: true } },
      customer: { select: { id: true, fullName: true } },
    };
  }

  private presentStage(stage: {
    id: string;
    name: string;
    colour: string | null;
    probability: number | null;
    isWon: boolean;
    isLost: boolean;
  }) {
    return {
      id: stage.id,
      name: stage.name,
      colour: stage.colour,
      probability: stage.probability ?? 0,
      isWon: stage.isWon,
      isLost: stage.isLost,
    };
  }

  private present(deal: {
    id: string;
    name: string;
    leadId: string | null;
    customerId: string | null;
    stageId: string;
    pipelineId: string;
    probability: number;
    valueMinor: bigint;
    grossMinor: bigint;
    discountMinor: bigint;
    taxMinor: bigint;
    currency: string;
    expectedCloseDate: Date | null;
    wonAt: Date | null;
    lostAt: Date | null;
    ownerUserId: string | null;
    branchId: string | null;
    teamId: string | null;
    lastActivityAt: Date | null;
    createdAt: Date;
    deletedAt: Date | null;
    stage?: { id: string; name: string; colour: string | null; isWon: boolean; isLost: boolean };
    owner?: { userId: string; user: { name: string } } | null;
    lead?: { id: string; fullName: string } | null;
    customer?: { id: string; fullName: string } | null;
  }) {
    const valueMinor = Number(deal.valueMinor);
    return {
      id: deal.id,
      name: deal.name,
      stage: deal.stage ?? { id: deal.stageId },
      pipelineId: deal.pipelineId,
      probability: deal.probability,
      valueMinor,
      grossMinor: Number(deal.grossMinor),
      discountMinor: Number(deal.discountMinor),
      taxMinor: Number(deal.taxMinor),
      /** What the probability says to expect — the figure a forecast should add up, not the total. */
      weightedMinor: weightedValueMinor(valueMinor, deal.probability),
      currency: deal.currency,
      expectedCloseDate: deal.expectedCloseDate,
      wonAt: deal.wonAt,
      lostAt: deal.lostAt,
      outcome: deal.wonAt ? ('won' as const) : deal.lostAt ? ('lost' as const) : ('open' as const),
      lead: deal.lead ?? null,
      customer: deal.customer ?? null,
      owner: deal.owner ? { userId: deal.owner.userId, name: deal.owner.user.name } : null,
      branchId: deal.branchId,
      teamId: deal.teamId,
      lastActivityAt: deal.lastActivityAt,
      createdAt: deal.createdAt,
      deletedAt: deal.deletedAt,
    };
  }

  private emptyPage(limit: number) {
    return {
      items: [] as ReturnType<DealsService['present']>[],
      meta: { totalValueMinor: 0 },
      pagination: { limit, nextCursor: null, hasMore: false, total: 0 },
    };
  }
}
