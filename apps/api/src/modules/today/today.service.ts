import { Injectable } from '@nestjs/common';
import {
  PERMISSIONS,
  slaHealth,
  taskBucket,
  taskBucketWhere,
  tenantContext,
  type SlaHealth,
  type TaskBucket,
} from '@leados/shared';
import { DbService } from '../../infra/db/db.service.js';
import { DataScopeService, applyScopeFilter } from '../../infra/authz/data-scope.service.js';
import { TODAY_SECTION_LIMITS } from './today.dto.js';

/** A section of the screen: the whole set's size, and the rows that fit. */
interface Section<T> {
  /** An aggregate over the whole set — never `items.length`. */
  readonly count: number;
  readonly items: readonly T[];
  /** `true` when the set is larger than the rows returned, so the screen can offer "see all". */
  readonly truncated: boolean;
  /**
   * `false` when the caller does not hold the permission this section reads.
   *
   * An empty section and a forbidden one look identical on a screen, and must not: somebody whose
   * role withholds `lead:read` should be told the list is not theirs to see, not shown "nothing to
   * do" and left to believe it.
   */
  readonly available: boolean;
}

function forbidden<T>(): Section<T> {
  return { count: 0, items: [], truncated: false, available: false };
}

function section<T>(count: number, items: readonly T[], limit: number): Section<T> {
  return {
    count,
    items,
    truncated: count > items.length || items.length >= limit,
    available: true,
  };
}

/**
 * Whose work this is: mine, plus anything nobody has claimed that I am allowed to see.
 *
 * The first version of this screen was strictly "mine", and a browser check found what that
 * costs: a workspace with no assignment rule leaves every captured lead unassigned, so the new
 * leads and the promises running out on them appeared on **nobody's** Today — the leads most at
 * risk of never being called were the ones the screen hid.
 *
 * The data scope then does the rest, and does it correctly without a second rule: somebody scoped
 * to their own rows has `assigned_user_id = me` added on top of this by `applyScopeFilter`, so the
 * `IS NULL` branch cannot widen what they see (they cannot read an unclaimed row at all). Somebody
 * scoped to a team, a branch or the workspace can read it, and for them it is exactly the thing
 * worth surfacing.
 *
 * Expressed under `AND` rather than as a bare `OR` so it composes with the `OR`s the SLA
 * predicates need: two `OR` keys at one level would silently replace each other.
 */
function mineOrUnclaimed(mine: string): Record<string, unknown> {
  return { AND: [{ OR: [{ assignedUserId: mine }, { assignedUserId: null }] }] };
}

/**
 * The executive workspace (`FR-TSK-7`) — the whole screen in one request.
 *
 * **One request, because the screen is read on a phone on the way to a meeting.** Five sections
 * fetched separately are five chances for a 4G connection to stall, and a Today screen that is
 * three-fifths rendered is worse than one that is late: somebody reads "no overdue follow-ups" off
 * a section that simply has not arrived. So this composes every count and every page here, in
 * parallel, and answers once.
 *
 * Four decisions shape the file:
 *
 *  * **It is "mine", with no parameters at all** (see `today.dto.ts`). The caller's own queue, and
 *    the data scope on top of that, so a widened scope cannot widen *this* screen.
 *  * **Every count is an aggregate over the whole set, never the length of the page.** A board that
 *    totals the twenty rows it loaded tells somebody they owe twenty calls when they owe ninety —
 *    the mistake the pipeline board and the SLA board each paid for once.
 *  * **The buckets come from `taskBucketWhere`**, the same definition `/tasks` counts with and the
 *    same one `taskBucket` derives each card's own label from. Three sections of one screen
 *    disagreeing about what "overdue" means is the whole reason that function moved into
 *    `@leados/shared`.
 *  * **A section the caller may not read is marked, not silently empty.** See `Section.available`.
 */
@Injectable()
export class TodayService {
  constructor(
    private readonly db: DbService,
    private readonly scopes: DataScopeService,
  ) {}

