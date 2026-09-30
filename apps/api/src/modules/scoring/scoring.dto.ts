import { z } from 'zod';
import { FILTER_OPERATORS, SCORE_MAX, SCORE_MIN } from '@leados/shared';

/**
 * Request shapes for scoring rules and bands.
 *
 * `triggerEvent` is checked against the registry in the service rather than as a `z.enum` here, so
 * the refusal can say *when* a dormant trigger arrives ("`message.received` arrives in Phase 5")
 * instead of listing the live ones and leaving someone to guess why theirs is missing.
 */
const conditionInput = z
  .object({
    /** A lead column (`priority`), a custom field (`custom.budget`) or `event.<key>`. */
    fieldPath: z.string().trim().min(1).max(80),
    operator: z.enum(FILTER_OPERATORS),
    value: z.unknown().optional(),
    groupIndex: z.coerce.number().int().min(0).max(20).optional(),
  })
  .strict();

const decayInput = z
  .object({
    afterDays: z.coerce.number().int().min(0).max(3650),
    points: z.coerce.number().int().min(1).max(SCORE_MAX),
    everyDays: z.coerce.number().int().min(1).max(365),
    floor: z.coerce.number().int().min(SCORE_MIN).max(SCORE_MAX),
  })
  .strict();

export const createScoringRuleSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    triggerEvent: z.string().trim().min(1).max(60),
    conditions: z.array(conditionInput).max(40).optional(),
    /** Negative is allowed and meant: a bad signal costs points. */
    points: z.coerce.number().int().min(-SCORE_MAX).max(SCORE_MAX).optional(),
    maxApplications: z.coerce.number().int().min(1).max(1000).nullish(),
    decay: decayInput.optional(),
    priority: z.coerce.number().int().min(0).max(9999).optional(),
  })
  .strict();

export const updateScoringRuleSchema = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    triggerEvent: z.string().trim().min(1).max(60).optional(),
    conditions: z.array(conditionInput).max(40).optional(),
    points: z.coerce.number().int().min(-SCORE_MAX).max(SCORE_MAX).optional(),
    maxApplications: z.coerce.number().int().min(1).max(1000).nullish(),
    decay: decayInput.nullish(),
    priority: z.coerce.number().int().min(0).max(9999).optional(),
    isActive: z.boolean().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, { message: 'Nothing to update' });

/** PUT semantics: bands are a partition of the range, so they are edited as a complete set. */
export const setBandsSchema = z
  .object({
    bands: z
      .array(
        z
          .object({
            name: z.string().trim().min(1).max(40),
            minScore: z.coerce.number().int().min(SCORE_MIN).max(SCORE_MAX),
            maxScore: z.coerce.number().int().min(SCORE_MIN).max(SCORE_MAX),
            colour: z
              .string()
              .trim()
              .regex(/^#[0-9a-fA-F]{6}$/, 'Use a hex colour like #e03131')
              .nullish(),
          })
          .strict(),
      )
      .min(1)
      .max(10),
  })
  .strict();

export const testScoringSchema = z
  .object({
    leadId: z.string().uuid().optional(),
    lead: z.record(z.string(), z.unknown()).optional(),
    customValues: z.record(z.string(), z.unknown()).optional(),
    /** Which trigger to simulate. Defaults to every live trigger, which is the useful default. */
    triggerEvent: z.string().trim().max(60).optional(),
    eventPayload: z.record(z.string(), z.unknown()).optional(),
  })
  .strict()
  .refine((value) => value.leadId !== undefined || value.lead !== undefined, {
    message: 'Give a leadId or a lead to score',
  });

export const listScoringRulesSchema = z
  .object({
    includeInactive: z
      .enum(['true', 'false'])
      .optional()
      .transform((value) => value === 'true'),
    triggerEvent: z.string().trim().max(60).optional(),
  })
  .strict();

export type CreateScoringRuleInput = z.infer<typeof createScoringRuleSchema>;
export type UpdateScoringRuleInput = z.infer<typeof updateScoringRuleSchema>;
export type SetBandsInput = z.infer<typeof setBandsSchema>;
export type TestScoringInput = z.infer<typeof testScoringSchema>;
export type ListScoringRulesQuery = z.infer<typeof listScoringRulesSchema>;
