import { Injectable } from '@nestjs/common';
import { AppError, newId, normaliseReminderOffsets, tenantContext } from '@leados/shared';
import { DbService } from '../../infra/db/db.service.js';
import { AuditService } from '../../infra/audit/audit.service.js';
import { fullPage } from '../organizations/organizations.service.js';
import type {
  CreateRescheduleReasonInput,
  CreateTaskOutcomeInput,
  CreateTaskTypeInput,
  UpdateRescheduleReasonInput,
  UpdateTaskOutcomeInput,
  UpdateTaskTypeInput,
} from './tasks.dto.js';

/**
 * Task types, outcomes and reschedule reasons — the tenant's own vocabulary for following up
 * (`FR-TSK-2`, `FR-TSK-5`, `FR-TSK-6`, rule 4).
 *
 * The same two invariants `CrmConfigService` holds, for the same reasons:
 *
 *  * **Configuration in use is never destroyed.** Deleting a type or a reason that tasks still
 *    carry is refused with the count; deactivating hides it from new tasks and leaves history
 *    readable. A business renaming "Site visit" must not rewrite what happened last month.
 *  * **The list a mandatory field reads from cannot become empty.** Completing a task requires an
 *    outcome and rescheduling requires a reason — both enforced, one of them by a database
 *    constraint. So deactivating or deleting the *last* active outcome or reason is refused:
 *    otherwise the workspace reaches a state where no task can ever be completed again, and the
 *    error it produces names a constraint rather than the setting that caused it.
 */
