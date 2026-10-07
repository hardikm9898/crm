import { Injectable } from '@nestjs/common';
import {
  ACTIVITY_TYPES,
  AppError,
  DEFAULT_REMINDER_OFFSETS,
  OPEN_TASK_STATUSES,
  PERMISSIONS,
  TASK_BUCKETS,
  describeReminderLead,
  dueParts,
  isOpenStatus,
  newId,
  normaliseReminderOffsets,
  reminderInstants,
  systemPrincipal,
  taskBucket,
  tenantContext,
  withPlatformScope,
  type ActorType,
  type TaskBucket,
} from '@leados/shared';
import { DbService } from '../../infra/db/db.service.js';
import { AuditService } from '../../infra/audit/audit.service.js';
import { OutboxService, type TransactionClient } from '../../infra/outbox/outbox.service.js';
import { TimelineService } from '../../infra/timeline/timeline.service.js';
import { DataScopeService, applyScopeFilter } from '../../infra/authz/data-scope.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { NextActionService } from './next-action.service.js';
import type {
  CancelTaskInput,
  CompleteTaskInput,
  CreateTaskInput,
  ListTasksQuery,
  RescheduleTaskInput,
  TaskSummaryQuery,
  UpdateTaskInput,
} from './tasks.dto.js';

/** The subject a task is about, and the ownership it inherits from it. */
interface TaskSubject {
  readonly leadId: string | null;
  readonly customerId: string | null;
  readonly dealId: string | null;
  readonly branchId: string | null;
  readonly teamId: string | null;
  readonly ownerUserId: string | null;
}

/**
 * Tasks and follow-ups (`FR-TSK-1..7`).
 *
 * **The product's answer to "what do I do next".** A CRM that records what happened is a filing
 * cabinet; what makes it a system of work is that every lead carries the next action somebody owes
 * it, and that the ones carrying none are visible (`FR-TSK-4`).
 *
 * Five decisions shape this file:
 *
 *  * **Overdue is derived, never stored.** A task due at 10:00 is overdue at 10:01, not at 10:30
 *    when the sweep next runs. The sweep's job is to *tell* somebody, which is why it writes
 *    `overdue_notified_at` and a timeline entry rather than a status.
 *  * **A reschedule moves the same row, and needs a reason.** Closing the task and opening another
 *    would double the lead's open count and put two things on the Today list for one call.
 *    `FR-TSK-5` makes the reason mandatory, and `task_reschedules` is what makes
 *    `reschedule_count` explainable.
 *  * **Completing a task asks what happened, and what is next.** The outcome is required (and the
 *    database agrees), and `nextFollowUp` is created in the same transaction — so a lead never
 *    passes through a state where its next action is missing.
 *  * **The lead's denormalized next action is recomputed, never incremented.**
 *    `NextActionService` takes the row lock and reads the open tasks.
 *  * **Rule 6 on every subject.** A task is written to the lead's timeline, the customer's and the
 *    deal's — never twice for the same party, which is the duplicate-row trap deals paid for.
 */
@Injectable()
export class TasksService {
  constructor(
    private readonly db: DbService,
    private readonly scopes: DataScopeService,
    private readonly nextActions: NextActionService,
    private readonly notifications: NotificationsService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly timeline: TimelineService,
  ) {}

  // ── Reading ───────────────────────────────────────────────────────────────

  async list(query: ListTasksQuery) {
    const principal = tenantContext.require('tasks.list');
    const filter = this.scopes.filterFor(PERMISSIONS.TASK_READ, {
      userColumn: 'assignedUserId',
      teamColumn: 'teamId',
      branchColumn: 'branchId',
    });
    const timeZone = await this.timeZone();
    const now = new Date();

    const baseWhere: Record<string, unknown> = {
      deletedAt: query.deleted ? { not: null } : null,
      ...(query.leadId ? { leadId: query.leadId } : {}),
      ...(query.customerId ? { customerId: query.customerId } : {}),
      ...(query.dealId ? { dealId: query.dealId } : {}),
      ...(query.mine ? { assignedUserId: principal.actorId ?? '' } : {}),
      ...(query.assignedUserId ? { assignedUserId: query.assignedUserId } : {}),
      ...(query.taskTypeId ? { taskTypeId: query.taskTypeId } : {}),
      ...(query.outcomeId ? { outcomeId: query.outcomeId } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.open === true ? { status: { in: [...OPEN_TASK_STATUSES] } } : {}),
      ...(query.open === false ? { status: { notIn: [...OPEN_TASK_STATUSES] } } : {}),
      ...(query.priority ? { priority: query.priority } : {}),
      ...(query.dueFrom || query.dueTo
        ? {
            dueAt: {
              ...(query.dueFrom ? { gte: query.dueFrom } : {}),
              ...(query.dueTo ? { lte: query.dueTo } : {}),
            },
          }
        : {}),
      ...(query.search ? { title: { contains: query.search, mode: 'insensitive' } } : {}),
      ...bucketWhere(query.bucket, now, timeZone),
    };

    const where = applyScopeFilter(baseWhere, filter);
    if (where === null) {
      return {
        items: [],
        pagination: { limit: query.limit, nextCursor: null, hasMore: false, total: 0 },
      };
    }

    const orderBy =
      query.sort === 'created_at'
        ? [{ createdAt: query.direction }]
        : query.sort === 'priority'
          ? // Postgres orders an enum by its declaration order, which is low → urgent, so the
            // queue's "most urgent first" is a descending sort on the column.
            [{ priority: query.direction === 'asc' ? 'desc' : 'asc' }, { dueAt: 'asc' as const }]
          : [{ dueAt: query.direction }, { id: 'asc' as const }];

    const [total, rows] = await Promise.all([
      this.db.client.task.count({ where }),
      this.db.client.task.findMany({
        where,
        orderBy: orderBy as never,
        take: query.limit + 1,
        ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
        include: this.listInclude(),
      }),
    ]);

    const page = rows.slice(0, query.limit);
    const hasMore = rows.length > query.limit;
    return {
      items: page.map((row) => this.present(row, now, timeZone)),
      pagination: {
        limit: query.limit,
        nextCursor: hasMore ? (page.at(-1)?.id ?? null) : null,
        hasMore,
        total,
      },
    };
  }

