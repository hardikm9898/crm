/**
 * The queue catalogue (docs/queue-event-architecture.md §3).
 *
 * Queues are separate rather than one firehose so a WhatsApp backlog cannot delay analytics,
 * and each can be scaled — and paused — independently. Only the queues with real work today
 * are declared; the rest arrive with the phases that need them, and adding one is a line here
 * plus a processor.
 */
export const QUEUES = {
  /** Outbound email and other notification delivery. */
  NOTIFICATIONS: 'notifications',
  /** Platform-scoped housekeeping: retention, sweeps, reconciliation. */
  MAINTENANCE: 'maintenance',
  /**
   * Lead scoring. Separate from notifications because a scoring backlog must never delay an
   * invitation email, and because scoring is the queue most likely to be replayed in bulk after a
   * rule change.
   */
  SCORING: 'scoring',
  /**
   * Bulk file work: an import run, an export generation. Separate because these are the only jobs
   * that are *long* — a 50 000-row import holds its worker for minutes — and a queue of them must
   * not be able to starve scoring or email. Concurrency is deliberately low for the same reason.
   */
  IMPORTS_EXPORTS: 'imports-exports',
  /**
   * Outbound webhooks. Separate because the work is **somebody else's server**: a customer whose
   * endpoint takes ten seconds to answer, or has been down since Tuesday, must not be able to hold
   * up an invitation email or a lead's score. Its retries are long (up to 24 hours) and its
   * concurrency is the highest in the product, because the jobs are almost entirely waiting.
   */
  WEBHOOKS: 'webhooks',
} as const;

export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

export const QUEUE_NAMES: readonly QueueName[] = Object.values(QUEUES);

/**
 * Job names are namespaced by domain so a queue's contents remain readable in an operator
 * dashboard, and so a processor registry can dispatch on them.
 */
export const JOBS = {
  MAIL_INVITATION: 'mail.invitation',
  MAIL_EMAIL_VERIFICATION: 'mail.email-verification',
  MAIL_PASSWORD_RESET: 'mail.password-reset',
  MAIL_SECURITY_NOTICE: 'mail.security-notice',

  NOTIFY_MEMBER_JOINED: 'notify.member-joined',
  NOTIFY_TRIAL_EXPIRED: 'notify.trial-expired',
  NOTIFY_LEAD_UNASSIGNED: 'notify.lead-unassigned',
  NOTIFY_TASK_OVERDUE: 'notify.task-overdue',
  NOTIFY_SLA_ESCALATION: 'notify.sla-escalation',
  /**
   * Emails one notification to the person it belongs to, when they chose the email channel for its
   * type (`FR-NOT-2`, `FR-NOT-3`). A queue hop rather than an inline send: a notification must not
   * wait for a provider, and a provider outage must not fail the write that caused it.
   */
  NOTIFY_EMAIL: 'notify.email',

  /**
   * Releases the notifications quiet hours held, re-checking each against its subject first
   * (`FR-NOT-3`). On `maintenance` because it is a platform-wide sweep, like the SLA one.
   */
  NOTIFICATION_RELEASE: 'notifications.release',

  SESSION_PRUNE: 'maintenance.session-prune',
  INVITATION_EXPIRE: 'maintenance.invitation-expire',
  TRIAL_CHECK: 'maintenance.trial-check',
  OUTBOX_REAP: 'maintenance.outbox-reap',
  ACTIVITY_PARTITIONS: 'maintenance.activity-partitions',
  LEAD_RECYCLE: 'maintenance.lead-recycle',
  QUOTATION_EXPIRY: 'maintenance.quotation-expiry',
  /**
   * The public lead API's idempotency window, swept (`FR-API-5`). A key is remembered for 48
   * hours; without a sweep the guarantee stays correct and the table grows forever.
   */
  IDEMPOTENCY_PRUNE: 'maintenance.idempotency-prune',
  /**
   * `api_logs`, kept a week ahead and pruned at thirty days (`FR-SA-4`). Its own job rather than a
   * fourth table in the monthly sweep, because these partitions are **days** and this is the only
   * one of them that deletes.
   */
  API_LOG_PARTITIONS: 'maintenance.api-log-partitions',
  /**
   * Every connected provider's credential, asked whether it still works
   * (`docs/queue-event-architecture.md` §5). On `maintenance` because it is a platform-wide sweep,
   * and a sweep rather than a job per connection because the thing it reads is a row: a tick
   * missed while a worker restarts costs ten minutes, not a probe.
   */
  INTEGRATION_HEALTH_CHECK: 'integration.health-check',
  /**
   * One provider event, turned into a lead (Phase 4's fifth exit criterion).
   *
   * A queue hop rather than work in the request, because a provider that waits for us is a provider
   * that **retries**: §7 of `api-architecture.md` asks for an acknowledgement in under a second,
   * and a Meta delivery that takes two seconds to capture becomes a second delivery. The
   * `provider_events` row is the durable record, so a worker restart costs a job and not a lead.
   */
  INTEGRATION_INGEST_EVENT: 'integration.ingest-event',
  /**
   * The provider events that have not become leads, re-queued (`maintenance.integration-retry`).
   *
   * The same argument the webhook retry sweep makes: the row is what is owed, and a job lost while
   * a worker was down must not be a lead lost. Bounded at three attempts per row, because a lead
   * Meta will not hand over is a credential problem and re-asking forever earns a rate limit.
   */
  INTEGRATION_RETRY_SWEEP: 'maintenance.integration-retry',
  /**
   * One inbound WhatsApp message, turned into a conversation and a message (`FR-WA-6`).
   *
   * A separate job from `integration.ingest-event` because it is a different pipeline, not a
   * different provider: a lead-ingest delivery becomes a lead through the capture path, and a
   * messaging one becomes a conversation. Which job a delivery gets is read from the provider's
   * **capabilities**, so the second messaging provider needs no change to the code that routes it.
   */
  WHATSAPP_INGEST_MESSAGE: 'whatsapp.ingest-message',
  /**
   * One status receipt, applied to the message it is about (`FR-WA-4`).
   *
   * Its own job rather than a branch inside the ingest one, because it is about a message we sent
   * rather than one that arrived — and a job name that covered both would be a name that lies in an
   * operator's dashboard, which is the one place a job name is read.
   */
  WHATSAPP_INGEST_STATUS: 'whatsapp.ingest-status',
  /**
   * One queued message, handed to Meta (`FR-WA-9`).
   *
   * A queue hop rather than an inline call for the reason every send path in this product has one:
   * a message somebody typed must not be lost to a provider timeout, and per-number rate limiting
   * is only possible where the sends are serialised. The job reads its subject from
   * `payload.aggregateId` — the message's own id.
   */
  WHATSAPP_SEND_MESSAGE: 'whatsapp.send-message',
  /**
   * Re-queues a message a worker never sent (`FR-WA-9`). The shape the webhook and integration
   * retries already have: a sweep over a row, because a job lost while a worker was down must not
   * be a message lost.
   */
  WHATSAPP_SEND_RETRY: 'maintenance.whatsapp-send-retry',
  /**
   * Reconciles every template against Meta (`FR-WA-5`). Meta approves, rejects, pauses and disables
   * on its own schedule, so a product that remembered its own last word would offer a button that
   * fails in front of a customer.
   */
  WHATSAPP_SYNC_TEMPLATES: 'whatsapp.sync-templates',
  /**
   * One event, fanned out to the endpoints that asked for it (`FR-API-4`). Reads the subscribed
   * endpoints and writes a `webhook_deliveries` row per endpoint — the store that makes a delivery
   * survive a worker restart, exactly as `inbound_payloads` does inbound.
   */
  WEBHOOK_FANOUT: 'webhook.fanout',
  /** One attempt at one delivery: sign, post, record, and schedule the next attempt or give up. */
  WEBHOOK_DELIVER: 'webhook.deliver',
  /**
   * Enqueues the deliveries whose next attempt is due (`maintenance.webhook-retry`).
   *
   * A sweep rather than a BullMQ delay, because the schedule reaches 24 hours and a delayed job is
   * a promise held in Redis: `webhook_deliveries.next_attempt_at` is the durable record, and the
   * sweep is what turns it into work. The same argument the notification release sweep makes.
   */
  WEBHOOK_RETRY_SWEEP: 'maintenance.webhook-retry',
  /**
   * The two names `docs/queue-event-architecture.md` §5 gives them. Both live on `maintenance`
   * because both are platform-scoped sweeps over every tenant.
   */
  TASK_OVERDUE_SWEEP: 'task.overdue-sweep',
  /**
   * Asks the person who dialled what happened, once, fifteen minutes on (`FR-CALL-1`). On
   * `maintenance` with the other platform-wide sweeps.
   */
  CALL_OUTCOME_SWEEP: 'call.outcome-sweep',
  TASK_REMINDER_DISPATCH: 'task.reminder-dispatch',
  SLA_SWEEP: 'sla.sweep',

  LEAD_SCORE: 'lead.score',
  SCORE_DECAY_SWEEP: 'score.decay-sweep',

  IMPORT_PROCESS: 'import.process',
  EXPORT_GENERATE: 'export.generate',
  DOCUMENT_EXPIRY: 'maintenance.document-expiry',
} as const;

