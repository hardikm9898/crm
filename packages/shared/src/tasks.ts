import { dateKeyInZone, zonedParts } from './time.js';

/**
 * Task vocabulary and the three pieces of arithmetic a task needs (`FR-TSK-1..7`).
 *
 * Here rather than in the API because three consumers need the same answers and must not disagree:
 * the service writes `due_date`/`due_time` and the reminder rows, the sweeps decide what is overdue,
 * and the web app groups the Today screen into buckets. A bucket computed one way on the server and
 * another way in the browser is a screen that contradicts its own counts.
 */

/** The statuses a task can be *in*. `overdue` is derived and `rescheduled` is an event — see below. */
export const TASK_STATUSES = ['pending', 'in_progress', 'completed', 'cancelled'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

/** The two statuses that mean "somebody still has to do this". */
export const OPEN_TASK_STATUSES = ['pending', 'in_progress'] as const;
export type OpenTaskStatus = (typeof OPEN_TASK_STATUSES)[number];

export const TASK_PRIORITIES = ['low', 'medium', 'high', 'urgent'] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];

export const TASK_CREATED_VIA = ['manual', 'automation', 'api', 'system', 'import'] as const;
export type TaskCreatedVia = (typeof TASK_CREATED_VIA)[number];

export function isOpenStatus(status: string): status is OpenTaskStatus {
  return (OPEN_TASK_STATUSES as readonly string[]).includes(status);
}

/**
 * The Today view's sections (`FR-TSK-7`), in the order an executive reads them.
 *
 * Non-overlapping by construction, so a task appears exactly once and the counts add up to the
 * list — a screen whose sections double-count is one nobody believes twice.
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

/**
 * How long before its due time a task reads as "due now".
 *
 * Half an hour, because that is roughly the horizon somebody plans the next call in: shorter and
 * the section is empty all morning, longer and it is the whole day's list under a heading that
 * says "now".
 */
export const DUE_NOW_WINDOW_MINUTES = 30;

export interface BucketableTask {
  readonly status: string;
  readonly dueAt: Date;
}

/**
 * Which section of the Today screen a task belongs in.
 *
 * **Overdue is read from the clock, never from a column.** A task due at 10:00 is overdue at 10:01,
 * not at 10:30 when the sweep next runs, so the only honest source is `dueAt < now`. The sweep
 * exists to *tell* somebody, which is a different job from knowing.
 */
export function taskBucket(task: BucketableTask, now: Date, timeZone: string): TaskBucket {
  if (task.status === 'completed') return 'completed';
  if (task.status === 'cancelled') return 'cancelled';
  if (task.dueAt.getTime() < now.getTime()) return 'overdue';
  if (task.dueAt.getTime() <= now.getTime() + DUE_NOW_WINDOW_MINUTES * 60_000) return 'due_now';
  if (dateKeyInZone(task.dueAt, timeZone) === dateKeyInZone(now, timeZone)) return 'due_today';
  return 'upcoming';
}

export function isOverdue(task: BucketableTask, now: Date): boolean {
  return isOpenStatus(task.status) && task.dueAt.getTime() < now.getTime();
}

/**
 * `due_at` as the workspace's own calendar date and wall-clock time.
 *
 * Stored alongside the instant because "due today" is a question about a *day*, and the day depends
 * on the workspace's timezone: 23:30 in Kolkata is the previous day in UTC. Computing it in SQL
 * with `AT TIME ZONE` on every query cannot use an index; a stored local date can.
 */
export function dueParts(dueAt: Date, timeZone: string): { dueDate: string; dueTime: string } {
  const { hour, minute, second } = zonedParts(dueAt, timeZone);
  return {
    dueDate: dateKeyInZone(dueAt, timeZone),
    dueTime: `${pad(hour)}:${pad(minute)}:${pad(second)}`,
  };
}

/**
 * Minutes before the due time that a task asks to be reminded.
 *
 * An hour is the one that matters — long enough to prepare, short enough to still be true. The
 * day-before offset is on the task types where somebody has to travel.
 */