  /**
   * The Today counters (`FR-TSK-7`).
   *
   * **Aggregated over the whole filter, never over the page.** A board that counts the twenty rows
   * it loaded tells an executive they have twenty things to do when they have ninety — the same
   * mistake the pipeline board paid for. Each bucket is its own `count`.
   */
  async summary(query: TaskSummaryQuery) {
    const principal = tenantContext.require('tasks.summary');
    const filter = this.scopes.filterFor(PERMISSIONS.TASK_READ, {
      userColumn: 'assignedUserId',
      teamColumn: 'teamId',
      branchColumn: 'branchId',
    });
    const timeZone = await this.timeZone();
    const now = new Date();

    // `mine` defaults to true: the summary is the executive's own queue, and a manager asking for
    // the whole team's says so. Absent means "mine", which is why this is a three-way flag.
    const mine = query.mine ?? query.assignedUserId === undefined;
    const base: Record<string, unknown> = {
      deletedAt: null,
      ...(mine ? { assignedUserId: principal.actorId ?? '' } : {}),
      ...(query.assignedUserId ? { assignedUserId: query.assignedUserId } : {}),
    };
    const where = applyScopeFilter(base, filter);
    if (where === null) return { counts: emptyCounts(), noNextAction: 0, generatedAt: now };

    const buckets = await Promise.all(
      TASK_BUCKETS.map(
        async (bucket) =>
          [
            bucket,
            await this.db.client.task.count({
              where: { ...where, ...bucketWhere(bucket, now, timeZone) },
            }),
          ] as const,
      ),
    );

    /**
     * Leads with nobody owing them anything — the "silent leads" half of `FR-TSK-4`.
     *
     * On the summary rather than on a separate endpoint because it is the number that belongs next
     * to the other counters: an empty Today list means nothing if forty leads have no next action.
     */
    const leadFilter = this.scopes.filterFor(PERMISSIONS.LEAD_READ, {
      userColumn: 'assignedUserId',
      teamColumn: 'teamId',
      branchColumn: 'branchId',
    });
    const leadWhere = applyScopeFilter(
      {
        deletedAt: null,
        nextActionTaskId: null,
        convertedAt: null,
        lostAt: null,
        ...(mine ? { assignedUserId: principal.actorId ?? '' } : {}),
      },
      leadFilter,
    );
    const noNextAction =
      leadWhere === null ? 0 : await this.db.client.lead.count({ where: leadWhere });

    return {
      counts: Object.fromEntries(buckets) as Record<TaskBucket, number>,
      noNextAction,
      generatedAt: now,
    };
  }

  async findOne(id: string) {
    const row = await this.db.client.task.findFirst({ where: { id }, include: this.listInclude() });
    if (!row) throw AppError.notFound('Task');
    if (!this.canRead(row)) throw AppError.notFound('Task');
    return this.present(row, new Date(), await this.timeZone());
  }

  /** The history behind `reschedule_count` (`FR-TSK-5`). A count with no story is not a signal. */
  async reschedules(id: string) {
    const task = await this.db.client.task.findFirst({ where: { id } });
    if (!task || !this.canRead(task)) throw AppError.notFound('Task');

    const rows = await this.db.client.taskReschedule.findMany({
      where: { taskId: id },
      orderBy: { createdAt: 'asc' },
      include: { reason: { select: { id: true, name: true } } },
    });
    const items = rows.map((row) => ({
      id: row.id,
      fromDueAt: row.fromDueAt,
      toDueAt: row.toDueAt,
      reason: row.reason,
      reasonNote: row.reasonNote,
      rescheduledById: row.rescheduledById,
      createdAt: row.createdAt,
    }));
    return {
      items,
      pagination: { limit: items.length, nextCursor: null, hasMore: false, total: items.length },
    };
  }

  // ── Writing ───────────────────────────────────────────────────────────────

  async create(input: CreateTaskInput) {
    const principal = tenantContext.require('tasks.create');
    const subject = await this.resolveSubject(input);
    const type = input.taskTypeId ? await this.loadType(input.taskTypeId) : null;
    const assignedUserId = await this.resolveAssignee(input.assignedUserId, subject);

    if (input.followsTaskId) {
      // A chain that points at somebody else's task, or at nothing, is a chain nobody can read.
      const previous = await this.db.client.task.findFirst({ where: { id: input.followsTaskId } });
      if (!previous) throw AppError.notFound('Task');
    }

    const timeZone = await this.timeZone();
    const id = newId();
    const offsets = this.offsetsFor(input.reminderOffsets, type);
    const now = new Date();

    await this.db.client.$transaction(async (tx) => {
      // The lead's lock first, before the insert: see `NextActionService.lockLeads`. Inserting a
      // task takes a KEY SHARE lock on its lead, so asking for FOR UPDATE afterwards is how two
      // simultaneous creates on one lead deadlock.
      await this.nextActions.lockLeads(tx, principal.organizationId, [subject.leadId]);
      await tx.task.create({
        data: {
          id,
          organizationId: principal.organizationId,
          leadId: subject.leadId,
          customerId: subject.customerId,
          dealId: subject.dealId,
          branchId: subject.branchId,
          teamId: subject.teamId,
          assignedUserId,
          title: input.title,
          ...(input.description ? { description: input.description } : {}),
          taskTypeId: type?.id ?? null,
          dueAt: input.dueAt,
          ...this.dueColumns(input.dueAt, timeZone),
          priority: input.priority,
          reminderOffsets: offsets as never,
          createdVia: 'manual',
          ...(input.followsTaskId ? { followsTaskId: input.followsTaskId } : {}),
          createdById: principal.actorId ?? null,
        },
      });
      await this.writeReminders(tx, principal.organizationId, id, input.dueAt, offsets, now);
      await this.nextActions.refreshLeads(tx, principal.organizationId, [subject.leadId]);
      await this.record(tx, subject, {
        type: ACTIVITY_TYPES.TASK_CREATED,
        occurredAt: now,
        payload: {
          taskId: id,
          title: input.title,
          dueAt: input.dueAt.toISOString(),
          priority: input.priority,
          ...(type ? { taskType: type.name } : {}),
          ...(input.followsTaskId ? { followsTaskId: input.followsTaskId } : {}),
        },
      });
      await this.audit.recordInTransaction(tx, {
        action: 'task.created',
        resourceType: 'task',
        resourceId: id,
        after: { title: input.title, dueAt: input.dueAt, assignedUserId },
      });
      await this.outbox.emit(tx, [
        {
          name: 'task.created',
          aggregateType: 'task',
          aggregateId: id,
          payload: {
            leadId: subject.leadId,
            customerId: subject.customerId,
            dealId: subject.dealId,
            assignedUserId,
            dueAt: input.dueAt.toISOString(),
            priority: input.priority,
          },
        },
      ]);
    });

    return this.findOne(id);
  }

