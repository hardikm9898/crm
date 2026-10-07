import { Inject, Injectable } from '@nestjs/common';
import { withPlatformScope } from '@leados/shared';
import type { Job } from 'bullmq';
import type { Logger } from 'pino';
import { DbService } from '../../infra/db/db.service.js';
import { LOGGER } from '../../infra/observability/logger.module.js';
import { JOBS, QUEUES } from '../../infra/queue/queue.constants.js';
import type { JobProcessor } from '../../infra/queue/job-processor.js';
import type { JobPayload } from '../../infra/queue/queue.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { SlaService } from './sla.service.js';

/**
 * The five-minute sweep (`sla.sweep`).
 *
 * Thin, like every other processor here: the sweep is a method on the domain service, which is what
 * makes it callable from a test over real HTTP rather than only from a cron tick.
 */
@Injectable()
export class SlaSweepProcessor implements JobProcessor {
  readonly queue = QUEUES.MAINTENANCE;
  readonly jobName = JOBS.SLA_SWEEP;

  constructor(
    private readonly sla: SlaService,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  async process(_payload: JobPayload, _job: Job): Promise<void> {
    const result = await this.sla.sweep();
    if (result.warned > 0 || result.breached > 0) {
      this.logger.info(result, 'sla sweep complete');
    }
  }
}

interface EventJobPayload extends JobPayload {
  readonly eventId?: string;
  /** The dispatcher puts the event's own name on the envelope, which is how one processor serves two. */
  readonly eventName?: string;
  readonly aggregateId?: string;
  readonly payload?: Record<string, unknown>;
}

/**
 * Tells the people the escalation named.
 *
 * Driven by the `sla.at_risk` / `sla.breached` events rather than by the sweep directly, so
 * "write the escalation" and "tell somebody" retry independently — and so a second consumer (a
 * WhatsApp nudge to the manager, a daily digest) is a line in `EVENT_SUBSCRIPTIONS` rather than a
 * change to the sweep.
 *
 * The recipients were resolved and **stored** by the sweep, not re-resolved here. That matters: an
 * escalation records who was told, and recomputing the list at delivery time would mean the row and
 * the notifications could disagree the moment somebody's role changed in between.
 */
@Injectable()
export class SlaEscalationNotificationProcessor implements JobProcessor<EventJobPayload> {
  readonly queue = QUEUES.NOTIFICATIONS;
  readonly jobName = JOBS.NOTIFY_SLA_ESCALATION;

  constructor(
    private readonly db: DbService,
    private readonly notifications: NotificationsService,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  async process(payload: EventJobPayload, _job: Job): Promise<void> {
    const organizationId = payload.organizationId;
    const clockId = payload.aggregateId;
    if (!organizationId || !clockId) {
      this.logger.error({ payload }, 'sla escalation notification has no organization or clock');
      return;
    }

    const body = payload.payload ?? {};
    // One processor for both events, dispatching on the envelope's name — the same reason the
    // scoring processor reads its trigger from the envelope rather than from the payload body.
    const breached = payload.eventName === 'sla.breached';
    const leadId = typeof body['leadId'] === 'string' ? body['leadId'] : null;
    const policyName = typeof body['policyName'] === 'string' ? body['policyName'] : 'An SLA';
    const target = typeof body['target'] === 'string' ? body['target'] : 'response';
    const recipients = Array.isArray(body['notifiedUserIds'])
      ? body['notifiedUserIds'].filter((id): id is string => typeof id === 'string')
      : [];

    const lead = leadId
      ? await withPlatformScope('notify: load escalated lead', async () =>
          this.db.client.lead.findFirst({
            where: { id: leadId },
            select: { fullName: true, phoneE164: true },
          }),
        )
      : null;
    const who = lead?.fullName ?? 'A lead';

    for (const userId of recipients) {
      await this.notifications.create({
        organizationId,
        userId,
        type: breached ? 'sla.breached' : 'sla.at_risk',
        title: breached ? `SLA missed: ${who}` : `SLA running out: ${who}`,
        body: breached
          ? `${policyName} — ${describeTarget(target)} is past its deadline.`
          : `${policyName} — ${describeTarget(target)} is nearly out of time.`,
        link: leadId ? `/leads/${leadId}` : '/sla',
        // The event id, so an at-least-once redelivery produces one notification.
        dedupeKey: payload.eventId ?? `${breached ? 'breach' : 'risk'}:${clockId}`,
        data: { clockId, leadId, target },
      });
    }
  }
}

function describeTarget(target: string): string {
  switch (target) {
    case 'first_response':
      return 'the first response';
    case 'next_response':
      return 'the next reply';
    case 'resolution':
      return 'closing this out';
    default:
      return 'the response';
  }
}
