import { Injectable } from '@nestjs/common';
import {
  ACTIVITY_TYPES,
  AppError,
  ESCALATION_LEVELS,
  PERMISSIONS,
  SLA_TARGETS,
  addBusinessMinutes,
  businessMinutesBetween,
  matchSlaPolicy,
  newId,
  slaHealth,
  systemPrincipal,
  targetMinutes,
  tenantContext,
  warnMinutes,
  wasMetOnTime,
  withPlatformScope,
  type SlaAppliesTo,
  type SlaHealth,
  type SlaPolicyLike,
  type SlaTarget,
} from '@leados/shared';
import { DbService } from '../../infra/db/db.service.js';
import { AuditService } from '../../infra/audit/audit.service.js';
import { OutboxService, type TransactionClient } from '../../infra/outbox/outbox.service.js';
import { TimelineService } from '../../infra/timeline/timeline.service.js';
import { DataScopeService, applyScopeFilter } from '../../infra/authz/data-scope.service.js';
import { SlaCalendarService } from './sla-calendar.service.js';
import type { ListClocksQuery } from './sla.dto.js';

/**
 * Clocks whose subject still exists.
 *
 * A clock with no lead is a conversation's or a task's, which arrive later and have their own
 * liveness; a clock on a lead must only be swept while that lead is live.
 */
function liveSubject() {
  return { OR: [{ leadId: null }, { lead: { deletedAt: null } }] };
}

/** The facts about a lead a clock needs, gathered once. */
interface LeadForSla {
  readonly id: string;
  readonly organizationId: string;
  readonly leadSourceId: string | null;
  readonly priority: string;
  readonly pipelineId: string;
  readonly scoreBand: string | null;
  readonly branchId: string | null;
  readonly teamId: string | null;
  readonly assignedUserId: string | null;
}

/**
 * SLA clocks (`FR-TSK-8`).
 *
 * **The product's answer to "did anybody get back to them, and how fast".** A lead that nobody
 * calls is the single most expensive failure this product can have — the business paid for the
 * click — and `FR-ASG-4`'s unassigned-pool notification only covers the case where nobody *owns*
 * it. This covers the commoner one: somebody owns it and nothing happens.
 *
 * Four decisions shape this file:
 *
 *  * **`due_at` is computed through the business calendar when the clock starts, and stored.** The
 *    sweep has to find what is due with one indexed query across every tenant, and a target
 *    recomputed later against a calendar somebody has since edited would silently move a promise
 *    that was already made.
 *  * **Escalating exactly once is a unique key, not careful code.** `escalations` is unique on
 *    `(organization_id, clock_id, level)`, so the sweep inserts and reads a collision as "already
 *    done". That is the guarantee the phase's exit criteria ask for.
 *  * **A running clock past its due instant already reads as breached.** `slaHealth()` reads the
 *    wall clock, so a manager refreshing the board at 10:01 is never told a 10:00 promise is fine
 *    because a cron has not fired. The stored state is about *having escalated*.
 *  * **The sweep reads across tenants and writes inside each one.** `TimelineService` takes the
 *    organization from the context by design — the trap the quotation expiry sweep paid for.
 */
@Injectable()
export class SlaService {
  constructor(
    private readonly db: DbService,
    private readonly scopes: DataScopeService,
    private readonly calendars: SlaCalendarService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly timeline: TimelineService,
  ) {}

  // ── Starting and satisfying ───────────────────────────────────────────────

