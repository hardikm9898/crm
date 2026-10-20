import { Inject, Injectable } from '@nestjs/common';
import {
  AppError,
  conversationLock,
  describeMessagePreview,
  describeWindow,
  tenantContext,
  windowIsOpen,
  type MessageType,
} from '@leados/shared';
import type { Logger } from 'pino';
import { DataScopeService } from '../../infra/authz/data-scope.service.js';
import { conversationScopeWhere } from './conversation-scope.js';
import { DbService } from '../../infra/db/db.service.js';
import { LOGGER } from '../../infra/observability/logger.module.js';
import { presentMessage } from './whatsapp-presenters.js';
import type { ListConversationsQuery, ListMessagesQuery } from './whatsapp.dto.js';

/**
 * Where the next page starts, from the cursor the previous one handed out.
 *
 * `(last_message_at, id)` as a **tuple**, not two independent comparisons: `lastMessageAt < t OR
 * (lastMessageAt = t AND id < i)` is the only form that neither skips a row nor repeats one when
 * two conversations' newest messages share a second. Written under `AND` so it composes with the
 * scope's own `OR`, which two keys at one level would silently replace.
 *
 * A malformed cursor cannot get here: the schema's regex refuses anything this endpoint did not
 * issue, which is also what stops a client inventing one and paging through another shape.
 */
function keysetFrom(cursor: string | undefined): Record<string, unknown> {
  if (cursor === undefined) return {};
  const split = cursor.lastIndexOf('_');
  const at = new Date(cursor.slice(0, split));
  const id = cursor.slice(split + 1);
  if (Number.isNaN(at.getTime())) return {};
  return {
    OR: [{ lastMessageAt: { lt: at } }, { lastMessageAt: at, id: { lt: id } }],
  };
}

/**
 * The inbox, read (`FR-WA-7`, `FR-WA-8`).
 *
 * Three decisions worth stating:
 *
 *  * **It goes through `DataScopeService`**, like every other list in this product: a branch-scoped
 *    agent sees their branch's conversations, and an own-scoped one sees theirs — decided from the
 *    `conversation:read` grant rather than filtered by hand. A conversation's ownership column is
 *    `assigned_user_id`, and one nobody has claimed is visible to anybody who can read the lead it
 *    belongs to, for the reason `/my/today` paid for: the conversations at the greatest risk of
 *    never being answered are the ones a "mine" filter hides.
 *  * **Every figure totals the filter, not the page.** `meta.unread` and `meta.open` are separate
 *    aggregates over the whole filtered set, because a badge that counts the twenty rows it loaded
 *    tells an agent their inbox is a fifth of its real size.
 *  * **The 24-hour window is answered as a sentence, not only as an instant.** `FR-WA-1` is the
 *    rule an agent runs into, and a screen that showed `2026-10-20T08:00:00Z` would leave them to
 *    do the arithmetic the write path is about to do for them.
 */
@Injectable()
export class ConversationsService {
  constructor(
    private readonly db: DbService,
    private readonly scopes: DataScopeService,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  async list(query: ListConversationsQuery) {
    const principal = tenantContext.require('conversations.list');
    const base: Record<string, unknown> = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.numberId ? { channelAccountId: query.numberId } : {}),
      ...(query.leadId ? { leadId: query.leadId } : {}),
      ...(query.unread === true ? { unreadCount: { gt: 0 } } : {}),
      ...(query.unread === false ? { unreadCount: 0 } : {}),
      ...(query.assigned === 'me' ? { assignedUserId: principal.actorId } : {}),
      ...(query.assigned === 'unassigned' ? { assignedUserId: null } : {}),
      // One tag, because a filter chip is one tag. `hasSome` rather than `has` so the predicate
      // stays right the day the screen offers two.
      ...(query.tag ? { tags: { hasSome: [query.tag] } } : {}),
      ...keysetFrom(query.cursor),
    };
    const scoped = this.scopedWhere(base);
    if (scoped === null) {
      return {
        items: [],
        pagination: { limit: query.limit, nextCursor: null, hasMore: false, total: 0 },
        meta: { unread: 0, open: 0 },
      };
    }

    if (query.q) {
      const matched = await this.searchIds(query.q, query.limit * 4);
      if (matched.length === 0) {
        return {
          items: [],
          pagination: { limit: query.limit, nextCursor: null, hasMore: false, total: 0 },
          meta: { unread: 0, open: 0 },
        };
      }
      scoped['id'] = { in: matched };
    }

