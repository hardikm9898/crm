import { z } from 'zod';
import { ASSIGNMENT_STRATEGIES, FALLBACK_MODES, FILTER_OPERATORS } from '@leados/shared';

/**
 * Request shapes for assignment rules.
 *
 * `target`, `fallback` and the pool are separate concerns on purpose: `target` says *who* for the
 * single-person and team strategies, the pool says *who* for the rotating ones (because each member
 * carries a weight), and `fallback` says what happens when the answer is nobody.
 */
const conditionInput = z
  .object({
    /** A lead column (`city`), a custom field (`custom.budget`), or the clock (`time.hour`). */
    fieldPath: z.string().trim().min(1).max(80),
    operator: z.enum(FILTER_OPERATORS),
    value: z.unknown().optional(),
    /** AND within a group, OR across groups. */
    groupIndex: z.coerce.number().int().min(0).max(20).optional(),
  })
  .strict();

const poolMemberInput = z
  .object({
    userId: z.string().uuid(),
    weight: z.coerce.number().int().min(1).max(100).optional(),
    isActive: z.boolean().optional(),
  })
  .strict();

const targetInput = z
  .object({
    userId: z.string().uuid().optional(),
    teamId: z.string().uuid().optional(),
  })
  .strict();

const fallbackInput = z
  .object({
    mode: z.enum(FALLBACK_MODES),
    userId: z.string().uuid().optional(),
    teamId: z.string().uuid().optional(),
    /** Whether to notify managers when this fallback fires. Defaults to true — `FR-ASG-4`. */
    notify: z.boolean().optional(),
  })
  .strict();

export const createAssignmentRuleSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    strategy: z.enum(ASSIGNMENT_STRATEGIES),
    priority: z.coerce.number().int().min(0).max(9999).optional(),
    target: targetInput.optional(),
    respectWorkingHours: z.boolean().optional(),
    capacityCap: z.coerce.number().int().min(1).max(10_000).nullish(),
    fallback: fallbackInput.optional(),
    conditions: z.array(conditionInput).max(40).optional(),
    pool: z.array(poolMemberInput).max(200).optional(),
  })
  .strict();

export const updateAssignmentRuleSchema = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    strategy: z.enum(ASSIGNMENT_STRATEGIES).optional(),
    priority: z.coerce.number().int().min(0).max(9999).optional(),
    target: targetInput.optional(),
    respectWorkingHours: z.boolean().optional(),
    capacityCap: z.coerce.number().int().min(1).max(10_000).nullish(),
    fallback: fallbackInput.optional(),
    isActive: z.boolean().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, { message: 'Nothing to update' });

/** PUT semantics: the condition editor submits the intended final set. */
export const setConditionsSchema = z
  .object({ conditions: z.array(conditionInput).max(40) })
  .strict();

export const setPoolSchema = z.object({ pool: z.array(poolMemberInput).max(200) }).strict();

/**
 * The rule tester (`FR-ASG-4`).
 *
 * Takes either an existing lead, or a hypothetical one — a manager asks both "why did this lead go
 * to Priya" and "where would a Facebook lead from Mumbai go at 9pm on a Sunday".
 */
export const testAssignmentSchema = z
  .object({
    leadId: z.string().uuid().optional(),
    lead: z.record(z.string(), z.unknown()).optional(),
    customValues: z.record(z.string(), z.unknown()).optional(),
    /** Overrides the clock, so out-of-hours behaviour is testable during the day. */
    at: z.coerce.date().optional(),
  })
  .strict()
  .refine((value) => value.leadId !== undefined || value.lead !== undefined, {
    message: 'Give a leadId or a lead to test with',
  });

export const reassignBulkSchema = z
  .object({
    leadIds: z.array(z.string().uuid()).min(1).max(200),
    /** Null returns them all to the pool. */
    assignedUserId: z.string().uuid().nullable(),
    reason: z.string().trim().max(200).optional(),
  })
  .strict();

export const evaluateAssignmentSchema = z
  .object({ leadIds: z.array(z.string().uuid()).min(1).max(200) })
  .strict();

export type CreateAssignmentRuleInput = z.infer<typeof createAssignmentRuleSchema>;
export type UpdateAssignmentRuleInput = z.infer<typeof updateAssignmentRuleSchema>;
export type SetConditionsInput = z.infer<typeof setConditionsSchema>;
export type SetPoolInput = z.infer<typeof setPoolSchema>;
export type TestAssignmentInput = z.infer<typeof testAssignmentSchema>;
export type ReassignBulkInput = z.infer<typeof reassignBulkSchema>;
export type EvaluateAssignmentInput = z.infer<typeof evaluateAssignmentSchema>;
