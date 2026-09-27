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

  SESSION_PRUNE: 'maintenance.session-prune',
  INVITATION_EXPIRE: 'maintenance.invitation-expire',
  TRIAL_CHECK: 'maintenance.trial-check',
  OUTBOX_REAP: 'maintenance.outbox-reap',
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