  /**
   * Starts the clocks a new lead is owed, inside the transaction that created it.
   *
   * Never throws. A lead that cannot be created because its SLA policy is misconfigured would be a
   * lead the business paid for and lost — so a missing policy, an empty calendar or an unparseable
   * `applies_to` means *no clock*, which the board then shows as a lead with no promise rather than
   * as a capture that failed.
   */
  async startForLead(
    tx: TransactionClient,
    lead: LeadForSla,
    startedAt: Date,
  ): Promise<{ started: SlaTarget[] }> {
    const policies = await this.activePolicies(tx);
    const policy = matchSlaPolicy(policies, {
      leadSourceId: lead.leadSourceId,
      priority: lead.priority,
      pipelineId: lead.pipelineId,
      scoreBand: lead.scoreBand,
    });
    if (!policy) return { started: [] };

    const organization = await tx.organization.findUniqueOrThrow({
      where: { id: lead.organizationId },
      select: { timezone: true },
    });
    const calendar = policy.businessHoursOnly
      ? await this.calendars.forBranch(organization.timezone, lead.branchId, startedAt)
      : this.calendars.alwaysOpenFor(organization.timezone);

    const started: SlaTarget[] = [];
    // `next_response` is deliberately not started: it measures a reply to a waiting conversation,
    // and the inbox arrives in Phase 5. Starting it now would breach every policy that sets it.
    for (const target of ['first_response', 'resolution'] as const) {
      const minutes = targetMinutes(policy, target);
      if (minutes === null) continue;

      const dueAt = addBusinessMinutes(startedAt, minutes, calendar);
      const warnAt = addBusinessMinutes(
        startedAt,
        warnMinutes(minutes, policy.warnAtPercent),
        calendar,
      );
      // A calendar that never opens again inside a year. No clock rather than a due date invented
      // by a fallback — a promise nobody made is worse than no promise.
      if (!dueAt || !warnAt) continue;

      await tx.slaClock.createMany({
        data: [
          {
            id: newId(),
            organizationId: lead.organizationId,
            policyId: policy.id,
            subjectType: 'lead',
            subjectId: lead.id,
            leadId: lead.id,
            target,
            branchId: lead.branchId,
            teamId: lead.teamId,
            assignedUserId: lead.assignedUserId,
            startedAt,
            dueAt,
            warnAt,
            targetMinutes: minutes,
          },
        ],
        // A capture replayed by a retry must not produce a second clock. The unique key on
        // `(organization_id, subject_type, subject_id, target)` is what makes this safe.
        skipDuplicates: true,
      });
      started.push(target);
    }
    return { started };
  }

  /**
   * Marks a promise kept.
   *
   * Idempotent on the clock's state rather than on a flag: the first thing that answers a lead wins
   * and everything after it is a no-op, which is what lets several call sites (a completed task
   * today; a WhatsApp send, a logged call and an email in later phases) all call this without
   * coordinating.
   */
  async satisfy(
    tx: TransactionClient,
    subject: { organizationId: string; leadId: string },
    target: SlaTarget,
    at: Date,
    by: string,
  ): Promise<boolean> {
    const updated = await tx.slaClock.updateMany({
      where: {
        organizationId: subject.organizationId,
        subjectType: 'lead',
        subjectId: subject.leadId,
        target,
        state: 'running',
      },
      data: { state: 'satisfied', satisfiedAt: at, satisfiedBy: by },
    });
    return updated.count > 0;
  }

  /**
   * Stops the clocks on a lead nobody will answer — a merge, a delete, a disqualification.
   *
   * Cancelled rather than satisfied: a promise that stopped applying was not kept, and counting it
   * as kept is how an SLA report becomes a number nobody believes.
   */
  async cancelForLead(
    tx: TransactionClient,
    organizationId: string,
    leadId: string,
    at: Date,
  ): Promise<number> {
    const updated = await tx.slaClock.updateMany({
      where: { organizationId, subjectType: 'lead', subjectId: leadId, state: 'running' },
      data: { state: 'cancelled', cancelledAt: at },
    });
    return updated.count;
  }

  // ── The sweep (`sla.sweep`) ───────────────────────────────────────────────

  /**
   * Warns what is at risk and escalates what has breached (`FR-TSK-8`).
   *
   * The **read** is cross-tenant; every **write** happens inside that row's own tenant context,
   * because `TimelineService` takes the organization from the context by design.
   *
   * Breaches are handled before warnings. A clock that went from "fine" to "past due" between two
   * ticks — a five-minute window and a sixty-minute target make that unlikely but not impossible —
   * must produce the breach, and warning about something that has already happened is noise.
   */
  async sweep(limit = 500): Promise<{ warned: number; breached: number }> {
    const now = new Date();

    const due = await withPlatformScope('sla: breach sweep', async () =>
      this.db.client.slaClock.findMany({
        // A clock on a lead that has been deleted or absorbed by a merge is a promise that stopped
        // applying. The call sites cancel it, and this is the guard that means a future one which
        // forgets cannot produce a phantom breach on a record nobody can open.
        where: { state: 'running', dueAt: { lte: now }, ...liveSubject() },
        select: this.sweepSelect(),
        orderBy: { dueAt: 'asc' },
        take: limit,
      }),
    );
    const atRisk = await withPlatformScope('sla: warning sweep', async () =>
      this.db.client.slaClock.findMany({
        where: {
          state: 'running',
          warnedAt: null,
          warnAt: { lte: now },
          dueAt: { gt: now },
          ...liveSubject(),
        },
        select: this.sweepSelect(),
        orderBy: { warnAt: 'asc' },
        take: limit,
      }),
    );

    let breached = 0;
    for (const clock of due) {
      if (await this.escalate(clock, 'breached', now)) breached += 1;
    }
    let warned = 0;
    for (const clock of atRisk) {
      if (await this.escalate(clock, 'at_risk', now)) warned += 1;
    }
    return { warned, breached };
  }

