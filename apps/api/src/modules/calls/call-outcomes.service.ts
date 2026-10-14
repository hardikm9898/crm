import { Injectable } from '@nestjs/common';
import { AppError, isContact, newId, tenantContext } from '@leados/shared';
import { DbService } from '../../infra/db/db.service.js';
import { AuditService } from '../../infra/audit/audit.service.js';
import { fullPage } from '../organizations/organizations.service.js';
import type { CreateCallOutcomeInput, UpdateCallOutcomeInput } from './calls.dto.js';

/**
 * The tenant's own list of what a call meant (`FR-CALL-1`, rule 4).
 *
 * "Not interested" is a different sentence in a school from a car dealership, so the names are rows
 * — but the **category** is code, because the product has to know which of them mean somebody was
 * actually spoken to and no amount of reading a name tells it that. Exactly the arrangement lead
 * statuses use.
 *
 * The two invariants every configuration service here holds:
 *
 *  * **Configuration in use is never destroyed.** An outcome calls still carry cannot be deleted;
 *    deactivating hides it from new calls and leaves history readable. A business renaming
 *    "Spoke — interested" must not rewrite what happened last month.
 *  * **The list a mandatory field reads from cannot become empty.** Logging a call requires an
 *    outcome, so removing the last active one would leave a workspace where no call can ever be
 *    logged again — and the error would name a constraint rather than the setting that caused it.
 */
@Injectable()
export class CallOutcomesService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
  ) {}

  async list(includeInactive = false) {
    const outcomes = await this.db.client.callOutcome.findMany({
      where: { deletedAt: null, ...(includeInactive ? {} : { isActive: true }) },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    });
    const counts = await this.db.client.call.groupBy({
      by: ['outcomeId'],
      where: { deletedAt: null },
      _count: { _all: true },
    });
    const byOutcome = new Map(counts.map((row) => [row.outcomeId, row._count._all]));
    const items = outcomes.map((outcome) => ({
      id: outcome.id,
      name: outcome.name,
      category: outcome.category,
      requiresNote: outcome.requiresNote,
      sortOrder: outcome.sortOrder,
      isActive: outcome.isActive,
      /**
       * Derived here as well as on `/calls/config`, deliberately: the settings screen is where
       * somebody chooses a category, and "which of these count as having reached them" is the only
       * question that choice actually decides. A screen that made the reader infer it from the
       * category name would be asking them to know `isContact` by heart.
       */
      isContact: isContact(outcome.category),
      callCount: byOutcome.get(outcome.id) ?? 0,
    }));
    return { items, pagination: fullPage(items.length) };
  }

  async create(input: CreateCallOutcomeInput) {
    const organizationId = tenantContext.organizationId('calls.createOutcome');
    const id = newId();
    await this.db.client.callOutcome.create({
      data: {
        id,
        organizationId,
        name: input.name,
        category: input.category,
        requiresNote: input.requiresNote,
        sortOrder: input.sortOrder ?? 0,
      },
    });
    await this.audit.record({
      action: 'call_outcome.created',
      resourceType: 'call_outcome',
      resourceId: id,
      after: { name: input.name, category: input.category },
    });
    return { id, name: input.name };
  }

  async update(id: string, input: UpdateCallOutcomeInput) {
    const outcome = await this.load(id);
    if (input.isActive === false && outcome.isActive) await this.assertNotTheLast(id);

    await this.db.client.callOutcome.update({
      where: { id },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.category !== undefined ? { category: input.category } : {}),
        ...(input.requiresNote !== undefined ? { requiresNote: input.requiresNote } : {}),
        ...(input.sortOrder !== undefined ? { sortOrder: input.sortOrder } : {}),
        ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
      },
    });
    await this.audit.record({
      action: 'call_outcome.updated',
      resourceType: 'call_outcome',
      resourceId: id,
      before: { name: outcome.name, category: outcome.category, isActive: outcome.isActive },
      after: input as Record<string, unknown>,
    });
    return { id };
  }

  async remove(id: string) {
    const outcome = await this.load(id);
    const inUse = await this.db.client.call.count({ where: { outcomeId: id } });
    if (inUse > 0) {
      throw AppError.businessRule(
        `${inUse === 1 ? '1 call ended' : `${inUse} calls ended`} with this outcome. Deactivate it instead — call reports read history`,
        { calls: inUse },
      );
    }
    if (outcome.isActive) await this.assertNotTheLast(id);

    await this.db.client.callOutcome.update({
      where: { id },
      data: { deletedAt: new Date(), isActive: false },
    });
    await this.audit.record({
      action: 'call_outcome.deleted',
      resourceType: 'call_outcome',
      resourceId: id,
      before: { name: outcome.name },
    });
    return { id, deleted: true };
  }

  /** Loaded for logging a call: active only, because a deactivated outcome is history. */
  async loadForLogging(id: string) {
    const outcome = await this.db.client.callOutcome.findFirst({
      where: { id, deletedAt: null, isActive: true },
    });
    if (!outcome) throw AppError.notFound('Call outcome');
    return outcome;
  }

  private async load(id: string) {
    const outcome = await this.db.client.callOutcome.findFirst({
      where: { id, deletedAt: null },
    });
    if (!outcome) throw AppError.notFound('Call outcome');
    return outcome;
  }

  private async assertNotTheLast(id: string): Promise<void> {
    const others = await this.db.client.callOutcome.count({
      where: { id: { not: id }, isActive: true, deletedAt: null },
    });
    if (others === 0) {
      throw AppError.businessRule(
        'This is the only outcome left, and logging a call needs one. Add another before removing it',
      );
    }
  }
}
