import { z } from 'zod';

/** Every name a tenant types is trimmed and bounded; colours are hex so a UI can rely on them. */
const name = z.string().trim().min(1).max(80);
const colour = z
  .string()
  .trim()
  .regex(/^#[0-9a-fA-F]{6}$/, 'Use a hex colour like #3b5bdb');
const sortOrder = z.coerce.number().int().min(0).max(9999);

export const createStatusSchema = z
  .object({
    name,
    colour: colour.optional(),
    category: z.enum(['open', 'won', 'lost', 'invalid']),
    sortOrder: sortOrder.optional(),
    isDefault: z.boolean().optional(),
  })
  .strict();

/**
 * `category` is changeable, unlike a custom field's type: code branches on the category rather than
 * storing it on the lead, so reclassifying "Quotation sent" from open to won takes effect everywhere
 * at once and rewrites nothing.
 */
export const updateStatusSchema = z
  .object({
    name: name.optional(),
    colour: colour.nullish(),
    category: z.enum(['open', 'won', 'lost', 'invalid']).optional(),
    sortOrder: sortOrder.optional(),
    isDefault: z.boolean().optional(),
    isActive: z.boolean().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, { message: 'Nothing to update' });

export const createSourceSchema = z
  .object({
    name,
    type: z.string().trim().max(40).optional(),
    costModel: z.string().trim().max(40).optional(),
    sortOrder: sortOrder.optional(),
  })
  .strict();

export const updateSourceSchema = z
  .object({
    name: name.optional(),
    type: z.string().trim().max(40).nullish(),
    costModel: z.string().trim().max(40).nullish(),
    sortOrder: sortOrder.optional(),
    isActive: z.boolean().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, { message: 'Nothing to update' });

export const createLostReasonSchema = z
  .object({
    name,
    sortOrder: sortOrder.optional(),
    requiresNote: z.boolean().optional(),
  })
  .strict();

export const updateLostReasonSchema = z
  .object({
    name: name.optional(),
    sortOrder: sortOrder.optional(),
    requiresNote: z.boolean().optional(),
    isActive: z.boolean().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, { message: 'Nothing to update' });

export const createTagSchema = z.object({ name, colour: colour.optional() }).strict();

export const updateTagSchema = z
  .object({ name: name.optional(), colour: colour.nullish() })
  .strict()
  .refine((value) => Object.keys(value).length > 0, { message: 'Nothing to update' });

const stageInput = z
  .object({
    /** Present when editing an existing stage; absent creates one. */
    id: z.string().uuid().optional(),
    name,
    colour: colour.optional(),
    probability: z.coerce.number().int().min(0).max(100).optional(),
    isWon: z.boolean().optional(),
    isLost: z.boolean().optional(),
    /** Custom-field keys and lead columns that must be filled to enter this stage. */
    requiredFields: z.array(z.string().trim().min(1).max(60)).max(50).optional(),
    targetDurationHours: z.coerce.number().int().min(1).max(8760).optional(),
  })
  .strict();

export const createPipelineSchema = z
  .object({
    name,
    isDefault: z.boolean().optional(),
    /** A pipeline with no stages is a board with no columns, so at least one is required. */
    stages: z.array(stageInput).min(1).max(30),
  })
  .strict();

export const updatePipelineSchema = z
  .object({
    name: name.optional(),
    isDefault: z.boolean().optional(),
    isActive: z.boolean().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, { message: 'Nothing to update' });

/** PUT semantics: the stage editor submits the intended final board, in order. */
export const setStagesSchema = z.object({ stages: z.array(stageInput).min(1).max(30) }).strict();

export type CreateStatusInput = z.infer<typeof createStatusSchema>;
export type UpdateStatusInput = z.infer<typeof updateStatusSchema>;
export type CreateSourceInput = z.infer<typeof createSourceSchema>;
export type UpdateSourceInput = z.infer<typeof updateSourceSchema>;
export type CreateLostReasonInput = z.infer<typeof createLostReasonSchema>;
export type UpdateLostReasonInput = z.infer<typeof updateLostReasonSchema>;
export type CreateTagInput = z.infer<typeof createTagSchema>;
export type UpdateTagInput = z.infer<typeof updateTagSchema>;
export type CreatePipelineInput = z.infer<typeof createPipelineSchema>;
export type UpdatePipelineInput = z.infer<typeof updatePipelineSchema>;
export type SetStagesInput = z.infer<typeof setStagesSchema>;
export type StageInput = z.infer<typeof stageInput>;
