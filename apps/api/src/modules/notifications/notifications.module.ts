import { Module } from '@nestjs/common';
import { NotificationsController } from './notifications.controller.js';
import {
  MemberJoinedNotificationProcessor,
  TrialExpiredNotificationProcessor,
  UnassignedLeadNotificationProcessor,
} from './notifications.processor.js';
import { NotificationsService } from './notifications.service.js';

@Module({
  controllers: [NotificationsController],
  providers: [
    NotificationsService,
    MemberJoinedNotificationProcessor,
    TrialExpiredNotificationProcessor,
    UnassignedLeadNotificationProcessor,
  ],
  exports: [
    NotificationsService,
    MemberJoinedNotificationProcessor,
    TrialExpiredNotificationProcessor,
    UnassignedLeadNotificationProcessor,
  ],
})
export class NotificationsModule {}
