import { Inject, Injectable } from '@nestjs/common';
import {
  ACTIVITY_TYPES,
  AppError,
  CALL_OUTCOME_GRACE_MINUTES,
  CALL_OUTCOME_NUDGE_WINDOW_HOURS,
  PERMISSIONS,
  describeCallDuration,
  isContact,
  newId,
  systemPrincipal,
  tenantContext,
  withPlatformScope,
  type CallOutcomeCategory,
} from '@leados/shared';
import { DbService } from '../../infra/db/db.service.js';
import { AuditService } from '../../infra/audit/audit.service.js';
import { OutboxService, type TransactionClient } from '../../infra/outbox/outbox.service.js';
import { TimelineService } from '../../infra/timeline/timeline.service.js';
import { DataScopeService, applyScopeFilter } from '../../infra/authz/data-scope.service.js';
import { TELEPHONY, type TelephonyPort } from '../../infra/telephony/telephony.port.js';
import { LeadContactService } from '../lead-contact/lead-contact.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { TasksService } from '../tasks/tasks.service.js';
import { CallOutcomesService } from './call-outcomes.service.js';
import type { CompleteTaskInput } from '../tasks/tasks.dto.js';
import type {
  DialCallInput,
  ListCallsQuery,
  LogCallInput,
  SettleCallInput,
  UpdateCallInput,
} from './calls.dto.js';

/** What a call was with, and the ownership it inherits from it. */
interface CallSubject {
  readonly leadId: string | null;
  readonly branchId: string | null;
  readonly teamId: string | null;
  readonly phoneE164: string | null;
}

/**
 * Calls — logging them, and dialling from the product (`FR-CALL-1..3`).
 *
 * **The call log is the only record a business has of the work that is actually done on a lead.**
 * Everything else in the CRM is a consequence of a conversation somebody had, so a call that is not
 * logged is a day's work that did not happen as far as every report is concerned.
 *
 * Five decisions shape this file:
 *
 *  * **A status and an outcome are different facts, and both are recorded.** The status is what the
 *    telephony saw — it rang, the line was busy, we spoke for four minutes. The outcome is what the
 *    conversation meant, and it is the tenant's own list (rule 4). Collapsing them would lose one or
 *    the other: a connected call with no useful outcome and a no-answer with "asked to call back"
 *    are both ordinary, and one enum cannot say either.
 *  * **An attempt and a result are two timeline entries.** With the manual driver the product hands
 *    a number to a phone and never learns what happened, so `call.attempted` says somebody tried and
 *    `call.logged` says what came of it. A lead showing three attempts and no outcomes is telling a
 *    manager something true, which is why a dialled call is left `dialing` rather than swept into a
 *    guess.
 *  * **The row is written before the provider is asked.** A telephony failure then leaves a logged
 *    attempt rather than nothing, and the product works identically before any provider is connected
 *    — which is the point of the port (`FR-CALL-2`).
 *  * **A call that reached somebody is a contact.** `LeadContactService` writes
 *    `first_contacted_at`/`last_contacted_at` and satisfies the first-response promise, in the call's
 *    own transaction and through the same service a completed follow-up uses. Which categories count
 *    is `isContact` in `@leados/shared`, not a condition written out here.
 *  * **Finishing the follow-up is not in the call's transaction.** `finishFollowUp` completes the
 *    task *after* the call commits: the call row is the thing that must not be lost, a task left open
 *    is visible on every queue screen and recoverable in one click, and making them atomic would mean
 *    reimplementing task completion — the outcome vocabulary, the next follow-up, the reminders —
 *    inside this module.
 */
@Injectable()
export class CallsService {
  constructor(
    private readonly db: DbService,
    private readonly scopes: DataScopeService,
    private readonly outcomes: CallOutcomesService,
    private readonly contact: LeadContactService,
    private readonly notifications: NotificationsService,
    private readonly tasks: TasksService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly timeline: TimelineService,
    @Inject(TELEPHONY) private readonly telephony: TelephonyPort,
  ) {}

  // ── Reading ───────────────────────────────────────────────────────────────