@Injectable()
export class TaskConfigService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Everything the task form needs, in one request.
   *
   * Deliberately one endpoint: a form that fetched types, outcomes and reasons separately would
   * make three round-trips before it could render its first dropdown.
   */
  async bundle() {
    const [types, outcomes, reasons] = await Promise.all([
      this.db.client.taskType.findMany({
        where: { deletedAt: null, isActive: true },
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      }),
      this.db.client.taskOutcome.findMany({
        where: { deletedAt: null, isActive: true },
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      }),
      this.db.client.rescheduleReason.findMany({
        where: { deletedAt: null, isActive: true },
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      }),
    ]);

    return {
      types: types.map((type) => ({
        id: type.id,
        name: type.name,
        icon: type.icon,
        defaultDurationMinutes: type.defaultDurationMinutes,
        defaultReminderOffsets: normaliseReminderOffsets(
          Array.isArray(type.defaultReminderOffsets) ? type.defaultReminderOffsets : [],
        ),
        sortOrder: type.sortOrder,
      })),
      outcomes: outcomes.map((outcome) => ({
        id: outcome.id,
        name: outcome.name,
        isPositive: outcome.isPositive,
        requiresNote: outcome.requiresNote,
        sortOrder: outcome.sortOrder,
      })),
      rescheduleReasons: reasons.map((reason) => ({
        id: reason.id,
        name: reason.name,
        requiresNote: reason.requiresNote,
        sortOrder: reason.sortOrder,
      })),
    };
  }

  // ── Task types ────────────────────────────────────────────────────────────

  async listTypes(includeInactive = false) {
    const types = await this.db.client.taskType.findMany({
      where: { deletedAt: null, ...(includeInactive ? {} : { isActive: true }) },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    });
    const counts = await this.db.client.task.groupBy({
      by: ['taskTypeId'],
      where: { deletedAt: null },
      _count: { _all: true },
    });
    const byType = new Map(counts.map((row) => [row.taskTypeId, row._count._all]));
    const items = types.map((type) => ({
      id: type.id,
      name: type.name,
      icon: type.icon,
      defaultDurationMinutes: type.defaultDurationMinutes,
      defaultReminderOffsets: normaliseReminderOffsets(
        Array.isArray(type.defaultReminderOffsets) ? type.defaultReminderOffsets : [],
      ),
      sortOrder: type.sortOrder,
      isActive: type.isActive,
      taskCount: byType.get(type.id) ?? 0,
    }));
    return { items, pagination: fullPage(items.length) };
  }

  async createType(input: CreateTaskTypeInput) {
    const organizationId = tenantContext.organizationId('tasks.createType');
    const id = newId();
    await this.db.client.taskType.create({
      data: {
        id,
        organizationId,
        name: input.name,
        icon: input.icon ?? null,
        defaultDurationMinutes: input.defaultDurationMinutes ?? null,
        defaultReminderOffsets: normaliseReminderOffsets(
          input.defaultReminderOffsets ?? [],
        ) as never,
        sortOrder: input.sortOrder ?? 0,
      },
    });
    await this.audit.record({
      action: 'task_type.created',
      resourceType: 'task_type',
      resourceId: id,
      after: { name: input.name },
    });
    return { id, name: input.name };
  }

  async updateType(id: string, input: UpdateTaskTypeInput) {
    const type = await this.db.client.taskType.findFirst({ where: { id, deletedAt: null } });
    if (!type) throw AppError.notFound('Task type');

    const result = await this.db.client.taskType.update({
      where: { id },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.icon !== undefined ? { icon: input.icon } : {}),
        ...(input.defaultDurationMinutes !== undefined
          ? { defaultDurationMinutes: input.defaultDurationMinutes }
          : {}),
        ...(input.defaultReminderOffsets !== undefined
          ? {
              defaultReminderOffsets: normaliseReminderOffsets(
                input.defaultReminderOffsets,
              ) as never,
            }
          : {}),
        ...(input.sortOrder !== undefined ? { sortOrder: input.sortOrder } : {}),
        ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
      },
    });
    await this.audit.record({
      action: 'task_type.updated',
      resourceType: 'task_type',
      resourceId: id,
      before: { name: type.name, isActive: type.isActive },
      after: input as Record<string, unknown>,
    });
    return { id: result.id };
  }

  async deleteType(id: string) {
    const type = await this.db.client.taskType.findFirst({ where: { id, deletedAt: null } });
    if (!type) throw AppError.notFound('Task type');

    const inUse = await this.db.client.task.count({ where: { taskTypeId: id, deletedAt: null } });
    if (inUse > 0) {
      throw AppError.businessRule(
        `${inUse === 1 ? '1 task is' : `${inUse} tasks are`} of this type. Deactivate it instead — the history reads its name`,
        { tasks: inUse },
      );
    }
    await this.db.client.taskType.update({
      where: { id },
      data: { deletedAt: new Date(), isActive: false },
    });
    await this.audit.record({
      action: 'task_type.deleted',
      resourceType: 'task_type',
      resourceId: id,
      before: { name: type.name },
    });
    return { id, deleted: true };
  }

  // ── Outcomes ──────────────────────────────────────────────────────────────

  async listOutcomes(includeInactive = false) {
    const outcomes = await this.db.client.taskOutcome.findMany({
      where: { deletedAt: null, ...(includeInactive ? {} : { isActive: true }) },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    });
    const counts = await this.db.client.task.groupBy({
      by: ['outcomeId'],
      where: { deletedAt: null },
      _count: { _all: true },
    });
    const byOutcome = new Map(counts.map((row) => [row.outcomeId, row._count._all]));
    const items = outcomes.map((outcome) => ({
      id: outcome.id,
      name: outcome.name,
      isPositive: outcome.isPositive,
      requiresNote: outcome.requiresNote,
      sortOrder: outcome.sortOrder,
      isActive: outcome.isActive,
      taskCount: byOutcome.get(outcome.id) ?? 0,
    }));
    return { items, pagination: fullPage(items.length) };
  }

  async createOutcome(input: CreateTaskOutcomeInput) {
    const organizationId = tenantContext.organizationId('tasks.createOutcome');
    const id = newId();
    await this.db.client.taskOutcome.create({
      data: {
        id,
        organizationId,
        name: input.name,
        isPositive: input.isPositive ?? null,
        requiresNote: input.requiresNote,
        sortOrder: input.sortOrder ?? 0,
      },
    });
    await this.audit.record({
      action: 'task_outcome.created',
      resourceType: 'task_outcome',
      resourceId: id,
      after: { name: input.name },
    });
    return { id, name: input.name };
  }

  async updateOutcome(id: string, input: UpdateTaskOutcomeInput) {
    const outcome = await this.db.client.taskOutcome.findFirst({ where: { id, deletedAt: null } });
    if (!outcome) throw AppError.notFound('Outcome');
    if (input.isActive === false && outcome.isActive) {
      await this.assertNotTheLastOutcome(id);
    }

    await this.db.client.taskOutcome.update({
      where: { id },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.isPositive !== undefined ? { isPositive: input.isPositive } : {}),
        ...(input.requiresNote !== undefined ? { requiresNote: input.requiresNote } : {}),
        ...(input.sortOrder !== undefined ? { sortOrder: input.sortOrder } : {}),
        ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
      },
    });
    await this.audit.record({
      action: 'task_outcome.updated',
      resourceType: 'task_outcome',
      resourceId: id,
      before: { name: outcome.name, isActive: outcome.isActive },
      after: input as Record<string, unknown>,
    });
    return { id };
  }

  async deleteOutcome(id: string) {
    const outcome = await this.db.client.taskOutcome.findFirst({ where: { id, deletedAt: null } });
    if (!outcome) throw AppError.notFound('Outcome');

    const inUse = await this.db.client.task.count({ where: { outcomeId: id } });
    if (inUse > 0) {
      throw AppError.businessRule(
        `${inUse === 1 ? '1 task ended' : `${inUse} tasks ended`} with this outcome. Deactivate it instead — outcome reports read history`,
        { tasks: inUse },
      );
    }
    if (outcome.isActive) await this.assertNotTheLastOutcome(id);

    await this.db.client.taskOutcome.update({
      where: { id },
      data: { deletedAt: new Date(), isActive: false },
    });
    await this.audit.record({
      action: 'task_outcome.deleted',
      resourceType: 'task_outcome',
      resourceId: id,
      before: { name: outcome.name },
    });
    return { id, deleted: true };
  }

  // ── Reschedule reasons ────────────────────────────────────────────────────

  async listReasons(includeInactive = false) {
    const reasons = await this.db.client.rescheduleReason.findMany({
      where: { deletedAt: null, ...(includeInactive ? {} : { isActive: true }) },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    });
    const counts = await this.db.client.taskReschedule.groupBy({
      by: ['reasonId'],
      _count: { _all: true },
    });
    const byReason = new Map(counts.map((row) => [row.reasonId, row._count._all]));
    const items = reasons.map((reason) => ({
      id: reason.id,
      name: reason.name,
      requiresNote: reason.requiresNote,
      sortOrder: reason.sortOrder,
      isActive: reason.isActive,
      /** How often it has been given — which is itself the `FR-TSK-5` coaching report. */
      useCount: byReason.get(reason.id) ?? 0,
    }));
    return { items, pagination: fullPage(items.length) };
  }

  async createReason(input: CreateRescheduleReasonInput) {
    const organizationId = tenantContext.organizationId('tasks.createReason');
    const id = newId();
    await this.db.client.rescheduleReason.create({
      data: {
        id,
        organizationId,
        name: input.name,
        requiresNote: input.requiresNote,
        sortOrder: input.sortOrder ?? 0,
      },
    });
    await this.audit.record({
      action: 'reschedule_reason.created',
      resourceType: 'reschedule_reason',
      resourceId: id,
      after: { name: input.name },
    });
    return { id, name: input.name };
  }

  async updateReason(id: string, input: UpdateRescheduleReasonInput) {
    const reason = await this.db.client.rescheduleReason.findFirst({
      where: { id, deletedAt: null },
    });
    if (!reason) throw AppError.notFound('Reschedule reason');
    if (input.isActive === false && reason.isActive) await this.assertNotTheLastReason(id);

    await this.db.client.rescheduleReason.update({
      where: { id },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.requiresNote !== undefined ? { requiresNote: input.requiresNote } : {}),
        ...(input.sortOrder !== undefined ? { sortOrder: input.sortOrder } : {}),
        ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
      },
    });
    await this.audit.record({
      action: 'reschedule_reason.updated',
      resourceType: 'reschedule_reason',
      resourceId: id,
      before: { name: reason.name, isActive: reason.isActive },
      after: input as Record<string, unknown>,
    });
    return { id };
  }

  async deleteReason(id: string) {
    const reason = await this.db.client.rescheduleReason.findFirst({
      where: { id, deletedAt: null },
    });
    if (!reason) throw AppError.notFound('Reschedule reason');

    const inUse = await this.db.client.taskReschedule.count({ where: { reasonId: id } });
    if (inUse > 0) {
      throw AppError.businessRule(
        `${inUse === 1 ? '1 reschedule gave' : `${inUse} reschedules gave`} this reason. Deactivate it instead — the reschedule report reads history`,
        { reschedules: inUse },
      );
    }
    if (reason.isActive) await this.assertNotTheLastReason(id);

    await this.db.client.rescheduleReason.update({
      where: { id },
      data: { deletedAt: new Date(), isActive: false },
    });
    await this.audit.record({
      action: 'reschedule_reason.deleted',
      resourceType: 'reschedule_reason',
      resourceId: id,
      before: { name: reason.name },
    });
    return { id, deleted: true };
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  /**
   * Refuses to leave a workspace with no outcome to choose.
   *
   * `tasks_completed_has_outcome` is a database constraint, so a workspace with no active outcome
   * is a workspace where no task can ever be completed — and the error would name the constraint
   * rather than the setting somebody changed five minutes earlier.
   */
  private async assertNotTheLastOutcome(id: string): Promise<void> {
    const others = await this.db.client.taskOutcome.count({
      where: { id: { not: id }, isActive: true, deletedAt: null },
    });
    if (others === 0) {
      throw AppError.businessRule(
        'This is the only outcome left, and finishing a task needs one. Add another before removing it',
      );
    }
  }

  /** The same, for reschedule reasons: `FR-TSK-5` makes the reason mandatory. */
  private async assertNotTheLastReason(id: string): Promise<void> {
    const others = await this.db.client.rescheduleReason.count({
      where: { id: { not: id }, isActive: true, deletedAt: null },
    });
    if (others === 0) {
      throw AppError.businessRule(
        'This is the only reason left, and moving a follow-up needs one. Add another before removing it',
      );
    }
  }
}
