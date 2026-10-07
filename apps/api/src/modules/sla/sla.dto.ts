import { z } from 'zod';
import { SLA_CLOCK_STATES, SLA_TARGETS } from '@leados/shared';

/**
 * Request shapes for SLA policies, clocks and escalations (`FR-TSK-8`).
 *
 * A query string carries strings, so every flag is an enum-and-transform rather than a
 * `z.boolean()`; `mine` folds an absent value to `false` because a manager's board is the default
 * and narrowing to your own is the thing you ask for.
 */
const booleanFlag = z
  .enum(['true', 'false'])
  .optional()
  .transform((value) => value === 'true');

const idList = z.array(z.string().uuid()).max(50).optional();

/**
 * `applies_to`, with every condition optional.
 *
 * An absent condition means "any"; an empty array is accepted and also means "any", because a
 * tenant clearing the last source from a condition means "stop filtering on source" rather than
 * "match nothing" — and a policy that silently matched nothing would be an SLA that quietly
 * stopped existing.
 */
export const appliesToSchema = z
  .object({
    sourceIds: idList,
    priorities: z
      .array(z.enum(['low', 'medium', 'high', 'urgent']))
      .max(4)
      .optional(),
    pipelineIds: idList,
    scoreBands: z.array(z.string().trim().min(1).max(60)).max(20).optional(),
  })
  .strict();

const minutes = z.coerce
  .number()
  .int()
  .min(1)
  .max(60 * 24 * 365);

export const createSlaPolicySchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    appliesTo: appliesToSchema.default({}),
    firstResponseMinutes: minutes,
    nextResponseMinutes: minutes.nullish(),
    resolutionMinutes: minutes.nullish(),
    businessHoursOnly: z.boolean().default(true),
    /** Strictly inside the target: 0 % fires at the start and 100 % arrives with the breach. */
    warnAtPercent: z.coerce.number().int().min(1).max(99).default(80),
    escalateTo: z
      .object({
        /** A permission, not a role name (rule 4). */
        permission: z.string().trim().min(1).max(60).optional(),
        userIds: idList,
      })
      .strict()
      .default({}),
    priority: z.coerce.number().int().min(0).max(999).default(0),
  })
  .strict();
export type CreateSlaPolicyInput = z.infer<typeof createSlaPolicySchema>;

export const updateSlaPolicySchema = createSlaPolicySchema
  .partial()
  .extend({ isActive: z.boolean().optional() })
  .strict()
  .refine((value) => Object.keys(value).length > 0, { message: 'Nothing to update' });
export type UpdateSlaPolicyInput = z.infer<typeof updateSlaPolicySchema>;

export const listClocksSchema = z
  .object({
    leadId: z.string().uuid().optional(),
    target: z.enum(SLA_TARGETS).optional(),
    state: z.enum(SLA_CLOCK_STATES).optional(),
    /** What the screen asks for: `breached` includes a running clock whose moment has passed. */
    health: z.enum(['breached', 'at_risk']).optional(),
    assignedUserId: z.string().uuid().optional(),
    mine: booleanFlag,
    limit: z.coerce.number().int().min(1).max(100).default(25),
    cursor: z.string().uuid().optional(),
    direction: z.enum(['asc', 'desc']).default('asc'),
  })
  .strict();
export type ListClocksQuery = z.infer<typeof listClocksSchema>;

export const slaBoardSchema = z
  .object({ mine: booleanFlag, assignedUserId: z.string().uuid().optional() })
  .strict();
export type SlaBoardQuery = z.infer<typeof slaBoardSchema>;

export const listEscalationsSchema = z
  .object({
    unacknowledgedOnly: booleanFlag,
    limit: z.coerce.number().int().min(1).max(100).default(25),
    cursor: z.string().uuid().optional(),
  })
  .strict();
export type ListEscalationsQuery = z.infer<typeof listEscalationsSchema>;
