import { Injectable } from '@nestjs/common';
import { AppError, newId, tenantContext, withPlatformScope } from '@leados/shared';
import { DbService } from '../../infra/db/db.service.js';

/**
 * In-app notifications (FR-NOT-1/2/3).
 *
 * Deliberately not a generic "message bus for humans": a notification is a row belonging to one
 * user in one organization, with a type the UI renders through a registry and a link to the thing
 * it is about. Email and WhatsApp delivery of the same event are separate channels chosen by
 * preference, not different notification records.
 */

export interface CreateNotificationInput {
  readonly organizationId: string;
  readonly userId: string;
  readonly type: string;
  readonly title: string;
  readonly body?: string;
  readonly link?: string;
  readonly data?: Record<string, unknown>;
  /**
   * Makes creation idempotent for a given event: a re-delivered job must not produce a second
   * copy of the same notification.
   */
  readonly dedupeKey?: string;
}

@Injectable()
export class NotificationsService {
  constructor(private readonly db: DbService) {}

  async list(options: { limit: number; cursor?: string; unreadOnly?: boolean }) {
    const principal = tenantContext.require('notifications.list');
    const where = {
      userId: principal.actorId ?? '',
      ...(options.unreadOnly === true ? { readAt: null } : {}),
    };

    const rows = await this.db.client.notification.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: options.limit + 1,
      ...(options.cursor ? { cursor: { id: options.cursor }, skip: 1 } : {}),
    });

    const page = rows.slice(0, options.limit);
    const hasMore = rows.length > options.limit;
    const unread = await this.db.client.notification.count({
      where: { userId: principal.actorId ?? '', readAt: null },
    });

    return {
      items: page.map((row) => ({
        id: row.id,
        type: row.type,
        title: row.title,
        body: row.body,
        link: row.link,
        data: row.data,
        readAt: row.readAt,
        createdAt: row.createdAt,
      })),
      pagination: {
        limit: options.limit,
        nextCursor: hasMore ? (page[page.length - 1]?.id ?? null) : null,
        hasMore,
        total: unread,
      },
      unreadCount: unread,
    };
  }

  async markRead(notificationId: string) {
    const principal = tenantContext.require('notifications.markRead');
    // Scoped to the caller's own notifications: an id alone must not let someone dismiss another
    // person's notification, even inside the same organization.
    const updated = await this.db.client.notification.updateMany({
      where: { id: notificationId, userId: principal.actorId ?? '', readAt: null },
      data: { readAt: new Date() },
    });
    if (updated.count === 0) throw AppError.notFound('Notification');
    return { read: true };
  }

  async markAllRead() {
    const principal = tenantContext.require('notifications.markAllRead');
    const updated = await this.db.client.notification.updateMany({
      where: { userId: principal.actorId ?? '', readAt: null },
      data: { readAt: new Date() },
    });
    return { read: updated.count };
  }

  async unreadCount(): Promise<number> {
    const principal = tenantContext.require('notifications.unreadCount');
    return this.db.client.notification.count({
      where: { userId: principal.actorId ?? '', readAt: null },
    });
  }

  /**
   * Creates a notification. Called by job processors, which run under a system principal, so the
   * recipient is passed explicitly rather than taken from the context.
   */
  async create(input: CreateNotificationInput): Promise<string | null> {
    return withPlatformScope('notifications: create for recipient', async () => {
      // Only a member of the organization can receive its notifications — and the composite
      // foreign key enforces that too, so this check is about a clear outcome, not safety.
      const membership = await this.db.client.membership.findUnique({
        where: {
          organizationId_userId: { organizationId: input.organizationId, userId: input.userId },
        },
      });
      if (!membership || membership.deletedAt !== null || membership.status !== 'active')
        return null;

      if (input.dedupeKey) {
        const existing = await this.db.client.notification.findFirst({
          where: {
            organizationId: input.organizationId,
            userId: input.userId,
            type: input.type,
            data: { path: ['dedupeKey'], equals: input.dedupeKey },
          },
        });
        if (existing) return existing.id;
      }

      const id = newId();
      await this.db.client.notification.create({
        data: {
          id,
          organizationId: input.organizationId,
          userId: input.userId,
          type: input.type,
          title: input.title,
          body: input.body ?? null,
          link: input.link ?? null,
          data: {
            ...(input.data ?? {}),
            ...(input.dedupeKey ? { dedupeKey: input.dedupeKey } : {}),
          } as never,
        },
      });
      return id;
    });
  }

  /** Everyone in the organization holding a given permission — "notify the managers". */
  async recipientsWithPermission(organizationId: string, permissionKey: string): Promise<string[]> {
    return withPlatformScope('notifications: resolve recipients by permission', async () => {
      const grants = await this.db.client.rolePermission.findMany({
        where: { organizationId, permissionKey },
        select: { roleId: true },
      });
      if (grants.length === 0) return [];

      const holders = await this.db.client.userRole.findMany({
        where: { organizationId, roleId: { in: grants.map((grant) => grant.roleId) } },
        select: { userId: true },
      });
      return [...new Set(holders.map((holder) => holder.userId))];
    });
  }
}
