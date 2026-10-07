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
  'task.overdue': [{ queue: QUEUES.NOTIFICATIONS, jobName: JOBS.NOTIFY_TASK_OVERDUE }],
  // Scoring reacts to what a lead does (`FR-SCR-2`). Every one of these is a trigger a tenant may
  // write a rule on, and the job name is the same for all of them — the processor reads which event
  // it was from the envelope, so adding a trigger is a line here and an entry in `SCORING_TRIGGERS`.
  'lead.created': [{ queue: QUEUES.SCORING, jobName: JOBS.LEAD_SCORE }],
  'lead.updated': [{ queue: QUEUES.SCORING, jobName: JOBS.LEAD_SCORE }],
  'lead.assigned': [{ queue: QUEUES.SCORING, jobName: JOBS.LEAD_SCORE }],
  'lead.status_changed': [{ queue: QUEUES.SCORING, jobName: JOBS.LEAD_SCORE }],
  'lead.stage_changed': [{ queue: QUEUES.SCORING, jobName: JOBS.LEAD_SCORE }],
  'lead.touchpoint_added': [{ queue: QUEUES.SCORING, jobName: JOBS.LEAD_SCORE }],
  // Recorded but not yet consumed. Listed explicitly so the set of known events is visible, and so
  // a typo in an event name shows up as "unsubscribed" rather than silently doing nothing.
  'task.created': [],
  'task.completed': [],
  'task.rescheduled': [],
  'task.cancelled': [],
  'organization.created': [],
  'onboarding.completed': [],
  'lead.deleted': [],
  'lead.merged': [],
  'lead.merge_undone': [],
  'lead.recycled': [],
  'lead.score_changed': [],
  'import.completed': [],
  'export.completed': [],
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
