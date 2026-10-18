import { z } from 'zod';
import { WEBHOOK_DELIVERY_STATUSES, WEBHOOK_EVENT_TYPES } from '@leados/shared';

/**
 * Request shapes for outbound webhooks (`FR-API-4`).
 *
 * The URL is only *shaped* here — `https://`, no credentials, a real URL. Whether it is somewhere
 * we may post to needs DNS and the deployment's own policy, so it is decided by
 * `WebhookUrlService`: the same division the import's dry run paid for, where a check that needs
 * information a schema does not have belongs where that information is.
 */
export const createWebhookEndpointSchema = z
  .object({
    url: z.string().trim().url().max(2_000),
    description: z.string().trim().max(200).optional(),
    /**
     * At least one, from the catalogue. `WEBHOOK_EVENT_TYPES` is what the product actually emits,
     * so a client cannot subscribe to an event that will never arrive.
     */
    eventTypes: z.array(z.enum(WEBHOOK_EVENT_TYPES)).min(1).max(WEBHOOK_EVENT_TYPES.length),
  })
  .strict();

export const updateWebhookEndpointSchema = z
  .object({
    url: z.string().trim().url().max(2_000).optional(),
    description: z.string().trim().max(200).nullish(),
    eventTypes: z
      .array(z.enum(WEBHOOK_EVENT_TYPES))
      .min(1)
      .max(WEBHOOK_EVENT_TYPES.length)
      .optional(),
    /**
     * Switching an endpoint back on is the same field as switching it off, and it clears the
     * failure count: an endpoint re-enabled with fourteen failures still on it would disable itself
     * again on the next bad afternoon, which reads as the product refusing to be fixed.
     */
    isActive: z.boolean().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, { message: 'Nothing to update' });

export const listDeliveriesSchema = z
  .object({
    endpointId: z.string().uuid().optional(),
    status: z.enum(WEBHOOK_DELIVERY_STATUSES).optional(),
    eventType: z.string().trim().max(60).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(25),
    cursor: z.string().uuid().optional(),
  })
  .strict();

export type CreateWebhookEndpointInput = z.infer<typeof createWebhookEndpointSchema>;
export type UpdateWebhookEndpointInput = z.infer<typeof updateWebhookEndpointSchema>;
export type ListDeliveriesQuery = z.infer<typeof listDeliveriesSchema>;