  async update(id: string, input: UpdateTaskInput) {
    const row = await this.loadForWrite(id);
    if (!isOpenStatus(row.status)) {
      throw AppError.businessRule(
        `This task is ${row.status}, so it cannot be edited. Create a new follow-up instead.`,
      );
    }
    const type = input.taskTypeId ? await this.loadType(input.taskTypeId) : null;
    const assignedUserId =
      input.assignedUserId === undefined
        ? undefined
        : await this.resolveAssignee(input.assignedUserId, row);

    const offsets =
      input.reminderOffsets === undefined
        ? null
        : this.offsetsFor(input.reminderOffsets, type ?? null);
    const now = new Date();

    await this.db.client.$transaction(async (tx) => {
      await tx.task.update({
        where: { id },
        data: {
          ...(input.title !== undefined ? { title: input.title } : {}),
          ...(input.description !== undefined ? { description: input.description } : {}),
          ...(input.taskTypeId !== undefined ? { taskTypeId: input.taskTypeId } : {}),
          ...(input.priority !== undefined ? { priority: input.priority } : {}),
          ...(assignedUserId !== undefined ? { assignedUserId } : {}),
          ...(offsets ? { reminderOffsets: offsets as never } : {}),
        },
      });
      if (offsets) {
        await this.writeReminders(tx, row.organizationId, id, row.dueAt, offsets, now);
      }
      await this.audit.recordInTransaction(tx, {
        action: 'task.updated',
        resourceType: 'task',
        resourceId: id,
        before: { title: row.title, priority: row.priority, assignedUserId: row.assignedUserId },
        after: { ...input },
      });
    });
    return this.findOne(id);
  }

  /**
   * Completing a task, and scheduling what comes next (`FR-TSK-6`).
   *
   * One interaction and one transaction, because they are one decision: a sales executive who has
   * just finished a call knows when the next one is, and asking them again on another screen is how
   * a lead ends up with nothing owed to it.
   */
  async complete(id: string, input: CompleteTaskInput) {
    const principal = tenantContext.require('tasks.complete');
    const row = await this.loadForWrite(id);
    if (row.status === 'completed') return this.findOne(id);
    if (row.status === 'cancelled') {
      throw AppError.businessRule('This task was cancelled. Create a new follow-up instead.');
    }

    const outcome = await this.loadOutcome(input.outcomeId);
    if (outcome.requiresNote && !input.note) {
      // The tenant ticked the box on this outcome precisely so that "Other" cannot be the end of
      // the story.
      throw AppError.validation('Some details need correcting', [
        {
          field: 'note',
          code: 'NOTE_REQUIRED',
          message: `“${outcome.name}” needs a note saying what happened.`,
        },
      ]);
    }

    const completedAt = input.completedAt ?? new Date();
    const timeZone = await this.timeZone();
    const subject = subjectOf(row);
    let followUpId: string | null = null;

    if (input.nextFollowUp) {
      const nextType = input.nextFollowUp.taskTypeId
        ? await this.loadType(input.nextFollowUp.taskTypeId)
        : null;
      const nextAssignee = await this.resolveAssignee(
        input.nextFollowUp.assignedUserId === undefined
          ? row.assignedUserId
          : input.nextFollowUp.assignedUserId,
        row,
      );
      followUpId = newId();
      const nextOffsets = this.offsetsFor(input.nextFollowUp.reminderOffsets, nextType);
      const nextDueAt = input.nextFollowUp.dueAt;
      const nextTitle = input.nextFollowUp.title ?? `Follow up: ${row.title}`;

      await this.db.client.$transaction(async (tx) => {
        await this.nextActions.lockLeads(tx, row.organizationId, [row.leadId]);
        await this.finish(tx, row, { outcome, note: input.note ?? null, completedAt });
        await tx.task.create({
          data: {
            id: followUpId!,
            organizationId: row.organizationId,
            leadId: row.leadId,
            customerId: row.customerId,
            dealId: row.dealId,
            branchId: row.branchId,
            teamId: row.teamId,
            assignedUserId: nextAssignee,
            title: nextTitle,
            taskTypeId: nextType?.id ?? row.taskTypeId,
            dueAt: nextDueAt,
            ...this.dueColumns(nextDueAt, timeZone),
            priority: input.nextFollowUp!.priority ?? row.priority,
            reminderOffsets: nextOffsets as never,
            createdVia: 'manual',
            followsTaskId: row.id,
            createdById: principal.actorId ?? null,
          },
        });
        await this.writeReminders(
          tx,
          row.organizationId,
          followUpId!,
          nextDueAt,
          nextOffsets,
          completedAt,
        );
        await this.nextActions.refreshLeads(tx, row.organizationId, [row.leadId]);
        await this.record(tx, subject, {
          type: ACTIVITY_TYPES.TASK_COMPLETED,
          occurredAt: completedAt,
          payload: {
            taskId: row.id,
            title: row.title,
            outcome: outcome.name,
            outcomeIsPositive: outcome.isPositive,
            ...(input.note ? { note: input.note } : {}),
            nextFollowUp: { taskId: followUpId, title: nextTitle, dueAt: nextDueAt.toISOString() },
          },
        });
        await this.record(tx, subject, {
          type: ACTIVITY_TYPES.TASK_CREATED,
          occurredAt: completedAt,
          payload: {
            taskId: followUpId,
            title: nextTitle,
            dueAt: nextDueAt.toISOString(),
            priority: input.nextFollowUp!.priority ?? row.priority,
            followsTaskId: row.id,
          },
        });
        await this.completionAudit(tx, row, outcome.name, followUpId);
        await this.emitCompleted(tx, row, outcome, followUpId);
      });
      return this.findOne(id);
    }

    await this.db.client.$transaction(async (tx) => {
      await this.nextActions.lockLeads(tx, row.organizationId, [row.leadId]);
      await this.finish(tx, row, { outcome, note: input.note ?? null, completedAt });
      await this.nextActions.refreshLeads(tx, row.organizationId, [row.leadId]);
      await this.record(tx, subject, {
        type: ACTIVITY_TYPES.TASK_COMPLETED,
        occurredAt: completedAt,
        payload: {
          taskId: row.id,
          title: row.title,
          outcome: outcome.name,
          outcomeIsPositive: outcome.isPositive,
          ...(input.note ? { note: input.note } : {}),
        },
      });
      await this.completionAudit(tx, row, outcome.name, null);
      await this.emitCompleted(tx, row, outcome, null);
    });
    return this.findOne(id);
  }

