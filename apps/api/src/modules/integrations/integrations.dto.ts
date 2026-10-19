import { z } from 'zod';
import {
  INTEGRATION_PROVIDER_KEYS,
  INTEGRATION_STATUSES,
  MAPPING_TRANSFORMS,
  PROBE_OUTCOMES,
} from '@leados/shared';
import { publicLeadSchema } from '../ingestion/ingestion.dto.js';

/**
 * Request shapes for the integration framework.
 *
 * The division is the one the import's dry run paid for: this file checks **shape**, and meaning —
 * is `postmark` a provider we have an adapter for, is `custom.budget` a field this workspace has,
 * would this mapping quietly overwrite itself — is checked by the service and by
 * `mappingProblems`, which have the information a schema does not.
 *
 * `provider` is a plain string with a length bound rather than a `z.enum`: the registry is the one
 * place that decides what exists, and a schema listing providers would be a second list to forget.
 * The published OpenAPI document still names them, because it reads the catalogue.
 */
export const fieldMappingSchema = z
  .object({
    source: z.string().trim().min(1).max(200),
    target: z.string().trim().min(1).max(140),
    transform: z.enum(MAPPING_TRANSFORMS).optional(),
  })
  .strict();

export const connectIntegrationSchema = z
  .object({
    provider: z.string().trim().min(1).max(60),
    name: z.string().trim().min(1).max(120),
    /**
     * The provider's token, for an `api_key` provider. **Absent** for a `shared_secret` one, where
     * we generate it: the adapter refuses a value rather than ignoring it, because a connection
     * whose secret is not the one the sender was told about fails every signature check.
     */
    credential: z.string().min(1).max(4_000).optional(),
    externalAccountId: z.string().trim().max(200).optional(),
    settings: z.record(z.string().max(60), z.unknown()).default({}),
    fieldMappings: z.array(fieldMappingSchema).max(100).optional(),
  })
  .strict();

export const updateIntegrationSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    /** A new token for the same connection. The old one stops being used the moment this returns. */
    credential: z.string().min(1).max(4_000).optional(),
    externalAccountId: z.string().trim().max(200).nullish(),
    settings: z.record(z.string().max(60), z.unknown()).optional(),
    fieldMappings: z.array(fieldMappingSchema).max(100).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, { message: 'Nothing to update' });

export const listIntegrationsSchema = z
  .object({
    provider: z.string().trim().max(60).optional(),
    status: z.enum(INTEGRATION_STATUSES).optional(),
    /**
     * Three-way on purpose, and `undefined` stays `undefined`: absent means "the live ones",
     * `true` means "the disconnected ones" and `false` is the explicit live filter. A
     * `z.enum(['true','false']).transform(v => v === 'true')` would fold absent to `false`, which
     * is right for `deleted` and wrong for any filter where absent is not one of the two answers.
     */
    disconnected: z
      .enum(['true', 'false'])
      .optional()
      .transform((value) => (value === undefined ? undefined : value === 'true')),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();

export const listHealthChecksSchema = z
  .object({
    connectionId: z.string().uuid().optional(),
    outcome: z.enum(PROBE_OUTCOMES).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(25),
  })
  .strict();

/**
 * The mapping preview (`FR-CAP-6`'s test tool, for a mapped provider).
 *
 * A payload in the **sender's** own shape, which is why it is a permissive record and not
 * `publicLeadSchema`: the whole question is what their field names become. The mapped result is
 * then checked against `publicLeadSchema` by the same code the real capture uses.
 */
export const previewMappingSchema = z
  .object({
    payload: z.record(z.string().max(200), z.unknown()),
    /** A mapping to try instead of the stored one, so somebody can edit before saving. */
    fieldMappings: z.array(fieldMappingSchema).max(100).optional(),
  })
  .strict();

/** What the preview answers, for a reader of the generated document. */
export const capturedLeadPreviewSchema = publicLeadSchema;

export const PROVIDER_KEYS = INTEGRATION_PROVIDER_KEYS;

export type ConnectIntegrationInput = z.infer<typeof connectIntegrationSchema>;
export type UpdateIntegrationInput = z.infer<typeof updateIntegrationSchema>;
export type ListIntegrationsQuery = z.infer<typeof listIntegrationsSchema>;
export type ListHealthChecksQuery = z.infer<typeof listHealthChecksSchema>;
export type PreviewMappingInput = z.infer<typeof previewMappingSchema>;