  async today() {
    const principal = tenantContext.require('today');
    const now = new Date();
    const timeZone = await this.timeZone();
    const mine = principal.actorId ?? '';

    const [queue, firstContact, promises] = await Promise.all([
      this.taskQueue(now, timeZone, mine),
      this.awaitingFirstContact(mine),
      this.promisesRunningOut(now, mine),
    ]);

    return {
      generatedAt: now,
      timeZone,
      /** Whose day this is. The screen greets by the session's own name; this is for the log. */
      for: { userId: principal.actorId },
      /**
       * The numbers above the sections, so the screen's head can be read without scrolling it.
       *
       * `upcoming` has a count and no list on purpose: tomorrow's work is context, not today's
       * queue, and a section for it would make the screen longer at the cost of the only thing it
       * is for.
       */
      counts: {
        overdue: queue.overdue.count,
        dueNow: queue.dueNow.count,
        laterToday: queue.laterToday.count,
        upcoming: queue.upcoming,
        awaitingFirstContact: firstContact.leads.count,
        noNextAction: firstContact.noNextAction,
        promisesBreached: promises.breached,
        promisesAtRisk: promises.atRisk,
        unacknowledgedEscalations: promises.unacknowledged,
      },
      sections: {
        overdue: queue.overdue,
        dueNow: queue.dueNow,
        laterToday: queue.laterToday,
        awaitingFirstContact: firstContact.leads,
        promisesRunningOut: promises.clocks,
      },
    };
  }

  // ── The follow-up queue ───────────────────────────────────────────────────

  /**
   * The three sections of today's work, plus tomorrow's count.
   *
   * One query per section rather than one query grouped afterwards: a single list ordered by due
   * time would spend its whole page on the overdue section whenever somebody is behind, and the two
   * sections underneath would read as empty while their own counts said otherwise. Six cheap
   * indexed queries in parallel are the price of three sections that are each actually populated.
   */
  private async taskQueue(now: Date, timeZone: string, mine: string) {
    const principal = tenantContext.require('today.tasks');
    if (!principal.permissions.has(PERMISSIONS.TASK_READ)) {
      return {
        overdue: forbidden<TaskCard>(),
        dueNow: forbidden<TaskCard>(),
        laterToday: forbidden<TaskCard>(),
        upcoming: 0,
      };
    }

    const filter = this.scopes.filterFor(PERMISSIONS.TASK_READ, {
      userColumn: 'assignedUserId',
      teamColumn: 'teamId',
      branchColumn: 'branchId',
    });
    const where = applyScopeFilter({ deletedAt: null, ...mineOrUnclaimed(mine) }, filter);
    if (where === null) {
      return {
        overdue: forbidden<TaskCard>(),
        dueNow: forbidden<TaskCard>(),
        laterToday: forbidden<TaskCard>(),
        upcoming: 0,
      };
    }

    const bucket = (name: TaskBucket) => ({ ...where, ...taskBucketWhere(name, now, timeZone) });

    /**
     * Overdue reads oldest-first and the rest priority-first.
     *
     * Not an inconsistency. The overdue section answers "who has been waiting longest", which is
     * the thing somebody apologises for; the two sections under it are the next few hours of work,
     * where an urgent call due at 16:00 belongs above a routine one due at 10:00
     * (`compareTasksForQueue` in `@leados/shared` says the same thing for the client).
     */
    const oldestFirst = [{ dueAt: 'asc' as const }, { id: 'asc' as const }];
    // Postgres orders an enum by its declaration order, which is low → urgent here, so "most
    // urgent first" is a *descending* sort on the column.
    const urgentFirst = [{ priority: 'desc' as const }, { dueAt: 'asc' as const }];

    const [overdueCount, overdueRows, dueNowCount, dueNowRows, laterCount, laterRows, upcoming] =
      await Promise.all([
        this.db.client.task.count({ where: bucket('overdue') }),
        this.db.client.task.findMany({
          where: bucket('overdue'),
          orderBy: oldestFirst,
          take: TODAY_SECTION_LIMITS.overdue,
          include: this.taskInclude(),
        }),
        this.db.client.task.count({ where: bucket('due_now') }),
        this.db.client.task.findMany({
          where: bucket('due_now'),
          orderBy: urgentFirst,
          take: TODAY_SECTION_LIMITS.dueNow,
          include: this.taskInclude(),
        }),
        this.db.client.task.count({ where: bucket('due_today') }),
        this.db.client.task.findMany({
          where: bucket('due_today'),
          orderBy: urgentFirst,
          take: TODAY_SECTION_LIMITS.laterToday,
          include: this.taskInclude(),
        }),
        this.db.client.task.count({ where: bucket('upcoming') }),
      ]);

    const card = (row: TaskRow) => this.taskCard(row, now, timeZone);
    return {
      overdue: section(overdueCount, overdueRows.map(card), TODAY_SECTION_LIMITS.overdue),
      dueNow: section(dueNowCount, dueNowRows.map(card), TODAY_SECTION_LIMITS.dueNow),
      laterToday: section(laterCount, laterRows.map(card), TODAY_SECTION_LIMITS.laterToday),
      upcoming,
    };
  }

