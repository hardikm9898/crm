import { request } from '@/lib/api';

/**
 * The Today view's sections (`FR-TSK-7`), **declared here rather than imported from
 * `@leados/shared`**.
 *
 * `@leados/shared`'s entry point re-exports the tenant context, which reaches
 * `node:async_hooks` — and a client component that transitively imports it fails the Next build
 * with "the chunking context does not support external modules", on whichever page happens to
 * render it. The same shape as the `next/headers` rule in the other direction: the web app's
 * runtime code owns its own copy of a shared vocabulary, hand-written against the documented
 * envelope like every other shape in this file.
 *
 * The two are kept honest by `tasks.spec.ts`, which runs in Node and so may import both.
 */
export const TASK_BUCKETS = [
  'overdue',
  'due_now',
  'due_today',
  'upcoming',
  'completed',
  'cancelled',
] as const;
export type TaskBucket = (typeof TASK_BUCKETS)[number];

/** The task shapes the screens read, hand-written against the documented envelope. */
export interface TaskSummary {
  id: string;
  title: string;
  description: string | null;
  status: 'pending' | 'in_progress' | 'completed' | 'cancelled';
  /** Derived by the API from the clock, not stored — so the screen and the counters agree. */
  bucket: TaskBucket;
  priority: 'low' | 'medium' | 'high' | 'urgent';
  dueAt: string;
  completedAt: string | null;
  cancelledAt: string | null;
  completionNote: string | null;
  reminderOffsets: number[];
  rescheduleCount: number;
  followsTaskId: string | null;
  assignedUserId: string | null;
  taskTypeId: string | null;
  taskType: { id: string; name: string; icon: string | null } | null;
  outcomeId: string | null;
  outcome: { id: string; name: string; isPositive: boolean | null } | null;
  leadId: string | null;
  lead: { id: string; fullName: string; phoneE164: string | null } | null;
  customerId: string | null;
  customer: { id: string; fullName: string } | null;
  dealId: string | null;
  deal: { id: string; name: string } | null;
  createdAt: string;
}

export interface TaskType {
  id: string;
  name: string;
  icon: string | null;
  defaultDurationMinutes: number | null;
  defaultReminderOffsets: number[];
  sortOrder: number;
  isActive?: boolean;
  taskCount?: number;
}

export interface TaskOutcome {
  id: string;
  name: string;
  isPositive: boolean | null;
  requiresNote: boolean;
  sortOrder: number;
  isActive?: boolean;
  taskCount?: number;
}

export interface RescheduleReason {
  id: string;
  name: string;
  requiresNote: boolean;
  sortOrder: number;
  isActive?: boolean;
  useCount?: number;
}

export interface TaskConfig {
  types: TaskType[];
  outcomes: TaskOutcome[];
  rescheduleReasons: RescheduleReason[];
}

export interface TaskCounts {
  counts: Record<TaskBucket, number>;
  /** Open leads with nobody owing them anything — the "silent leads" half of `FR-TSK-4`. */
  noNextAction: number;
  generatedAt: string;
}

export async function loadTasks(
  query: string,
  token: string | null,
): Promise<{ items: TaskSummary[]; total?: number; nextCursor: string | null }> {
  const response = await request<TaskSummary[]>(`/tasks${query}`, { token });
  return {
    items: response.data,
    ...(response.pagination?.total === undefined ? {} : { total: response.pagination.total }),
    nextCursor: response.pagination?.nextCursor ?? null,
  };
}

/**
 * One task, by id.
 *
 * Needed because `?taskId=` is a **deep link** — the reminder notification and the lead panel both
 * point at it — and finding the row inside whatever page the current filter happened to load means
 * the panel silently fails to open whenever the filter excludes it. That is exactly what happened
 * to a follow-up assigned to a colleague while the queue was showing "mine".
 */
export async function loadTask(id: string, token: string | null): Promise<TaskSummary | null> {
  try {
    return (await request<TaskSummary>(`/tasks/${id}`, { token })).data;
  } catch {
    return null;
  }
}

export async function loadTaskCounts(token: string | null, query = ''): Promise<TaskCounts> {
  return (await request<TaskCounts>(`/tasks/summary${query}`, { token })).data;
}

/**
 * The follow-up vocabulary.
 *
 * `loadTaskConfigOrThrow` is for the settings screen and for the forms, where an empty list and a
 * failed request look identical and must not: a form offering no outcomes is unusable, and "there
 * are no outcomes" would be a lie somebody acts on. The swallowing version is for a panel beside
 * other content, where a missing dropdown is better than a page that will not open.
 */
export async function loadTaskConfig(token: string | null): Promise<TaskConfig> {
  try {
    return await loadTaskConfigOrThrow(token);
  } catch {
    return { types: [], outcomes: [], rescheduleReasons: [] };
  }
}

