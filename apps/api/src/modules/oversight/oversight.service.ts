import { Injectable } from '@nestjs/common';
import {
  OPEN_TASK_STATUSES,
  PERMISSIONS,
  taskBucketWhere,
  tenantContext,
  withPlatformScope,
} from '@leados/shared';
import { DbService } from '../../infra/db/db.service.js';
import { DataScopeService, applyScopeFilter } from '../../infra/authz/data-scope.service.js';
import { OVERSIGHT_PEOPLE_LIMIT, type OversightQuery } from './oversight.dto.js';

/** One person's row. Every number here is a link on the screen. */
export interface PersonRow {
  userId: string;
  name: string;
  email: string;
  /** Open follow-ups, and how many of those are past their time. */
  openFollowUps: number;
  overdue: number;
  /** Follow-ups moved at least once in the period — `FR-TSK-5`'s coaching signal. */
  rescheduled: number;
  /** Leads of theirs nobody has spoken to yet. */
  awaitingFirstContact: number;
  /** Open leads of theirs with nobody owing them anything. */
  noNextAction: number;
  promisesBreached: number;
  promisesAtRisk: number;
  promisesMet: number;
  promisesAnsweredLate: number;
  /** `null` when no promise of theirs was answered in the period — not zero. */
  onTimeRate: number | null;
  /** Median minutes from capture to first response, over the period. `null` when none. */
  medianResponseMinutes: number | null;
  leadsAssigned: number;
  converted: number;
}

/**
 * Manager oversight (brief §4 "Which leads are being missed?", `FR-TSK-5`, `FR-TSK-8`).
 *
 * **One request, one table, and no composite score.** The screen answers "who is behind, and on
 * what" — which is six different questions about each person, not one. A single ranking number
 * would be the easiest thing to build and the worst thing to ship: it hides which dimension
 * somebody is actually behind on, and the moment it exists people optimise it. See
 * ADR-0026 for the full argument; the short version is that every column here is an **outcome**
 * (promises kept, leads contacted, deals converted) or a **cost** (overdue, reschedules), and
 * nothing here counts activity. A leaderboard ranked by calls logged teaches everybody to log
 * calls.
 *
 * Read with `report:read` through `DataScopeService`, so a branch manager sees their branch and the
 * owner sees the workspace from the same endpoint — the arrangement `/sla/board` settled.
 *
 * Every number is a live aggregate over the whole set. The design says these cards should read
 * rollup tables (ADR-0010), and they will; the rollups arrive in Phase 10 and inventing them now
 * would mean a second definition of every number on this page, to disagree with this one later.
 */
@Injectable()
export class OversightService {
  constructor(
    private readonly db: DbService,
    private readonly scopes: DataScopeService,
  ) {}

  async board(query: OversightQuery) {
    const now = new Date();
    const from = new Date(now.getTime() - query.days * 24 * 3_600_000);
    const timeZone = await this.timeZone();

    const people = await this.peopleInScope();
    const personIds = people.map((person) => person.id);
    const [queue, promises, rows] = await Promise.all([
      this.queueTotals(now, timeZone),
      this.promiseTotals(now, from, personIds),
      this.perPerson(people, now, from, timeZone),
    ]);

    return {
      generatedAt: now,
      timeZone,
      period: { from, to: now, days: query.days },
      scope: {
        /** How wide the caller's own `report:read` grant is, so the screen can say so. */
        kind: this.scopeKind(),
        people: people.length,
        truncated: people.length >= OVERSIGHT_PEOPLE_LIMIT,
      },
      queue,
      promises,
      people: rows,
    };
  }

  // ── The workspace's own backlog ───────────────────────────────────────────

