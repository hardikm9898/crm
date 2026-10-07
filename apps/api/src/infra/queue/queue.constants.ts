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

  SESSION_PRUNE: 'maintenance.session-prune',
  INVITATION_EXPIRE: 'maintenance.invitation-expire',
  TRIAL_CHECK: 'maintenance.trial-check',
  OUTBOX_REAP: 'maintenance.outbox-reap',
  ACTIVITY_PARTITIONS: 'maintenance.activity-partitions',
  LEAD_RECYCLE: 'maintenance.lead-recycle',
  QUOTATION_EXPIRY: 'maintenance.quotation-expiry',
  /**
   * The two names `docs/queue-event-architecture.md` §5 gives them. Both live on `maintenance`
   * because both are platform-scoped sweeps over every tenant.
   */
  TASK_OVERDUE_SWEEP: 'task.overdue-sweep',
  TASK_REMINDER_DISPATCH: 'task.reminder-dispatch',

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
