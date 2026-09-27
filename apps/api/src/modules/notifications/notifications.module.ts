import { Module } from '@nestjs/common';
import { NotificationsController } from './notifications.controller.js';
import {
  MemberJoinedNotificationProcessor,
  TrialExpiredNotificationProcessor,
} from './notifications.processor.js';
import { NotificationsService } from './notifications.service.js';

@Module({
  controllers: [NotificationsController],
  providers: [
    NotificationsService,
    MemberJoinedNotificationProcessor,
    TrialExpiredNotificationProcessor,
  ],
  exports: [
    NotificationsService,
    MemberJoinedNotificationProcessor,
    TrialExpiredNotificationProcessor,
  ],
})
export class NotificationsModule {}
