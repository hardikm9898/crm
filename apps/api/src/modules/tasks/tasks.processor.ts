import { Inject, Injectable } from '@nestjs/common';
import { PERMISSIONS, withPlatformScope } from '@leados/shared';
import type { Job } from 'bullmq';
import type { Logger } from 'pino';
import { DbService } from '../../infra/db/db.service.js';
import { LOGGER } from '../../infra/observability/logger.module.js';
import { JOBS, QUEUES } from '../../infra/queue/queue.constants.js';
import type { JobProcessor } from '../../infra/queue/job-processor.js';
import type { JobPayload } from '../../infra/queue/queue.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { TasksService } from './tasks.service.js';

/**
 * Reports tasks whose time has passed (`task.overdue-sweep`).
 *
 * Thin, like every other processor here: the sweep is a method on the domain service, which is what
 * makes it callable from a test over real HTTP rather than only from a cron tick.
 */
@Injectable()
export class TaskOverdueSweepProcessor implements JobProcessor {
  readonly queue = QUEUES.MAINTENANCE;
  readonly jobName = JOBS.TASK_OVERDUE_SWEEP;

  constructor(
    private readonly tasks: TasksService,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  async process(_payload: JobPayload, _job: Job): Promise<void> {
    const result = await this.tasks.sweepOverdue();
    if (result.reported > 0) this.logger.info(result, 'task overdue sweep complete');
  }
}

/** Sends the reminders whose moment has come (`task.reminder-dispatch`). */
@Injectable()
export class TaskReminderDispatchProcessor implements JobProcessor {
  readonly queue = QUEUES.MAINTENANCE;
  readonly jobName = JOBS.TASK_REMINDER_DISPATCH;

  constructor(
    private readonly tasks: TasksService,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  async process(_payload: JobPayload, _job: Job): Promise<void> {
    const result = await this.tasks.dispatchDueReminders();
    if (result.sent > 0) this.logger.info(result, 'task reminders dispatched');
  }
}

interface EventJobPayload extends JobPayload {
  readonly eventId?: string;
  readonly aggregateId?: string;
  readonly payload?: Record<string, unknown>;
}

/**
 * Tells the assignee, and whoever manages them, that a follow-up was missed (`FR-TSK-8`'s
 * escalation is a later step; this is the plain notification the contract asks for).
 *
 * Driven by the `task.overdue` event rather than by the sweep directly, so the "tell somebody"
 * half is retried independently of the "mark it reported" half — and so a second consumer (an
 * escalation policy, a WhatsApp nudge) is a line in `EVENT_SUBSCRIPTIONS` rather than a change to
 * the sweep.
 *
 * The manager is resolved by **permission**, not by role name: whoever the workspace made
 * responsible for other people's tasks (`task:manage_others`), whatever they call that role.
 */
@Injectable()
export class TaskOverdueNotificationProcessor implements JobProcessor<EventJobPayload> {
  readonly queue = QUEUES.NOTIFICATIONS;
  readonly jobName = JOBS.NOTIFY_TASK_OVERDUE;

  constructor(
    private readonly db: DbService,
    private readonly notifications: NotificationsService,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  async process(payload: EventJobPayload, _job: Job): Promise<void> {
    const organizationId = payload.organizationId;
    const taskId = payload.aggregateId;
    if (!organizationId || !taskId) {
      this.logger.error({ payload }, 'task-overdue notification has no organization or task');
      return;
    }

    const body = payload.payload ?? {};
    const title = typeof body['title'] === 'string' ? body['title'] : 'A follow-up';
    const assignedUserId =
      typeof body['assignedUserId'] === 'string' ? body['assignedUserId'] : null;
    const leadId = typeof body['leadId'] === 'string' ? body['leadId'] : null;

    const about = leadId
      ? await withPlatformScope('notify: load overdue task lead', async () =>
          this.db.client.lead.findFirst({ where: { id: leadId }, select: { fullName: true } }),
        )
      : null;
    const subject = about?.fullName ? ` — ${about.fullName}` : '';
    const link = leadId ? `/leads/${leadId}` : `/tasks?taskId=${taskId}`;

    const recipients = new Set<string>();
    if (assignedUserId) recipients.add(assignedUserId);
    for (const userId of await this.notifications.recipientsWithPermission(
      organizationId,
      PERMISSIONS.TASK_MANAGE_OTHERS,
    )) {
      recipients.add(userId);
    }

    for (const userId of recipients) {
      await this.notifications.create({
        organizationId,
        userId,
        type: 'task.overdue',
        title: `Overdue: ${title}${subject}`,
        body:
          userId === assignedUserId
            ? 'This was due and has not been done yet.'
            : 'A follow-up on your team has gone past its time.',
        link,
        // The event id, so a redelivery produces one notification rather than a second copy.
        dedupeKey: payload.eventId ?? `task-overdue:${taskId}`,
        data: { taskId, leadId },
      });
    }
  }
}