  /**
   * Everything the call panel needs in one request: the outcome list, and what the dial button
   * will actually do.
   *
   * `placesCalls` is why this endpoint exists rather than the screen hard-coding "this opens your
   * phone": the sentence under the button has to change the day a provider is connected, and a
   * screen that guessed would be wrong in one direction or the other for every workspace.
   */
  async config() {
    const outcomes = await this.db.client.callOutcome.findMany({
      where: { deletedAt: null, isActive: true },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    });
    return {
      outcomes: outcomes.map((outcome) => ({
        id: outcome.id,
        name: outcome.name,
        category: outcome.category,
        requiresNote: outcome.requiresNote,
        sortOrder: outcome.sortOrder,
        /** Derived in one place, so no screen has to know which categories mean "reached". */
        isContact: isContact(outcome.category),
      })),
      telephony: { driver: this.telephony.driver, placesCalls: this.telephony.placesCalls },
    };
  }

  async list(query: ListCallsQuery) {
    const principal = tenantContext.require('calls.list');
    const filter = this.scopes.filterFor(PERMISSIONS.CALL_READ, {
      userColumn: 'agentUserId',
      teamColumn: 'teamId',
      branchColumn: 'branchId',
    });

    const baseWhere: Record<string, unknown> = {
      deletedAt: query.deleted ? { not: null } : null,
      ...(query.leadId ? { leadId: query.leadId } : {}),
      ...(query.taskId ? { taskId: query.taskId } : {}),
      ...(query.mine ? { agentUserId: principal.actorId ?? '' } : {}),
      ...(query.agentUserId ? { agentUserId: query.agentUserId } : {}),
      ...(query.outcomeId ? { outcomeId: query.outcomeId } : {}),
      ...(query.direction ? { direction: query.direction } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.category ? { outcome: { category: query.category } } : {}),
      ...(query.linked === true ? { leadId: { not: null } } : {}),
      ...(query.linked === false ? { leadId: null } : {}),
      ...(query.open === true ? { status: 'dialing' } : {}),
      ...(query.open === false ? { status: { not: 'dialing' } } : {}),
      ...(query.from || query.to
        ? {
            startedAt: {
              ...(query.from ? { gte: query.from } : {}),
              ...(query.to ? { lte: query.to } : {}),
            },
          }
        : {}),
    };

    const where = applyScopeFilter(baseWhere, filter);
    if (where === null) {
      return {
        items: [],
        pagination: { limit: query.limit, nextCursor: null, hasMore: false, total: 0 },
        meta: { totalTalkTimeSeconds: 0, connected: 0 },
      };
    }

    const [total, rows, talk, connected] = await Promise.all([
      this.db.client.call.count({ where }),
      this.db.client.call.findMany({
        where,
        orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
        take: query.limit + 1,
        ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
        include: this.listInclude(),
      }),
      // Over the whole filter, never over the page: a panel that summed the twenty rows it loaded
      // would tell a manager their team spent a fifth of the time on the phone that it did.
      this.db.client.call.aggregate({ where, _sum: { durationSeconds: true } }),
      this.db.client.call.count({ where: { ...where, status: 'completed' } }),
    ]);

    const page = rows.slice(0, query.limit);
    const hasMore = rows.length > query.limit;
    return {
      items: page.map((row) => this.present(row)),
      pagination: {
        limit: query.limit,
        nextCursor: hasMore ? (page.at(-1)?.id ?? null) : null,
        hasMore,
        total,
      },
      // The envelope merges `meta`; returning these as siblings of `items` would discard them.
      meta: { totalTalkTimeSeconds: talk._sum.durationSeconds ?? 0, connected },
    };
  }

  async findOne(id: string) {
    const row = await this.db.client.call.findFirst({ where: { id }, include: this.listInclude() });
    if (!row || !this.canRead(row)) throw AppError.notFound('Call');
    return this.present(row);
  }

  // ── Writing ───────────────────────────────────────────────────────────────

