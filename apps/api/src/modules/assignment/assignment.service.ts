import { Injectable } from '@nestjs/common';
import {
  ACTIVITY_TYPES,
  AppError,
  PERMISSIONS,
  STRATEGY_SPECS,
  newId,
  strategySpec,
  tenantContext,
} from '@leados/shared';
import { DbService } from '../../infra/db/db.service.js';
import { AuditService } from '../../infra/audit/audit.service.js';
import { OutboxService, type DomainEventInput } from '../../infra/outbox/outbox.service.js';
import { TimelineService } from '../../infra/timeline/timeline.service.js';
import { DataScopeService } from '../../infra/authz/data-scope.service.js';
import { fullPage } from '../organizations/organizations.service.js';
import { AssignmentEngineService, type AssignmentDecision } from './assignment-engine.service.js';
import type {
  CreateAssignmentRuleInput,
  EvaluateAssignmentInput,
  ReassignBulkInput,
  SetConditionsInput,
  SetPoolInput,
  TestAssignmentInput,
  UpdateAssignmentRuleInput,
} from './assignment.dto.js';

/**
 * Assignment rules, the tester, and bulk reassignment.
 *
 * The engine decides; this service configures it, explains it, and applies its decisions to leads
 * that already exist. Lead *creation* calls the engine directly, because the assignment has to
 * happen inside the same transaction as the insert.
 */
@Injectable()
export class AssignmentService {
  constructor(
    private readonly db: DbService,
    private readonly engine: AssignmentEngineService,
    private readonly scopes: DataScopeService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly timeline: TimelineService,
  ) {}

  /** The strategies, so a rule builder renders from the registry rather than a hardcoded list. */
  strategies() {
    const items = Object.values(STRATEGY_SPECS).map((spec) => ({
      strategy: spec.strategy,
      label: spec.label,
      requires: spec.requires,
      usesPool: spec.usesPool,
      describe: spec.describe,
    }));
    return { items, pagination: fullPage(items.length) };
  }

  async listRules(includeInactive = false) {
    const rules = await this.db.client.assignmentRule.findMany({
      where: { deletedAt: null, ...(includeInactive ? {} : { isActive: true }) },
      orderBy: [{ priority: 'asc' }, { name: 'asc' }],
      include: {
        conditions: { orderBy: [{ groupIndex: 'asc' }, { createdAt: 'asc' }] },
        poolMembers: { orderBy: { createdAt: 'asc' } },
        roundRobinState: true,
      },
    });

    const items = rules.map((rule) => ({
      id: rule.id,
      name: rule.name,
      priority: rule.priority,
      strategy: rule.strategy,
      target: rule.target,
      respectWorkingHours: rule.respectWorkingHours,
      capacityCap: rule.capacityCap,
      fallback: rule.fallback,
      isActive: rule.isActive,
      conditions: rule.conditions.map((condition) => ({
        id: condition.id,
        fieldPath: condition.fieldPath,
        operator: condition.operator,
        value: condition.value,
        groupIndex: condition.groupIndex,
      })),
      pool: rule.poolMembers.map((member) => ({
        userId: member.userId,
        weight: member.weight,
        isActive: member.isActive,
      })),
      // Where the rotation currently stands, so a manager can see it is actually rotating.
      rotation: rule.roundRobinState
        ? {
            cursorIndex: rule.roundRobinState.cursorIndex,
            lastAssignedUserId: rule.roundRobinState.lastAssignedUserId,
            updatedAt: rule.roundRobinState.updatedAt,
          }
        : null,
    }));
    return { items, pagination: fullPage(items.length) };
  }

