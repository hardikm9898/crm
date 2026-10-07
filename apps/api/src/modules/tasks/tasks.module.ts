import { Module } from '@nestjs/common';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { TaskConfigController, TasksController } from './tasks.controller.js';
import { TasksService } from './tasks.service.js';
import { TaskConfigService } from './task-config.service.js';
import { NextActionService } from './next-action.service.js';
import {
  TaskOverdueNotificationProcessor,
  TaskOverdueSweepProcessor,
  TaskReminderDispatchProcessor,
} from './tasks.processor.js';

/**
 * Tasks, follow-ups and the vocabulary they use (`FR-TSK-1..7`).
 *
 * Imports `NotificationsModule` because a reminder *is* a notification — the dispatch sweep creates
 * them directly rather than through a second queue hop, which is what lets the "create then mark
 * sent" ordering be the thing that makes a retry safe.
 *
 * Reads leads, customers and deals directly rather than through their modules: a task needs a
 * subject's branch, team and owner to inherit ownership, and importing three modules to read three
 * columns each would couple follow-ups to the whole CRM surface. The same reasoning payments used.
 */
@Module({
  imports: [NotificationsModule],
  controllers: [TasksController, TaskConfigController],
  providers: [
    TasksService,
    TaskConfigService,
    NextActionService,
    TaskOverdueSweepProcessor,
    TaskReminderDispatchProcessor,
    TaskOverdueNotificationProcessor,
  ],
  exports: [
    TasksService,
    TaskConfigService,
    TaskOverdueSweepProcessor,
    TaskReminderDispatchProcessor,
    TaskOverdueNotificationProcessor,
  ],
})
export class TasksModule {}