  // ── The leads nobody has called ───────────────────────────────────────────

  /**
   * New leads owed a first contact, and the count of open leads with nothing planned at all.
   *
   * Two different failures, deliberately side by side. A lead nobody has spoken to yet is today's
   * work; a lead with no next action is work that has *stopped* — `FR-TSK-4`'s silent leads — and an
   * empty Today screen means nothing while forty of those exist.
   *
   * `first_contacted_at IS NULL` is the question, and it is served by the
   * `leads_awaiting_first_contact` partial index — keyed on `(organization_id, created_at)` and
   * deliberately not on the assignee, because `mineOrUnclaimed` is an `OR` and an `OR` cannot be a
   * range scan. See the migration; the first version of that index was keyed the obvious way and
   * the planner ignored it.
   */
  private async awaitingFirstContact(mine: string) {
    const principal = tenantContext.require('today.leads');
    if (!principal.permissions.has(PERMISSIONS.LEAD_READ)) {
      return { leads: forbidden<LeadCard>(), noNextAction: 0 };
    }

    const filter = this.scopes.filterFor(PERMISSIONS.LEAD_READ, {
      userColumn: 'assignedUserId',
      teamColumn: 'teamId',
      branchColumn: 'branchId',
    });
    const open = { deletedAt: null, convertedAt: null, lostAt: null, ...mineOrUnclaimed(mine) };
    const uncontacted = applyScopeFilter({ ...open, firstContactedAt: null }, filter);
    const silent = applyScopeFilter({ ...open, nextActionTaskId: null }, filter);
    if (uncontacted === null || silent === null) {
      return { leads: forbidden<LeadCard>(), noNextAction: 0 };
    }

    const [count, rows, noNextAction] = await Promise.all([
      this.db.client.lead.count({ where: uncontacted }),
      this.db.client.lead.findMany({
        where: uncontacted,
        // Oldest first: the lead captured two hours ago is the one whose promise runs out next,
        // and "new leads" sorted newest-first buries exactly the row that needs the call.
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: TODAY_SECTION_LIMITS.awaitingFirstContact,
        select: {
          id: true,
          fullName: true,
          phoneE164: true,
          city: true,
          score: true,
          scoreBand: true,
          valueMinor: true,
          currency: true,
          createdAt: true,
          source: { select: { id: true, name: true } },
          status: { select: { id: true, name: true } },
          /**
           * The promise on this lead, so the card can say "43 minutes left" (`FR-TSK-8`).
           *
           * The first-response clock only — a resolution clock on the same lead is a different
           * promise with a different deadline, and showing the nearer of two unrelated numbers
           * under one label is how a screen becomes untrustworthy.
           */
          slaClocks: {
            where: { target: 'first_response', state: 'running' },
            select: { id: true, state: true, dueAt: true, warnAt: true, satisfiedAt: true },
            take: 1,
          },
        },
      }),
      this.db.client.lead.count({ where: silent }),
    ]);

    const now = new Date();
    const items: LeadCard[] = rows.map((row) => {
      const clock = row.slaClocks[0] ?? null;
      return {
        id: row.id,
        fullName: row.fullName,
        phoneE164: row.phoneE164,
        city: row.city,
        score: row.score,
        scoreBand: row.scoreBand,
        valueMinor: row.valueMinor === null ? null : Number(row.valueMinor),
        currency: row.currency,
        createdAt: row.createdAt,
        source: row.source,
        status: row.status,
        promise:
          clock === null
            ? null
            : {
                id: clock.id,
                dueAt: clock.dueAt,
                health: slaHealth(clock, now),
                minutesLeft: minutesBetween(now, clock.dueAt),
              },
      };
    });

    return {
      leads: section(count, items, TODAY_SECTION_LIMITS.awaitingFirstContact),
      noNextAction,
    };
  }

