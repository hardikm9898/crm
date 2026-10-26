import { JOBS, QUEUES, type JobName, type QueueName } from '../queue/queue.constants.js';

/**
 * Which queues react to which domain events (docs/queue-event-architecture.md §8).
 *
 * This is the whole point of the outbox: adding a reaction to `lead.created` is a line here plus
 * a processor, with no change to the code that creates leads. A producer never knows who is
 * listening.
 *
 * An event with no subscribers is not an error — it is recorded, marked published and available
 * to whatever subscribes later.
 */
export interface EventSubscription {
  readonly queue: QueueName;
  readonly jobName: JobName;
}

/**
 * Every webhook-eligible event goes to one fan-out job (`FR-API-4`).
 *
 * Written once and spread, rather than repeated twenty-five times: the queue and job name are one
 * decision, and `event-subscriptions.spec.ts` asserts that **every** type in
 * `WEBHOOK_EVENT_TYPES` has it — a type offered on the settings screen with no subscription here
 * is an endpoint that looks subscribed and receives nothing.
 */
const WEBHOOK: EventSubscription = { queue: QUEUES.WEBHOOKS, jobName: JOBS.WEBHOOK_FANOUT };

/**
 * Every event a workflow can be triggered by goes to one dispatch job (`FR-AUT-6`).
 *
 * Written once and spread, like `WEBHOOK` above and for the same reason — and
 * `event-subscriptions.spec.ts` asserts that **every** `WORKFLOW_TRIGGERS[].event` carries it: a
 * trigger the editor offers whose event reaches no dispatcher is a workflow that publishes,
 * reports itself live, and never runs.
 */
const AUTOMATION: EventSubscription = {
  queue: QUEUES.AUTOMATION,
  jobName: JOBS.AUTOMATION_TRIGGER,
};