  /**
   * The four numbers that are about the whole set rather than about a person.
   *
   * `unassigned` and `noNextAction` are deliberately here and not only in the table: a lead nobody
   * owns appears in **no** person's row, which is exactly what makes it the number most worth
   * putting at the top of a manager's screen.
   */
  private async queueTotals(now: Date, timeZone: string) {
    const leadFilter = this.scopes.filterFor(PERMISSIONS.LEAD_READ, {
      userColumn: 'assignedUserId',
      teamColumn: 'teamId',
      branchColumn: 'branchId',
    });
    const taskFilter = this.scopes.filterFor(PERMISSIONS.TASK_READ, {
      userColumn: 'assignedUserId',
      teamColumn: 'teamId',
      branchColumn: 'branchId',
    });
    const open = { deletedAt: null, convertedAt: null, lostAt: null };
    const unassigned = applyScopeFilter({ ...open, assignedUserId: null }, leadFilter);
    const uncontacted = applyScopeFilter({ ...open, firstContactedAt: null }, leadFilter);
    const silent = applyScopeFilter({ ...open, nextActionTaskId: null }, leadFilter);
    const tasks = applyScopeFilter({ deletedAt: null }, taskFilter);

    const [unassignedCount, uncontactedCount, silentCount, overdue, dueToday] = await Promise.all([
      unassigned === null ? 0 : this.db.client.lead.count({ where: unassigned }),
      uncontacted === null ? 0 : this.db.client.lead.count({ where: uncontacted }),
      silent === null ? 0 : this.db.client.lead.count({ where: silent }),
      tasks === null
        ? 0
        : this.db.client.task.count({
            where: { ...tasks, ...taskBucketWhere('overdue', now, timeZone) },
          }),
      tasks === null
        ? 0
        : this.db.client.task.count({
            where: { ...tasks, ...taskBucketWhere('due_today', now, timeZone) },
          }),
    ]);

    return {
      unassigned: unassignedCount,
      awaitingFirstContact: uncontactedCount,
      noNextAction: silentCount,
      overdue,
      dueToday,
    };
  }

  // ── The promises, across everybody in scope ───────────────────────────────

  private async promiseTotals(now: Date, from: Date, userIds: readonly string[]) {
    if (!this.has(PERMISSIONS.SLA_READ)) return null;
    const filter = this.scopes.filterFor(PERMISSIONS.SLA_READ, {
      userColumn: 'assignedUserId',
      teamColumn: 'teamId',
      branchColumn: 'branchId',
    });
    const where = applyScopeFilter({}, filter);
    if (where === null) return null;

    const settled = { ...where, state: 'satisfied' as const, satisfiedAt: { gte: from } };
    const [breached, atRisk, met, late] = await Promise.all([
      this.db.client.slaClock.count({
        where: { ...where, OR: [{ state: 'breached' }, { state: 'running', dueAt: { lte: now } }] },
      }),
      this.db.client.slaClock.count({
        where: { ...where, state: 'running', warnAt: { lte: now }, dueAt: { gt: now } },
      }),
      this.db.client.slaClock.count({ where: settled }),
      this.db.client.slaClock.count({
        // A field reference, as on the board: "late" is a comparison between two columns of the
        // same row, and a stored `met_on_time` would be a second thing to disagree with them.
        where: { ...settled, satisfiedAt: { gt: this.db.client.slaClock.fields.dueAt } },
      }),
    ]);

    return {
      breached,
      atRisk,
      met,
      answeredLate: late,
      onTimeRate: onTimeRate(met, late),
      /**
       * **Over the same people the table below is**, not over the workspace.
       *
       * The first version passed no user filter here while every count beside it was data-scoped,
       * so a branch manager read their branch's counts next to the whole workspace's median — a
       * number on a filtered screen that was not filtered, which is the exact failure this
       * codebase keeps paying for one layer at a time. Found by measuring on the 100 k fixture and
       * noticing the headline median disagreeing with every row under it.
       *
       * A clock with no assignee is therefore outside this number, which is right: a promise
       * nobody was given has nobody whose response time it measures. The unassigned backlog is its
       * own number at the top of the screen.
       */
      medianResponseMinutes: await this.medianResponseMinutes(from, userIds),
    };
  }

  /**
   * The median minutes from a promise starting to its being answered.
   *
   * **A median, not a mean**, and that is the whole reason this one number is raw SQL: one lead
   * answered three days late drags a mean across a team of ten into uselessness, while the median
   * still says "half our replies are inside eleven minutes". Prisma has no percentile aggregate, so
   * `percentile_cont` it is — with `organization_id` passed explicitly, because raw SQL does not go
   * through the tenant-scoping extension and this is exactly the shape rule 1 is about.
   */
  private async medianResponseMinutes(
    from: Date,
    userIds: readonly string[],
  ): Promise<number | null> {
    if (userIds.length === 0) return null;
    const organizationId = tenantContext.organizationId('oversight.median');
    const rows = await this.db.client.$queryRaw<{ median: number | null }[]>`
      SELECT percentile_cont(0.5) WITHIN GROUP (
               ORDER BY EXTRACT(EPOCH FROM (satisfied_at - started_at)) / 60
             ) AS median
      FROM sla_clocks
      WHERE organization_id = ${organizationId}::uuid
        AND state = 'satisfied'
        AND satisfied_at >= ${from}
        AND assigned_user_id = ANY(${[...userIds]}::uuid[])
    `;
    const median = rows[0]?.median;
    return median === null || median === undefined ? null : Math.round(Number(median));
  }

