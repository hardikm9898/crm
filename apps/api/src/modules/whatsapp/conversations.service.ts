import { Inject, Injectable } from '@nestjs/common';
import {
  AppError,
  describeMessagePreview,
  describeWindow,
  tenantContext,
  windowIsOpen,
  type MessageType,
} from '@leados/shared';
import type { Logger } from 'pino';
import { DataScopeService, applyScopeFilter } from '../../infra/authz/data-scope.service.js';
import { DbService } from '../../infra/db/db.service.js';
import { LOGGER } from '../../infra/observability/logger.module.js';
import type { ListConversationsQuery, ListMessagesQuery } from './whatsapp.dto.js';

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
    const filter = this.scopes.filterFor('conversation:read', {
      userColumn: 'assignedUserId',
      // No branch or team column: a conversation carries neither, and the lead it belongs to is a
      // join this step does not need. A branch-scoped agent is therefore narrowed to their own
      // rows, which is what `filterFor` does for a principal whose scope has no column to use —
      // narrower than their grant, never wider, which is the right direction to err in.
    });
    const base: Record<string, unknown> = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.numberId ? { channelAccountId: query.numberId } : {}),
      ...(query.leadId ? { leadId: query.leadId } : {}),
      ...(query.unread === true ? { unreadCount: { gt: 0 } } : {}),
      ...(query.unread === false ? { unreadCount: 0 } : {}),
      ...(query.assigned === 'me' ? { assignedUserId: principal.actorId } : {}),
      ...(query.assigned === 'unassigned' ? { assignedUserId: null } : {}),
    };
    const scoped = applyScopeFilter(base, filter);
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
        take: query.limit,
        include: {
          number: { select: { id: true, displayPhoneE164: true, verifiedName: true } },
          lead: { select: { id: true, fullName: true, status: { select: { name: true } } } },
          assignedTo: { select: { userId: true, user: { select: { name: true } } } },
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

    return {
      items: rows.map((row) => this.presentConversation(row)),
      pagination: { limit: query.limit, nextCursor: null, hasMore: false, total },
      meta: { unread, open },
    };
  }

  async findOne(id: string) {
    const filter = this.scopes.filterFor('conversation:read', { userColumn: 'assignedUserId' });
    const scoped = applyScopeFilter({ id }, filter);
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
      include: { sender: { select: { userId: true, user: { select: { name: true } } } } },
    });
    const page = rows.slice(0, query.limit);
    return {
      items: page.map((row) => ({
        id: row.id,
        direction: row.direction,
        type: row.type,
        body: row.body,
        preview: describeMessagePreview(row.type as MessageType, row.body),
        status: row.status,
        errorCode: row.errorCode,
        errorMessage: row.errorMessage,
        providerMessageId: row.providerMessageId,
        replyToProviderId: row.replyToProviderId,
        sender: row.sender ? { id: row.sender.userId, name: row.sender.user.name } : null,
        payload: row.payload,
        createdAt: row.createdAt,
      })),
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
    tags: string[];
    createdAt: Date;
    number: { id: string; displayPhoneE164: string; verifiedName: string | null } | null;
    lead: { id: string; fullName: string } | null;
    assignedTo: { userId: string; user: { name: string } } | null;
    messages: { type: string; body: string | null; direction: string; createdAt: Date }[];
  }) {
    const last = row.messages[0];
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