  /**
   * Logging a call that has already happened (`FR-CALL-1`).
   *
   * The path that works with no provider, no integration and a mobile phone — which is every
   * workspace on day one, and the reason this is the endpoint the UI is built around rather than a
   * fallback for one.
   */
  async log(input: LogCallInput) {
    const agentUserId = this.agent('calls.log');
    const subject = await this.resolveSubject(input.leadId ?? null);
    const task = input.taskId ? await this.loadTask(input.taskId, subject.leadId) : null;
    const outcome = await this.outcomes.loadForLogging(input.outcomeId);
    this.assertNoteWhenRequired(outcome, input.notes ?? null);
    this.assertStatusMatchesOutcome(input.status, outcome.category);

    const numbers = this.numbersFor(input.direction, input.toE164, input.fromE164, subject);
    const startedAt = input.startedAt ?? new Date();
    const endedAt =
      input.endedAt ?? new Date(startedAt.getTime() + (input.durationSeconds ?? 0) * 1000);
    if (endedAt < startedAt) {
      throw AppError.validation('Some details need correcting', [
        {
          field: 'endedAt',
          code: 'ENDED_BEFORE_STARTED',
          message: 'A call cannot end before it started.',
        },
      ]);
    }
    const id = newId();

    await this.db.client.$transaction(async (tx) => {
      await tx.call.create({
        data: {
          id,
          organizationId: subject.organizationId,
          leadId: subject.leadId,
          taskId: task?.id ?? null,
          direction: input.direction,
          status: input.status,
          ...numbers,
          outcomeId: outcome.id,
          ...(input.durationSeconds !== undefined
            ? { durationSeconds: input.durationSeconds }
            : {}),
          ...(input.notes ? { notes: input.notes } : {}),
          agentUserId,
          startedAt,
          endedAt,
          branchId: subject.branchId,
          teamId: subject.teamId,
        },
      });
      await this.recordLogged(
        tx,
        { id, leadId: subject.leadId, organizationId: subject.organizationId },
        {
          direction: input.direction,
          status: input.status,
          outcome,
          durationSeconds: input.durationSeconds ?? null,
          notes: input.notes ?? null,
          occurredAt: endedAt,
          taskId: task?.id ?? null,
        },
      );
      await this.audit.recordInTransaction(tx, {
        action: 'call.logged',
        resourceType: 'call',
        resourceId: id,
        after: { leadId: subject.leadId, status: input.status, outcome: outcome.name },
      });
    });

    // Outside the transaction, deliberately — see the class comment.
    let followUpCompleted = false;
    if (input.finishFollowUp && task) {
      const finish: CompleteTaskInput = {
        outcomeId: input.finishFollowUp.outcomeId,
        ...(input.finishFollowUp.note ? { note: input.finishFollowUp.note } : {}),
        completedAt: endedAt,
      };
      await this.tasks.complete(task.id, finish);
      followUpCompleted = true;
    }

    return { call: await this.findOne(id), followUpCompleted };
  }

  /**
   * Click-to-call (`FR-CALL-2`, `FR-CALL-3`).
   *
   * Writes the attempt, then asks the port how the call will be placed. With the manual driver the
   * answer is a `tel:` link for the device to open, which is not a degraded mode: it is what makes
   * one-tap calling work before anybody has bought a telephony plan, and the row it leaves behind is
   * what the outcome form on the lead screen then asks about.
   */
  async dial(input: DialCallInput) {
    const agentUserId = this.agent('calls.dial');
    const subject = await this.resolveSubject(input.leadId ?? null);
    const task = input.taskId ? await this.loadTask(input.taskId, subject.leadId) : null;

    const to = input.to ?? subject.phoneE164;
    if (!to) {
      throw AppError.businessRule(
        'This lead has no phone number on record. Add one, or dial a number directly',
      );
    }

    const id = newId();
    const startedAt = new Date();
    await this.db.client.$transaction(async (tx) => {
      await tx.call.create({
        data: {
          id,
          organizationId: subject.organizationId,
          leadId: subject.leadId,
          taskId: task?.id ?? null,
          direction: 'outbound',
          status: 'dialing',
          toE164: to,
          agentUserId,
          startedAt,
          branchId: subject.branchId,
          teamId: subject.teamId,
        },
      });
      if (subject.leadId) {
        await this.timeline.recordInTransaction(tx, {
          type: ACTIVITY_TYPES.CALL_ATTEMPTED,
          leadId: subject.leadId,
          occurredAt: startedAt,
          payload: { callId: id, toE164: to, direction: 'outbound', via: this.telephony.driver },
        });
        await this.outbox.emit(tx, [
          {
            name: 'call.attempted',
            aggregateType: 'lead',
            aggregateId: subject.leadId,
            payload: { callId: id, toE164: to, agentUserId, driver: this.telephony.driver },
          },
        ]);
      }
      await this.audit.recordInTransaction(tx, {
        action: 'call.dialled',
        resourceType: 'call',
        resourceId: id,
        after: { leadId: subject.leadId, toE164: to, driver: this.telephony.driver },
      });
    });

    // The row exists whatever happens next. A provider that refuses leaves an attempt somebody can
    // record the outcome of, rather than a call that is nowhere.
    const dial = await this.telephony.dial({ to, callId: id });
    if (dial.mode === 'provider') {
      await this.db.client.call.update({
        where: { id },
        data: { provider: dial.provider, providerCallId: dial.providerCallId },
      });
    }

    return { call: await this.findOne(id), dial };
  }