  // ── Per person ────────────────────────────────────────────────────────────

  /**
   * The people this caller may see, oldest membership first.
   *
   * From the **member list** rather than from the work: a person nobody has given anything to has
   * no tasks, no leads and no clocks, and would therefore be invisible on exactly the screen whose
   * job is to notice that.
   */
  private async peopleInScope() {
    const filter = this.scopes.filterFor(PERMISSIONS.REPORT_READ, {
      userColumn: 'userId',
      branchColumn: 'defaultBranchId',
    });
    const where = applyScopeFilter({ deletedAt: null, status: 'active' as const }, filter);
    if (where === null) return [];

    const memberships = await this.db.client.membership.findMany({
      where,
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: OVERSIGHT_PEOPLE_LIMIT,
      select: { userId: true },
    });
    if (memberships.length === 0) return [];

    const users = await withPlatformScope('oversight: load identities', async () =>
      this.db.client.user.findMany({
        where: { id: { in: memberships.map((row) => row.userId) } },
        select: { id: true, name: true, email: true },
      }),
    );
    const byId = new Map(users.map((user) => [user.id, user]));
    return memberships
      .map((row) => byId.get(row.userId))
      .filter((user): user is { id: string; name: string; email: string } => user !== undefined);
  }

  private async perPerson(
    people: readonly { id: string; name: string; email: string }[],
    now: Date,
    from: Date,
    timeZone: string,
  ): Promise<PersonRow[]> {
    if (people.length === 0) return [];
    const ids = people.map((person) => person.id);

    const taskFilter = this.scopes.filterFor(PERMISSIONS.TASK_READ, {
      userColumn: 'assignedUserId',
      teamColumn: 'teamId',
      branchColumn: 'branchId',
    });
    const leadFilter = this.has(PERMISSIONS.LEAD_READ)
      ? this.scopes.filterFor(PERMISSIONS.LEAD_READ, {
          userColumn: 'assignedUserId',
          teamColumn: 'teamId',
          branchColumn: 'branchId',
        })
      : null;
    const slaFilter = this.has(PERMISSIONS.SLA_READ)
      ? this.scopes.filterFor(PERMISSIONS.SLA_READ, {
          userColumn: 'assignedUserId',
          teamColumn: 'teamId',
          branchColumn: 'branchId',
        })
      : null;

    const mine = { assignedUserId: { in: ids } };
    const tasksWhere = applyScopeFilter({ deletedAt: null, ...mine }, taskFilter);
    const leadsWhere =
      leadFilter === null ? null : applyScopeFilter({ deletedAt: null, ...mine }, leadFilter);
    const clocksWhere = slaFilter === null ? null : applyScopeFilter({ ...mine }, slaFilter);

    /**
     * One `groupBy` per question rather than one query per person.
     *
     * Ten people and seven questions is seventy round trips the naive way, on a screen somebody
     * refreshes. Grouped, it is seven — and the shape does not change when the team doubles.
     */
    const [
      openTasks,
      overdueTasks,
      rescheduled,
      uncontacted,
      silent,
      leadsAssigned,
      converted,
      breached,
      atRisk,
      met,
      late,
    ] = await Promise.all([
      this.groupTasks(tasksWhere, { status: { in: [...OPEN_TASK_STATUSES] } }),
      this.groupTasks(tasksWhere, taskBucketWhere('overdue', now, timeZone)),
      // Moved at least once, and touched in the period: `reschedule_count` is cumulative, so
      // without the window this column would never improve for anybody.
      this.groupTasks(tasksWhere, { rescheduleCount: { gt: 0 }, updatedAt: { gte: from } }),
      this.groupLeads(leadsWhere, { firstContactedAt: null, convertedAt: null, lostAt: null }),
      this.groupLeads(leadsWhere, { nextActionTaskId: null, convertedAt: null, lostAt: null }),
      this.groupLeads(leadsWhere, { createdAt: { gte: from } }),
      this.groupLeads(leadsWhere, { convertedAt: { gte: from } }),
      this.groupClocks(clocksWhere, {
        OR: [{ state: 'breached' }, { state: 'running', dueAt: { lte: now } }],
      }),
      this.groupClocks(clocksWhere, { state: 'running', warnAt: { lte: now }, dueAt: { gt: now } }),
      this.groupClocks(clocksWhere, { state: 'satisfied', satisfiedAt: { gte: from } }),
      this.groupClocks(clocksWhere, {
        state: 'satisfied',
        satisfiedAt: { gte: from, gt: this.db.client.slaClock.fields.dueAt },
      }),
    ]);

    /**
     * The median is per person and therefore one query each — the one place this file pays for a
     * loop. Capped by `OVERSIGHT_PEOPLE_LIMIT`, and only for people who answered something, so a
     * workspace of fifty with ten active people runs ten.
     */
    const medians = new Map<string, number | null>();
    for (const person of people) {
      medians.set(
        person.id,
        (met.get(person.id) ?? 0) === 0
          ? null
          : await this.medianResponseMinutes(from, [person.id]),
      );
    }

    return people.map((person) => {
      const metCount = met.get(person.id) ?? 0;
      const lateCount = late.get(person.id) ?? 0;
      return {
        userId: person.id,
        name: person.name,
        email: person.email,
        openFollowUps: openTasks.get(person.id) ?? 0,
        overdue: overdueTasks.get(person.id) ?? 0,
        rescheduled: rescheduled.get(person.id) ?? 0,
        awaitingFirstContact: uncontacted.get(person.id) ?? 0,
        noNextAction: silent.get(person.id) ?? 0,
        promisesBreached: breached.get(person.id) ?? 0,
        promisesAtRisk: atRisk.get(person.id) ?? 0,
        promisesMet: metCount,
        promisesAnsweredLate: lateCount,
        onTimeRate: onTimeRate(metCount, lateCount),
        medianResponseMinutes: medians.get(person.id) ?? null,
        leadsAssigned: leadsAssigned.get(person.id) ?? 0,
        converted: converted.get(person.id) ?? 0,
      };
    });
  }

