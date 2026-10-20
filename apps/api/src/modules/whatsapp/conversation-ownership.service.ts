import { Inject, Injectable } from '@nestjs/common';
import {
  ACTIVITY_TYPES,
  AppError,
  conversationLockExpiry,
  snoozeProblem,
  tenantContext,
} from '@leados/shared';
import type { Logger } from 'pino';
import { AuditService } from '../../infra/audit/audit.service.js';
import { DbService } from '../../infra/db/db.service.js';
import { LOGGER } from '../../infra/observability/logger.module.js';
import { TimelineService } from '../../infra/timeline/timeline.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { ConversationsService } from './conversations.service.js';

/**
 * Who owns a conversation, and what state it is in (`FR-WA-7`).
 *
 * Five decisions are visible in this file:
 *
 *  * **Assignment and the lock are different things, and conflating them is the bug this split
 *    avoids.** `assigned_user_id` is ownership: it survives a closed tab, it drives "my
 *    conversations", and changing it is an audited act. The lock is five minutes of "I am typing",
 *    taken by opening the conversation and refreshed by replying. A product that used one column
 *    for both would either lose ownership when somebody closed a tab or leave a conversation
 *    permanently claimed by whoever opened it first.
 *  * **The lock is advisory and says so.** A reply from somebody who is not the holder goes
 *    through. `FR-WA-7` asks that two agents on one conversation *see* each other, which is a
 *    sentence on a screen; refusing the second one means a customer waits while the holder is at
 *    lunch. The sentence comes from `conversationLock` in `@leados/shared`, which the screen calls
 *    too, so the warning and the state cannot disagree.
 *  * **Every change of hands is on the lead's timeline and in the audit log.** "Transfer is
 *    audited" is one of this phase's exit criteria, and a transfer a manager cannot reconstruct is
 *    the thing the criterion is about. Both writes are in the same transaction as the change.
 *  * **A snooze without a waker is a conversation nobody sees again.** `snoozed_until` is swept —
 *    which is also why a snooze notifies the person who asked for it when it comes back: the
 *    passage of time is not a thing anybody notices.
 *  * **Closing takes a note, and the note is the timeline entry's body.** "Closed" with no reason
 *    is a row that answers nothing three weeks later.
 */
