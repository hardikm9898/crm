import { z } from 'zod';

/**
 * Reading the request log (`FR-API-1`, `FR-SA-4`).
 *
 * `since` defaults to the last day in the service rather than here, so the default appears in the
 * response's `meta` and a screen can say which window it is showing.
 */
export const listApiLogsSchema = z
  .object({
    apiKeyId: z.string().uuid().optional(),
    method: z.enum(['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'HEAD', 'OPTIONS']).optional(),
    /**
     * Absent means every status. Not a boolean `failed` flag: "refused" (the caller can fix it) and
     * "failed" (we must) are different problems with different owners, and collapsing them would
     * hide the only rows on this screen that are ours.
     */
    status: z.enum(['success', 'client_error', 'server_error']).optional(),
    since: z.coerce.date().optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
  })
  .strict();

export type ListApiLogsQuery = z.infer<typeof listApiLogsSchema>;