  /**
   * Moving a follow-up (`FR-TSK-5`).
   *
   * The reason is required by the schema, the note by the reason, and the move is recorded in
   * `task_reschedules` — which is what turns `reschedule_count` from a number into a coaching
   * conversation. `overdue_notified_at` is cleared, because the next miss is news again.
   */
  async reschedule(id: string, input: RescheduleTaskInput) {
    const principal = tenantContext.require('tasks.reschedule');
    const row = await this.loadForWrite(id);
    if (!isOpenStatus(row.status)) {
      throw AppError.businessRule(
        `This task is ${row.status}, so there is nothing to move. Create a new follow-up instead.`,
      );
    }
    if (input.dueAt.getTime() === row.dueAt.getTime()) {
      // `task_reschedules_changes_the_time` would refuse the row anyway; saying so here attaches
      // the refusal to the field somebody typed in.
      throw AppError.validation('Some details need correcting', [
        {
          field: 'dueAt',
          code: 'UNCHANGED',
          message: 'Pick a different date or time — this is when it is already due.',
        },
      ]);
    }

    const reason = await this.loadReason(input.reasonId);
    if (reason.requiresNote && !input.note) {
      throw AppError.validation('Some details need correcting', [
        {
          field: 'note',
          code: 'NOTE_REQUIRED',
          message: `“${reason.name}” needs a note saying why.`,
        },
      ]);
    }

    const timeZone = await this.timeZone();
    const now = new Date();
    const fromDueAt = row.dueAt;

    await this.db.client.$transaction(async (tx) => {
      await this.nextActions.lockLeads(tx, row.organizationId, [row.leadId]);
      await tx.task.update({
        where: { id },
        data: {
          dueAt: input.dueAt,
          ...this.dueColumns(input.dueAt, timeZone),
          rescheduleCount: { increment: 1 },
          // The next miss is news again, so the sweep is allowed to report it.
          overdueNotifiedAt: null,
        },
      });
      await tx.taskReschedule.create({
        data: {
          id: newId(),
          organizationId: row.organizationId,
          taskId: id,
          fromDueAt,
          toDueAt: input.dueAt,
          reasonId: reason.id,
          ...(input.note ? { reasonNote: input.note } : {}),
          rescheduledById: principal.actorId ?? null,
        },
      });
      await this.writeReminders(
        tx,
        row.organizationId,
        id,
        input.dueAt,
        normaliseReminderOffsets(Array.isArray(row.reminderOffsets) ? row.reminderOffsets : []),
        now,
      );
      await this.nextActions.refreshLeads(tx, row.organizationId, [row.leadId]);
      await this.record(tx, subjectOf(row), {
        type: ACTIVITY_TYPES.TASK_RESCHEDULED,
        occurredAt: now,
        payload: {
          taskId: id,
          title: row.title,
          fromDueAt: fromDueAt.toISOString(),
          toDueAt: input.dueAt.toISOString(),
          reason: reason.name,
          ...(input.note ? { note: input.note } : {}),
          rescheduleCount: row.rescheduleCount + 1,
        },
      });
      await this.audit.recordInTransaction(tx, {
        action: 'task.rescheduled',
        resourceType: 'task',
        resourceId: id,
        before: { dueAt: fromDueAt },
        after: { dueAt: input.dueAt, reason: reason.name, note: input.note ?? null },
      });
      await this.outbox.emit(tx, [
        {
          name: 'task.rescheduled',
          aggregateType: 'task',
          aggregateId: id,
          payload: {
            leadId: row.leadId,
            customerId: row.customerId,
            dealId: row.dealId,
            fromDueAt: fromDueAt.toISOString(),
            toDueAt: input.dueAt.toISOString(),
            reasonId: reason.id,
            rescheduleCount: row.rescheduleCount + 1,
          },
        },
      ]);
    });
    return this.findOne(id);
  }