export type JobName = (typeof JOBS)[keyof typeof JOBS];

/** Per-queue retry and retention policy. */
export interface QueuePolicy {
  readonly attempts: number;
  readonly backoffDelayMs: number;
  readonly concurrency: number;
}

export const QUEUE_POLICIES: Readonly<Record<QueueName, QueuePolicy>> = {
  [QUEUES.NOTIFICATIONS]: { attempts: 5, backoffDelayMs: 2_000, concurrency: 10 },
  // Housekeeping is idempotent and runs on a schedule, so a failure can wait for the next tick
  // rather than being retried aggressively.
  [QUEUES.MAINTENANCE]: { attempts: 3, backoffDelayMs: 30_000, concurrency: 2 },
  // Idempotent per `(lead, rule, source event)`, so a retry is free; three attempts is enough to
  // ride out a transient database blip without holding a lead's score hostage.
  [QUEUES.SCORING]: { attempts: 3, backoffDelayMs: 5_000, concurrency: 10 },
  // Low concurrency because each job is long and reads a whole file into memory; three attempts
  // because a run resumes from the rows it has already recorded rather than starting again, so a
  // retry after a database blip is safe and finishes the job.
  [QUEUES.IMPORTS_EXPORTS]: { attempts: 3, backoffDelayMs: 10_000, concurrency: 5 },
  // **One** attempt, deliberately: a delivery's retries are the schedule in `webhook_deliveries`,
  // not BullMQ's. Two retry mechanisms over one row would deliver the same event three times for
  // every failure and make `attempt_count` a number nobody could explain. High concurrency because
  // each job is a 10-second wait on somebody else's server, not work.
  [QUEUES.WEBHOOKS]: { attempts: 1, backoffDelayMs: 1_000, concurrency: 20 },
};

/**
 * Jobs are removed on success (keeping a bounded window for debugging) and **kept** on failure
 * until they exhaust their attempts, at which point the DLQ mirror records them in
 * `job_failures` for the Super Admin console.
 */
export const DEFAULT_JOB_OPTIONS = {
  removeOnComplete: { age: 3_600, count: 1_000 },
  removeOnFail: { age: 7 * 24 * 3_600 },
} as const;
