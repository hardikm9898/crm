import { FILTER_OPERATORS } from '@leados/shared';
import { z } from 'zod';

/**
 * Request shapes for exports.
 *
 * The filter is the **same** DSL the lead list and saved views use, deliberately: "export what I am
 * looking at" has to mean exactly that, and a second filter language for exports would drift from
 * the first within a release. So this schema accepts a `viewId` or a `filter`, exactly as
 * `POST /leads/search` does, and the compiler is shared.
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

export const createExportSchema = z
  .object({
    entityType: z.literal('lead').default('lead'),
    viewId: z.string().uuid().optional(),
    filter: filterInput.optional(),
    /** Omitted means the default column set, which is what a person expects on a spreadsheet. */
    columns: z.array(z.string().trim().min(1).max(80)).min(1).max(60).optional(),
    /** The recycle bin, for parity with the list it is exporting. */
    deleted: z.boolean().optional(),
    /** Overrides the clock so a named window ("today") is reproducible. */
    at: z.coerce.date().optional(),
  })
  .strict();
export type CreateExportInput = z.infer<typeof createExportSchema>;

export const listExportsSchema = z
  .object({
    status: z.enum(['queued', 'running', 'completed', 'failed']).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    cursor: z.string().uuid().optional(),
  })
  .strict();
export type ListExportsQuery = z.infer<typeof listExportsSchema>;