  /**
   * What happened on a call the product dialled.
   *
   * Its own endpoint, not a `status` on the PATCH: it is the write that marks the lead contacted,
   * satisfies the first-response promise and emits the event scoring reads.
   */
  async settle(id: string, input: SettleCallInput) {
    const row = await this.loadForWrite(id);
    if (row.status !== 'dialing') {
      throw AppError.businessRule(
        'This call already has an outcome recorded. Log a new call if you rang again',
      );
    }
    const outcome = await this.outcomes.loadForLogging(input.outcomeId);
    this.assertNoteWhenRequired(outcome, input.notes ?? null);
    this.assertStatusMatchesOutcome(input.status, outcome.category);

    const endedAt = input.endedAt ?? new Date();
    if (endedAt < row.startedAt) {
      throw AppError.validation('Some details need correcting', [
        {
          field: 'endedAt',
          code: 'ENDED_BEFORE_STARTED',
          message: 'A call cannot end before it started.',
        },
      ]);
    }

    await this.db.client.$transaction(async (tx) => {
      await tx.call.update({
        where: { id },
        data: {
          status: input.status,
          outcomeId: outcome.id,
          endedAt,
          ...(input.durationSeconds !== undefined
            ? { durationSeconds: input.durationSeconds }
            : {}),
          ...(input.notes ? { notes: input.notes } : {}),
        },
      });
      await this.recordLogged(tx, row, {
        direction: row.direction,
        status: input.status,
        outcome,
        durationSeconds: input.durationSeconds ?? null,
        notes: input.notes ?? null,
        occurredAt: endedAt,
        taskId: row.taskId,
      });
      await this.audit.recordInTransaction(tx, {
        action: 'call.settled',
        resourceType: 'call',
        resourceId: id,
        before: { status: row.status },
        after: { status: input.status, outcome: outcome.name },
      });
    });

    return this.findOne(id);
  }

  /**
   * Corrections, and attributing an unknown number to a lead.
   *
   * Linking is the one that matters: an inbound call from a number nobody recognises is logged
   * against the numbers, and until somebody says who it was the lead's own history does not have it.
   * So the link is the moment `call.logged` becomes true *of a lead* — and that is where the event
   * and the timeline entry are written, not before.
   */
  async update(id: string, input: UpdateCallInput) {
    const row = await this.loadForWrite(id);
    const linking =
      input.leadId !== undefined && input.leadId !== null && input.leadId !== row.leadId;
    const subject = linking ? await this.resolveSubject(input.leadId ?? null) : null;

    await this.db.client.$transaction(async (tx) => {
      await tx.call.update({
        where: { id },
        data: {
          ...(input.leadId !== undefined ? { leadId: input.leadId } : {}),
          ...(subject ? { branchId: subject.branchId, teamId: subject.teamId } : {}),
          ...(input.notes !== undefined ? { notes: input.notes } : {}),
        },
      });
      if (linking && subject?.leadId && row.status !== 'dialing' && row.outcomeId) {
        const outcome = await tx.callOutcome.findFirstOrThrow({ where: { id: row.outcomeId } });
        await this.recordLogged(
          tx,
          { id, leadId: subject.leadId, organizationId: row.organizationId },
          {
            direction: row.direction,
            status: row.status,
            outcome,
            durationSeconds: row.durationSeconds,
            notes: row.notes,
            occurredAt: row.endedAt ?? row.startedAt,
            taskId: row.taskId,
          },
        );
      }
      await this.audit.recordInTransaction(tx, {
        action: 'call.updated',
        resourceType: 'call',
        resourceId: id,
        before: { leadId: row.leadId, notes: row.notes },
        after: input as Record<string, unknown>,
      });
    });

    return this.findOne(id);
  }

