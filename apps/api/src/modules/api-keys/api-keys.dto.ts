import { z } from 'zod';
import { API_KEY_SCOPES } from '@leados/shared';

/**
 * Request shapes for API keys (`FR-API-2`, `FR-CAP-7`).
 *
 * The IP allowlist is validated as CIDR or a bare address here rather than in the service, because
 * a malformed entry would otherwise lock a key out of every address — including the one the person
 * is testing from — with a refusal that names no field.
 */
const cidr = z
  .string()
  .trim()
  .regex(
    /^(\d{1,3}\.){3}\d{1,3}(\/(3[0-2]|[12]?\d))?$|^([0-9a-fA-F:]+)(\/(12[0-8]|1[01]\d|[1-9]?\d))?$/,
    'Use an address like 203.0.113.7 or a range like 203.0.113.0/24',
  );

export const createApiKeySchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    /** At least one: a key with no scopes can do nothing, and the database says so too. */
    scopes: z.array(z.enum(API_KEY_SCOPES)).min(1).max(API_KEY_SCOPES.length),
    ipAllowlist: z.array(cidr).max(20).optional(),
    rateLimitPerMin: z.coerce.number().int().min(1).max(10_000).nullish(),
    expiresAt: z.coerce.date().optional(),
  })
  .strict();

export const updateApiKeySchema = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    scopes: z.array(z.enum(API_KEY_SCOPES)).min(1).max(API_KEY_SCOPES.length).optional(),
    ipAllowlist: z.array(cidr).max(20).optional(),
    rateLimitPerMin: z.coerce.number().int().min(1).max(10_000).nullish(),
    expiresAt: z.coerce.date().nullish(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, { message: 'Nothing to update' });

export const listApiKeysSchema = z
  .object({
    /** Absent means both. A revoked key is history somebody may need to read. */
    revoked: z
      .enum(['true', 'false'])
      .optional()
      .transform((value) => (value === undefined ? undefined : value === 'true')),
  })
  .strict();

export type CreateApiKeyInput = z.infer<typeof createApiKeySchema>;
export type UpdateApiKeyInput = z.infer<typeof updateApiKeySchema>;
export type ListApiKeysQuery = z.infer<typeof listApiKeysSchema>;