  // ── Reading ───────────────────────────────────────────────────────────────

  /**
   * The manager's board (`GET /sla/board`).
   *
   * **Counts are aggregates over the whole filter**, not a tally of the loaded page — the mistake
   * the pipeline board paid for, where a screen summing twenty cards told a business owner their
   * pipeline was worth a fifth of what it was.
   */
  async board(query: { assignedUserId?: string; mine?: boolean }) {
    const principal = tenantContext.require('sla.board');
    const filter = this.scopes.filterFor(PERMISSIONS.SLA_READ, {
      userColumn: 'assignedUserId',
      teamColumn: 'teamId',
      branchColumn: 'branchId',
    });
    const now = new Date();
    const base: Record<string, unknown> = {
      ...(query.mine ? { assignedUserId: principal.actorId ?? '' } : {}),
      ...(query.assignedUserId ? { assignedUserId: query.assignedUserId } : {}),
    };
    const where = applyScopeFilter(base, filter);
    if (where === null) {
      return { counts: emptyCounts(), items: [], unacknowledged: 0, generatedAt: now };
    }

    const [breached, atRisk, running, satisfied, late, unacknowledged, rows] = await Promise.all([
      this.db.client.slaClock.count({
        where: { ...where, OR: [{ state: 'breached' }, { state: 'running', dueAt: { lte: now } }] },
      }),
      this.db.client.slaClock.count({
        where: { ...where, state: 'running', warnAt: { lte: now }, dueAt: { gt: now } },
      }),
      this.db.client.slaClock.count({ where: { ...where, state: 'running', warnAt: { gt: now } } }),
      this.db.client.slaClock.count({ where: { ...where, state: 'satisfied' } }),
      /**
       * Answered, but late. Separate from `breached` on purpose: a clock somebody eventually
       * answered is a different management problem from one still sitting there, and a board that
       * folded them together could not tell a backlog from a habit.
       *
       * A **field reference** rather than a stored `met_on_time` boolean: the comparison is between
       * two columns of the same row, and a second copy of "was it late" is a second thing that can
       * disagree with the timestamps it was derived from.
       */
      this.db.client.slaClock.count({
        where: {
          ...where,
          state: 'satisfied',
          satisfiedAt: { gt: this.db.client.slaClock.fields.dueAt },
        },
      }),
      this.db.client.escalation.count({ where: { acknowledgedAt: null } }),
      this.db.client.slaClock.findMany({
        where: { ...where, state: 'running' },
        orderBy: { dueAt: 'asc' },
        take: 50,
        include: this.listInclude(),
      }),
    ]);

    return {
      counts: {
        breached,
        at_risk: atRisk,
        running,
        met: satisfied,
        answered_late: late,
      },
      items: rows.map((row) => this.present(row, now)),
      unacknowledged,
      generatedAt: now,
    };
  }

  async list(query: ListClocksQuery) {
    const principal = tenantContext.require('sla.list');
    const filter = this.scopes.filterFor(PERMISSIONS.SLA_READ, {
      userColumn: 'assignedUserId',
      teamColumn: 'teamId',
      branchColumn: 'branchId',
    });
    const now = new Date();
    const base: Record<string, unknown> = {
      ...(query.leadId ? { leadId: query.leadId } : {}),
      ...(query.target ? { target: query.target } : {}),
      ...(query.state ? { state: query.state } : {}),
      ...(query.mine ? { assignedUserId: principal.actorId ?? '' } : {}),
      ...(query.assignedUserId ? { assignedUserId: query.assignedUserId } : {}),
      ...(query.health === 'breached'
        ? { OR: [{ state: 'breached' }, { state: 'running', dueAt: { lte: now } }] }
        : {}),
      ...(query.health === 'at_risk'
        ? { state: 'running', warnAt: { lte: now }, dueAt: { gt: now } }
        : {}),
    };
    const where = applyScopeFilter(base, filter);
    if (where === null) {
      return {
        items: [],
        pagination: { limit: query.limit, nextCursor: null, hasMore: false, total: 0 },
      };
    }

    const [total, rows] = await Promise.all([
      this.db.client.slaClock.count({ where }),
      this.db.client.slaClock.findMany({
        where,
        orderBy: [{ dueAt: query.direction }, { id: 'asc' }],
        take: query.limit + 1,
        ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
        include: this.listInclude(),
      }),
    ]);
    const page = rows.slice(0, query.limit);
    const hasMore = rows.length > query.limit;
    return {
      items: page.map((row) => this.present(row, now)),
      pagination: {
        limit: query.limit,
        nextCursor: hasMore ? (page.at(-1)?.id ?? null) : null,
        hasMore,
        total,
      },
    };
  }

