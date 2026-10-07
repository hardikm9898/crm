import { z } from 'zod';
import {
  MAX_REMINDERS_PER_TASK,
  TASK_BUCKETS,
  TASK_PRIORITIES,
  TASK_STATUSES,
} from '@leados/shared';

/**
 * Request shapes for tasks and follow-ups (`FR-TSK-1..7`).
 *
 * Two conventions this file is careful about, both of them traps this repository has already paid
 * for:
 *
 *  * **A query string carries strings.** `z.boolean()` cannot parse `?overdue=true`. The existing
 *    convention folds an absent flag to `false`, which is right for `deleted` and wrong for any
 *    three-way filter — absent means "both", and folding it to `false` silently returns half the
 *    list. `threeWayFlag` keeps `undefined` as `undefined`.
 *  * **A reschedule needs a reason, at the schema level.** `FR-TSK-5` says date, time *and* reason,
 *    so `reasonId` is required rather than validated later — a refusal that arrives from the
 *    database is a refusal with no field attached to it.
 */

/** Absent means "either". See the class comment. */
const threeWayFlag = z
  .enum(['true', 'false'])
  .optional()
  .transform((value) => (value === undefined ? undefined : value === 'true'));

/** Absent means "false" — right for a flag whose absence is the normal case. */
const booleanFlag = z
  .enum(['true', 'false'])
  .optional()
  .transform((value) => value === 'true');

const reminderOffsets = z
  .array(
    z.coerce
      .number()
      .int()
      .min(0)
      .max(14 * 24 * 60),
  )
  .max(MAX_REMINDERS_PER_TASK + 4)
  .optional();

const subject = {
  leadId: z.string().uuid().optional(),
  customerId: z.string().uuid().optional(),
  dealId: z.string().uuid().optional(),
};

export const createTaskSchema = z
  .object({
    ...subject,
    title: z.string().trim().min(1).max(200),
    description: z.string().trim().max(4000).optional(),
    taskTypeId: z.string().uuid().optional(),
    /** The instant. The screen sends a date and a time; the browser turns them into one. */
    dueAt: z.coerce.date(),
    priority: z.enum(TASK_PRIORITIES).default('medium'),
    assignedUserId: z.string().uuid().nullish(),
    /**
     * Minutes before `dueAt`. Omitted means "whatever the task type says", which is the whole point
     * of the type carrying defaults; an explicit empty array means "do not remind me".
     */
    reminderOffsets,
    /** The task this one follows, when it was created from a completion (`FR-TSK-6`). */
    followsTaskId: z.string().uuid().optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.leadId !== undefined || value.customerId !== undefined || value.dealId !== undefined,
    { message: 'Say who the task is about — a lead, a customer or a deal' },
  );
export type CreateTaskInput = z.infer<typeof createTaskSchema>;

/**
 * Corrects a task.
 *
 * Deliberately cannot change `status`: completing, cancelling and rescheduling each have their own
 * preconditions, their own timeline entry and their own effect on the lead's next action, and a
 * PATCH that happened to carry a status could check none of them. Moving `dueAt` is not here
 * either — that is a reschedule, and `FR-TSK-5` requires a reason for it.
 */
export const updateTaskSchema = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    description: z.string().trim().max(4000).nullish(),
    taskTypeId: z.string().uuid().nullish(),
    priority: z.enum(TASK_PRIORITIES).optional(),
    assignedUserId: z.string().uuid().nullish(),
    reminderOffsets,
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, { message: 'Nothing to update' });
export type UpdateTaskInput = z.infer<typeof updateTaskSchema>;

/**
 * Completing a task (`FR-TSK-6`).
 *
 * `outcomeId` is required, not optional — "prompt for outcome" is only worth anything if the
 * prompt cannot be dismissed, and a month later "what happened on those forty calls" has to have
 * an answer. `nextFollowUp` is the other half of the requirement: the next task is created in the
 * same interaction, in the same transaction, so the lead never passes through a state with no next
 * action.
 */
export const completeTaskSchema = z
  .object({
    outcomeId: z.string().uuid(),
    note: z.string().trim().max(4000).optional(),
    completedAt: z.coerce.date().optional(),
    nextFollowUp: z
      .object({
        title: z.string().trim().min(1).max(200).optional(),
        taskTypeId: z.string().uuid().optional(),
        dueAt: z.coerce.date(),
        priority: z.enum(TASK_PRIORITIES).optional(),
        assignedUserId: z.string().uuid().nullish(),
        reminderOffsets,
      })
      .strict()
      .optional(),
  })
  .strict();