  /**
   * Soft delete, for a call logged against the wrong person.
   *
   * It does **not** undo the contact: `first_contacted_at` records that somebody was reached, and a
   * mistyped log is not evidence they were not. Removing it would make the SLA report disagree with
   * the clock that was satisfied at the time, which is a worse lie than a deleted row.
   */
  async remove(id: string) {
    const row = await this.loadForWrite(id);
    await this.db.client.$transaction(async (tx) => {
      await tx.call.update({ where: { id }, data: { deletedAt: new Date() } });
      await this.audit.recordInTransaction(tx, {
        action: 'call.deleted',
        resourceType: 'call',
        resourceId: id,
        before: { leadId: row.leadId, status: row.status },
      });
    });
    return { id, deleted: true };
  }

  // ── The sweep ─────────────────────────────────────────────────────────────

  /**
   * Asks the person who dialled what happened (`call.outcome-sweep`).
   *
   * **The feature does not work without this.** With the manual driver the product hands a number
   * to a phone and never learns the result, so every click-to-call leaves a row saying only that
   * somebody tried. Left alone, a workspace's call log fills with attempts and "what happened on
   * those forty calls" — the question `FR-CALL-1` exists to answer — stays unanswerable. The nudge
   * is the only thing that turns an attempt into a record.
   *
   * Three properties worth stating, because each is a way this could have been worse than nothing:
   *
   *  * **Once per call, never a nag.** `outcome_prompted_at` records the question, exactly as
   *    `tasks.overdue_notified_at` does, and the sweep's own predicate excludes what it has already
   *    asked about — so a tick finds nothing rather than re-deciding quiet hours for every open
   *    call in the workspace. The dedupe key is the second line of defence.
   *  * **It stops looking after a day.** Past that nobody remembers the call, so there is nothing
   *    useful to ask; the row stays `dialing` for ever, which is the truth. It also bounds the read.
   *  * **The held nudge re-checks itself.** `call.outcome_missing` declares staleness
   *    `call_still_open`, so one written at 21:40 and held until 07:00 is dropped if the outcome was
   *    recorded at 21:45 — which is the common case, and the one time a nudge reads as the product
   *    being a day behind.
   */
  async sweepUnrecordedOutcomes(limit = 200): Promise<{ examined: number; asked: number }> {
    const now = new Date();
    const until = new Date(now.getTime() - CALL_OUTCOME_GRACE_MINUTES * 60_000);
    const since = new Date(now.getTime() - CALL_OUTCOME_NUDGE_WINDOW_HOURS * 3_600_000);

    const open = await withPlatformScope('calls: outcome sweep', async () =>
      this.db.client.call.findMany({
        where: {
          status: 'dialing',
          deletedAt: null,
          outcomePromptedAt: null,
          startedAt: { gte: since, lte: until },
        },
        orderBy: { startedAt: 'asc' },
        take: limit,
        select: {
          id: true,
          organizationId: true,
          agentUserId: true,
          leadId: true,
          toE164: true,
          lead: { select: { fullName: true } },
        },
      }),
    );

    let asked = 0;
    for (const call of open) {
      // Per tenant, like every other sweep that writes: a notification belongs to a workspace, and
      // `withPlatformScope` leaves the context without an organization.
      await tenantContext.run(systemPrincipal(call.organizationId, newId()), async () => {
        const who = call.lead?.fullName ?? call.toE164 ?? 'somebody';
        const written = await this.notifications.create({
          organizationId: call.organizationId,
          userId: call.agentUserId,
          type: 'call.outcome_missing',
          title: `What happened with ${who}?`,
          body: 'You dialled from the product and the call has no outcome recorded yet.',
          link: call.leadId ? `/leads/${call.leadId}` : '/calls',
          dedupeKey: `call-outcome:${call.id}`,
          data: { callId: call.id, leadId: call.leadId },
        });
        // The notification first, then the mark — the ordering the reminder dispatcher uses: a
        // crash between the two re-asks, and `create` is idempotent on the dedupe key, so the worst
        // case is a repeated attempt rather than a question nobody is ever asked.
        if (written) {
          await this.db.client.call.updateMany({
            where: { id: call.id, outcomePromptedAt: null },
            data: { outcomePromptedAt: now },
          });
          asked += 1;
        }
      });
    }

    return { examined: open.length, asked };
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  /**
   * The timeline entry, the contact, and the event — the three things every settled call owes,
   * wherever it was settled from.
   */
  private async recordLogged(
    tx: TransactionClient,
    call: { id: string; leadId: string | null; organizationId: string },
    result: {
      direction: string;
      status: string;
      outcome: { id: string; name: string; category: CallOutcomeCategory };
      durationSeconds: number | null;
      notes: string | null;
      occurredAt: Date;
      taskId: string | null;
    },
  ): Promise<void> {
    const reached = result.status === 'completed' && isContact(result.outcome.category);

    if (call.leadId) {
      await this.timeline.recordInTransaction(tx, {
        type: ACTIVITY_TYPES.CALL_LOGGED,
        leadId: call.leadId,
        occurredAt: result.occurredAt,
        payload: {
          callId: call.id,
          direction: result.direction,
          status: result.status,
          outcome: result.outcome.name,
          outcomeCategory: result.outcome.category,
          reached,
          ...(result.durationSeconds !== null ? { durationSeconds: result.durationSeconds } : {}),
          ...(result.notes ? { note: result.notes } : {}),
          ...(result.taskId ? { taskId: result.taskId } : {}),
        },
      });
      if (reached) {
        await this.contact.record(
          tx,
          { organizationId: call.organizationId, leadId: call.leadId },
          result.occurredAt,
          `Call — ${result.outcome.name} (${describeCallDuration(result.durationSeconds)})`,
        );
      }
      // The envelope's subject is the **lead**, because that is what a consumer reacts to: the
      // scoring processor reads its subject from `payload.aggregateId`, and a rule reads
      // `event.outcomeCategory` to score "spoke to them" differently from "wrong number".
      await this.outbox.emit(tx, [
        {
          name: 'call.logged',
          aggregateType: 'lead',
          aggregateId: call.leadId,
          payload: {
            callId: call.id,
            direction: result.direction,
            status: result.status,
            outcomeId: result.outcome.id,
            outcomeCategory: result.outcome.category,
            reached,
            durationSeconds: result.durationSeconds,
            taskId: result.taskId,
          },
        },
      ]);
    }
  }

  /**
   * A call is made by a **person**, so the column is NOT NULL.
   *
   * A background job has no business logging one, and a row claiming the system was on the phone
   * would be a row no report could attribute.
   */
  private agent(reason: string): string {
    const principal = tenantContext.require(reason);
    if (!principal.actorId) throw AppError.internal('A call must be logged by a person');
    return principal.actorId;
  }

  /** The lead the call was with, and the branch and team a report scopes by. */
  private async resolveSubject(
    leadId: string | null,
  ): Promise<CallSubject & { organizationId: string }> {
    const organizationId = tenantContext.organizationId('calls.subject');
    if (!leadId) {
      return { organizationId, leadId: null, branchId: null, teamId: null, phoneE164: null };
    }
    const lead = await this.db.client.lead.findFirst({ where: { id: leadId, deletedAt: null } });
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
      organizationId,
      leadId: lead.id,
      branchId: lead.branchId,
      teamId: lead.teamId,
      phoneE164: lead.phoneE164,
    };
  }