export async function loadTaskConfigOrThrow(token: string | null): Promise<TaskConfig> {
  return (await request<TaskConfig>('/tasks/config', { token })).data;
}

/** The open follow-ups on one lead, newest commitment first. Swallows, like `loadDealPayments`. */
export async function loadLeadTasks(leadId: string, token: string | null): Promise<TaskSummary[]> {
  try {
    return (
      await request<TaskSummary[]>(`/tasks?leadId=${leadId}&limit=50&direction=asc`, { token })
    ).data;
  } catch {
    return [];
  }
}

export async function loadTaskReschedules(
  taskId: string,
  token: string | null,
): Promise<
  {
    id: string;
    fromDueAt: string;
    toDueAt: string;
    reason: { id: string; name: string };
    reasonNote: string | null;
    createdAt: string;
  }[]
> {
  try {
    return (
      await request<
        {
          id: string;
          fromDueAt: string;
          toDueAt: string;
          reason: { id: string; name: string };
          reasonNote: string | null;
          createdAt: string;
        }[]
      >(`/tasks/${taskId}/reschedules`, { token })
    ).data;
  } catch {
    return [];
  }
}

export async function loadTaskTypes(token: string | null, query = ''): Promise<TaskType[]> {
  return (await request<TaskType[]>(`/settings/task-types${query}`, { token })).data;
}

export async function loadTaskOutcomes(token: string | null, query = ''): Promise<TaskOutcome[]> {
  return (await request<TaskOutcome[]>(`/settings/task-outcomes${query}`, { token })).data;
}

export async function loadRescheduleReasons(
  token: string | null,
  query = '',
): Promise<RescheduleReason[]> {
  return (await request<RescheduleReason[]>(`/settings/reschedule-reasons${query}`, { token }))
    .data;
}

/**
 * How each section of the Today screen is headed, and the sentence under it.
 *
 * The sentence matters more than it looks: "Overdue (3)" with nothing else tells a sales executive
 * what but not why, and the whole point of a queue is that the next thing to do is obvious.
 */
export const BUCKET_LABELS: Record<TaskBucket, string> = {
  overdue: 'Overdue',
  due_now: 'Due now',
  due_today: 'Later today',
  upcoming: 'Coming up',
  completed: 'Done',
  cancelled: 'Called off',
};

export const BUCKET_HINTS: Record<TaskBucket, string> = {
  overdue: 'Past their time. Start here.',
  due_now: 'Within the next half hour.',
  due_today: 'Still today, in your workspace’s time.',
  upcoming: 'Tomorrow onwards.',
  completed: 'Finished, with what happened.',
  cancelled: 'Decided against.',
};

/** The sections an executive's queue is read in. Finished work is not part of the queue. */
export const QUEUE_BUCKETS: readonly TaskBucket[] = ['overdue', 'due_now', 'due_today', 'upcoming'];

export const BUCKET_CLASSES: Record<TaskBucket, string> = {
  overdue: 'bg-rose-100 text-rose-800',
  due_now: 'bg-amber-100 text-amber-900',
  due_today: 'bg-sky-100 text-sky-900',
  upcoming: 'bg-slate-100 text-slate-700',
  completed: 'bg-emerald-100 text-emerald-800',
  cancelled: 'bg-slate-100 text-slate-500',
};

export const PRIORITY_LABELS: Record<TaskSummary['priority'], string> = {
  low: 'Low',
  medium: 'Normal',
  high: 'High',
  urgent: 'Urgent',
};

/** Only the two that should change what somebody does next get a colour. */
export const PRIORITY_CLASSES: Record<TaskSummary['priority'], string> = {
  low: 'text-[var(--color-text-muted)]',
  medium: 'text-[var(--color-text-muted)]',
  high: 'text-amber-700',
  urgent: 'text-rose-700',
};

export function isQueueBucket(value: string): value is TaskBucket {
  return (TASK_BUCKETS as readonly string[]).includes(value);
}

/**
 * `dueAt` as the two inputs a form shows, in the browser's own timezone.
 *
 * A `datetime-local` input would be one field, and is the obvious choice — but it renders as a
 * different control in every browser, is close to unusable on an Indian Android keyboard, and
 * cannot be given a sensible default time. Two fields are what a person planning a call actually
 * fills in: a day, and a time.
 */
export function dueFields(when: Date): { date: string; time: string } {
  const pad = (value: number) => String(value).padStart(2, '0');
  return {
    date: `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}`,
    time: `${pad(when.getHours())}:${pad(when.getMinutes())}`,
  };
}

/** Tomorrow at ten, which is what "follow up" means if nobody says otherwise. */
export function defaultDue(now = new Date()): { date: string; time: string } {
  const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  tomorrow.setHours(10, 0, 0, 0);
  return dueFields(tomorrow);
}