export type CompleteTaskInput = z.infer<typeof completeTaskSchema>;

/** `FR-TSK-5`: a new time and a reason, both required. */
export const rescheduleTaskSchema = z
  .object({
    dueAt: z.coerce.date(),
    reasonId: z.string().uuid(),
    note: z.string().trim().max(1000).optional(),
  })
  .strict();
export type RescheduleTaskInput = z.infer<typeof rescheduleTaskSchema>;

export const cancelTaskSchema = z
  .object({ reason: z.string().trim().max(1000).optional() })
  .strict();
export type CancelTaskInput = z.infer<typeof cancelTaskSchema>;

export const listTasksSchema = z
  .object({
    leadId: z.string().uuid().optional(),
    customerId: z.string().uuid().optional(),
    dealId: z.string().uuid().optional(),
    assignedUserId: z.string().uuid().optional(),
    taskTypeId: z.string().uuid().optional(),
    outcomeId: z.string().uuid().optional(),
    status: z.enum(TASK_STATUSES).optional(),
    /** `open` is the question every screen actually asks, and it spans two statuses. */
    open: threeWayFlag,
    priority: z.enum(TASK_PRIORITIES).optional(),
    bucket: z.enum(TASK_BUCKETS).optional(),
    dueFrom: z.coerce.date().optional(),
    dueTo: z.coerce.date().optional(),
    /** Mine only. The Today screen's default, and cheaper than making every client know their id. */
    mine: booleanFlag,
    deleted: booleanFlag,
    search: z.string().trim().min(1).max(120).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(25),
    cursor: z.string().uuid().optional(),
    sort: z.enum(['due_at', 'created_at', 'priority']).default('due_at'),
    direction: z.enum(['asc', 'desc']).default('asc'),
  })
  .strict();
export type ListTasksQuery = z.infer<typeof listTasksSchema>;

export const taskSummarySchema = z
  .object({ mine: threeWayFlag, assignedUserId: z.string().uuid().optional() })
  .strict();
export type TaskSummaryQuery = z.infer<typeof taskSummarySchema>;

// ── Configuration (rule 4: every one of these is a row) ─────────────────────

export const createTaskTypeSchema = z
  .object({
    name: z.string().trim().min(1).max(60),
    icon: z.string().trim().max(40).nullish(),
    defaultDurationMinutes: z.coerce
      .number()
      .int()
      .min(1)
      .max(24 * 60)
      .nullish(),
    defaultReminderOffsets: reminderOffsets,
    sortOrder: z.coerce.number().int().min(0).max(999).optional(),
  })
  .strict();
export type CreateTaskTypeInput = z.infer<typeof createTaskTypeSchema>;

export const updateTaskTypeSchema = createTaskTypeSchema
  .partial()
  .extend({ isActive: z.boolean().optional() })
  .strict()
  .refine((value) => Object.keys(value).length > 0, { message: 'Nothing to update' });
export type UpdateTaskTypeInput = z.infer<typeof updateTaskTypeSchema>;

export const createTaskOutcomeSchema = z
  .object({
    name: z.string().trim().min(1).max(60),
    /** `null` is "neither" — a no-answer is not a failure. */
    isPositive: z.boolean().nullish(),
    requiresNote: z.boolean().default(false),
    sortOrder: z.coerce.number().int().min(0).max(999).optional(),
  })
  .strict();
export type CreateTaskOutcomeInput = z.infer<typeof createTaskOutcomeSchema>;

export const updateTaskOutcomeSchema = createTaskOutcomeSchema
  .partial()
  .extend({ isActive: z.boolean().optional() })
  .strict()
  .refine((value) => Object.keys(value).length > 0, { message: 'Nothing to update' });
export type UpdateTaskOutcomeInput = z.infer<typeof updateTaskOutcomeSchema>;

export const createRescheduleReasonSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    requiresNote: z.boolean().default(false),
    sortOrder: z.coerce.number().int().min(0).max(999).optional(),
  })
  .strict();
export type CreateRescheduleReasonInput = z.infer<typeof createRescheduleReasonSchema>;

export const updateRescheduleReasonSchema = createRescheduleReasonSchema
  .partial()
  .extend({ isActive: z.boolean().optional() })
  .strict()
  .refine((value) => Object.keys(value).length > 0, { message: 'Nothing to update' });
export type UpdateRescheduleReasonInput = z.infer<typeof updateRescheduleReasonSchema>;
