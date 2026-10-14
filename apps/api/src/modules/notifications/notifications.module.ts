import { Module } from '@nestjs/common';
import { NotificationsController } from './notifications.controller.js';
import {
  MemberJoinedNotificationProcessor,
  NotificationEmailProcessor,
  NotificationReleaseProcessor,
  TrialExpiredNotificationProcessor,
  UnassignedLeadNotificationProcessor,
} from './notifications.processor.js';
import { NotificationsService } from './notifications.service.js';
import { NotificationPreferencesService } from './notification-preferences.service.js';

@Module({
  controllers: [NotificationsController],
  providers: [
    NotificationsService,
    NotificationPreferencesService,
    NotificationReleaseProcessor,
    NotificationEmailProcessor,
    MemberJoinedNotificationProcessor,
    TrialExpiredNotificationProcessor,
    UnassignedLeadNotificationProcessor,
  ],
  exports: [
    NotificationsService,
    NotificationReleaseProcessor,
    NotificationEmailProcessor,
    MemberJoinedNotificationProcessor,
    TrialExpiredNotificationProcessor,
    UnassignedLeadNotificationProcessor,
  ],
})
export class NotificationsModule {}
