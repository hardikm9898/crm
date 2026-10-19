import { Inject, Injectable } from '@nestjs/common';
import {
  PERMISSIONS,
  channelsFor,
  isOpenStatus,
  notificationType,
  withPlatformScope,
} from '@leados/shared';
import type { Job } from 'bullmq';
import type { Logger } from 'pino';
import { DbService } from '../../infra/db/db.service.js';
import { LOGGER } from '../../infra/observability/logger.module.js';
import { JOBS, QUEUES } from '../../infra/queue/queue.constants.js';
import type { JobProcessor } from '../../infra/queue/job-processor.js';
import type { JobPayload } from '../../infra/queue/queue.service.js';
import { APP_CONFIG } from '../../infra/config/config.module.js';
import type { AppConfig } from '../../infra/config/config.schema.js';
import { EmailSenderService } from '../../infra/mail/email-sender.service.js';
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

/**
 * Releases the notifications quiet hours held — and drops the ones that stopped mattering.
 *
 * **The hard half of quiet hours.** Holding a notification is arithmetic; the question holding it
 * creates is what to do at 07:00 with a warning written at 21:40 about a follow-up somebody
 * finished at 08:15. Delivering it is worse than not holding it at all: it reads as the product
 * being a day behind, and the one thing a notification must be is current.
 *
 * So every held notification is re-checked against its subject at the moment it is released, by
 * the kind of check its type declares (`NOTIFICATION_TYPES[].staleness`):
 *
 *  * `task_still_open` — a reminder or an overdue notice is dropped if the follow-up is finished,
 *    cancelled or gone.
 *  * `clock_still_running` — a near-breach warning is dropped if the promise has since been
 *    answered. The **breach** notice is `never`, because a missed promise is a fact about the past
 *    and the morning after is exactly when somebody should hear about it.
 *  * `call_still_open` — "what happened with Priya?" is dropped if the outcome has since been
 *    recorded, which is the common case: the nudge is written fifteen minutes after the call and
 *    most people log it within the hour.
 *  * `never` — released as written.
 *
 * A dropped one is marked `superseded_at`, not deleted: "was I ever told?" then has an answer, and
 * the answer is "no, it was held until 07:00 and by then you had already done it".
 *
 * Platform-wide, like the SLA sweep, through `notifications_awaiting_release`.
 */
@Injectable()
export class NotificationReleaseProcessor implements JobProcessor<JobPayload> {
  readonly queue = QUEUES.MAINTENANCE;
  readonly jobName = JOBS.NOTIFICATION_RELEASE;