  /** The follow-up this call was for. It has to be about the same lead, or the link is a lie. */
  private async loadTask(taskId: string, leadId: string | null) {
    const task = await this.db.client.task.findFirst({ where: { id: taskId, deletedAt: null } });
    if (!task) throw AppError.notFound('Task');
    if (leadId && task.leadId && task.leadId !== leadId) {
      throw AppError.businessRule('That follow-up is about a different lead');
    }
    return task;
  }

  /**
   * Which end is "us" depends on the direction, and a call with neither number is a row about
   * nothing (`calls_has_a_number`).
   */
  private numbersFor(
    direction: string,
    toE164: string | undefined,
    fromE164: string | undefined,
    subject: CallSubject,
  ): { toE164?: string; fromE164?: string } {
    const theirs = direction === 'inbound' ? fromE164 : toE164;
    const resolved = theirs ?? subject.phoneE164 ?? undefined;
    if (!resolved) {
      throw AppError.validation('Some details need correcting', [
        {
          field: direction === 'inbound' ? 'fromE164' : 'toE164',
          code: 'NUMBER_REQUIRED',
          message:
            'This lead has no phone number on record, so say which number the call was with.',
        },
      ]);
    }
    return direction === 'inbound'
      ? { fromE164: resolved, ...(toE164 ? { toE164 } : {}) }
      : { toE164: resolved, ...(fromE164 ? { fromE164 } : {}) };
  }