  /** The clocks on one lead, for its detail screen. */
  async forLead(leadId: string) {
    const lead = await this.db.client.lead.findFirst({
      where: { id: leadId },
      select: { id: true, assignedUserId: true, teamId: true, branchId: true },
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

    const now = new Date();
    const rows = await this.db.client.slaClock.findMany({
      where: { leadId },
      orderBy: { startedAt: 'asc' },
      include: this.listInclude(),
    });
    const items = rows.map((row) => this.present(row, now));
    return {
      items,
      pagination: { limit: items.length, nextCursor: null, hasMore: false, total: items.length },
    };
  }

  async escalations(query: { limit: number; cursor?: string; unacknowledgedOnly?: boolean }) {
    this.scopes.filterFor(PERMISSIONS.SLA_READ, {});
    const where = query.unacknowledgedOnly === true ? { acknowledgedAt: null } : {};
    const rows = await this.db.client.escalation.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
      include: {
        policy: { select: { id: true, name: true } },
        clock: {
          select: {
            id: true,
            target: true,
            dueAt: true,
            leadId: true,
            lead: { select: { id: true, fullName: true } },
          },
        },
      },
    });
    const page = rows.slice(0, query.limit);
    const hasMore = rows.length > query.limit;
    const total = await this.db.client.escalation.count({ where });
    return {
      items: page.map((row) => ({
        id: row.id,
        level: row.level,
        reason: row.reason,
        notifiedUserIds: row.notifiedUserIds,
        createdAt: row.createdAt,
        acknowledgedAt: row.acknowledgedAt,
        acknowledgedById: row.acknowledgedById,
        policy: row.policy,
        clock: row.clock,
      })),
      pagination: {
        limit: query.limit,
        nextCursor: hasMore ? (page.at(-1)?.id ?? null) : null,
        hasMore,
        total,
      },
    };
  }

