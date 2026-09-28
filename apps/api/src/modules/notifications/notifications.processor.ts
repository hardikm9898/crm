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

/**
 * Tells managers a lead landed in the unassigned pool (`FR-ASG-4`).
 *
 * This is the notification that justifies the whole fallback machinery. A lead that arrives at 9pm,
 * matches a rule whose pool is all off shift, and goes nowhere is the single most expensive silent
 * failure this product can have — the business paid for the click and nobody ever calls. So the
 * engine emits its own event for it rather than letting it be inferred from an assignment with a
 * null, and this processor tells whoever holds `lead:assign` that there is a lead waiting.
 */
@Injectable()
export class UnassignedLeadNotificationProcessor implements JobProcessor<EventJobPayload> {
  readonly queue = QUEUES.NOTIFICATIONS;
  readonly jobName = JOBS.NOTIFY_LEAD_UNASSIGNED;

  constructor(
    private readonly notifications: NotificationsService,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  async process(payload: EventJobPayload, _job: Job): Promise<void> {
    const organizationId = payload.organizationId;
    const leadId = payload.aggregateId;
    if (!organizationId || !leadId) {
      this.logger.error({ payload }, 'unassigned-lead notification has no organization or lead');
      return;
    }

    const body = payload.payload ?? {};
    const fullName = typeof body['fullName'] === 'string' ? body['fullName'] : 'A lead';
    const explanation = typeof body['explanation'] === 'string' ? body['explanation'] : null;

    // `lead:assign` rather than a role name: whoever the organization made responsible for
    // distributing work, whatever they call that role (rule 4).
    const recipients = await this.notifications.recipientsWithPermission(
      organizationId,
      PERMISSIONS.LEAD_ASSIGN,
    );

    for (const userId of recipients) {
      await this.notifications.create({
        organizationId,
        userId,
        type: 'lead.unassigned_pool',
        title: `${fullName} is waiting for someone to pick up`,
        body: explanation ?? undefined,
        link: `/leads/${leadId}`,
        dedupeKey: payload.eventId ?? `lead-unassigned:${leadId}`,
        data: { leadId, ruleName: body['ruleName'] ?? null },
      });
    }
  }
}
