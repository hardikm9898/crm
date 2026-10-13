import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { NoPermissionRequired } from '../../infra/authz/permission.decorator.js';
import { ZodBody } from '../../infra/http/zod-validation.pipe.js';
import { withMessage } from '../../infra/http/envelope.interceptor.js';
import { AllowWhenRestricted } from '../../infra/entitlements/subscription.guard.js';
import { NotificationsService } from './notifications.service.js';
import { NotificationPreferencesService } from './notification-preferences.service.js';
import {
  updateNotificationPreferencesSchema,
  type UpdateNotificationPreferencesInput,
} from './notifications.dto.js';

const listSchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(50).default(20),
    cursor: z.string().max(200).optional(),
    unreadOnly: z
      .enum(['true', 'false'])
      .optional()
      .transform((value) => value === 'true'),
  })
  .strict();

/**
 * A person's own notifications. No permission is required because the only thing reachable is
 * their own — the service scopes every query to the caller.
 */
@Controller('notifications')
export class NotificationsController {
  constructor(
    private readonly notifications: NotificationsService,
    private readonly preferences: NotificationPreferencesService,
  ) {}

  @Get()
  @NoPermissionRequired('own notifications')
  async list(@Query(new ZodBody(listSchema)) query: z.infer<typeof listSchema>) {
    return this.notifications.list(query);
  }

  /**
   * The person's own settings (`FR-NOT-3`).
   *
   * Above `:id/read` in the file and in the route table for a reason that is not cosmetic: a
   * literal segment and a `:id` parameter on the same path compete, and `UuidParamPipe` answers
   * 404 for a non-UUID `:id` — so a `preferences` route declared after the parameter would be
   * reachable only as "not found".
   */
  @Get('preferences')
  @NoPermissionRequired('own notification preferences')
  async readPreferences() {
    return this.preferences.read();
  }

  /**
   * `PATCH`, not `PUT`: an absent key means "unchanged", so a tab open on the quiet-hours half
   * cannot overwrite a type somebody switched off on their phone five minutes ago.
   */
  @Patch('preferences')
  @NoPermissionRequired('own notification preferences')
  @AllowWhenRestricted()
  async updatePreferences(
    @Body(new ZodBody(updateNotificationPreferencesSchema))
    body: UpdateNotificationPreferencesInput,
  ) {
    return withMessage(await this.preferences.update(body), 'Notification settings saved');
  }

  @Get('unread-count')
  @NoPermissionRequired('own notifications')
  async unreadCount() {
    return { unreadCount: await this.notifications.unreadCount() };
  }

  /**
   * Marking a notification read stays available in restricted mode: it is housekeeping on the
   * caller's own inbox, and a read-only tenant should still be able to clear a badge.
   */
  @Post(':id/read')
  @HttpCode(200)
  @NoPermissionRequired('own notifications')
  @AllowWhenRestricted()
  async markRead(@Param('id') id: string) {
    return this.notifications.markRead(id);
  }

  @Post('read-all')
  @HttpCode(200)
  @NoPermissionRequired('own notifications')
  @AllowWhenRestricted()
  async markAllRead(@Body() _body: unknown) {
    return withMessage(await this.notifications.markAllRead(), 'All caught up');
  }
}
