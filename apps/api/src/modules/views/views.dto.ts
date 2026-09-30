import { z } from 'zod';
import { FILTER_OPERATORS, LEAD_SORTABLE_FIELDS, VIEW_VISIBILITIES } from '@leados/shared';

/**
 * Request shapes for saved views.
 *
 * The filter itself is validated against the **tenant's** field catalogue in
 * `FilterCompilerService`, not here: whether `custom.budget` exists is a question about rows, and a
 * Zod schema cannot know the answer. What this layer does is refuse the shapes that are wrong for
 * everybody — an unknown operator, a name nobody can read, a sort on a column with no index.
 */
const conditionInput = z
  .object({
    field: z.string().trim().min(1).max(80),
    operator: z.enum(FILTER_OPERATORS),
    value: z.unknown().optional(),
    groupIndex: z.coerce.number().int().min(0).max(20).optional(),
  })
  .strict();

const filterInput = z.object({ conditions: z.array(conditionInput).max(40) }).strict();

const sortInput = z
  .object({
    field: z.enum(LEAD_SORTABLE_FIELDS),
    direction: z.enum(['asc', 'desc']).default('desc'),
  })
  .strict();

export const createViewSchema = z
  .object({
    entityType: z.enum(['lead']).default('lead'),
    name: z.string().trim().min(1).max(60),
    filters: filterInput,
    columns: z.array(z.string().trim().min(1).max(80)).max(30).optional(),
    sort: sortInput.optional(),
    visibility: z.enum(VIEW_VISIBILITIES).default('private'),
    /** Required when `visibility` is `team`. */
    teamId: z.string().uuid().nullish(),
    defaultForRoleId: z.string().uuid().nullish(),
  })
  .strict();

export const updateViewSchema = z
  .object({
    name: z.string().trim().min(1).max(60).optional(),
    filters: filterInput.optional(),
    columns: z.array(z.string().trim().min(1).max(80)).max(30).optional(),
    sort: sortInput.optional(),
    visibility: z.enum(VIEW_VISIBILITIES).optional(),
    teamId: z.string().uuid().nullish(),
    defaultForRoleId: z.string().uuid().nullish(),
    sortOrder: z.coerce.number().int().min(0).max(999).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, { message: 'Nothing to update' });

export const listViewsSchema = z.object({ entityType: z.enum(['lead']).default('lead') }).strict();

/**
 * The lead search body (`FR-VIEW-2`).
 *
 * A POST rather than a GET with a query string: a filter is a nested object, and a saved view's
 * filter can exceed what a URL should carry. `viewId` and `filter` are alternatives — running a
 * saved view must go through the same code path as running an ad-hoc filter, or the two drift.
 */
export const searchLeadsSchema = z
  .object({
    viewId: z.string().uuid().optional(),
    filter: filterInput.optional(),
    sort: sortInput.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(25),
    cursor: z.string().max(200).optional(),
    /** Overrides the clock, so a named window ("today") is testable at any hour. */
    at: z.coerce.date().optional(),
    /** The recycle bin, for parity with `GET /leads`. */
    deleted: z.boolean().optional(),
  })
  .strict()
  .refine((value) => value.viewId !== undefined || value.filter !== undefined, {
    message: 'Give a viewId or a filter',
  });

export type CreateViewInput = z.infer<typeof createViewSchema>;
export type UpdateViewInput = z.infer<typeof updateViewSchema>;
export type ListViewsQuery = z.infer<typeof listViewsSchema>;
export type SearchLeadsInput = z.infer<typeof searchLeadsSchema>;
