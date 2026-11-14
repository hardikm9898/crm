import { z } from 'zod';
import { REDIRECT_KINDS, WEBSITE_PAGE_STATUSES } from '@leados/shared';

/**
 * Validators for the website endpoints (`FR-WEB-1`, `FR-WEB-2`, `FR-WEB-5`).
 *
 * `ZodBody` exposes these to the OpenAPI generator, so the document that describes an endpoint is
 * the validator that guards it and the two cannot drift. Nothing here re-implements the vocabulary
 * in `@leados/shared`: the subdomain and page-path rules live there, are enforced by CHECK
 * constraints, and are applied by the service — a schema that also normalized them would be a
 * second answer to one question, which is the `ERROR_COPY` shape in a field rather than a message.
 */

export const createWebsiteSchema = z.object({
  name: z.string().trim().min(1).max(200),
  /** Raw, as somebody typed it. `normalizeSubdomain` runs in the service. */
  subdomain: z.string().trim().min(1).max(120),
  templateCode: z.string().trim().min(1).max(64).optional(),
});
export type CreateWebsiteInput = z.infer<typeof createWebsiteSchema>;

export const updateWebsiteSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    subdomain: z.string().trim().min(1).max(120).optional(),
    theme: z.record(z.string(), z.unknown()).optional(),
    seoDefaults: z.record(z.string(), z.unknown()).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, 'Change at least one thing.');
export type UpdateWebsiteInput = z.infer<typeof updateWebsiteSchema>;

export const listWebsitesSchema = z.object({
  /**
   * Three-way on purpose. `z.enum(['true','false']).transform(v => v === 'true')` folds an absent
   * parameter to `false`, which is right for a `deleted` flag and wrong here: absent means "both",
   * and defaulting it would silently return half the list.
   */
  status: z.enum(['draft', 'published']).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});
export type ListWebsitesQuery = z.infer<typeof listWebsitesSchema>;

export const createPageSchema = z.object({
  /** Raw, as somebody typed it. `normalizePagePath` runs in the service. */
  path: z.string().trim().min(1).max(512),
  title: z.string().trim().min(1).max(200),
  blocks: z.array(z.unknown()).optional(),
  seo: z.record(z.string(), z.unknown()).optional(),
  isHome: z.boolean().optional(),
  sortOrder: z.number().int().min(0).max(10_000).optional(),
  status: z.enum(WEBSITE_PAGE_STATUSES).optional(),
});
export type CreatePageInput = z.infer<typeof createPageSchema>;

export const updatePageSchema = z
  .object({
    path: z.string().trim().min(1).max(512).optional(),
    title: z.string().trim().min(1).max(200).optional(),
    blocks: z.array(z.unknown()).optional(),
    seo: z.record(z.string(), z.unknown()).optional(),
    isHome: z.boolean().optional(),
    sortOrder: z.number().int().min(0).max(10_000).optional(),
    status: z.enum(WEBSITE_PAGE_STATUSES).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, 'Change at least one thing.');
export type UpdatePageInput = z.infer<typeof updatePageSchema>;

export const rollbackSchema = z.object({
  /** The version whose snapshot to restore. A rollback writes a new version carrying it. */
  versionId: z.string().uuid(),
});
export type RollbackInput = z.infer<typeof rollbackSchema>;

/**
 * A redirect (`FR-WEB-3`).
 *
 * `fromPath` and `toPath` arrive raw, as the subdomain and page path do: `normalizePagePath` and
 * `redirectTargetProblem` run in the service, next to the chain collapse they inform, and the
 * CHECK constraints are what make "something else wrote this row" unrepresentable.
 *
 * Note which rules are **not** here. "The destination may be a path or a full address" is in
 * `redirectTargetProblem`, because the same rule is installed as a CHECK and the two have to be
 * one statement. A schema that also expressed it would be a third copy, and the one that was wrong
 * would be the one nothing ran.
 */
export const createRedirectSchema = z.object({
  fromPath: z.string().trim().min(1).max(512),
  toPath: z.string().trim().min(1).max(1024),
  kind: z.enum(REDIRECT_KINDS).optional(),
  note: z.string().trim().max(500).optional(),
});
export type CreateRedirectInput = z.infer<typeof createRedirectSchema>;

export const updateRedirectSchema = z
  .object({
    fromPath: z.string().trim().min(1).max(512).optional(),
    toPath: z.string().trim().min(1).max(1024).optional(),
    kind: z.enum(REDIRECT_KINDS).optional(),
    note: z.string().trim().max(500).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, 'Change at least one thing.');
export type UpdateRedirectInput = z.infer<typeof updateRedirectSchema>;
