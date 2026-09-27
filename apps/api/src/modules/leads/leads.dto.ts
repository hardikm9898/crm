import { z } from 'zod';

/**
 * Request shapes for leads.
 *
 * Phone numbers are accepted as typed and normalized by the service, not by the schema: normalization
 * needs the organization's default country, which a schema has no access to. The schema's job is to
 * refuse obvious rubbish early.
 */
const optionalText = (max: number) => z.string().trim().max(max).nullish();

const consent = z
  .object({
    whatsapp: z.boolean().optional(),
    email: z.boolean().optional(),
    calls: z.boolean().optional(),
  })
  .strict();

const utm = z
  .object({
    source: z.string().trim().max(120).optional(),
    medium: z.string().trim().max(120).optional(),
    campaign: z.string().trim().max(200).optional(),
    term: z.string().trim().max(200).optional(),
    content: z.string().trim().max(200).optional(),
    gclid: z.string().trim().max(200).optional(),
    fbclid: z.string().trim().max(200).optional(),
  })
  .strict();

const identity = {
  firstName: optionalText(80),
  lastName: optionalText(80),
  company: optionalText(160),
  jobTitle: optionalText(120),
  phone: z.string().trim().min(4).max(32).nullish(),
  whatsapp: z.string().trim().min(4).max(32).nullish(),
  email: z.string().trim().toLowerCase().email().max(254).nullish(),
  city: optionalText(80),
  state: optionalText(80),
  country: z.string().trim().length(2).toUpperCase().nullish(),
  postalCode: optionalText(20),
};

export const createLeadSchema = z
  .object({
    ...identity,
    /** Either a name or a way to reach them; enforced in the service, which can say why. */
    statusId: z.string().uuid().optional(),
    pipelineId: z.string().uuid().optional(),
    stageId: z.string().uuid().optional(),
    leadSourceId: z.string().uuid().nullish(),
    priority: z.enum(['low', 'medium', 'high', 'urgent']).optional(),
    assignedUserId: z.string().uuid().nullish(),
    branchId: z.string().uuid().nullish(),
    teamId: z.string().uuid().nullish(),
    valueMinor: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullish(),
    currency: z.string().trim().length(3).toUpperCase().nullish(),
    landingPageUrl: z.string().trim().url().max(2000).nullish(),
    utm: utm.optional(),
    consent: consent.optional(),
    tagIds: z.array(z.string().uuid()).max(50).optional(),
    customValues: z.record(z.string(), z.unknown()).optional(),
    createdVia: z
      .enum([
        'manual',
        'form',
        'api',
        'webhook',
        'import',
        'whatsapp',
        'meta_ads',
        'google_ads',
        'website',
      ])
      .optional(),
  })
  .strict();

export const updateLeadSchema = z
  .object({
    ...identity,
    priority: z.enum(['low', 'medium', 'high', 'urgent']).optional(),
    leadSourceId: z.string().uuid().nullish(),
    valueMinor: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullish(),
    currency: z.string().trim().length(3).toUpperCase().nullish(),
    consent: consent.optional(),
    customValues: z.record(z.string(), z.unknown()).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, { message: 'Nothing to update' });

/**
 * Status, stage and assignment are separate endpoints rather than fields on the update.
 *
 * Each is a transition with its own history table, its own timeline entry and its own permission —
 * `lead:assign` is not `lead:update`, and a stage move must check the stage's required fields. Folding
 * them into a general PATCH would make all of that conditional on what happened to be in the body.
 */
export const changeStatusSchema = z
  .object({
    statusId: z.string().uuid(),
    lostReasonId: z.string().uuid().optional(),
    lostNote: z.string().trim().max(1000).optional(),
  })
  .strict();

export const changeStageSchema = z
  .object({
    stageId: z.string().uuid(),
    /** Moving to a stage on a different pipeline is a deliberate act, so it must be named. */
    pipelineId: z.string().uuid().optional(),
  })
  .strict();

export const assignLeadSchema = z
  .object({
    /** Null unassigns, returning the lead to the pool. */
    assignedUserId: z.string().uuid().nullable(),
    teamId: z.string().uuid().nullish(),
    reason: z.string().trim().max(200).optional(),
  })
  .strict();

export const setTagsSchema = z.object({ tagIds: z.array(z.string().uuid()).max(50) }).strict();

export const addTouchpointSchema = z
  .object({
    channel: z.enum([
      'website',
      'form',
      'whatsapp',
      'call',
      'email',
      'meta_ads',
      'google_ads',
      'referral',
      'walk_in',
      'marketplace',
      'import',
      'manual',
      'api',
      'other',
    ]),
    occurredAt: z.coerce.date().optional(),
    leadSourceId: z.string().uuid().nullish(),
    landingPageUrl: z.string().trim().url().max(2000).nullish(),
    utm: utm.optional(),
    sessionId: z.string().trim().max(120).nullish(),
    costAttributable: z.boolean().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export const listLeadsSchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(25),
    cursor: z.string().max(200).optional(),
    search: z.string().trim().max(120).optional(),
    statusId: z.string().uuid().optional(),
    stageId: z.string().uuid().optional(),
    pipelineId: z.string().uuid().optional(),
    leadSourceId: z.string().uuid().optional(),
    assignedUserId: z.string().uuid().optional(),
    tagId: z.string().uuid().optional(),
    priority: z.enum(['low', 'medium', 'high', 'urgent']).optional(),
    /** `unassigned=true` is the manager's most common question. */
    unassigned: z
      .enum(['true', 'false'])
      .optional()
      .transform((value) => value === 'true'),
    /** `noNextAction=true` is the second: who has nobody doing anything next. */
    noNextAction: z
      .enum(['true', 'false'])
      .optional()
      .transform((value) => value === 'true'),
    /** The recycle bin. */
    deleted: z
      .enum(['true', 'false'])
      .optional()
      .transform((value) => value === 'true'),
    sort: z.enum(['created_at', 'updated_at', 'last_activity_at', 'score']).default('created_at'),
    direction: z.enum(['asc', 'desc']).default('desc'),
  })
  .strict();

export const timelineQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(50),
    cursor: z.string().max(200).optional(),
    /** Filter by module (`lead`, `whatsapp`, `task`…) rather than by individual type. */
    module: z.string().trim().max(30).optional(),
    type: z.string().trim().max(60).optional(),
    includeInternal: z
      .enum(['true', 'false'])
      .optional()
      .transform((value) => value !== 'false'),
  })
  .strict();

export type CreateLeadInput = z.infer<typeof createLeadSchema>;
export type UpdateLeadInput = z.infer<typeof updateLeadSchema>;
export type ChangeStatusInput = z.infer<typeof changeStatusSchema>;
export type ChangeStageInput = z.infer<typeof changeStageSchema>;
export type AssignLeadInput = z.infer<typeof assignLeadSchema>;
export type SetTagsInput = z.infer<typeof setTagsSchema>;
export type AddTouchpointInput = z.infer<typeof addTouchpointSchema>;
export type ListLeadsQuery = z.infer<typeof listLeadsSchema>;
export type TimelineQuery = z.infer<typeof timelineQuerySchema>;