  async createRule(input: CreateAssignmentRuleInput) {
    const organizationId = tenantContext.organizationId('assignment.createRule');
    await this.assertRuleCoherent(input.strategy, input.target, input.pool, input.fallback);

    const id = newId();
    await this.db.client.$transaction(async (tx) => {
      await tx.assignmentRule.create({
        data: {
          id,
          organizationId,
          name: input.name,
          priority: input.priority ?? 0,
          strategy: input.strategy,
          target: (input.target ?? {}) as never,
          respectWorkingHours: input.respectWorkingHours ?? true,
          capacityCap: input.capacityCap ?? null,
          fallback: (input.fallback ?? { mode: 'unassigned_pool', notify: true }) as never,
        },
      });

      if (input.conditions && input.conditions.length > 0) {
        await tx.assignmentRuleCondition.createMany({
          data: input.conditions.map((condition) => ({
            id: newId(),
            organizationId,
            ruleId: id,
            fieldPath: condition.fieldPath,
            operator: condition.operator,
            value: (condition.value ?? null) as never,
            groupIndex: condition.groupIndex ?? 0,
          })),
        });
      }

      if (input.pool && input.pool.length > 0) {
        await tx.assignmentPoolMember.createMany({
          data: input.pool.map((member) => ({
            id: newId(),
            organizationId,
            ruleId: id,
            userId: member.userId,
            weight: member.weight ?? 1,
            isActive: member.isActive ?? true,
          })),
        });
      }

      await this.audit.recordInTransaction(tx, {
        action: 'assignment_rule.created',
        resourceType: 'assignment_rule',
        resourceId: id,
        after: { name: input.name, strategy: input.strategy, priority: input.priority ?? 0 },
      });
    });

    return { id, name: input.name, strategy: input.strategy };
  }

