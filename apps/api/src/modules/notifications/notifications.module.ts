import { Module } from '@nestjs/common';
import { NotificationsController } from './notifications.controller.js';
import {
  MemberJoinedNotificationProcessor,
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
    MemberJoinedNotificationProcessor,
    TrialExpiredNotificationProcessor,
    UnassignedLeadNotificationProcessor,
  ],
  exports: [
    NotificationsService,
    NotificationReleaseProcessor,
    MemberJoinedNotificationProcessor,
    TrialExpiredNotificationProcessor,
    UnassignedLeadNotificationProcessor,
  ],
})
export class NotificationsModule {}
