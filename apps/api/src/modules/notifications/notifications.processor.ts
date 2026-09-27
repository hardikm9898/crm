import { Inject, Injectable } from '@nestjs/common';
import { PERMISSIONS, withPlatformScope } from '@leados/shared';
import type { Job } from 'bullmq';
import type { Logger } from 'pino';
import { DbService } from '../../infra/db/db.service.js';
import { LOGGER } from '../../infra/observability/logger.module.js';
import { JOBS, QUEUES } from '../../infra/queue/queue.constants.js';
import type { JobProcessor } from '../../infra/queue/job-processor.js';
import type { JobPayload } from '../../infra/queue/queue.service.js';
import { NotificationsService } from './notifications.service.js';

/**
 * Turns domain events into in-app notifications.
 *
 * The recipient is resolved by **permission**, not by role name: "tell whoever can manage users"
 * survives a tenant renaming or restructuring their roles (FR-IAM-3). Idempotent via a dedupe key
 * derived from the event id, so an at-least-once redelivery produces one notification.
 */
interface EventJobPayload extends JobPayload {
  readonly eventId?: string;
  readonly aggregateId?: string;
  readonly payload?: Record<string, unknown>;
}

@Injectable()
export class MemberJoinedNotificationProcessor implements JobProcessor<EventJobPayload> {
  readonly queue = QUEUES.NOTIFICATIONS;
  readonly jobName = JOBS.NOTIFY_MEMBER_JOINED;

  constructor(
    private readonly db: DbService,
    private readonly notifications: NotificationsService,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  async process(payload: EventJobPayload, _job: Job): Promise<void> {
    const organizationId = payload.organizationId;
    const joinedUserId = payload.aggregateId ?? (payload.payload?.['userId'] as string | undefined);
    if (!organizationId || !joinedUserId) {
      this.logger.error({ payload }, 'member-joined notification has no organization or user');
      return;
    }

    const joined = await withPlatformScope('notify: load joined member', async () =>
      this.db.client.user.findUnique({
        where: { id: joinedUserId },
        select: { name: true, email: true },
      }),
    );
    if (!joined) return;

    const recipients = await this.notifications.recipientsWithPermission(
      organizationId,
      PERMISSIONS.USER_MANAGE,
    );

    for (const userId of recipients) {
      if (userId === joinedUserId) continue; // no point telling them they joined
      await this.notifications.create({
        organizationId,
        userId,
        type: 'member.joined',
        title: `${joined.name} joined the workspace`,
        body: joined.email,
        link: '/settings/members',
        dedupeKey: payload.eventId ?? `member-joined:${joinedUserId}`,
        data: { userId: joinedUserId },
      });
    }
  }
}

/**
 * Tells the people who can do something about it that the trial has ended. Billing permission
 * rather than ownership: whoever the organization made responsible for paying.
 */
@Injectable()
export class TrialExpiredNotificationProcessor implements JobProcessor<EventJobPayload> {
  readonly queue = QUEUES.NOTIFICATIONS;
  readonly jobName = JOBS.NOTIFY_TRIAL_EXPIRED;

  constructor(
    private readonly notifications: NotificationsService,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  async process(payload: EventJobPayload, _job: Job): Promise<void> {
    const organizationId = payload.organizationId;
    if (!organizationId) {
      this.logger.error({ payload }, 'trial-expired notification has no organization');
      return;
    }

    const recipients = await this.notifications.recipientsWithPermission(
      organizationId,
      PERMISSIONS.BILLING_MANAGE,
    );

    for (const userId of recipients) {
      await this.notifications.create({
        organizationId,
        userId,
        type: 'trial.expired',
        title: 'Your free trial has ended',
        body: 'Your data is safe and still here. Choose a plan to start working again.',
        link: '/settings/billing',
        dedupeKey: payload.eventId ?? `trial-expired:${organizationId}`,
      });
    }
  }
}