  private async groupTasks(
    base: Record<string, unknown> | null,
    extra: Record<string, unknown>,
  ): Promise<Map<string, number>> {
    if (base === null) return new Map();
    const rows = await this.db.client.task.groupBy({
      by: ['assignedUserId'],
      where: { ...base, ...extra },
      _count: { _all: true },
    });
    return countsByUser(rows);
  }

  private async groupLeads(
    base: Record<string, unknown> | null,
    extra: Record<string, unknown>,
  ): Promise<Map<string, number>> {
    if (base === null) return new Map();
    const rows = await this.db.client.lead.groupBy({
      by: ['assignedUserId'],
      where: { ...base, deletedAt: null, ...extra },
      _count: { _all: true },
    });
    return countsByUser(rows);
  }

  private async groupClocks(
    base: Record<string, unknown> | null,
    extra: Record<string, unknown>,
  ): Promise<Map<string, number>> {
    if (base === null) return new Map();
    const rows = await this.db.client.slaClock.groupBy({
      by: ['assignedUserId'],
      where: { ...base, ...extra },
      _count: { _all: true },
    });
    return countsByUser(rows);
  }

  // ── Plumbing ──────────────────────────────────────────────────────────────

  private has(permission: string): boolean {
    const principal = tenantContext.require('oversight.permissions');
    return principal.permissions.has(permission);
  }

  /** The breadth of the caller's own `report:read` grant, for the screen to state. */
  private scopeKind(): string {
    const principal = tenantContext.require('oversight.scope');
    return principal.scopes.get(PERMISSIONS.REPORT_READ) ?? 'own';
  }

  private async timeZone(): Promise<string> {
    const organizationId = tenantContext.organizationId('oversight.timeZone');
    const organization = await this.db.client.organization.findUniqueOrThrow({
      where: { id: organizationId },
      select: { timezone: true },
    });
    return organization.timezone;
  }
}

function countsByUser(
  rows: readonly { assignedUserId: string | null; _count: { _all: number } }[],
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    if (row.assignedUserId === null) continue;
    counts.set(row.assignedUserId, row._count._all);
  }
  return counts;
}

/**
 * The share of answered promises that were answered **on time**.
 *
 * `null` rather than `0` or `100` when nobody answered anything: a new joiner with no promises yet
 * is not at 0 % and is not at 100 %, and a screen that picks either is a screen that ranks them
 * against people who have done a month's work. The UI shows "—".
 */
function onTimeRate(met: number, late: number): number | null {
  if (met === 0) return null;
  return Math.round(((met - late) / met) * 100);
}
