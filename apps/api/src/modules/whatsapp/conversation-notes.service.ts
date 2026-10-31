import { Injectable } from '@nestjs/common';
import { ACTIVITY_TYPES, AppError, newId, noteProblem, tenantContext } from '@leados/shared';
import { DbService } from '../../infra/db/db.service.js';
import { TimelineService } from '../../infra/timeline/timeline.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { ConversationsService } from './conversations.service.js';

/**
 * Internal notes on a conversation, and the people they name (`FR-WA-7`).
 *
 * Four decisions:
 *
 *  * **A note is its own table, not a `message` with a flag.** A note is never sent, so putting one
 *    in `messages` would make every "did we reply?" and every export carry a predicate it could
 *    forget — and one forgotten predicate shows a colleague's private words to a customer.
 *  * **A mention is an id the client sends, not a name this service parses out of the text.**
 *    Matching `@Asha` against member names is ambiguous the moment a workspace has two Ashas, and
 *    wrong in the quiet direction: the wrong person is told and the right one is not. The composer
 *    offers a picker, submits ids, and the body keeps the `@Name` text somebody typed — which is
 *    why the two are written in one request and cannot disagree.
 *  * **Every mentioned id is checked against `Membership`.** An array column cannot carry a
 *    foreign key, so the guarantee the composite FK gives the author has to be a check here; the
 *    alternative is a note naming somebody who is not in this workspace, which is a notification
 *    nobody receives and a name nobody can resolve.
 *  * **A mention reaches the lead's timeline as well as the person's inbox.** `mention.created` has
 *    been in the activity vocabulary since Phase 1 with nothing writing it; a business owner
 *    reading a lead wants to know a colleague was pulled in, and the note's own text is what says
 *    why.
 */
@Injectable()
export class ConversationNotesService {
  constructor(
    private readonly db: DbService,
    private readonly conversations: ConversationsService,
    private readonly timeline: TimelineService,
    private readonly notifications: NotificationsService,
  ) {}

  /** One conversation's notes, newest first. Behind the conversation's own read scope. */
  async list(conversationId: string) {
    await this.conversations.findOne(conversationId);
    const rows = await this.db.client.conversationNote.findMany({
      where: { conversationId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 100,
      include: { author: { select: { userId: true, user: { select: { name: true } } } } },
    });
    // The names behind the ids, resolved once for the whole page rather than per row: a note that
    // rendered a raw uuid where a colleague's name belongs is the "Changed billingLine1" mistake.
    const mentioned = [...new Set(rows.flatMap((row) => row.mentionedUserIds))];
    const names = await this.namesFor(mentioned);
    return {
      items: rows.map((row) => ({
        id: row.id,
        body: row.body,
        author: { id: row.author.userId, name: row.author.user.name },
        mentions: row.mentionedUserIds.map((id) => ({ id, name: names.get(id) ?? 'Someone' })),
        createdAt: row.createdAt,
      })),
      pagination: { limit: 100, nextCursor: null, hasMore: false, total: rows.length },
    };
  }

  async create(conversationId: string, body: string, mentionedUserIds: readonly string[]) {
    const principal = tenantContext.require('conversations.notes.create');
    const conversation = await this.conversations.findOne(conversationId);

    // A note has an author, and the column is NOT NULL for that reason: "somebody wrote this" with
    // no somebody is a row a colleague cannot reply to. `actorId` is optional on the principal
    // because the system itself writes some rows, and nothing here is written by the system.
    const authorUserId = principal.actorId;
    if (authorUserId === undefined) {
      throw AppError.businessRule('A note has to be written by a person.');
    }

    const problem = noteProblem(body);
    if (problem !== null) {
      throw AppError.validation('That note cannot be saved', [
        { field: 'body', code: 'NOTE_INVALID', message: problem },
      ]);
    }
    const mentions = [...new Set(mentionedUserIds)];
    if (mentions.length > 0) {
      const names = await this.namesFor(mentions);
      const unknown = mentions.filter((id) => !names.has(id));
      if (unknown.length > 0) {
        throw AppError.validation('That note names somebody who is not here', [
          {
            field: 'mentionedUserIds',
            code: 'NOT_A_MEMBER',
            message: `${unknown.length === 1 ? 'One of the people' : `${unknown.length} of the people`} you named is not an active member of this workspace.`,
          },
        ]);
      }
    }

    const id = newId();
    const now = new Date();
    const text = body.trim();
    await this.db.client.$transaction(async (tx) => {
      await tx.conversationNote.create({
        data: {
          id,
          organizationId: principal.organizationId,
          conversationId,
          body: text,
          authorUserId,
          mentionedUserIds: [...mentions],
        },
      });
      if (conversation.lead !== null && mentions.length > 0) {
        // One entry for the note, naming everybody it pulled in — not one per person, which would
        // read as the same note three times.
        await this.timeline.recordInTransaction(tx, {
          type: ACTIVITY_TYPES.MENTION_CREATED,
          leadId: conversation.lead.id,
          occurredAt: now,
          payload: {
            conversationId,
            note: text.slice(0, 500),
            mentionedUserIds: [...mentions],
          },
        });
      }
    });

    for (const userId of mentions) {
      // Not yourself: being told about your own note is the product talking to itself.
      if (userId === principal.actorId) continue;
      await this.notifications.create({
        organizationId: principal.organizationId,
        userId,
        type: 'conversation.mentioned',
        title: 'You were mentioned in a conversation',
        body: text.slice(0, 280),
        link: `/inbox?c=${conversationId}`,
        data: { conversationId, noteId: id },
        // The note's own id, which is the event: a mention is written once and a retry of the same
        // write must not produce a second ping.
        dedupeKey: `conversation.mentioned:${id}:${userId}`,
      });
    }
    return this.list(conversationId);
  }

  /** The names of these members, as a map. Missing ids are simply absent, which is the check. */
  private async namesFor(userIds: readonly string[]): Promise<Map<string, string>> {
    if (userIds.length === 0) return new Map();
    const rows = await this.db.client.membership.findMany({
      where: { userId: { in: [...userIds] }, status: 'active', deletedAt: null },
      select: { userId: true, user: { select: { name: true } } },
    });
    return new Map(rows.map((row) => [row.userId, row.user.name]));
  }
}