  async updateRule(id: string, input: UpdateAssignmentRuleInput) {
    const rule = await this.db.client.assignmentRule.findFirst({
      where: { id, deletedAt: null },
      include: { poolMembers: true },
    });
    if (!rule) throw AppError.notFound('Assignment rule');

    if (input.strategy || input.target || input.fallback) {
      await this.assertRuleCoherent(
        input.strategy ?? rule.strategy,
        input.target ?? (rule.target as { userId?: string; teamId?: string }),
        rule.poolMembers.map((member) => ({ userId: member.userId })),
        input.fallback ?? (rule.fallback as { mode?: string; userId?: string; teamId?: string }),
      );
    }

    await this.db.client.assignmentRule.update({
      where: { id },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.priority !== undefined ? { priority: input.priority } : {}),
        ...(input.strategy !== undefined ? { strategy: input.strategy } : {}),
        ...(input.target !== undefined ? { target: input.target as never } : {}),
        ...(input.respectWorkingHours !== undefined
          ? { respectWorkingHours: input.respectWorkingHours }
          : {}),
        ...(input.capacityCap !== undefined ? { capacityCap: input.capacityCap } : {}),
        ...(input.fallback !== undefined ? { fallback: input.fallback as never } : {}),
        ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
      },
    });
    await this.audit.record({
      action: 'assignment_rule.updated',
      resourceType: 'assignment_rule',
      resourceId: id,
      before: { strategy: rule.strategy, priority: rule.priority, isActive: rule.isActive },
      after: input as Record<string, unknown>,
    });
    return { id };
  }

  /** PUT: the condition editor submits the intended final set. */
  async setConditions(ruleId: string, input: SetConditionsInput) {
    const organizationId = tenantContext.organizationId('assignment.setConditions');
    const rule = await this.db.client.assignmentRule.findFirst({
      where: { id: ruleId, deletedAt: null },
    });
    if (!rule) throw AppError.notFound('Assignment rule');

    await this.db.client.$transaction(async (tx) => {
      await tx.assignmentRuleCondition.deleteMany({ where: { ruleId } });
      if (input.conditions.length > 0) {
        await tx.assignmentRuleCondition.createMany({
          data: input.conditions.map((condition) => ({
            id: newId(),
            organizationId,
            ruleId,
            fieldPath: condition.fieldPath,
            operator: condition.operator,
            value: (condition.value ?? null) as never,
            groupIndex: condition.groupIndex ?? 0,
          })),
        });
      }
      await this.audit.recordInTransaction(tx, {
        action: 'assignment_rule.conditions_set',
        resourceType: 'assignment_rule',
        resourceId: ruleId,
        after: { conditions: input.conditions.length },
      });
    });
    return { id: ruleId, conditions: input.conditions.length };
  }

  /**
   * PUT: the pool editor submits the intended final membership.
   *
   * The round-robin cursor is **reset** when the pool changes. A cursor is an index into a specific
   * ordering; keeping it across a membership change would silently skip whoever now occupies the
   * position, and "fairness" that depends on nobody ever joining is not worth preserving.
   */
  async setPool(ruleId: string, input: SetPoolInput) {
    const organizationId = tenantContext.organizationId('assignment.setPool');
    const rule = await this.db.client.assignmentRule.findFirst({
      where: { id: ruleId, deletedAt: null },
    });
    if (!rule) throw AppError.notFound('Assignment rule');

    if (input.pool.length > 0) {
      const userIds = input.pool.map((member) => member.userId);
      const members = await this.db.client.membership.findMany({
        where: { userId: { in: userIds }, status: 'active', deletedAt: null },
        select: { userId: true },
      });
      if (members.length !== new Set(userIds).size) throw AppError.notFound('Member');
    }

    const spec = strategySpec(rule.strategy);
    if (spec?.usesPool === true && input.pool.length === 0) {
      throw AppError.businessRule(
        `“${spec.label}” needs at least one person in the pool, or it can never assign anything`,
      );
    }

    await this.db.client.$transaction(async (tx) => {
      await tx.assignmentPoolMember.deleteMany({ where: { ruleId } });
      if (input.pool.length > 0) {
        await tx.assignmentPoolMember.createMany({
          data: input.pool.map((member) => ({
            id: newId(),
            organizationId,
            ruleId,
            userId: member.userId,
            weight: member.weight ?? 1,
            isActive: member.isActive ?? true,
          })),
        });
      }
      await tx.roundRobinState.deleteMany({ where: { ruleId } });
      await this.audit.recordInTransaction(tx, {
        action: 'assignment_rule.pool_set',
        resourceType: 'assignment_rule',
        resourceId: ruleId,
        after: { members: input.pool.length, rotationReset: true },
      });
    });
    return { id: ruleId, pool: input.pool.length, rotationReset: true };
  }

  async deleteRule(id: string) {
    const rule = await this.db.client.assignmentRule.findFirst({ where: { id, deletedAt: null } });
    if (!rule) throw AppError.notFound('Assignment rule');
    await this.db.client.assignmentRule.update({
      where: { id },
      data: { deletedAt: new Date(), isActive: false },
    });
    await this.audit.record({
      action: 'assignment_rule.deleted',
      resourceType: 'assignment_rule',
      resourceId: id,
      before: { name: rule.name, strategy: rule.strategy },
    });
    return { id, deleted: true };
  }

  /**
   * The rule tester (`FR-ASG-4`): runs the real engine and shows its working, writing nothing.
   *
   * Takes an existing lead or a hypothetical one, and an optional clock, because the two questions a
   * manager asks are "why did *this* lead go there" and "where would a lead like this go at 9pm".
   */
  async test(input: TestAssignmentInput): Promise<{
    decision: AssignmentDecision;
    at: Date;
    subject: Record<string, unknown>;
  }> {
    const at = input.at ?? new Date();
    let lead: Record<string, unknown>;
    let customValues: Record<string, unknown>;

    if (input.leadId) {
      const found = await this.db.client.lead.findFirst({ where: { id: input.leadId } });
      if (!found) throw AppError.notFound('Lead');
      const allowed = this.scopes.canAct(PERMISSIONS.LEAD_READ, {
        userId: found.assignedUserId,
        teamId: found.teamId,
        branchId: found.branchId,
      });
      if (!allowed) throw AppError.notFound('Lead');
      lead = serialiseLead(found);
      customValues = (found.customValues ?? {}) as Record<string, unknown>;
    } else {
      lead = input.lead ?? {};
      customValues = input.customValues ?? {};
    }

    const decision = await this.engine.decide({ lead, customValues, at });
    return { decision, at, subject: { ...lead, custom: customValues } };
  }

  /**
   * Re-runs the rules over leads that already exist (`FR-ASG-1`: "and on explicit re-evaluation").
   *
   * Sequential rather than parallel, and deliberately so: a round-robin over a pool of three,
   * evaluated concurrently for twenty leads, would hand several of them to the same person. The
   * cursor is the shared resource, and stepping it one lead at a time is what keeps the split even.
   */
  async evaluate(input: EvaluateAssignmentInput) {
    const results: {
      leadId: string;
      assignedUserId: string | null;
      changed: boolean;
      explanation: string;
    }[] = [];

    for (const leadId of input.leadIds) {
      const lead = await this.loadForAssign(leadId);
      const decision = await this.engine.decide({
        lead: serialiseLead(lead),
        customValues: (lead.customValues ?? {}) as Record<string, unknown>,
      });

      if (decision.assignedUserId === lead.assignedUserId) {
        results.push({
          leadId,
          assignedUserId: lead.assignedUserId,
          changed: false,
          explanation: `${decision.explanation} They already hold it.`,
        });
        continue;
      }

      await this.applyDecision(leadId, lead, decision);
      results.push({
        leadId,
        assignedUserId: decision.assignedUserId,
        changed: true,
        explanation: decision.explanation,
      });
    }

    return {
      items: results,
      pagination: fullPage(results.length),
      changed: results.filter((result) => result.changed).length,
    };
  }

  /**
   * Bulk manual reassignment (`FR-ASG-6`).
   *
   * Transferring the open tasks and conversation ownership that come with a lead needs those tables,
   * so it arrives with them. The response says so rather than implying the transfer happened.
   */
  async reassignBulk(input: ReassignBulkInput) {
    if (input.assignedUserId) {
      const membership = await this.db.client.membership.findFirst({
        where: { userId: input.assignedUserId, status: 'active', deletedAt: null },
      });
      if (!membership) throw AppError.notFound('Member');
    }

    const moved: string[] = [];
    const skipped: { leadId: string; reason: string }[] = [];

    for (const leadId of input.leadIds) {
      let lead;
      try {
        lead = await this.loadForAssign(leadId);
      } catch {
        // A lead the caller may not touch is reported, not silently dropped: a bulk action that
        // says "200 reassigned" when it moved 140 is worse than one that says which 60 it skipped.
        skipped.push({ leadId, reason: 'not found, or outside your access' });
        continue;
      }
      if (lead.assignedUserId === input.assignedUserId) {
        skipped.push({ leadId, reason: 'already assigned to that person' });
        continue;
      }

      await this.applyDecision(leadId, lead, {
        assignedUserId: input.assignedUserId,
        teamId: null,
        rule: null,
        usedFallback: false,
        notifyManagers: false,
        candidates: [],
        ruleEvaluations: [],
        explanation: input.reason ?? 'Reassigned in bulk',
        reason: input.reason ?? 'bulk reassignment',
        roundRobinAdvance: null,
      });
      moved.push(leadId);
    }

    return {
      reassigned: moved.length,
      skipped,
      openTasksTransferred: false,
      note: 'Open tasks and conversation ownership move with a lead once tasks and conversations exist.',
    };
  }

  /** Applies a decision to one lead: the row, the history, the timeline and the event. */
  async applyDecision(
    leadId: string,
    lead: { organizationId: string; assignedUserId: string | null; teamId: string | null },
    decision: AssignmentDecision,
  ): Promise<void> {
    const now = new Date();
    await this.db.client.$transaction(async (tx) => {
      await tx.lead.update({
        where: { id: leadId },
        data: {
          assignedUserId: decision.assignedUserId,
          ...(decision.teamId !== null ? { teamId: decision.teamId } : {}),
          lastActivityAt: now,
        },
      });
      await tx.leadAssignment.create({
        data: {
          id: newId(),
          organizationId: lead.organizationId,
          leadId,
          fromUserId: lead.assignedUserId,
          toUserId: decision.assignedUserId,
          toTeamId: decision.teamId,
          assignedById: tenantContext.get()?.actorId ?? null,
          reason: decision.reason,
        },
      });
      if (decision.roundRobinAdvance) {
        await this.engine.commitRoundRobin(tx, decision.roundRobinAdvance);
        if (decision.assignedUserId) {
          await tx.roundRobinState.updateMany({
            where: { ruleId: decision.roundRobinAdvance.ruleId },
            data: { lastAssignedUserId: decision.assignedUserId },
          });
        }
      }

      await this.timeline.recordInTransaction(tx, {
        type:
          decision.assignedUserId === null
            ? ACTIVITY_TYPES.LEAD_UNASSIGNED
            : lead.assignedUserId
              ? ACTIVITY_TYPES.LEAD_REASSIGNED
              : ACTIVITY_TYPES.LEAD_ASSIGNED,
        leadId,
        occurredAt: now,
        payload: {
          fromUserId: lead.assignedUserId,
          toUserId: decision.assignedUserId,
          reason: decision.reason,
          ruleId: decision.rule?.id ?? null,
          ruleName: decision.rule?.name ?? null,
          usedFallback: decision.usedFallback,
          explanation: decision.explanation,
        },
      });
      await this.audit.recordInTransaction(tx, {
        action: 'lead.assigned',
        resourceType: 'lead',
        resourceId: leadId,
        before: { assignedUserId: lead.assignedUserId },
        after: { assignedUserId: decision.assignedUserId, rule: decision.rule?.name ?? null },
      });

      const events: DomainEventInput[] = [
        {
          name: 'lead.assigned',
          aggregateType: 'lead',
          aggregateId: leadId,
          payload: {
            leadId,
            fromUserId: lead.assignedUserId,
            toUserId: decision.assignedUserId,
            ruleId: decision.rule?.id ?? null,
          },
        },
      ];
      // A lead nobody picked up is the case that loses business, so it leaves as its own event for
      // the notification consumer rather than being inferred from `lead.assigned` with a null.
      if (decision.assignedUserId === null && decision.notifyManagers) {
        events.push({
          name: 'lead.unassigned_pool',
          aggregateType: 'lead',
          aggregateId: leadId,
          payload: {
            leadId,
            ruleId: decision.rule?.id ?? null,
            ruleName: decision.rule?.name ?? null,
            explanation: decision.explanation,
          },
        });
      }
      await this.outbox.emit(tx, events);
    });
  }

  private async loadForAssign(leadId: string) {
    const lead = await this.db.client.lead.findFirst({ where: { id: leadId, deletedAt: null } });
    if (!lead) throw AppError.notFound('Lead');
    const allowed = this.scopes.canAct(PERMISSIONS.LEAD_ASSIGN, {
      userId: lead.assignedUserId,
      teamId: lead.teamId,
      branchId: lead.branchId,
    });
    if (!allowed) throw AppError.notFound('Lead');
    return lead;
  }

  /**
   * Checks a rule is capable of assigning anything before it is stored.
   *
   * A `specific_user` rule with no user, or a round-robin with an empty pool, is a rule that silently
   * sends every matching lead to the fallback. Refusing it at configuration time is the only place
   * somebody can still see why.
   */
  private async assertRuleCoherent(
    strategy: string,
    target: { userId?: string; teamId?: string } | undefined,
    pool: readonly { userId: string }[] | undefined,
    fallback: { mode?: string; userId?: string; teamId?: string } | undefined,
  ): Promise<void> {
    const spec = strategySpec(strategy);
    if (!spec) throw AppError.businessRule(`Unknown strategy “${strategy}”`);

    if (spec.requires === 'userId') {
      if (!target?.userId) {
        throw AppError.validation('Some details need correcting', [
          { field: 'target.userId', code: 'REQUIRED', message: `“${spec.label}” needs a person.` },
        ]);
      }
      await this.assertMember(target.userId);
    }
    if (spec.requires === 'teamId') {
      if (!target?.teamId) {
        throw AppError.validation('Some details need correcting', [
          { field: 'target.teamId', code: 'REQUIRED', message: `“${spec.label}” needs a team.` },
        ]);
      }
      await this.assertTeam(target.teamId);
    }
    if (spec.requires === 'pool' && (pool === undefined || pool.length === 0)) {
      throw AppError.validation('Some details need correcting', [
        {
          field: 'pool',
          code: 'REQUIRED',
          message: `“${spec.label}” needs at least one person in the pool.`,
        },
      ]);
    }
    if (pool && pool.length > 0) {
      const userIds = pool.map((member) => member.userId);
      const members = await this.db.client.membership.findMany({
        where: { userId: { in: userIds }, status: 'active', deletedAt: null },
        select: { userId: true },
      });
      if (members.length !== new Set(userIds).size) throw AppError.notFound('Member');
    }

    if (fallback?.mode === 'specific_user') {
      if (!fallback.userId) {
        throw AppError.validation('Some details need correcting', [
          {
            field: 'fallback.userId',
            code: 'REQUIRED',
            message: 'Name the person to fall back to.',
          },
        ]);
      }
      await this.assertMember(fallback.userId);
    }
    if (fallback?.mode === 'team') {
      if (!fallback.teamId) {
        throw AppError.validation('Some details need correcting', [
          { field: 'fallback.teamId', code: 'REQUIRED', message: 'Name the team to fall back to.' },
        ]);
      }
      await this.assertTeam(fallback.teamId);
    }
  }

  private async assertMember(userId: string): Promise<void> {
    const membership = await this.db.client.membership.findFirst({
      where: { userId, status: 'active', deletedAt: null },
    });
    if (!membership) throw AppError.notFound('Member');
  }

  private async assertTeam(teamId: string): Promise<void> {
    const team = await this.db.client.team.findFirst({ where: { id: teamId, deletedAt: null } });
    if (!team) throw AppError.notFound('Team');
  }
}

/** BigInt does not survive the pure evaluator's comparisons, and money is stored as one. */
function serialiseLead(lead: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(lead)) {
    result[key] = typeof value === 'bigint' ? Number(value) : value;
  }
  return result;
}