  /** Cancelled, not deleted: "we decided not to" is information. */
  async cancel(id: string, input: CancelTaskInput) {
    const row = await this.loadForWrite(id);
    if (row.status === 'cancelled') return this.findOne(id);
    if (row.status === 'completed') {
      throw AppError.businessRule('This task is already done, so it cannot be cancelled.');
    }

    const cancelledAt = new Date();
    await this.db.client.$transaction(async (tx) => {
      await this.nextActions.lockLeads(tx, row.organizationId, [row.leadId]);
      await tx.task.update({
        where: { id },
        data: {
          status: 'cancelled',
          cancelledAt,
          ...(input.reason ? { completionNote: input.reason } : {}),
        },
      });
      await tx.taskReminder.deleteMany({ where: { taskId: id, sentAt: null } });
      await this.nextActions.refreshLeads(tx, row.organizationId, [row.leadId]);
      await this.record(tx, subjectOf(row), {
        type: ACTIVITY_TYPES.TASK_CANCELLED,
        occurredAt: cancelledAt,
        payload: {
          taskId: id,
          title: row.title,
          ...(input.reason ? { reason: input.reason } : {}),
        },
      });
      await this.audit.recordInTransaction(tx, {
        action: 'task.cancelled',
        resourceType: 'task',
        resourceId: id,
        before: { status: row.status, dueAt: row.dueAt },
        after: { reason: input.reason ?? null },
      });
      await this.outbox.emit(tx, [
        {
          name: 'task.cancelled',
          aggregateType: 'task',
          aggregateId: id,
          payload: { leadId: row.leadId, customerId: row.customerId, dealId: row.dealId },
        },
      ]);
    });
    return this.findOne(id);
  }

  /**
   * Soft-deletes a task entered by mistake.
   *
   * No timeline entry, deliberately: a task somebody created on the wrong lead and removed a minute
   * later is not part of that lead's history, and writing "task deleted" would make the mistake
   * permanent on the one screen the business owner reads.
   */
  async remove(id: string) {
    const row = await this.loadForWrite(id);
    if (row.deletedAt) return { deleted: true };

    await this.db.client.$transaction(async (tx) => {
      await this.nextActions.lockLeads(tx, row.organizationId, [row.leadId]);
      await tx.task.update({ where: { id }, data: { deletedAt: new Date() } });
      await tx.taskReminder.deleteMany({ where: { taskId: id, sentAt: null } });
      await this.nextActions.refreshLeads(tx, row.organizationId, [row.leadId]);
      await this.audit.recordInTransaction(tx, {
        action: 'task.deleted',
        resourceType: 'task',
        resourceId: id,
        before: { title: row.title, dueAt: row.dueAt, status: row.status },
      });
    });
    return { deleted: true };
  }

  // ── Sweeps (`task.overdue-sweep`, `task.reminder-dispatch`) ───────────────

  /**
   * Reports tasks whose time has passed, once each.
   *
   * The *read* is cross-tenant; every *write* happens inside that row's own tenant context, because
   * `TimelineService` takes the organization from the context by design — the trap the quotation
   * expiry sweep paid for. `overdue_notified_at` is what makes it once rather than every half hour,
   * and the predicate repeats it so a task completed between the read and the write is not
   * retrospectively declared late.
   */
  async sweepOverdue(limit = 500): Promise<{ examined: number; reported: number }> {
    const now = new Date();
    const due = await withPlatformScope('tasks: overdue sweep', async () =>
      this.db.client.task.findMany({
        where: {
          deletedAt: null,
          status: { in: [...OPEN_TASK_STATUSES] },
          overdueNotifiedAt: null,
          dueAt: { lt: now },
        },
        select: {
          id: true,
          organizationId: true,
          leadId: true,
          customerId: true,
          dealId: true,
          assignedUserId: true,
          title: true,
          dueAt: true,
          priority: true,
        },
        orderBy: { dueAt: 'asc' },
        take: limit,
      }),
    );

    let reported = 0;
    for (const row of due) {
      await tenantContext.run(systemPrincipal(row.organizationId, newId()), async () => {
        await this.db.client.$transaction(async (tx) => {
          const updated = await tx.task.updateMany({
            where: {
              id: row.id,
              overdueNotifiedAt: null,
              status: { in: [...OPEN_TASK_STATUSES] },
            },
            data: { overdueNotifiedAt: now },
          });
          if (updated.count === 0) return;
          reported += 1;
          await this.record(tx, row, {
            type: ACTIVITY_TYPES.TASK_OVERDUE,
            occurredAt: now,
            payload: {
              taskId: row.id,
              title: row.title,
              dueAt: row.dueAt.toISOString(),
              priority: row.priority,
            },
            // The sweep is not a person.
            actorType: 'system',
          });
          await this.outbox.emit(tx, [
            {
              name: 'task.overdue',
              aggregateType: 'task',
              aggregateId: row.id,
              payload: {
                leadId: row.leadId,
                customerId: row.customerId,
                dealId: row.dealId,
                assignedUserId: row.assignedUserId,
                title: row.title,
                dueAt: row.dueAt.toISOString(),
                priority: row.priority,
              },
            },
          ]);
        });
      });
    }
    return { examined: due.length, reported };
  }

