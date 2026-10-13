import { Injectable } from '@nestjs/common';
import {
  AppError,
  channelsFor,
  newId,
  notificationType,
  quietHoursHold,
  tenantContext,
  withPlatformScope,
} from '@leados/shared';
import { DbService } from '../../infra/db/db.service.js';

/**
 * In-app notifications (FR-NOT-1/2/3).
 *
 * Deliberately not a generic "message bus for humans": a notification is a row belonging to one
 * user in one organization, with a type the UI renders through a registry and a link to the thing
 * it is about. Email and WhatsApp delivery of the same event are separate channels chosen by
 * preference, not different notification records.
 *
 * **Preferences and quiet hours are enforced in `create`, not in the producers.** There are five
 * producers today and every one of them calls this method; a gate in each would be five places to
 * forget it, and the sixth producer somebody adds next month would ship without one. The cost is
 * that `create` can answer "no" — which it already could, for somebody who is not a member — and
 * callers must treat `null` as a normal outcome.
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

/**
 * What counts as delivered, in one place.
 *
 * A notification being held through somebody's quiet hours exists as a row and is **not** in their
 * inbox, and neither is one that was held and turned out to be about something already dealt with.
 * Both the list and the unread *count* use this, because a badge that counts rows the list hides is
 * the way a screen stops being believed.
 *
 * Visibility is the sweep's write, not the passage of time (`deferred_until <= now()` would make
 * the row visible before anything had checked whether it still mattered). The cost is named in the
 * README: with no worker running, held notifications are not released — the same failure as
 * reminders not firing, which is the shape this product already has.
 */
const DELIVERED = { deferredUntil: null, supersededAt: null } as const;

/** What the gate decided about one notification, before it is written. */
interface Decision {
  readonly deliver: boolean;
  readonly holdUntil: Date | null;
}

@Injectable()
export class NotificationsService {
  constructor(private readonly db: DbService) {}

  async list(options: { limit: number; cursor?: string; unreadOnly?: boolean }) {
    const principal = tenantContext.require('notifications.list');
    const where = {
      userId: principal.actorId ?? '',
      ...DELIVERED,
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
      where: { userId: principal.actorId ?? '', readAt: null, ...DELIVERED },
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
      // `DELIVERED` here too: a notification still being held is not one the caller can have read,
      // and letting an id mark it read would let somebody clear a warning before it ever arrived.
      where: { id: notificationId, userId: principal.actorId ?? '', readAt: null, ...DELIVERED },
      data: { readAt: new Date() },
    });
    if (updated.count === 0) throw AppError.notFound('Notification');
    return { read: true };
  }

  async markAllRead() {
    const principal = tenantContext.require('notifications.markAllRead');
    const updated = await this.db.client.notification.updateMany({
      where: { userId: principal.actorId ?? '', readAt: null, ...DELIVERED },
      data: { readAt: new Date() },
    });
    return { read: updated.count };
  }

  async unreadCount(): Promise<number> {
    const principal = tenantContext.require('notifications.unreadCount');
    return this.db.client.notification.count({
      where: { userId: principal.actorId ?? '', readAt: null, ...DELIVERED },
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

      /**
       * The gate (`FR-NOT-3`). Three outcomes: send, hold, or do not write at all.
       *
       * Before the dedupe check on purpose — a type somebody has switched off should not leave a
       * row behind that a later re-delivery then finds and calls "already sent".
       */
      const decision = await this.decide(input.organizationId, input.userId, input.type);
      if (!decision.deliver) return null;

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
          deferredUntil: decision.holdUntil,
          data: {
            ...(input.data ?? {}),
            ...(input.dedupeKey ? { dedupeKey: input.dedupeKey } : {}),
            // The hold is recorded in the payload as well as in the column, because the column is
            // cleared on release and the screen still wants to say "held until 07:00". One
            // nullable column and a JSON key, rather than a third column nothing else reads.
            ...(decision.holdUntil ? { heldUntil: decision.holdUntil.toISOString() } : {}),
          } as never,
        },
      });
      return id;
    });
  }

  /**
   * Whether to write this notification, and whether to hold it.
   *
   * Two reads, in parallel: the person's per-type channel choice and their own settings row.
   * Absence of either is the common case and means "the default", so a new notification type
   * reaches everybody without a row being backfilled per person.
   *
   * The workspace's timezone is read **only** when somebody has a quiet window and has not said
   * which zone it is in — the third query is rare, and it is the one that makes "21:00" mean 21:00
   * where the person actually is.
   */
  private async decide(organizationId: string, userId: string, type: string): Promise<Decision> {
    const [preference, settings] = await Promise.all([
      this.db.client.notificationPreference.findUnique({
        where: { organizationId_userId_type: { organizationId, userId, type } },
        select: { channels: true },
      }),
      this.db.client.notificationSetting.findUnique({
        where: { notification_setting_person_key: { organizationId, userId } },
        select: { quietStartMinute: true, quietEndMinute: true, timeZone: true },
      }),
    ]);

    const chosen = Array.isArray(preference?.channels)
      ? preference.channels.filter((entry): entry is string => typeof entry === 'string')
      : undefined;
    if (channelsFor(type, chosen).length === 0) return { deliver: false, holdUntil: null };

    const spec = notificationType(type);
    if (
      spec?.respectsQuietHours === false ||
      settings?.quietStartMinute === null ||
      settings?.quietStartMinute === undefined ||
      settings.quietEndMinute === null
    ) {
      return { deliver: true, holdUntil: null };
    }

    const timeZone = settings.timeZone ?? (await this.workspaceTimeZone(organizationId));
    const holdUntil = quietHoursHold(new Date(), {
      startMinute: settings.quietStartMinute,
      endMinute: settings.quietEndMinute,
      timeZone,
    });
    return { deliver: true, holdUntil };
  }

  private async workspaceTimeZone(organizationId: string): Promise<string> {
    const organization = await this.db.client.organization.findUnique({
      where: { id: organizationId },
      select: { timezone: true },
    });
    return organization?.timezone ?? 'Asia/Kolkata';
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
