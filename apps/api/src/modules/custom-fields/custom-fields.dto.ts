import { z } from 'zod';
import { CUSTOM_FIELD_ENTITIES, CUSTOM_FIELD_TYPES, isValidCustomFieldKey } from '@leados/shared';

/**
 * Request shapes for the field builder.
 *
 * `key` is validated here against the same rule the database CHECK enforces and the same helper the
 * filter DSL uses — three places, one definition, because a key that passes one and fails another is
 * a field that can be created and never used.
 */
const entityType = z.enum(CUSTOM_FIELD_ENTITIES);

const optionInput = z
  .object({
    value: z.string().trim().min(1).max(80),
    label: z.string().trim().min(1).max(120),
    colour: z
      .string()
      .trim()
      .regex(/^#[0-9a-fA-F]{6}$/, 'Use a hex colour like #3b5bdb')
      .optional(),
    sortOrder: z.coerce.number().int().min(0).max(9999).optional(),
    isActive: z.boolean().optional(),
  })
  .strict();

export const createFieldSchema = z
  .object({
    entityType,
    key: z
      .string()
      .trim()
      .toLowerCase()
      .refine(
        isValidCustomFieldKey,
        'Use lowercase letters, numbers and underscores; not a reserved name',
      ),
    label: z.string().trim().min(1).max(120),
    type: z.enum(CUSTOM_FIELD_TYPES),
    placeholder: z.string().trim().max(160).optional(),
    helpText: z.string().trim().max(400).optional(),
    isRequired: z.boolean().optional(),
    defaultValue: z.unknown().optional(),
    validation: z.record(z.string(), z.unknown()).optional(),
    sectionId: z.string().uuid().optional(),
    sortOrder: z.coerce.number().int().min(0).max(9999).optional(),
    showInList: z.boolean().optional(),
    isSearchable: z.boolean().optional(),
    isFilterable: z.boolean().optional(),
    isIndexed: z.boolean().optional(),
    isPii: z.boolean().optional(),
    options: z.array(optionInput).max(200).optional(),
  })
  .strict();

/**
 * `key`, `entityType` and `type` are absent by design: all three appear in stored values, saved
 * views, import mappings and index names, so changing one would orphan every value already written.
 * Deactivating the field and creating a new one is the honest path, and keeps history readable.
 */
export const updateFieldSchema = z
  .object({
    label: z.string().trim().min(1).max(120).optional(),
    placeholder: z.string().trim().max(160).nullish(),
    helpText: z.string().trim().max(400).nullish(),
    isRequired: z.boolean().optional(),
    defaultValue: z.unknown().optional(),
    validation: z.record(z.string(), z.unknown()).optional(),
    sectionId: z.string().uuid().nullish(),
    sortOrder: z.coerce.number().int().min(0).max(9999).optional(),
    showInList: z.boolean().optional(),
    isSearchable: z.boolean().optional(),
    isFilterable: z.boolean().optional(),
    isIndexed: z.boolean().optional(),
    isPii: z.boolean().optional(),
    isActive: z.boolean().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, { message: 'Nothing to update' });

export const setOptionsSchema = z.object({ options: z.array(optionInput).max(200) }).strict();

export const createSectionSchema = z
  .object({
    entityType,
    name: z.string().trim().min(1).max(80),
    sortOrder: z.coerce.number().int().min(0).max(9999).optional(),
    collapsedByDefault: z.boolean().optional(),
  })
  .strict();

export const updateSectionSchema = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    sortOrder: z.coerce.number().int().min(0).max(9999).optional(),
    collapsedByDefault: z.boolean().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, { message: 'Nothing to update' });

export const listFieldsSchema = z
  .object({
    entityType: entityType.optional(),
    includeInactive: z
      .enum(['true', 'false'])
      .optional()
      .transform((value) => value === 'true'),
  })
  .strict();

export type CreateFieldInput = z.infer<typeof createFieldSchema>;
export type UpdateFieldInput = z.infer<typeof updateFieldSchema>;
export type SetOptionsInput = z.infer<typeof setOptionsSchema>;
export type CreateSectionInput = z.infer<typeof createSectionSchema>;
export type UpdateSectionInput = z.infer<typeof updateSectionSchema>;
export type ListFieldsQuery = z.infer<typeof listFieldsSchema>;