  /**
   * Sends the reminders whose moment has come (`task.reminder-dispatch`).
   *
   * The notification is created **before** `sent_at` is written, not after: a crash between the two
   * means the reminder is retried, and `NotificationsService.create` is idempotent on its dedupe
   * key, so the worst case is a repeated attempt rather than a reminder nobody ever gets. The other
   * order loses it silently.
   */
  async dispatchDueReminders(limit = 200): Promise<{ examined: number; sent: number }> {
    const now = new Date();
    const due = await withPlatformScope('tasks: reminder dispatch', async () =>
      this.db.client.taskReminder.findMany({
        where: { sentAt: null, remindAt: { lte: now } },
        select: { id: true, organizationId: true, taskId: true, offsetMinutes: true },
        orderBy: { remindAt: 'asc' },
        take: limit,
      }),
    );

    let sent = 0;
    for (const reminder of due) {
      await tenantContext.run(systemPrincipal(reminder.organizationId, newId()), async () => {
        const task = await this.db.client.task.findFirst({
          where: { id: reminder.taskId },
          select: {
            id: true,
            title: true,
            status: true,
            dueAt: true,
            deletedAt: true,
            assignedUserId: true,
            leadId: true,
            lead: { select: { fullName: true } },
          },
        });

        // A reminder for work that is finished, deleted or assigned to nobody has nobody to go to.
        // Marking it sent is the honest end state: the row records that its moment passed.
        const deliverable =
          task !== null &&
          task.deletedAt === null &&
          isOpenStatus(task.status) &&
          task.assignedUserId !== null;

        if (deliverable) {
          const about = task.lead?.fullName ? ` — ${task.lead.fullName}` : '';
          await this.notifications.create({
            organizationId: reminder.organizationId,
            userId: task.assignedUserId!,
            type: 'task.reminder',
            title: `${task.title}${about}`,
            body: `Due ${describeReminderLead(reminder.offsetMinutes)}.`,
            link: task.leadId ? `/leads/${task.leadId}` : `/tasks?taskId=${task.id}`,
            dedupeKey: `task-reminder:${reminder.id}`,
            data: { taskId: task.id, leadId: task.leadId },
          });
          sent += 1;
        }

        await this.db.client.taskReminder.updateMany({
          where: { id: reminder.id, sentAt: null },
          data: { sentAt: now },
        });
      });
    }
    return { examined: due.length, sent };
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  /** Completion, without the surrounding bookkeeping — shared by both branches of `complete`. */
  private async finish(
    tx: TransactionClient,
    row: { id: string },
    done: { outcome: { id: string }; note: string | null; completedAt: Date },
  ): Promise<void> {
    await tx.task.update({
      where: { id: row.id },
      data: {
        status: 'completed',
        completedAt: done.completedAt,
        outcomeId: done.outcome.id,
        ...(done.note ? { completionNote: done.note } : {}),
      },
    });
    // A reminder for a task that is finished is noise. Only the unsent ones go; the sent ones are
    // a record of having been told.
    await tx.taskReminder.deleteMany({ where: { taskId: row.id, sentAt: null } });
  }

  private async completionAudit(
    tx: TransactionClient,
    row: { id: string; title: string },
    outcomeName: string,
    followUpId: string | null,
  ): Promise<void> {
    await this.audit.recordInTransaction(tx, {
      action: 'task.completed',
      resourceType: 'task',
      resourceId: row.id,
      after: { title: row.title, outcome: outcomeName, followUpId },
    });
  }

  private async emitCompleted(
    tx: TransactionClient,
    row: { id: string; leadId: string | null; customerId: string | null; dealId: string | null },
    outcome: { id: string; name: string; isPositive: boolean | null },
    followUpId: string | null,
  ): Promise<void> {
    await this.outbox.emit(tx, [
      {
        name: 'task.completed',
        aggregateType: 'task',
        aggregateId: row.id,
        payload: {
          leadId: row.leadId,
          customerId: row.customerId,
          dealId: row.dealId,
          outcomeId: outcome.id,
          outcomeIsPositive: outcome.isPositive,
          followUpTaskId: followUpId,
        },
      },
    ]);
  }

  /**
   * `due_at` as the workspace's own date and wall clock.
   *
   * Prisma's `@db.Date` and `@db.Time` both want a `Date`, and both read only their own half of it,
   * so the epoch day carrying the time is deliberate and inert.
   */
  private dueColumns(dueAt: Date, timeZone: string): { dueDate: Date; dueTime: Date } {
    const parts = dueParts(dueAt, timeZone);
    return {
      dueDate: new Date(`${parts.dueDate}T00:00:00.000Z`),
      dueTime: new Date(`1970-01-01T${parts.dueTime}.000Z`),
    };
  }

  /** Explicit offsets win; absent falls back to the type's defaults, then to one hour before. */
  private offsetsFor(
    submitted: readonly number[] | undefined,
    type: { defaultReminderOffsets: unknown } | null,
  ): number[] {
    if (submitted !== undefined) return normaliseReminderOffsets(submitted);
    if (type && Array.isArray(type.defaultReminderOffsets)) {
      return normaliseReminderOffsets(type.defaultReminderOffsets);
    }
    return [...DEFAULT_REMINDER_OFFSETS];
  }

  /**
   * Rewrites a task's reminder rows.
   *
   * Delete-then-insert rather than a diff: the set is at most five rows, the unique key is
   * `(organization_id, task_id, offset_minutes)`, and a reminder already sent must not be
   * resurrected by a reschedule — so only the unsent ones are replaced.
   */
  private async writeReminders(
    tx: TransactionClient,
    organizationId: string,
    taskId: string,
    dueAt: Date,
    offsets: readonly number[],
    now: Date,
  ): Promise<void> {
    await tx.taskReminder.deleteMany({ where: { taskId, sentAt: null } });
    const instants = reminderInstants(dueAt, offsets, now);
    if (instants.length === 0) return;

    const alreadySent = await tx.taskReminder.findMany({
      where: { taskId },
      select: { offsetMinutes: true },
    });
    const taken = new Set(alreadySent.map((row) => row.offsetMinutes));

    const fresh = instants.filter((instant) => !taken.has(instant.offsetMinutes));
    if (fresh.length === 0) return;
    await tx.taskReminder.createMany({
      data: fresh.map((instant) => ({
        id: newId(),
        organizationId,
        taskId,
        remindAt: instant.remindAt,
        offsetMinutes: instant.offsetMinutes,
      })),
    });
  }

  /** Loaded for writing, with the caller's authority on it checked. 404 either way. */
  private async loadForWrite(id: string) {
    const row = await this.db.client.task.findFirst({ where: { id } });
    if (!row) throw AppError.notFound('Task');
    const allowed = this.scopes.canAct(PERMISSIONS.TASK_MANAGE, {
      userId: row.assignedUserId,
      teamId: row.teamId,
      branchId: row.branchId,
    });
    if (!allowed) throw AppError.notFound('Task');
    this.assertMayActForAssignee(row.assignedUserId);
    return row;
  }

  private canRead(row: {
    assignedUserId: string | null;
    teamId: string | null;
    branchId: string | null;
  }): boolean {
    return this.scopes.canAct(PERMISSIONS.TASK_READ, {
      userId: row.assignedUserId,
      teamId: row.teamId,
      branchId: row.branchId,
    });
  }

  /**
   * `task:manage_others` — "act on other users' tasks".
   *
   * Separate from the data scope, and both apply. A branch manager's scope says *which* tasks they
   * can see; this says whether they may finish somebody else's work for them. A workspace that
   * wants executives to own their own queue and nothing else grants `task:manage` and withholds
   * this, which is a configuration the permission catalogue has always offered and nothing was
   * enforcing.
   */
  private assertMayActForAssignee(assignedUserId: string | null): void {
    const principal = tenantContext.require('tasks.assignee');
    if (assignedUserId === null) return;
    if (assignedUserId === principal.actorId) return;
    if (principal.permissions.has(PERMISSIONS.TASK_MANAGE_OTHERS)) return;
    throw AppError.permissionDenied(PERMISSIONS.TASK_MANAGE_OTHERS);
  }

  /**
   * Who the task is for.
   *
   * The subject's owner first: a task created on a lead that belongs to somebody else is almost
   * always work for *them*, and silently assigning it to whoever typed it in is how a colleague's
   * queue loses an item. **Then the caller** — because a lead in the unassigned pool has no owner,
   * and a task belonging to nobody is exactly the silent failure this feature exists to prevent:
   * it appears in no Today list and no overdue sweep can tell anybody about it.
   */
  private async resolveAssignee(
    submitted: string | null | undefined,
    subject: { ownerUserId?: string | null; assignedUserId?: string | null },
  ): Promise<string | null> {
    const principal = tenantContext.require('tasks.resolveAssignee');
    const fallback = subject.ownerUserId ?? subject.assignedUserId ?? principal.actorId ?? null;
    const chosen = submitted === undefined ? fallback : submitted;
    if (chosen === null) return null;

    const membership = await this.db.client.membership.findFirst({
      where: { userId: chosen, deletedAt: null, status: 'active' },
      select: { userId: true },
    });
    if (!membership) {
      throw AppError.validation('Some details need correcting', [
        {
          field: 'assignedUserId',
          code: 'NOT_A_MEMBER',
          message: 'That person is not an active member of this workspace.',
        },
      ]);
    }
    this.assertMayActForAssignee(chosen);
    return chosen;
  }

  /** What the task is about, and the branch, team and owner it inherits. */
  private async resolveSubject(input: CreateTaskInput): Promise<TaskSubject> {
    if (input.dealId) {
      const deal = await this.db.client.deal.findFirst({
        where: { id: input.dealId, deletedAt: null },
      });
      if (!deal) throw AppError.notFound('Deal');
      if (
        !this.scopes.canAct(PERMISSIONS.DEAL_READ, {
          userId: deal.ownerUserId,
          teamId: deal.teamId,
          branchId: deal.branchId,
        })
      ) {
        throw AppError.notFound('Deal');
      }
      return {
        dealId: deal.id,
        leadId: input.leadId ?? deal.leadId,
        customerId: input.customerId ?? deal.customerId,
        branchId: deal.branchId,
        teamId: deal.teamId,
        ownerUserId: deal.ownerUserId,
      };
    }

    if (input.customerId) {
      const customer = await this.db.client.customer.findFirst({
        where: { id: input.customerId, deletedAt: null },
      });
      if (!customer) throw AppError.notFound('Customer');
      if (
        !this.scopes.canAct(PERMISSIONS.CUSTOMER_READ, {
          userId: customer.ownerUserId,
          teamId: customer.teamId,
          branchId: customer.branchId,
        })
      ) {
        throw AppError.notFound('Customer');
      }
      return {
        dealId: null,
        customerId: customer.id,
        leadId: input.leadId ?? null,
        branchId: customer.branchId,
        teamId: customer.teamId,
        ownerUserId: customer.ownerUserId,
      };
    }

    const lead = await this.db.client.lead.findFirst({
      where: { id: input.leadId, deletedAt: null },
    });
    if (!lead) throw AppError.notFound('Lead');
    if (
      !this.scopes.canAct(PERMISSIONS.LEAD_READ, {
        userId: lead.assignedUserId,
        teamId: lead.teamId,
        branchId: lead.branchId,
      })
    ) {
      throw AppError.notFound('Lead');
    }
    return {
      dealId: null,
      customerId: null,
      leadId: lead.id,
      branchId: lead.branchId,
      teamId: lead.teamId,
      ownerUserId: lead.assignedUserId,
    };
  }

  private async loadType(id: string) {
    const type = await this.db.client.taskType.findFirst({ where: { id, deletedAt: null } });
    if (!type) throw AppError.notFound('Task type');
    return type;
  }

  private async loadOutcome(id: string) {
    const outcome = await this.db.client.taskOutcome.findFirst({ where: { id, deletedAt: null } });
    if (!outcome) throw AppError.notFound('Outcome');
    return outcome;
  }

  private async loadReason(id: string) {
    const reason = await this.db.client.rescheduleReason.findFirst({
      where: { id, deletedAt: null },
    });
    if (!reason) throw AppError.notFound('Reschedule reason');
    return reason;
  }

  /** The workspace's timezone, which is what "today" and "due at 10:00" mean. */
  private async timeZone(): Promise<string> {
    const organizationId = tenantContext.organizationId('tasks.timeZone');
    const organization = await this.db.client.organization.findUniqueOrThrow({
      where: { id: organizationId },
      select: { timezone: true },
    });
    return organization.timezone;
  }

  /**
   * One timeline entry per subject, never two for the same party.
   *
   * The same shape payments uses, and for the same reason: a lead that has been converted appears
   * twice — once as itself and once as its customer — and writing both would read as a duplicated
   * row rather than as one event on one person.
   */
  private async record(
    tx: TransactionClient,
    subject: { leadId: string | null; customerId: string | null; dealId: string | null },
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
      taskType: { select: { id: true, name: true, icon: true } },
      outcome: { select: { id: true, name: true, isPositive: true } },
      lead: { select: { id: true, fullName: true, phoneE164: true } },
      customer: { select: { id: true, fullName: true } },
      deal: { select: { id: true, name: true } },
    };
  }