  /** The tenant ticked the box on this outcome so that "Other" cannot be the end of the story. */
  private assertNoteWhenRequired(
    outcome: { name: string; requiresNote: boolean },
    note: string | null,
  ): void {
    if (outcome.requiresNote && !note) {
      throw AppError.validation('Some details need correcting', [
        {
          field: 'notes',
          code: 'NOTE_REQUIRED',
          message: `“${outcome.name}” needs a note saying what happened.`,
        },
      ]);
    }
  }

  /**
   * An outcome that means somebody was spoken to needs a call that connected.
   *
   * Only this direction is refused, and it is refused because the pair decides whether the lead is
   * marked contacted and whether a first-response promise is satisfied: "spoke to them" on a call
   * that never connected would answer an SLA with a conversation that did not happen. The other
   * direction is ordinary — a call that connected and went nowhere is most of them.
   */
  private assertStatusMatchesOutcome(status: string, category: CallOutcomeCategory): void {
    if (isContact(category) && status !== 'completed') {
      throw AppError.validation('Some details need correcting', [
        {
          field: 'status',
          code: 'OUTCOME_NEEDS_A_CONNECTED_CALL',
          message: 'That outcome means you spoke to them, so the call has to be a connected one.',
        },
      ]);
    }
  }

  /** Loaded for writing, with the caller's authority on it checked. 404 either way. */
  private async loadForWrite(id: string) {
    const row = await this.db.client.call.findFirst({ where: { id, deletedAt: null } });
    if (!row) throw AppError.notFound('Call');
    const allowed = this.scopes.canAct(PERMISSIONS.CALL_LOG, {
      userId: row.agentUserId,
      teamId: row.teamId,
      branchId: row.branchId,
    });
    if (!allowed) throw AppError.notFound('Call');
    return row;
  }

  private canRead(row: {
    agentUserId: string;
    teamId: string | null;
    branchId: string | null;
  }): boolean {
    return this.scopes.canAct(PERMISSIONS.CALL_READ, {
      userId: row.agentUserId,
      teamId: row.teamId,
      branchId: row.branchId,
    });
  }

  private listInclude() {
    return {
      outcome: { select: { id: true, name: true, category: true, requiresNote: true } },
      lead: { select: { id: true, fullName: true, phoneE164: true } },
      task: { select: { id: true, title: true, status: true } },
    };
  }

  private present(row: {
    id: string;
    leadId: string | null;
    taskId: string | null;
    direction: string;
    status: string;
    fromE164: string | null;
    toE164: string | null;
    outcomeId: string | null;
    durationSeconds: number | null;
    notes: string | null;
    recordingUrl: string | null;
    provider: string | null;
    providerCallId: string | null;
    agentUserId: string;
    startedAt: Date;
    endedAt: Date | null;
    createdAt: Date;
    deletedAt: Date | null;
    outcome?: { id: string; name: string; category: string; requiresNote: boolean } | null;
    lead?: { id: string; fullName: string | null; phoneE164: string | null } | null;
    task?: { id: string; title: string; status: string } | null;
  }) {
    return {
      id: row.id,
      leadId: row.leadId,
      lead: row.lead ?? null,
      taskId: row.taskId,
      task: row.task ?? null,
      direction: row.direction,
      status: row.status,
      fromE164: row.fromE164,
      toE164: row.toE164,
      outcomeId: row.outcomeId,
      outcome: row.outcome ?? null,
      /** Derived once, here, so no screen reimplements which categories mean "reached". */
      reached: row.status === 'completed' && row.outcome ? isContact(row.outcome.category) : false,
      durationSeconds: row.durationSeconds,
      /** The sentence, not only the number: "4 min 12 sec" is what a person reads. */
      duration: describeCallDuration(row.durationSeconds),
      notes: row.notes,
      recordingUrl: row.recordingUrl,
      provider: row.provider,
      providerCallId: row.providerCallId,
      agentUserId: row.agentUserId,
      startedAt: row.startedAt,
      endedAt: row.endedAt,
      createdAt: row.createdAt,
      deletedAt: row.deletedAt,
    };
  }
}