@Injectable()
export class ConversationOwnershipService {
  constructor(
    private readonly db: DbService,
    private readonly conversations: ConversationsService,
    private readonly timeline: TimelineService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  /**
   * Takes the soft lock, or refreshes it.
   *
   * Idempotent for the holder: opening a conversation you already have open extends it, which is
   * what makes "refreshed by every reply" work without a second method. Taking one somebody else
   * holds is **allowed** and answers the state, because the alternative is an agent who cannot
   * answer a customer until a colleague's five minutes run out.
   */
  async claim(id: string) {
    const principal = tenantContext.require('conversations.claim');
    const current = await this.row(id);
    const now = new Date();
    const takenFrom =
      current.lockUserId !== null &&
      current.lockUserId !== principal.actorId &&
      current.lockExpiresAt !== null &&
      current.lockExpiresAt.getTime() > now.getTime()
        ? current.lockUserId
        : null;

    await this.db.client.conversation.update({
      where: { id },
      data: { lockUserId: principal.actorId, lockExpiresAt: conversationLockExpiry(now) },
    });
    if (takenFrom !== null) {
      // Not a refusal, but not silent either: somebody else's lock was overridden, and that is a
      // fact a manager asking "who was on this" needs.
      await this.audit.record({
        action: 'conversation.lock_taken_over',
        resourceType: 'conversation',
        resourceId: id,
        before: { lockUserId: takenFrom },
        after: { lockUserId: principal.actorId },
      });
      this.logger.info(
        { conversationId: id, from: takenFrom, to: principal.actorId },
        'a conversation lock was taken over',
      );
    }
    return this.conversations.findOne(id);
  }

  /** Gives the lock up. Somebody else's lock is left alone — releasing it would be a lie. */
  async release(id: string) {
    const principal = tenantContext.require('conversations.release');
    await this.row(id);
    // Conditional, and the condition is the point: `updateMany … WHERE lock_user_id = me` cannot
    // release a lock that moved to a colleague a millisecond ago. The same shape as the status
    // receipts' conditional advance, for the same reason.
    await this.db.client.conversation.updateMany({
      where: { id, lockUserId: principal.actorId },
      data: { lockUserId: null, lockExpiresAt: null },
    });
    return this.conversations.findOne(id);
  }

  /**
   * Hands a conversation to somebody, or takes it off everybody (`assignedUserId: null`).
   *
   * `null` is a real answer rather than an omission: a conversation nobody owns is visible to
   * everybody who can read it, and "put this back in the pool" is a thing an agent going on
   * holiday needs. The same reasoning as `POST /leads/:id/assign`.
   */
  async assign(id: string, assignedUserId: string | null, reason: string | null) {
    const principal = tenantContext.require('conversations.assign');
    const current = await this.row(id);
    if (assignedUserId !== null) await this.requireMember(assignedUserId);
    if (current.assignedUserId === assignedUserId) {
      // Not an error: pressing it twice is not a mistake, and a 422 here would be a dead end on a
      // screen whose state may simply be stale.
      return this.conversations.findOne(id);
    }

    const now = new Date();
    await this.db.client.$transaction(async (tx) => {
      await tx.conversation.update({
        where: { id },
        data: {
          assignedUserId,
          // Ownership moving releases the lock: the person who had it open is no longer the person
          // answering, and a lock left behind is a warning about somebody who has moved on.
          lockUserId: null,
          lockExpiresAt: null,
        },
      });
      if (current.leadId !== null) {
        await this.timeline.recordInTransaction(tx, {
          type: ACTIVITY_TYPES.CONVERSATION_ASSIGNED,
          leadId: current.leadId,
          occurredAt: now,
          payload: {
            conversationId: id,
            fromUserId: current.assignedUserId,
            toUserId: assignedUserId,
            reason: reason ?? (assignedUserId === null ? 'put back in the pool' : 'assigned'),
          },
        });
      }
      await this.audit.recordInTransaction(tx, {
        action: 'conversation.assigned',
        resourceType: 'conversation',
        resourceId: id,
        before: { assignedUserId: current.assignedUserId },
        after: { assignedUserId },
      });
    });

    if (assignedUserId !== null && assignedUserId !== principal.actorId) {
      await this.tell(assignedUserId, id, {
        type: 'conversation.assigned',
        title: 'A conversation was assigned to you',
        body: reason ?? 'Somebody handed you a WhatsApp conversation.',
      });
    }
    return this.conversations.findOne(id);
  }

  /**
   * A transfer: an assignment that insists on a recipient, and says why.
   *
   * A separate method rather than `assign` with a longer comment, because the two are different
   * acts. An assignment may be to nobody and needs no reason; a transfer is one person handing
   * work to another and the note is what makes it accountable — the exit criterion is "transfer is
   * audited", and an audit row with no reason answers nothing.
   */
  async transfer(id: string, toUserId: string, note: string) {
    const principal = tenantContext.require('conversations.transfer');
    const current = await this.row(id);
    await this.requireMember(toUserId);
    if (toUserId === current.assignedUserId) {
      throw AppError.businessRule('That conversation is already theirs.');
    }

    const now = new Date();
    await this.db.client.$transaction(async (tx) => {
      await tx.conversation.update({
        where: { id },
        data: { assignedUserId: toUserId, lockUserId: null, lockExpiresAt: null },
      });
      if (current.leadId !== null) {
        await this.timeline.recordInTransaction(tx, {
          type: ACTIVITY_TYPES.CONVERSATION_TRANSFERRED,
          leadId: current.leadId,
          occurredAt: now,
          payload: {
            conversationId: id,
            fromUserId: current.assignedUserId,
            toUserId,
            note,
          },
        });
      }
      await this.audit.recordInTransaction(tx, {
        action: 'conversation.transferred',
        resourceType: 'conversation',
        resourceId: id,
        before: { assignedUserId: current.assignedUserId },
        after: { assignedUserId: toUserId, note },
      });
    });

    if (toUserId !== principal.actorId) {
      await this.tell(toUserId, id, {
        type: 'conversation.assigned',
        title: 'A conversation was transferred to you',
        body: note,
      });
    }
    return this.conversations.findOne(id);
  }

  /** Closes it, with the reason on the timeline. */
  async close(id: string, note: string | null) {
    const principal = tenantContext.require('conversations.close');
    const current = await this.row(id);
    if (current.status === 'closed') throw AppError.businessRule('That conversation is closed.');

    const now = new Date();
    await this.db.client.$transaction(async (tx) => {
      await tx.conversation.update({
        where: { id },
        data: {
          status: 'closed',
          closedAt: now,
          closedById: principal.actorId,
          lockUserId: null,
          lockExpiresAt: null,
          // A closed conversation is not waiting for anything, so the snooze it was waiting for is
          // over. The instant stays on the row: what somebody asked for is history, not state.
          unreadCount: 0,
        },
      });
      if (current.leadId !== null) {
        await this.timeline.recordInTransaction(tx, {
          type: ACTIVITY_TYPES.CONVERSATION_CLOSED,
          leadId: current.leadId,
          occurredAt: now,
          payload: { conversationId: id, note },
        });
      }
      await this.audit.recordInTransaction(tx, {
        action: 'conversation.closed',
        resourceType: 'conversation',
        resourceId: id,
        before: { status: current.status },
        after: { status: 'closed', note },
      });
    });
    return this.conversations.findOne(id);
  }

  /** Opens it again. `closed_at` and `closed_by_id` are cleared: they describe a state it is not in. */
  async reopen(id: string) {
    const current = await this.row(id);
    if (current.status !== 'closed') {
      throw AppError.businessRule('That conversation is already open.');
    }
    const now = new Date();
    await this.db.client.$transaction(async (tx) => {
      await tx.conversation.update({
        where: { id },
        data: { status: 'open', closedAt: null, closedById: null, snoozedUntil: null },
      });
      if (current.leadId !== null) {
        await this.timeline.recordInTransaction(tx, {
          type: ACTIVITY_TYPES.CONVERSATION_REOPENED,
          leadId: current.leadId,
          occurredAt: now,
          payload: { conversationId: id },
        });
      }
      await this.audit.recordInTransaction(tx, {
        action: 'conversation.reopened',
        resourceType: 'conversation',
        resourceId: id,
        before: { status: 'closed' },
        after: { status: 'open' },
      });
    });
    return this.conversations.findOne(id);
  }

  /**
   * Puts it aside until an instant.
   *
   * No timeline entry, deliberately: a business owner reading a lead wants the conversation, and
   * "the inbox hid this for two hours" is a fact about somebody's working day rather than about
   * the customer. The audit log has it, which is where a question about the inbox belongs.
   */
  async snooze(id: string, until: Date) {
    const current = await this.row(id);
    if (current.status === 'closed') {
      throw AppError.businessRule('That conversation is closed — reopen it before snoozing it.');
    }
    const problem = snoozeProblem(until);
    if (problem !== null) {
      throw AppError.validation('That snooze cannot be set', [
        { field: 'until', code: 'SNOOZE_INVALID', message: problem },
      ]);
    }
    await this.db.client.conversation.update({
      where: { id },
      data: { status: 'snoozed', snoozedUntil: until, lockUserId: null, lockExpiresAt: null },
    });
    await this.audit.record({
      action: 'conversation.snoozed',
      resourceType: 'conversation',
      resourceId: id,
      before: { status: current.status },
      after: { status: 'snoozed', snoozedUntil: until.toISOString() },
    });
    return this.conversations.findOne(id);
  }

  /**
   * The rows the sweep has to act on, across every workspace.
   *
   * Two separate reads rather than one `OR`: an `OR` cannot be a range scan, so the two partial
   * indexes (`conversations_locked`, `conversations_snoozed`) are only used if each is asked its
   * own question — the `/my/today` lesson, in a second place.
   */
  async dueForSweep(limit: number) {
    const now = new Date();
    const [staleLocks, waking] = await Promise.all([
      this.db.client.conversation.findMany({
        where: { lockUserId: { not: null }, lockExpiresAt: { lt: now } },
        select: { id: true, organizationId: true, lockUserId: true },
        take: limit,
      }),
      this.db.client.conversation.findMany({
        where: { status: 'snoozed', snoozedUntil: { lte: now } },
        select: { id: true, organizationId: true, assignedUserId: true, leadId: true },
        take: limit,
      }),
    ]);
    return { staleLocks, waking };
  }

  /**
   * Clears one lapsed lock.
   *
   * The read already treats an expired lock as absent, so this changes no behaviour — and it is
   * what stops the column being a lie. A row saying "Nikhil holds this" three days after Nikhil
   * went on holiday is a thing somebody will read and believe, and a `lock_expires_at` that
   * nothing clears means every screen has to remember to compare it to the clock.
   */
  async clearLock(id: string): Promise<boolean> {
    const cleared = await this.db.client.conversation.updateMany({
      where: { id, lockExpiresAt: { lt: new Date() } },
      data: { lockUserId: null, lockExpiresAt: null },
    });
    return cleared.count > 0;
  }

  /** Brings one snoozed conversation back, and tells whoever asked for it. */
  async wake(row: {
    id: string;
    assignedUserId: string | null;
    organizationId: string;
  }): Promise<boolean> {
    // Conditional on the state the sweep read: a conversation somebody reopened or closed in the
    // meantime must not be dragged back to `open` by a job that is a second behind.
    const woke = await this.db.client.conversation.updateMany({
      where: { id: row.id, status: 'snoozed', snoozedUntil: { lte: new Date() } },
      data: { status: 'open', snoozedUntil: null },
    });
    if (woke.count === 0) return false;
    if (row.assignedUserId !== null) {
      await this.tell(row.assignedUserId, row.id, {
        type: 'conversation.woke',
        title: 'A conversation you snoozed is back',
        body: 'You asked to come back to this one.',
      });
    }
    return true;
  }

  /** The columns every method here needs, through the scope that decides who may see it. */
  private async row(id: string) {
    // Through the read service, so a conversation outside the caller's scope answers 404 rather
    // than being assignable by somebody who cannot see it.
    await this.conversations.findOne(id);
    const row = await this.db.client.conversation.findFirst({
      where: { id },
      select: {
        id: true,
        organizationId: true,
        leadId: true,
        status: true,
        assignedUserId: true,
        lockUserId: true,
        lockExpiresAt: true,
      },
    });
    if (!row) throw AppError.notFound('Conversation');
    return row;
  }

  /** A person a conversation may be given to has to be a member of this workspace. */
  private async requireMember(userId: string): Promise<void> {
    const member = await this.db.client.membership.findFirst({
      where: { userId, status: 'active', deletedAt: null },
      select: { userId: true },
    });
    if (!member) {
      throw AppError.validation('That person cannot take this conversation', [
        {
          field: 'assignedUserId',
          code: 'NOT_A_MEMBER',
          message: 'They are not an active member of this workspace.',
        },
      ]);
    }
  }

  /**
   * One notification, through the method every producer in this product goes through.
   *
   * `create` can answer `null` — the person switched the type off, or their quiet hours are on —
   * and that is not a failure of the thing that caused it.
   */
  private async tell(
    userId: string,
    conversationId: string,
    input: { type: string; title: string; body: string },
  ): Promise<void> {
    const organizationId = tenantContext.organizationId('conversations.notify');
    await this.notifications.create({
      organizationId,
      userId,
      type: input.type,
      title: input.title,
      body: input.body,
      link: `/inbox?c=${conversationId}`,
      data: { conversationId },
      // **No `dedupeKey`**, and deliberately. A hand-over has no event id of its own, and a key
      // built from the conversation and the recipient would silently swallow the second of two
      // real hand-overs — somebody given a conversation, handing it back, and being given it
      // again. A double-click cannot get here: `assign` returns early when the assignee has not
      // changed, and the sweep's own `updateMany` row count is what stops two wakes. A dedupe key
      // with a random suffix in it would be a key that never matches, which is worse than none.
    });
  }
}