export const DEFAULT_REMINDER_OFFSETS: readonly number[] = [60];

/** More than this and a reminder stops being a reminder. */
export const MAX_REMINDERS_PER_TASK = 5;
/** A fortnight. Beyond that the reminder is a different task. */
export const MAX_REMINDER_OFFSET_MINUTES = 14 * 24 * 60;

/**
 * Cleans a submitted offset list: integers only, no duplicates, no negatives, soonest last.
 *
 * Returned longest-first so the rows read in the order they fire, and capped rather than refused —
 * somebody who asks for nine reminders gets five, which is a better outcome than a validation
 * error on a field they did not know was limited.
 */
export function normaliseReminderOffsets(offsets: readonly unknown[]): number[] {
  const cleaned = offsets
    .map(toMinutes)
    .filter(
      (value) => Number.isInteger(value) && value >= 0 && value <= MAX_REMINDER_OFFSET_MINUTES,
    );
  return [...new Set(cleaned)].sort((a, b) => b - a).slice(0, MAX_REMINDERS_PER_TASK);
}

/**
 * A coercion that refuses what `Number()` would accept.
 *
 * `Number(null)` is 0 and `Number('')` is 0, and 0 is a *meaningful* offset here — "remind me at
 * the due time". So a JSONB array that picked up a null, or a form field somebody left blank,
 * would silently become a reminder nobody asked for, at the one moment it is most confusing.
 */
function toMinutes(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value.trim() !== '') return Number(value);
  return Number.NaN;
}

export interface ReminderInstant {
  readonly offsetMinutes: number;
  readonly remindAt: Date;
}

/**
 * The instants a task's reminders fire at.
 *
 * A reminder whose moment has already gone is dropped rather than fired late: being told at 15:00
 * about a call that was due at 14:00 is not a reminder, it is the overdue sweep's job, and the two
 * arriving together is how a notification list becomes noise. An offset of 0 means "at the due
 * time", which is kept, because that one *is* the call.
 */
export function reminderInstants(
  dueAt: Date,
  offsets: readonly number[],
  now: Date,
): ReminderInstant[] {
  return normaliseReminderOffsets(offsets)
    .map((offsetMinutes) => ({
      offsetMinutes,
      remindAt: new Date(dueAt.getTime() - offsetMinutes * 60_000),
    }))
    .filter((reminder) => reminder.remindAt.getTime() > now.getTime());
}

/**
 * How a reminder describes the wait, for the notification's own sentence.
 *
 * "in an hour" rather than "in 60 minutes", because the second one reads as machine output.
 */
export function describeReminderLead(offsetMinutes: number): string {
  if (offsetMinutes === 0) return 'now';
  if (offsetMinutes < 60) return `in ${offsetMinutes} minute${offsetMinutes === 1 ? '' : 's'}`;
  if (offsetMinutes % (24 * 60) === 0) {
    const days = offsetMinutes / (24 * 60);
    return days === 1 ? 'tomorrow' : `in ${days} days`;
  }
  const hours = Math.round(offsetMinutes / 60);
  return `in ${hours === 1 ? 'an hour' : `${hours} hours`}`;
}

/**
 * Sort order for a queue of tasks: priority first, then due time (`FR-TSK-7`).
 *
 * Priority before time on purpose — an urgent call due at 16:00 belongs above a low-priority one
 * due at 10:00 on the same screen, because the screen is a work queue and not a diary.
 */
const PRIORITY_RANK: Readonly<Record<string, number>> = {
  urgent: 0,
  high: 1,
  medium: 2,
  low: 3,
};

export function compareTasksForQueue(
  a: { priority: string; dueAt: Date },
  b: { priority: string; dueAt: Date },
): number {
  const byPriority = (PRIORITY_RANK[a.priority] ?? 9) - (PRIORITY_RANK[b.priority] ?? 9);
  if (byPriority !== 0) return byPriority;
  return a.dueAt.getTime() - b.dueAt.getTime();
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}