    const [total, unread, open, rows] = await Promise.all([
      this.db.client.conversation.count({ where: scoped }),
      // Over the whole filter, not the page.
      this.db.client.conversation.count({ where: { ...scoped, unreadCount: { gt: 0 } } }),
      this.db.client.conversation.count({ where: { ...scoped, status: 'open' } }),
      this.db.client.conversation.findMany({
        where: scoped,
        orderBy: [{ lastMessageAt: 'desc' }, { id: 'desc' }],
        // One more than asked for, so "is there another page" is read from the database rather
        // than inferred from a full page — which is wrong exactly when the total is a multiple of
        // the limit.
        take: query.limit + 1,
        include: {
          number: { select: { id: true, displayPhoneE164: true, verifiedName: true } },
          lead: { select: { id: true, fullName: true, status: { select: { name: true } } } },
          assignedTo: { select: { userId: true, user: { select: { name: true } } } },
          lockedBy: { select: { userId: true, user: { select: { name: true } } } },
          messages: {
            // Both halves of the key the cursor pages by, so "the latest message" here and the
            // first row of `/messages` are the same row. A `createdAt` alone would tie.
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            take: 1,
            select: { type: true, body: true, direction: true, createdAt: true },
          },
        },
      }),
    ]);

    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    return {
      items: page.map((row) => this.presentConversation(row)),
      pagination: {
        limit: query.limit,
        // A real cursor. The first version answered `nextCursor: null, hasMore: false` on every
        // page — so a workspace with 4 000 conversations was told its inbox held 50, with the
        // other 3 950 unreachable and `total` sitting beside the lie saying 4 000. Found by
        // measuring against the 100 k fixture, which is the only thing that would have.
        nextCursor:
          rows.length > query.limit && last ? `${last.lastMessageAt.toISOString()}_${last.id}` : null,
        hasMore: rows.length > query.limit,
        total,
      },
      meta: { unread, open },
    };
  }

  async findOne(id: string) {
    const scoped = this.scopedWhere({ id });
    if (scoped === null) throw AppError.notFound('Conversation');
    const row = await this.db.client.conversation.findFirst({
      where: scoped,
      include: {
        number: { select: { id: true, displayPhoneE164: true, verifiedName: true } },
        lead: {
          select: {
            id: true,
            fullName: true,
            phoneE164: true,
            email: true,
            score: true,
            status: { select: { id: true, name: true } },
            assignee: { select: { userId: true, user: { select: { name: true } } } },
          },
        },
        assignedTo: { select: { userId: true, user: { select: { name: true } } } },
        lockedBy: { select: { userId: true, user: { select: { name: true } } } },
        messages: {
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: 1,
          select: { type: true, body: true, direction: true, createdAt: true },
        },
      },
    });
    if (!row) throw AppError.notFound('Conversation');
    return {
      ...this.presentConversation(row),
      // `FR-WA-8`'s lead context, beside the conversation rather than a click away: the whole
      // point of an inbox in a CRM is that the person's history is on the same screen.
      lead: row.lead
        ? {
            id: row.lead.id,
            fullName: row.lead.fullName,
            phone: row.lead.phoneE164,
            email: row.lead.email,
            score: row.lead.score,
            status: row.lead.status,
            owner: row.lead.assignee
              ? { id: row.lead.assignee.userId, name: row.lead.assignee.user.name }
              : null,
          }
        : null,
    };
  }

  /**
   * One conversation's messages, newest first.
   *
   * The cursor carries **both halves** of the partitioned table's key: `messages` is partitioned by
   * `created_at` and its primary key is `(id, created_at)`, so an id alone selects the wrong page —
   * the `activities` lesson, in the second table to have it.
   */
  async messages(conversationId: string, query: ListMessagesQuery) {
    // Through `findOne`, so a conversation outside the caller's scope answers 404 here too rather
    // than leaking its messages to somebody who cannot see the conversation they belong to.
    await this.findOne(conversationId);

    const before =
      query.before === undefined
        ? null
        : await this.db.client.message.findFirst({
            where: { id: query.before },
            select: { createdAt: true },
          });

    const rows = await this.db.client.message.findMany({
      where: {
        conversationId,
        ...(before ? { createdAt: { lt: before.createdAt } } : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
      include: {
        sender: { select: { userId: true, user: { select: { name: true } } } },
        // One of each, in both readings: a row with two presenters is a row whose two readings
        // diverge, which `sendAttempts` already paid for once.
        media: true,
      },
    });
    const page = rows.slice(0, query.limit);
    return {
      // Through the one presenter both this and the send path use: two readings of one row are two
      // readings that diverge, which is how `sendAttempts` came to be absent from the list the
      // screen renders while being present everywhere else.
      items: page.map((row) => presentMessage(row)),
      pagination: {
        limit: query.limit,
        nextCursor: rows.length > query.limit ? (page.at(-1)?.id ?? null) : null,
        hasMore: rows.length > query.limit,
        total: page.length,
      },
    };
  }

  /** Marks everything in a conversation read. The badge and the list share one predicate. */
  async markRead(id: string) {
    await this.findOne(id);
    await this.db.client.conversation.update({ where: { id }, data: { unreadCount: 0 } });
    return this.findOne(id);
  }

  /** The scope, plus anything nobody has claimed — the one decider, in its own module. */
  private scopedWhere(base: Record<string, unknown>): Record<string, unknown> | null {
    return conversationScopeWhere(this.scopes, 'conversation:read', base);
  }

  /**
   * Conversation ids whose messages match, by body.
   *
   * Through the GIN index on `to_tsvector('simple', body)`, and raw — which means the tenant scope
   * and the data scope do **not** come for free: `organization_id` is written out by hand, and the
   * ids are then intersected with the scoped `where` by the caller. The trap `/oversight`'s median
   * paid for, stated where the next person will read it.
   */
  private async searchIds(term: string, limit: number): Promise<string[]> {
    const organizationId = tenantContext.organizationId('conversations.search');
    const rows = await this.db.client.$queryRaw<{ conversation_id: string }[]>`
      SELECT DISTINCT conversation_id
        FROM messages
       WHERE organization_id = ${organizationId}::uuid
         AND to_tsvector('simple', coalesce(body, '')) @@ plainto_tsquery('simple', ${term})
       LIMIT ${limit}
    `;
    const byBody = rows.map((row) => row.conversation_id);
    // A number is what somebody types into a search box at least as often as a word, and it is not
    // in any message body.
    const byNumber = await this.db.client.conversation.findMany({
      where: { contactE164: { contains: term.replace(/[^\d+]/g, '') || term } },
      select: { id: true },
      take: limit,
    });
    return [...new Set([...byBody, ...byNumber.map((row) => row.id)])];
  }

  private presentConversation(row: {
    id: string;
    channel: string;
    contactE164: string | null;
    status: string;
    unreadCount: number;
    lastMessageAt: Date;
    lastInboundAt: Date | null;
    lastOutboundAt: Date | null;
    windowExpiresAt: Date | null;
    lockUserId: string | null;
    lockExpiresAt: Date | null;
    snoozedUntil: Date | null;
    tags: string[];
    createdAt: Date;
    number: { id: string; displayPhoneE164: string; verifiedName: string | null } | null;
    lead: { id: string; fullName: string } | null;
    assignedTo: { userId: string; user: { name: string } } | null;
    lockedBy: { userId: string; user: { name: string } } | null;
    messages: { type: string; body: string | null; direction: string; createdAt: Date }[];
  }) {
    const last = row.messages[0];
    // From the viewer's side, by the one function the screen calls too: "You have this open" and
    // "Nikhil opened this four minutes ago" are a reassurance and a warning, and a screen that
    // computed its own answer is how "the button was enabled and the action was refused" happens.
    const lock = conversationLock({
      lockUserId: row.lockUserId,
      lockExpiresAt: row.lockExpiresAt,
      lockHolderName: row.lockedBy?.user.name ?? null,
      viewerId: tenantContext.get()?.actorId ?? '',
    });
    return {
      id: row.id,
      channel: row.channel,
      contact: row.contactE164,
      number: row.number,
      lead: row.lead ? { id: row.lead.id, fullName: row.lead.fullName } : null,
      assignedTo: row.assignedTo
        ? { id: row.assignedTo.userId, name: row.assignedTo.user.name }
        : null,
      status: row.status,
      unreadCount: row.unreadCount,
      lastMessageAt: row.lastMessageAt,
      lastInboundAt: row.lastInboundAt,
      lastOutboundAt: row.lastOutboundAt,
      windowExpiresAt: row.windowExpiresAt,
      // Both, because they answer different questions: the boolean is what a button is disabled by
      // and the sentence is what a person reads.
      windowIsOpen: windowIsOpen(row.windowExpiresAt),
      windowSummary: describeWindow(row.windowExpiresAt),
      /**
       * The soft lock, as a state rather than as two columns (`FR-WA-7`).
       *
       * `lockedBy` is who, and `lock` is what the viewer should be told — including `null` for the
       * common case, so a screen never has to decide whether an expired `lockExpiresAt` counts.
       */
      lockedBy: row.lockedBy ? { id: row.lockedBy.userId, name: row.lockedBy.user.name } : null,
      lock,
      snoozedUntil: row.snoozedUntil,
      tags: row.tags,
      lastMessage: last
        ? {
            direction: last.direction,
            type: last.type,
            preview: describeMessagePreview(last.type as MessageType, last.body),
            createdAt: last.createdAt,
          }
        : null,
      createdAt: row.createdAt,
    };
  }
}
