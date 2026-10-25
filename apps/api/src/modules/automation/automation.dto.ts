import { z } from 'zod';
import { REENTRY_POLICIES, WORKFLOW_STATUSES } from '@leados/shared';

/**
 * The write contracts for workflows (`FR-AUT-4`, `FR-AUT-5`).
 *
 * The **definition** is deliberately not described here beyond "an object". Its shape is the
 * registry's to check — `validateWorkflowDefinition` reads the same declarations the editor
 * renders from, and writing a second description of a workflow graph in Zod is how "adding an
 * action requires no engine change" stops being true. A draft is allowed to be incomplete, and
 * the detail response says what is still wrong; `publish` is where that list becomes a refusal.
 */
export const workflowDefinitionSchema = z.record(z.string(), z.unknown());

const guardrails = {
  /** `null` clears the cap. Absent leaves it alone — the three-way distinction a query string cannot carry, which a JSON body can. */
  maxRunsPerEntity: z.number().int().positive().max(1000).nullable().optional(),
  reentryPolicy: z.enum(REENTRY_POLICIES).optional(),
  cooldownHours: z.number().int().positive().max(24 * 365).nullable().optional(),
};

export const createWorkflowSchema = z.object({
  name: z.string().trim().min(2).max(120),
  description: z.string().trim().max(2000).nullable().optional(),
  definition: workflowDefinitionSchema.optional(),
  ...guardrails,
});
export type CreateWorkflowInput = z.infer<typeof createWorkflowSchema>;

export const updateWorkflowSchema = z
  .object({
    name: z.string().trim().min(2).max(120).optional(),
    description: z.string().trim().max(2000).nullable().optional(),
    /** `archived` is reached here; `draft` is not — a published workflow cannot un-publish itself. */
    status: z.enum(WORKFLOW_STATUSES).optional(),
    killSwitch: z.boolean().optional(),
    ...guardrails,
  })
  .refine((body) => Object.keys(body).length > 0, {
    message: 'Nothing to change.',
  });
export type UpdateWorkflowInput = z.infer<typeof updateWorkflowSchema>;

export const saveDefinitionSchema = z.object({
  definition: workflowDefinitionSchema,
});
export type SaveDefinitionInput = z.infer<typeof saveDefinitionSchema>;

export const listWorkflowsSchema = z.object({
  status: z.enum(WORKFLOW_STATUSES).optional(),
  /**
   * Three-way on purpose. `z.enum(['true','false']).transform(v => v === 'true')` folds an absent
   * parameter to `false`, which is right for `deleted` and wrong here: absent means "either".
   */
  killSwitch: z
    .enum(['true', 'false'])
    .optional()
    .transform((value) => (value === undefined ? undefined : value === 'true')),
  trigger: z.string().trim().max(120).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().max(200).optional(),
});
export type ListWorkflowsQuery = z.infer<typeof listWorkflowsSchema>;
