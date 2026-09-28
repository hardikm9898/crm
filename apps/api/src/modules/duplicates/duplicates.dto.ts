import { z } from 'zod';
import { MATCHABLE_FIELDS } from '@leados/shared';

/**
 * Request shapes for duplicate rules and merges.
 *
 * `matchOn` is validated twice on purpose: the schema checks the shape, and
 * `validateMatchOn` in `@leados/shared` checks whether the criteria would actually discriminate
 * between people. A rule matching on city alone passes any schema and is still a rule that would
 * merge strangers.
 */
const matchableField = z.enum(
  MATCHABLE_FIELDS.map((field) => field.field) as [string, ...string[]],
);

export const createDuplicateRuleSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    /** `[["phoneE164"], ["email", "lastName"]]` — any set, all fields within a set. */
    matchOn: z.array(z.array(matchableField).min(1).max(6)).min(1).max(10),
    lookbackDays: z.coerce.number().int().min(1).max(3650).optional(),
    action: z.enum(['attach_to_existing', 'create_and_link', 'reject', 'create_new']).optional(),
    priority: z.coerce.number().int().min(0).max(9999).optional(),
  })
  .strict();

export const updateDuplicateRuleSchema = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    matchOn: z.array(z.array(matchableField).min(1).max(6)).min(1).max(10).optional(),
    lookbackDays: z.coerce.number().int().min(1).max(3650).optional(),
    action: z.enum(['attach_to_existing', 'create_and_link', 'reject', 'create_new']).optional(),
    priority: z.coerce.number().int().min(0).max(9999).optional(),
    isActive: z.boolean().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, { message: 'Nothing to update' });

export const listDuplicatesSchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(25),
    cursor: z.string().max(200).optional(),
    status: z.enum(['open', 'merged', 'dismissed']).optional(),
    leadId: z.string().uuid().optional(),
    /** Only pairs at or above this confidence — the triage a manager actually does. */
    minConfidence: z.coerce.number().int().min(0).max(100).optional(),
  })
  .strict();

/**
 * A merge.
 *
 * `fieldChoices` names the winner per field, and `merged` is the only value that needs stating —
 * the surviving lead's own value is the default, so a merge with no choices keeps the survivor
 * intact and simply absorbs the other record's children.
 */
export const mergeLeadsSchema = z
  .object({
    survivingLeadId: z.string().uuid(),
    mergedLeadId: z.string().uuid(),
    /** `{ "email": "merged" }` takes the absorbed lead's email. Anything absent keeps the survivor's. */
    fieldChoices: z.record(z.string(), z.enum(['surviving', 'merged'])).optional(),
  })
  .strict();

export const testDuplicateSchema = z
  .object({
    phone: z.string().trim().max(32).optional(),
    whatsapp: z.string().trim().max(32).optional(),
    email: z.string().trim().toLowerCase().max(254).optional(),
    firstName: z.string().trim().max(80).optional(),
    lastName: z.string().trim().max(80).optional(),
    company: z.string().trim().max(160).optional(),
    city: z.string().trim().max(80).optional(),
    postalCode: z.string().trim().max(20).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: 'Give at least one detail to check',
  });

export type CreateDuplicateRuleInput = z.infer<typeof createDuplicateRuleSchema>;
export type UpdateDuplicateRuleInput = z.infer<typeof updateDuplicateRuleSchema>;
export type ListDuplicatesQuery = z.infer<typeof listDuplicatesSchema>;
export type MergeLeadsInput = z.infer<typeof mergeLeadsSchema>;
export type TestDuplicateInput = z.infer<typeof testDuplicateSchema>;
