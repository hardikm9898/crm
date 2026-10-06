import { z } from 'zod';
import { lineItemSchema } from '../deals/deals.dto.js';

/**
 * Request shapes for quotations (`FR-DEAL-2`).
 *
 * The line shape is imported from the deals DTO rather than restated: a quotation's lines and a
 * deal's lines are the same concept, and two schemas for one concept drift the moment one of them
 * gains a field.
 */

/** A query-string flag that keeps `undefined` as `undefined`, for a three-way filter. */
const booleanFlag = z
  .enum(['true', 'false'])
  .optional()
  .transform((value) => (value === undefined ? undefined : value === 'true'));

export const QUOTATION_STATUSES = ['draft', 'sent', 'accepted', 'rejected', 'expired'] as const;
export const QUOTATION_CHANNELS = ['email', 'whatsapp', 'link', 'manual'] as const;

export const createQuotationSchema = z
  .object({
    /** Normally a deal; `quotations_has_subject` requires one of the three. */
    dealId: z.string().uuid().optional(),
    leadId: z.string().uuid().optional(),
    customerId: z.string().uuid().optional(),
    title: z.string().trim().min(1).max(200).optional(),
    terms: z.string().trim().max(5000).nullish(),
    validUntil: z.coerce.date().optional(),
    currency: z.string().trim().length(3).toUpperCase().optional(),
    /**
     * Omitted means "copy the deal's lines", which is what raising a quotation from a deal means.
     * An explicit empty array means an empty quotation, and is honoured.
     */
    items: z.array(lineItemSchema).max(200).optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.dealId !== undefined || value.leadId !== undefined || value.customerId !== undefined,
    { message: 'Say who the quotation is for — a deal, a lead or a customer' },
  );
export type CreateQuotationInput = z.infer<typeof createQuotationSchema>;

export const updateQuotationSchema = z
  .object({
    title: z.string().trim().min(1).max(200).nullish(),
    terms: z.string().trim().max(5000).nullish(),
    validUntil: z.coerce.date().nullish(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, { message: 'Nothing to update' });
export type UpdateQuotationInput = z.infer<typeof updateQuotationSchema>;

export const setQuotationItemsSchema = z
  .object({ items: z.array(lineItemSchema).max(200) })
  .strict();
export type SetQuotationItemsInput = z.infer<typeof setQuotationItemsSchema>;

export const sendQuotationSchema = z
  .object({
    /**
     * How it went out. `manual` is the honest option for "I printed it and handed it over", and it
     * is the default because the product does not yet deliver email or WhatsApp itself.
     */
    via: z.enum(QUOTATION_CHANNELS).default('manual'),
    /** The address or number it went to, as evidence. Not validated as a contact: it is a record. */
    to: z.string().trim().max(320).optional(),
    sentAt: z.coerce.date().optional(),
  })
  .strict();
export type SendQuotationInput = z.infer<typeof sendQuotationSchema>;

export const acceptQuotationSchema = z
  .object({
    acceptedAt: z.coerce.date().optional(),
    note: z.string().trim().max(1000).optional(),
  })
  .strict();
export type AcceptQuotationInput = z.infer<typeof acceptQuotationSchema>;

export const rejectQuotationSchema = z
  .object({
    /** The tenant's own `lost_reasons` — the same list a lost deal uses, never a free-text enum. */
    reasonId: z.string().uuid().optional(),
    note: z.string().trim().max(1000).optional(),
    rejectedAt: z.coerce.date().optional(),
  })
  .strict();
export type RejectQuotationInput = z.infer<typeof rejectQuotationSchema>;

export const reviseQuotationSchema = z
  .object({
    /** Omitted copies the version being revised, which is what "revise" nearly always means. */
    items: z.array(lineItemSchema).max(200).optional(),
    title: z.string().trim().min(1).max(200).nullish(),
    terms: z.string().trim().max(5000).nullish(),
    validUntil: z.coerce.date().nullish(),
  })
  .strict();
export type ReviseQuotationInput = z.infer<typeof reviseQuotationSchema>;

export const listQuotationsSchema = z
  .object({
    dealId: z.string().uuid().optional(),
    leadId: z.string().uuid().optional(),
    customerId: z.string().uuid().optional(),
    ownerUserId: z.string().uuid().optional(),
    status: z.enum(QUOTATION_STATUSES).optional(),
    number: z.string().trim().min(1).max(60).optional(),
    /**
     * Superseded versions are hidden by default: a list of quotations means a list of the current
     * ones, and showing six versions of the same number as six rows is the first thing anybody
     * complains about. `?versions=all` is the history.
     */
    versions: z.enum(['current', 'all']).default('current'),
    deleted: booleanFlag,
    limit: z.coerce.number().int().min(1).max(100).default(25),
    cursor: z.string().uuid().optional(),
    sort: z.enum(['created_at', 'total', 'valid_until']).default('created_at'),
    direction: z.enum(['asc', 'desc']).default('desc'),
  })
  .strict();
export type ListQuotationsQuery = z.infer<typeof listQuotationsSchema>;

export const updateNumberSeriesSchema = z
  .object({
    prefix: z.string().trim().max(20),
    padding: z.coerce.number().int().min(0).max(12),
    /**
     * Only ever moved **forward**: rewinding a counter would hand a number that is already in a
     * customer's inbox to a second document.
     */
    nextValue: z.coerce.number().int().min(1).optional(),
  })
  .strict();
export type UpdateNumberSeriesInput = z.infer<typeof updateNumberSeriesSchema>;