  private present(
    row: {
      id: string;
      title: string;
      description: string | null;
      status: string;
      priority: string;
      dueAt: Date;
      completedAt: Date | null;
      cancelledAt: Date | null;
      completionNote: string | null;
      reminderOffsets: unknown;
      rescheduleCount: number;
      overdueNotifiedAt: Date | null;
      followsTaskId: string | null;
      assignedUserId: string | null;
      createdVia: string;
      createdById: string | null;
      createdAt: Date;
      updatedAt: Date;
      deletedAt: Date | null;
      leadId: string | null;
      customerId: string | null;
      dealId: string | null;
      taskTypeId: string | null;
      outcomeId: string | null;
      taskType?: { id: string; name: string; icon: string | null } | null;
      outcome?: { id: string; name: string; isPositive: boolean | null } | null;
      lead?: { id: string; fullName: string | null; phoneE164: string | null } | null;
      customer?: { id: string; fullName: string | null } | null;
      deal?: { id: string; name: string } | null;
    },
    now: Date,
    timeZone: string,
  ) {
    return {
      id: row.id,
      title: row.title,
      description: row.description,
      status: row.status,
      /** Derived, not stored — see the class comment. */
      bucket: taskBucket({ status: row.status, dueAt: row.dueAt }, now, timeZone),
      priority: row.priority,
      dueAt: row.dueAt,
      completedAt: row.completedAt,
      cancelledAt: row.cancelledAt,
      completionNote: row.completionNote,
      reminderOffsets: normaliseReminderOffsets(
        Array.isArray(row.reminderOffsets) ? row.reminderOffsets : [],
      ),
      rescheduleCount: row.rescheduleCount,
      overdueNotifiedAt: row.overdueNotifiedAt,
      followsTaskId: row.followsTaskId,
      assignedUserId: row.assignedUserId,
      taskTypeId: row.taskTypeId,
      taskType: row.taskType ?? null,
      outcomeId: row.outcomeId,
      outcome: row.outcome ?? null,
      leadId: row.leadId,
      lead: row.lead ?? null,
      customerId: row.customerId,
      customer: row.customer ?? null,
      dealId: row.dealId,
      deal: row.deal ?? null,
      createdVia: row.createdVia,
      createdById: row.createdById,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      deletedAt: row.deletedAt,
    };
  }
}