export const EVENT_SUBSCRIPTIONS: Readonly<Record<string, readonly EventSubscription[]>> = {
  'invitation.sent': [{ queue: QUEUES.NOTIFICATIONS, jobName: JOBS.MAIL_INVITATION }],
  'user.registered': [{ queue: QUEUES.NOTIFICATIONS, jobName: JOBS.MAIL_EMAIL_VERIFICATION }],
  'user.password_reset_requested': [
    { queue: QUEUES.NOTIFICATIONS, jobName: JOBS.MAIL_PASSWORD_RESET },
  ],
  'user.password_changed': [{ queue: QUEUES.NOTIFICATIONS, jobName: JOBS.MAIL_SECURITY_NOTICE }],
  // Recorded but not yet consumed. Listed explicitly so the set of known events is visible, and
  // so a typo in an event name shows up as "unsubscribed" rather than silently doing nothing.
  'invitation.accepted': [{ queue: QUEUES.NOTIFICATIONS, jobName: JOBS.NOTIFY_MEMBER_JOINED }],
  'trial.expired': [{ queue: QUEUES.NOTIFICATIONS, jobName: JOBS.NOTIFY_TRIAL_EXPIRED }],
  // A lead nobody picked up is the most expensive silent failure in the product, so it has its own
  // event rather than being inferred from `lead.assigned` with a null (`FR-ASG-4`).
  'lead.unassigned_pool': [{ queue: QUEUES.NOTIFICATIONS, jobName: JOBS.NOTIFY_LEAD_UNASSIGNED }],
  // A missed follow-up is told about through the event rather than by the sweep, so "mark it
  // reported" and "tell somebody" retry independently — and a second consumer (the Phase 3
  // escalation policy, a WhatsApp nudge) is a line here rather than a change to the sweep.
  'task.overdue': [{ queue: QUEUES.NOTIFICATIONS, jobName: JOBS.NOTIFY_TASK_OVERDUE }, WEBHOOK, AUTOMATION],
  // One processor serves both, dispatching on the envelope's event name — and the recipients were
  // resolved and stored by the sweep, so the escalation row and the notifications cannot disagree.
  'sla.at_risk': [{ queue: QUEUES.NOTIFICATIONS, jobName: JOBS.NOTIFY_SLA_ESCALATION }],
  'sla.breached': [{ queue: QUEUES.NOTIFICATIONS, jobName: JOBS.NOTIFY_SLA_ESCALATION }, AUTOMATION],
  // Scoring reacts to what a lead does (`FR-SCR-2`). Every one of these is a trigger a tenant may
  // write a rule on, and the job name is the same for all of them — the processor reads which event
  // it was from the envelope, so adding a trigger is a line here and an entry in `SCORING_TRIGGERS`.
  'lead.created': [{ queue: QUEUES.SCORING, jobName: JOBS.LEAD_SCORE }, WEBHOOK, AUTOMATION],
  'lead.updated': [{ queue: QUEUES.SCORING, jobName: JOBS.LEAD_SCORE }, WEBHOOK],
  'lead.assigned': [{ queue: QUEUES.SCORING, jobName: JOBS.LEAD_SCORE }, WEBHOOK, AUTOMATION],
  'lead.status_changed': [{ queue: QUEUES.SCORING, jobName: JOBS.LEAD_SCORE }, WEBHOOK, AUTOMATION],
  'lead.stage_changed': [{ queue: QUEUES.SCORING, jobName: JOBS.LEAD_SCORE }, WEBHOOK, AUTOMATION],
  'lead.touchpoint_added': [{ queue: QUEUES.SCORING, jobName: JOBS.LEAD_SCORE }],
  // A call is the one thing a salesperson does that a score should move on, and the payload carries
  // `outcomeCategory` so a rule can score "spoke to them" and "wrong number" differently
  // (`FR-CALL-1`). Its envelope names the **lead** as the aggregate, not the call: the processor
  // reads its subject from `payload.aggregateId`, and an unlinked inbound call has no lead to score
  // — which is why `CallsService` emits this when the call is attributed rather than when it is
  // logged.
  'call.logged': [{ queue: QUEUES.SCORING, jobName: JOBS.LEAD_SCORE }, WEBHOOK],
  // Recorded but not yet consumed. Listed explicitly so the set of known events is visible, and so
  // a typo in an event name shows up as "unsubscribed" rather than silently doing nothing.
  'call.attempted': [],
  'task.created': [WEBHOOK],
  'task.completed': [WEBHOOK, AUTOMATION],
  'task.rescheduled': [WEBHOOK],
  'task.cancelled': [],
  'organization.created': [],
  'onboarding.completed': [],
  'lead.deleted': [WEBHOOK],
  'lead.merged': [WEBHOOK],
  'lead.merge_undone': [],
  'lead.recycled': [],
  'lead.score_changed': [WEBHOOK, AUTOMATION],
  'import.completed': [],
  'export.completed': [],
  /**
   * Emitted since Phase 2 and 3 and **never listed here**, which `isKnownEvent` reported as
   * "unknown" and the dispatcher treated as "no subscribers" — the same answer for a typo and for a
   * real event nothing had been wired to yet. Listing them is what Phase 4 step 3 needed anyway:
   * every one of them is a webhook event somebody can subscribe to (`FR-API-4`).
   */
  'lead.converted': [WEBHOOK],
  'customer.created': [WEBHOOK],
  'customer.updated': [WEBHOOK],
  'customer.deleted': [],
  'deal.created': [WEBHOOK],
  'deal.stage_changed': [WEBHOOK],
  'deal.won': [WEBHOOK],
  'deal.lost': [WEBHOOK],
  'quotation.created': [],
  'quotation.sent': [WEBHOOK],
  'quotation.accepted': [WEBHOOK],
  'quotation.rejected': [WEBHOOK],
  'payment.received': [WEBHOOK, AUTOMATION],
  'payment.refunded': [WEBHOOK],
  'onboarding.industry_template_applied': [],
  /**
   * A customer's own reply (Phase 5 step 1's write, Phase 6 step 1's event). Listed with no
   * subscriber: the automation dispatcher that consumes it is step 2's, and an event recorded with
   * nothing listening is the outbox working as designed — what it must not be is *unlisted*, which
   * `isKnownEvent` reports identically to a typo. It is a `WORKFLOW_TRIGGERS` event, and
   * `event-subscriptions.spec.ts` now insists every one of those appears here.
   */
  'whatsapp.message_received': [AUTOMATION],
};

export function subscribersFor(eventName: string): readonly EventSubscription[] {
  return EVENT_SUBSCRIPTIONS[eventName] ?? [];
}

export function isKnownEvent(eventName: string): boolean {
  return eventName in EVENT_SUBSCRIPTIONS;
}

/**
 * The queue-level deduplication key for a dispatched event.
 *
 * Derived from the event id, not the dispatch attempt, so re-dispatching after a crash between
 * "enqueue" and "mark published" collapses into a single job (docs/queue-event-architecture.md §4).
 * BullMQ reserves ':' in key names and rejects a custom id containing one, hence the dash.
 */
export function outboxJobId(jobName: JobName, eventId: string): string {
  return `${jobName}-${eventId}`;
}