  // ── The promises running out ──────────────────────────────────────────────

  /**
   * The clocks that need somebody now: breached first, then the ones about to be.
   *
   * **Read from the clock, not from the stored state.** The sweep runs every five minutes, so a
   * promise that came due forty seconds ago still says `running` in the database — and a screen
   * that believed the column would tell somebody at 10:01 that their 10:00 promise is fine. The
   * same predicate the SLA board uses, for the same reason.
   */
  private async promisesRunningOut(now: Date, mine: string) {
    const principal = tenantContext.require('today.sla');
    if (!principal.permissions.has(PERMISSIONS.SLA_READ)) {
      return { clocks: forbidden<ClockCard>(), breached: 0, atRisk: 0, unacknowledged: 0 };
    }

    const filter = this.scopes.filterFor(PERMISSIONS.SLA_READ, {
      userColumn: 'assignedUserId',
      teamColumn: 'teamId',
      branchColumn: 'branchId',
    });
    const where = applyScopeFilter(mineOrUnclaimed(mine), filter);
    if (where === null) {
      return { clocks: forbidden<ClockCard>(), breached: 0, atRisk: 0, unacknowledged: 0 };
    }

    const breachedWhere = {
      ...where,
      OR: [{ state: 'breached' as const }, { state: 'running' as const, dueAt: { lte: now } }],
    };
    const atRiskWhere = {
      ...where,
      state: 'running' as const,
      warnAt: { lte: now },
      dueAt: { gt: now },
    };

    const [breached, atRisk, unacknowledged, rows] = await Promise.all([
      this.db.client.slaClock.count({ where: breachedWhere }),
      this.db.client.slaClock.count({ where: atRiskWhere }),
      /**
       * Unacknowledged escalations **about my own clocks**, not the workspace's.
       *
       * The manager's board counts them workspace-wide, which is right there and wrong here: a
       * number on somebody's own screen that counts other people's reprimands is noise they
       * cannot act on.
       */
      this.db.client.escalation.count({ where: { acknowledgedAt: null, clock: where } }),
      this.db.client.slaClock.findMany({
        where: {
          ...where,
          // Breached and at-risk in one page, soonest deadline first — which puts the breaches at
          // the top by arithmetic rather than by a second query and a concatenation.
          state: { in: ['running', 'breached'] },
          warnAt: { lte: now },
        },
        orderBy: [{ dueAt: 'asc' }, { id: 'asc' }],
        take: TODAY_SECTION_LIMITS.promisesRunningOut,
        select: {
          id: true,
          target: true,
          state: true,
          dueAt: true,
          warnAt: true,
          satisfiedAt: true,
          targetMinutes: true,
          lead: { select: { id: true, fullName: true, phoneE164: true } },
        },
      }),
    ]);

    const items: ClockCard[] = rows.map((row) => ({
      id: row.id,
      target: row.target,
      health: slaHealth(row, now),
      dueAt: row.dueAt,
      targetMinutes: row.targetMinutes,
      minutesLeft: minutesBetween(now, row.dueAt),
      lead: row.lead,
    }));

    return {
      clocks: section(breached + atRisk, items, TODAY_SECTION_LIMITS.promisesRunningOut),
      breached,
      atRisk,
      unacknowledged,
    };
  }

  // ── Plumbing ──────────────────────────────────────────────────────────────

  private taskInclude() {
    return {
      taskType: { select: { id: true, name: true, icon: true } },
      /**
       * More of the lead than the `/tasks` row carries, because the card is what somebody decides
       * from: a call is made differently to a ₹50 lakh enquiry scored 82 than to a cold one, and
       * making that decision cost a tap to the lead screen is what makes a queue feel like a form.
       */
      lead: {
        select: {
          id: true,
          fullName: true,
          phoneE164: true,
          whatsappE164: true,
          city: true,
          score: true,
          scoreBand: true,
          valueMinor: true,
          currency: true,
          consentWhatsapp: true,
          consentCalls: true,
          source: { select: { id: true, name: true } },
        },
      },
      customer: { select: { id: true, fullName: true } },
      deal: { select: { id: true, name: true } },
    };
  }