  /**
   * "I have seen it."
   *
   * Worth a column rather than nothing: an escalation nobody acknowledges is the one a manager
   * needs to chase, and a board that cannot tell those apart is a board that only ever grows.
   */
  async acknowledge(id: string) {
    const principal = tenantContext.require('sla.acknowledge');
    const updated = await this.db.client.escalation.updateMany({
      where: { id, acknowledgedAt: null },
      data: { acknowledgedAt: new Date(), acknowledgedById: principal.actorId ?? null },
    });
    if (updated.count === 0) {
      const exists = await this.db.client.escalation.findFirst({ where: { id } });
      if (!exists) throw AppError.notFound('Escalation');
      return { acknowledged: true, alreadyAcknowledged: true };
    }
    await this.audit.record({
      action: 'escalation.acknowledged',
      resourceType: 'escalation',
      resourceId: id,
    });
    return { acknowledged: true, alreadyAcknowledged: false };
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  /**
   * Writes one escalation, or returns false because it was already written.
   *
   * The insert **is** the idempotency check: `escalation_once_per_level_key` is unique on
   * `(organization_id, clock_id, level)`, so a second attempt collides. That is why this is a
   * `createMany` with `skipDuplicates` whose count is the answer, rather than a read followed by a
   * write — two sweeps running at once would both pass the read.
   */
  private async escalate(
    clock: SweepRow,
    reason: 'at_risk' | 'breached',
    now: Date,
  ): Promise<boolean> {
    const level = reason === 'breached' ? ESCALATION_LEVELS.breached : ESCALATION_LEVELS.atRisk;

    return tenantContext.run(systemPrincipal(clock.organizationId, newId()), async () => {
      const recipients = await this.recipientsFor(clock);
      // An escalation that reached nobody is a row claiming somebody was told. `escalations_
      // notified_somebody` would refuse it, so the sweep does not try — and it still marks the
      // clock, or it would retry this every five minutes forever.
      if (recipients.length === 0) {
        await this.db.client.slaClock.updateMany({
          where: { id: clock.id },
          data:
            reason === 'breached'
              ? { state: 'breached', breachedAt: now, warnedAt: clock.warnedAt ?? now }
              : { warnedAt: now },
        });
        return false;
      }

      return this.db.client.$transaction(async (tx) => {
        const inserted = await tx.escalation.createMany({
          data: [
            {
              id: newId(),
              organizationId: clock.organizationId,
              clockId: clock.id,
              policyId: clock.policyId,
              subjectType: clock.subjectType,
              subjectId: clock.subjectId,
              level,
              reason,
              notifiedUserIds: recipients,
            },
          ],
          skipDuplicates: true,
        });
        if (inserted.count === 0) {
          // Somebody else got here first. Still move the clock on, so the breach sweep does not
          // keep finding it.
          if (reason === 'breached') {
            await tx.slaClock.updateMany({
              where: { id: clock.id, state: 'running' },
              data: { state: 'breached', breachedAt: now },
            });
          }
          return false;
        }

        await tx.slaClock.updateMany({
          where: { id: clock.id },
          data:
            reason === 'breached'
              ? { state: 'breached', breachedAt: now, warnedAt: clock.warnedAt ?? now }
              : { warnedAt: now },
        });

        if (clock.leadId) {
          await this.timeline.recordInTransaction(tx, {
            type: reason === 'breached' ? ACTIVITY_TYPES.SLA_BREACHED : ACTIVITY_TYPES.SLA_AT_RISK,
            leadId: clock.leadId,
            occurredAt: now,
            payload: {
              clockId: clock.id,
              target: clock.target,
              policy: clock.policy.name,
              dueAt: clock.dueAt.toISOString(),
              targetMinutes: clock.targetMinutes,
              notified: recipients.length,
            },
            // The sweep is not a person.
            actorType: 'system',
          });
        }

        await this.audit.recordInTransaction(tx, {
          action: reason === 'breached' ? 'sla.breached' : 'sla.at_risk',
          resourceType: 'sla_clock',
          resourceId: clock.id,
          after: { target: clock.target, dueAt: clock.dueAt, notified: recipients },
        });

        await this.outbox.emit(tx, [
          {
            name: reason === 'breached' ? 'sla.breached' : 'sla.at_risk',
            aggregateType: 'sla_clock',
            aggregateId: clock.id,
            payload: {
              leadId: clock.leadId,
              target: clock.target,
              policyName: clock.policy.name,
              dueAt: clock.dueAt.toISOString(),
              targetMinutes: clock.targetMinutes,
              assignedUserId: clock.assignedUserId,
              notifiedUserIds: recipients,
            },
          },
        ]);
        return true;
      });
    });
  }

  /**
   * Who hears about it.
   *
   * By **permission**, not by role name (rule 4): `escalate_to.permission` names the authority a
   * workspace has made responsible, whatever it calls the role. Explicit `userIds` win when the
   * tenant named people, and the clock's own assignee is always included — somebody has to know
   * their own lead is about to breach, and telling only their manager is how an escalation becomes
   * a reprimand instead of a reminder.
   */
  private async recipientsFor(clock: SweepRow): Promise<string[]> {
    const escalateTo = (clock.policy.escalateTo ?? {}) as {
      permission?: unknown;
      userIds?: unknown;
    };
    const recipients = new Set<string>();
    if (clock.assignedUserId) recipients.add(clock.assignedUserId);

    if (Array.isArray(escalateTo.userIds)) {
      for (const userId of escalateTo.userIds) {
        if (typeof userId === 'string') recipients.add(userId);
      }
    }

    const permission =
      typeof escalateTo.permission === 'string'
        ? escalateTo.permission
        : PERMISSIONS.TASK_MANAGE_OTHERS;
    const grants = await this.db.client.rolePermission.findMany({
      where: { permissionKey: permission },
      select: { roleId: true },
    });
    if (grants.length > 0) {
      const holders = await this.db.client.userRole.findMany({
        where: { roleId: { in: grants.map((grant) => grant.roleId) } },
        select: { userId: true },
      });
      for (const holder of holders) recipients.add(holder.userId);
    }

    // Only active members: a notification for somebody who left is a notification nobody reads,
    // and the composite FK on `notifications` would refuse it anyway.
    const active = await this.db.client.membership.findMany({
      where: { userId: { in: [...recipients] }, status: 'active', deletedAt: null },
      select: { userId: true },
    });
    return active.map((row) => row.userId);
  }

  private async activePolicies(tx: TransactionClient): Promise<SlaPolicyLike[]> {
    const rows = await tx.slaPolicy.findMany({
      where: { isActive: true, deletedAt: null },
      orderBy: [{ priority: 'asc' }, { name: 'asc' }],
    });
    return rows.map((row) => ({
      id: row.id,
      priority: row.priority,
      appliesTo: asAppliesTo(row.appliesTo),
      firstResponseMinutes: row.firstResponseMinutes,
      nextResponseMinutes: row.nextResponseMinutes,
      resolutionMinutes: row.resolutionMinutes,
      businessHoursOnly: row.businessHoursOnly,
      warnAtPercent: row.warnAtPercent,
    }));
  }

  private sweepSelect() {
    return {
      id: true,
      organizationId: true,
      policyId: true,
      subjectType: true,
      subjectId: true,
      leadId: true,
      target: true,
      dueAt: true,
      warnAt: true,
      warnedAt: true,
      targetMinutes: true,
      assignedUserId: true,
      policy: { select: { name: true, escalateTo: true } },
    } as const;
  }

  private listInclude() {
    return {
      policy: { select: { id: true, name: true } },
      lead: { select: { id: true, fullName: true, phoneE164: true } },
    };
  }

  private present(
    row: {
      id: string;
      target: string;
      state: string;
      startedAt: Date;
      dueAt: Date;
      warnAt: Date;
      targetMinutes: number;
      satisfiedAt: Date | null;
      breachedAt: Date | null;
      warnedAt: Date | null;
      cancelledAt: Date | null;
      satisfiedBy: string | null;
      leadId: string | null;
      assignedUserId: string | null;
      policy?: { id: string; name: string } | null;
      lead?: { id: string; fullName: string | null; phoneE164: string | null } | null;
    },
    now: Date,
  ) {
    const health: SlaHealth = slaHealth(
      {
        state: row.state as never,
        dueAt: row.dueAt,
        warnAt: row.warnAt,
        satisfiedAt: row.satisfiedAt,
        breachedAt: row.breachedAt,
      },
      now,
    );
    return {
      id: row.id,
      target: row.target,
      state: row.state,
      /** Derived from the clock, so a board is never a cron tick behind the truth. */
      health,
      startedAt: row.startedAt,
      dueAt: row.dueAt,
      warnAt: row.warnAt,
      targetMinutes: row.targetMinutes,
      satisfiedAt: row.satisfiedAt,
      satisfiedBy: row.satisfiedBy,
      breachedAt: row.breachedAt,
      warnedAt: row.warnedAt,
      cancelledAt: row.cancelledAt,
      metOnTime: wasMetOnTime({
        state: row.state as never,
        dueAt: row.dueAt,
        warnAt: row.warnAt,
        satisfiedAt: row.satisfiedAt,
      }),
      leadId: row.leadId,
      lead: row.lead ?? null,
      assignedUserId: row.assignedUserId,
      policy: row.policy ?? null,
    };
  }
}

type SweepRow = {
  id: string;
  organizationId: string;
  policyId: string;
  subjectType: 'lead' | 'conversation' | 'task';
  subjectId: string;
  leadId: string | null;
  target: string;
  dueAt: Date;
  warnAt: Date;
  warnedAt: Date | null;
  targetMinutes: number;
  assignedUserId: string | null;
  policy: { name: string; escalateTo: unknown };
};

/** A JSONB value read back as the shape the matcher expects, defensively. */
function asAppliesTo(value: unknown): SlaAppliesTo {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
  const record = value as Record<string, unknown>;
  const list = (key: string): string[] | undefined => {
    const raw = record[key];
    if (!Array.isArray(raw)) return undefined;
    return raw.filter((entry): entry is string => typeof entry === 'string');
  };
  return {
    ...(list('sourceIds') ? { sourceIds: list('sourceIds') } : {}),
    ...(list('priorities') ? { priorities: list('priorities') } : {}),
    ...(list('pipelineIds') ? { pipelineIds: list('pipelineIds') } : {}),
    ...(list('scoreBands') ? { scoreBands: list('scoreBands') } : {}),
  };
}

function emptyCounts(): Record<string, number> {
  return { breached: 0, at_risk: 0, running: 0, met: 0, answered_late: 0 };
}

/** Exported for the report the board shows; kept here so the two use one definition. */
export { SLA_TARGETS, businessMinutesBetween };