  constructor(
    private readonly db: DbService,
    private readonly notifications: NotificationsService,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  async process(_payload: JobPayload, _job: Job): Promise<void> {
    const { released, superseded } = await this.release();
    if (released > 0 || superseded > 0) {
      this.logger.debug({ released, superseded }, 'notifications released from quiet hours');
    }
  }

  /** Exposed so a test can run exactly what the cron runs. */
  async release(limit = 500): Promise<{ released: number; superseded: number }> {
    const now = new Date();
    const due = await withPlatformScope('notifications: release held', async () =>
      this.db.client.notification.findMany({
        where: { deferredUntil: { lte: now }, supersededAt: null },
        orderBy: { deferredUntil: 'asc' },
        take: limit,
        select: { id: true, organizationId: true, userId: true, type: true, data: true },
      }),
    );

    let released = 0;
    let superseded = 0;
    for (const row of due) {
      const stale = await this.isStale(row.type, row.data);
      await withPlatformScope('notifications: settle held notification', async () => {
        if (stale) {
          await this.db.client.notification.update({
            where: { id: row.id },
            data: { supersededAt: now, deferredUntil: null },
          });
        } else {
          await this.db.client.notification.update({
            where: { id: row.id },
            data: { deferredUntil: null },
          });
        }
      });
      if (stale) superseded += 1;
      else {
        released += 1;
        // The email goes out **here**, not when the notification was written: a held row is one the
        // inbox is deliberately hiding, and an email about it at 21:40 would break the only promise
        // quiet hours make. The ones that turned out not to matter are superseded above and get
        // nothing, which is the whole point of re-checking them.
        if (await this.wantsEmail(row.organizationId, row.userId, row.type)) {
          await this.notifications.queueEmail(row.id);
        }
      }
    }
    return { released, superseded };
  }

  /**
   * Whether this person asked for this type by email.
   *
   * Read at **release**, not at write: somebody who switched email off while a notification sat in
   * their quiet window has switched it off, and honouring the older answer would be the product
   * arguing with a setting it can see.
   */
  private async wantsEmail(organizationId: string, userId: string, type: string): Promise<boolean> {
    const preference = await withPlatformScope('notify release: read channel choice', async () =>
      this.db.client.notificationPreference.findUnique({
        where: { organizationId_userId_type: { organizationId, userId, type } },
        select: { channels: true },
      }),
    );
    const chosen = Array.isArray(preference?.channels)
      ? preference.channels.filter((entry): entry is string => typeof entry === 'string')
      : undefined;
    return channelsFor(type, chosen).includes('email');
  }

  /**
   * Whether the thing this notification is about has stopped needing attention.
   *
   * A type with no registry entry is **never** stale: a producer added without one should deliver
   * and be noticed, not disappear. The same default the timeline registry takes, for the same
   * reason — silence is the one failure nobody debugs.
   */
  private async isStale(type: string, data: unknown): Promise<boolean> {
    const spec = notificationType(type);
    if (!spec || spec.staleness === 'never') return false;
    const payload = (data ?? {}) as Record<string, unknown>;

    if (spec.staleness === 'task_still_open') {
      const taskId = typeof payload['taskId'] === 'string' ? payload['taskId'] : null;
      if (!taskId) return false;
      const task = await withPlatformScope('notifications: re-check task', async () =>
        this.db.client.task.findFirst({
          where: { id: taskId },
          select: { status: true, deletedAt: true },
        }),
      );
      if (!task) return true;
      return task.deletedAt !== null || !isOpenStatus(task.status);
    }

    if (spec.staleness === 'call_still_open') {
      const callId = typeof payload['callId'] === 'string' ? payload['callId'] : null;
      if (!callId) return false;
      const call = await withPlatformScope('notifications: re-check call', async () =>
        this.db.client.call.findFirst({
          where: { id: callId },
          select: { status: true, deletedAt: true },
        }),
      );
      // A call whose outcome was recorded while the nudge was held has nothing left to ask, and a
      // question about a call that no longer exists is worse than silence.
      if (!call) return true;
      return call.deletedAt !== null || call.status !== 'dialing';
    }

    if (spec.staleness === 'connection_still_broken') {
      const connectionId =
        typeof payload['connectionId'] === 'string' ? payload['connectionId'] : null;
      if (!connectionId) return false;
      const connection = await withPlatformScope(
        'notifications: re-check integration connection',
        async () =>
          this.db.client.integrationConnection.findFirst({
            where: { id: connectionId },
            select: { status: true, disconnectedAt: true },
          }),
      );
      // A connection somebody reconnected while the notice was held has nothing left to ask for.
      // One that was disconnected outright is also nothing to act on: the person did the other
      // thing the message offered.
      if (!connection) return true;
      return connection.disconnectedAt !== null || connection.status === 'connected';
    }

    const clockId = typeof payload['clockId'] === 'string' ? payload['clockId'] : null;
    if (!clockId) return false;
    const clock = await withPlatformScope('notifications: re-check clock', async () =>
      this.db.client.slaClock.findFirst({ where: { id: clockId }, select: { state: true } }),
    );
    if (!clock) return true;
    return clock.state !== 'running';
  }
}

interface NotificationEmailPayload extends JobPayload {
  readonly notificationId?: string;
}

/**
 * Emails one notification to the person it belongs to (`FR-NOT-2`).
 *
 * The notification row is the record; this is a **delivery** of it. So the subject is the
 * notification's own title, the body is its own sentence, and the link is the one the inbox would
 * have taken them to — a second vocabulary for the same event is how an email and an app end up
 * telling somebody different things.
 *
 * Three things it refuses to do:
 *
 *  * **It does not re-decide the channel.** `NotificationsService.create` already read the
 *    preference and chose; reading it again here could disagree with the first read, and the person
 *    would get an email for a notification the inbox decided not to write.
 *  * **It does not email a notification that is held or superseded.** A row the inbox is hiding is
 *    one nothing should have arrived about — the whole promise of quiet hours — and the release
 *    sweep enqueues the ones it lets through.
 *  * **It does not fail a job for a suppressed address.** `EmailSenderService` answers
 *    `suppressed`, with a row saying which suppression stopped it, and that is a finished outcome
 *    rather than something to retry for ever.
 */
@Injectable()
export class NotificationEmailProcessor implements JobProcessor<NotificationEmailPayload> {
  readonly queue = QUEUES.NOTIFICATIONS;
  readonly jobName = JOBS.NOTIFY_EMAIL;

  constructor(
    private readonly db: DbService,
    private readonly email: EmailSenderService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  async process(payload: NotificationEmailPayload, _job: Job): Promise<void> {
    const notificationId = payload.notificationId;
    if (!notificationId) {
      this.logger.error({ payload }, 'notification email job has no notification id');
      return;
    }

    const row = await withPlatformScope('notify email: load notification', async () =>
      this.db.client.notification.findFirst({
        where: { id: notificationId },
        select: {
          id: true,
          type: true,
          title: true,
          body: true,
          link: true,
          deferredUntil: true,
          supersededAt: true,
          userId: true,
          // Through `Membership`, because that is how a person is referenced on a tenant table
          // (rule 2) — and it is also the check that matters: somebody removed from the workspace
          // should stop getting its email.
          membership: {
            select: {
              status: true,
              deletedAt: true,
              user: { select: { email: true, deletedAt: true } },
            },
          },
        },
      }),
    );
    if (!row) {
      this.logger.warn({ notificationId }, 'notification vanished before its email was sent');
      return;
    }
    // Held or dropped: the inbox is hiding it, so nothing should arrive about it.
    if (row.deferredUntil !== null || row.supersededAt !== null) return;
    const person = row.membership;
    if (!person || person.deletedAt !== null || person.status !== 'active') return;
    if (person.user.deletedAt !== null) return;

    const link = row.link ? `${this.config.WEB_ORIGIN}${row.link}` : this.config.WEB_ORIGIN;
    const outcome = await this.email.send({
      to: person.user.email,
      kind: 'notification',
      subject: row.title,
      text:
        `${row.body ? `${row.body}\n\n` : ''}${link}\n\n` +
        `You are getting this because email is switched on for “${describeNotificationType(row.type)}”. ` +
        `Change that at ${this.config.WEB_ORIGIN}/notifications.`,
    });
    if (outcome.status !== 'sent') {
      this.logger.info(
        { notificationId, status: outcome.status, reason: outcome.reason },
        'notification email not sent',
      );
    }
  }
}

/** The label from the shared registry, so the footer names the switch somebody would go and find. */
function describeNotificationType(type: string): string {
  return notificationType(type)?.label ?? type;
}