  private taskCard(row: TaskRow, now: Date, timeZone: string): TaskCard {
    const lead = row.lead;
    return {
      id: row.id,
      title: row.title,
      status: row.status,
      /** Derived from the clock, like everywhere else, so the card and the counter agree. */
      bucket: taskBucket({ status: row.status, dueAt: row.dueAt }, now, timeZone),
      priority: row.priority,
      dueAt: row.dueAt,
      /** Negative when it has passed, which is what "2 days late" is rendered from. */
      minutesUntilDue: minutesBetween(now, row.dueAt),
      rescheduleCount: row.rescheduleCount,
      taskType: row.taskType ?? null,
      leadId: row.leadId,
      lead:
        lead === null || lead === undefined
          ? null
          : {
              id: lead.id,
              fullName: lead.fullName,
              phoneE164: lead.phoneE164,
              whatsappE164: lead.whatsappE164,
              city: lead.city,
              score: lead.score,
              scoreBand: lead.scoreBand,
              valueMinor: lead.valueMinor === null ? null : Number(lead.valueMinor),
              currency: lead.currency,
              consentWhatsapp: lead.consentWhatsapp,
              consentCalls: lead.consentCalls,
              source: lead.source,
            },
      customerId: row.customerId,
      customer: row.customer ?? null,
      dealId: row.dealId,
      deal: row.deal ?? null,
    };
  }

  private async timeZone(): Promise<string> {
    const organizationId = tenantContext.organizationId('today.timeZone');
    const organization = await this.db.client.organization.findUniqueOrThrow({
      where: { id: organizationId },
      select: { timezone: true },
    });
    return organization.timezone;
  }
}

/** Whole minutes from `now` to `when`; negative once it has passed. */
function minutesBetween(now: Date, when: Date): number {
  return Math.round((when.getTime() - now.getTime()) / 60_000);
}

interface LeadFacts {
  id: string;
  fullName: string;
  phoneE164: string | null;
  whatsappE164: string | null;
  city: string | null;
  score: number;
  scoreBand: string | null;
  valueMinor: bigint | null;
  currency: string | null;
  consentWhatsapp: boolean;
  consentCalls: boolean;
  source: { id: string; name: string } | null;
}

interface TaskRow {
  id: string;
  title: string;
  status: string;
  priority: string;
  dueAt: Date;
  rescheduleCount: number;
  leadId: string | null;
  customerId: string | null;
  dealId: string | null;
  taskType?: { id: string; name: string; icon: string | null } | null;
  lead?: LeadFacts | null;
  customer?: { id: string; fullName: string } | null;
  deal?: { id: string; name: string } | null;
}

interface TaskCard {
  id: string;
  title: string;
  status: string;
  bucket: TaskBucket;
  priority: string;
  dueAt: Date;
  minutesUntilDue: number;
  rescheduleCount: number;
  taskType: { id: string; name: string; icon: string | null } | null;
  leadId: string | null;
  lead: (Omit<LeadFacts, 'valueMinor'> & { valueMinor: number | null }) | null;
  customerId: string | null;
  customer: { id: string; fullName: string } | null;
  dealId: string | null;
  deal: { id: string; name: string } | null;
}

interface LeadCard {
  id: string;
  fullName: string;
  phoneE164: string | null;
  city: string | null;
  score: number;
  scoreBand: string | null;
  valueMinor: number | null;
  currency: string | null;
  createdAt: Date;
  source: { id: string; name: string } | null;
  status: { id: string; name: string } | null;
  promise: { id: string; dueAt: Date; health: SlaHealth; minutesLeft: number } | null;
}

interface ClockCard {
  id: string;
  target: string;
  health: SlaHealth;
  dueAt: Date;
  targetMinutes: number;
  minutesLeft: number;
  lead: { id: string; fullName: string; phoneE164: string | null } | null;
}

/** Unused outside the file, but exported so a consumer that wants the shape reads one definition. */
export type { ClockCard, LeadCard, Section, TaskCard };