function subjectOf(row: {
  leadId: string | null;
  customerId: string | null;
  dealId: string | null;
}): { leadId: string | null; customerId: string | null; dealId: string | null } {
  return { leadId: row.leadId, customerId: row.customerId, dealId: row.dealId };
}

/**
 * A bucket as a `where` clause.
 *
 * The same definitions `taskBucket` uses, expressed for the database — which is what lets the
 * counters be aggregates over the whole filter rather than a tally of the loaded page, without the
 * two disagreeing. Kept beside each other here on purpose: they are one definition in two
 * languages, and a change to one that misses the other is a screen whose counts contradict its
 * own list.
 */
function bucketWhere(
  bucket: TaskBucket | undefined,
  now: Date,
  timeZone: string,
): Record<string, unknown> {
  if (bucket === undefined) return {};
  const open = { status: { in: [...OPEN_TASK_STATUSES] } };
  switch (bucket) {
    case 'completed':
      return { status: 'completed' };
    case 'cancelled':
      return { status: 'cancelled' };
    case 'overdue':
      return { ...open, dueAt: { lt: now } };
    case 'due_now':
      return { ...open, dueAt: { gte: now, lte: new Date(now.getTime() + 30 * 60_000) } };
    case 'due_today': {
      // "The rest of the workspace's day", which is where `due_date` earns its place: the
      // alternative is `due_at AT TIME ZONE …` on every row, and that cannot use an index.
      const today = dueParts(now, timeZone).dueDate;
      return {
        ...open,
        dueAt: { gt: new Date(now.getTime() + 30 * 60_000) },
        dueDate: new Date(`${today}T00:00:00.000Z`),
      };
    }
    case 'upcoming': {
      const today = dueParts(now, timeZone).dueDate;
      return {
        ...open,
        dueAt: { gt: new Date(now.getTime() + 30 * 60_000) },
        dueDate: { gt: new Date(`${today}T00:00:00.000Z`) },
      };
    }
  }
}

function emptyCounts(): Record<TaskBucket, number> {
  return Object.fromEntries(TASK_BUCKETS.map((bucket) => [bucket, 0])) as Record<
    TaskBucket,
    number
  >;
}
