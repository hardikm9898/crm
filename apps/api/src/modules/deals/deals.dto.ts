import { z } from 'zod';

/**
 * Request shapes for products, deals and their line items.
 *
 * Line-item money is **minor units and whole numbers** everywhere, because that is what the
 * arithmetic in `@leados/shared` takes and the only place a rupee becomes paise should be the screen
 * a person types into. Quantity is the one fractional input, with three decimal places.
 */
const optionalText = (max: number) => z.string().trim().max(max).nullish();

/** A query-string flag that keeps `undefined` as `undefined`, for a three-way filter. */
const booleanFlag = z
  .enum(['true', 'false'])
  .optional()
  .transform((value) => (value === undefined ? undefined : value === 'true'));

const moneyMinor = z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const taxPercent = z.coerce.number().min(0).max(100);

// ── Products ────────────────────────────────────────────────────────────────

export const createProductSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    sku: z.string().trim().min(1).max(60).nullish(),
    description: optionalText(2000),
    category: optionalText(80),
    priceMinor: moneyMinor.default(0),
    currency: z.string().trim().length(3).toUpperCase().nullish(),
    taxPercent: taxPercent.default(0),
    unit: optionalText(20),
  })
  .strict();
export type CreateProductInput = z.infer<typeof createProductSchema>;

export const updateProductSchema = createProductSchema
  .partial()
  .extend({ isActive: z.boolean().optional() })
  .strict()
  .refine((value) => Object.keys(value).length > 0, { message: 'Nothing to update' });
export type UpdateProductInput = z.infer<typeof updateProductSchema>;

export const listProductsSchema = z
  .object({
    search: z.string().trim().min(1).max(120).optional(),
    category: z.string().trim().min(1).max(80).optional(),
    active: booleanFlag,
    limit: z.coerce.number().int().min(1).max(200).default(50),
    cursor: z.string().uuid().optional(),
  })
  .strict();
export type ListProductsQuery = z.infer<typeof listProductsSchema>;

// ── Line items ──────────────────────────────────────────────────────────────

/**
 * One line, as a client sends it. **Exported**, because a quotation's lines are the same shape by
 * design — one schema for one concept, the same reason there is one `LineBuilderService` and one
 * `lineTotals()`.
 *
 * The name, price and tax rate are **sent**, not looked up from `productId` at write time: a line
 * states what was agreed, and a later price change must not rewrite it. `productId` is for
 * reporting, and the API fills the three from the product only when the client omits them — which
 * is the convenience of picking a product from the catalogue.
 */
export const lineItemSchema = z
  .object({
    productId: z.string().uuid().nullish(),
    name: z.string().trim().min(1).max(200).optional(),
    description: optionalText(1000),
    quantity: z.coerce.number().positive().max(1_000_000),
    unit: optionalText(20),
    unitPriceMinor: moneyMinor.optional(),
    discountMinor: moneyMinor.default(0),
    taxPercent: taxPercent.optional(),
  })
  .strict()
  .refine(
    (value) =>
      (value.productId !== null && value.productId !== undefined) ||
      (value.name !== undefined && value.unitPriceMinor !== undefined),
    { message: 'Give a product, or a name and a price' },
  );

// ── Deals ───────────────────────────────────────────────────────────────────

export const createDealSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    /** At least one of these two: a deal attached to nobody is a forecast of money from nowhere. */
    leadId: z.string().uuid().optional(),
    customerId: z.string().uuid().optional(),
    pipelineId: z.string().uuid().optional(),
    stageId: z.string().uuid().optional(),
    ownerUserId: z.string().uuid().nullish(),
    /** Only used when there are no line items; with items the total is the sum of the lines. */
    valueMinor: moneyMinor.optional(),
    currency: z.string().trim().length(3).toUpperCase().optional(),
    probability: z.coerce.number().int().min(0).max(100).optional(),
    expectedCloseDate: z.coerce.date().optional(),
    items: z.array(lineItemSchema).max(200).optional(),
    customValues: z.record(z.string(), z.unknown()).optional(),
  })
  .strict()
  .refine((value) => value.leadId !== undefined || value.customerId !== undefined, {
    message: 'Say who the deal is with — a lead, a customer, or both',
  });
export type CreateDealInput = z.infer<typeof createDealSchema>;

export const updateDealSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    ownerUserId: z.string().uuid().nullish(),
    valueMinor: moneyMinor.optional(),
    probability: z.coerce.number().int().min(0).max(100).optional(),
    expectedCloseDate: z.coerce.date().nullish(),
    customValues: z.record(z.string(), z.unknown()).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, { message: 'Nothing to update' });
export type UpdateDealInput = z.infer<typeof updateDealSchema>;

/**
 * Replacing the line items, as a whole list.
 *
 * `PUT` semantics rather than per-item endpoints: a line-items editor submits the table it has, and
 * three endpoints (add, edit, remove) would make reordering a sequence of writes that can half-fail.
 */
export const setDealItemsSchema = z.object({ items: z.array(lineItemSchema).max(200) }).strict();
export type SetDealItemsInput = z.infer<typeof setDealItemsSchema>;

export const moveDealSchema = z
  .object({
    stageId: z.string().uuid(),
    /** Moving to a stage on a different pipeline is a deliberate act, so it must be named. */
    pipelineId: z.string().uuid().optional(),
  })
  .strict();
export type MoveDealInput = z.infer<typeof moveDealSchema>;

export const winDealSchema = z
  .object({
    /** Defaults to now. Backdating a win is legitimate — the paperwork follows the handshake. */
    wonAt: z.coerce.date().optional(),
    note: z.string().trim().max(1000).optional(),
  })
  .strict();
export type WinDealInput = z.infer<typeof winDealSchema>;

export const loseDealSchema = z
  .object({
    lostReasonId: z.string().uuid().optional(),
    note: z.string().trim().max(1000).optional(),
    lostAt: z.coerce.date().optional(),
  })
  .strict();
export type LoseDealInput = z.infer<typeof loseDealSchema>;

export const listDealsSchema = z
  .object({
    search: z.string().trim().min(1).max(120).optional(),
    leadId: z.string().uuid().optional(),
    customerId: z.string().uuid().optional(),
    ownerUserId: z.string().uuid().optional(),
    pipelineId: z.string().uuid().optional(),
    stageId: z.string().uuid().optional(),
    /** Defaults to `any`: a list screen shows the whole pipeline until somebody narrows it. */
    outcome: z.enum(['open', 'won', 'lost', 'any']).default('any'),
    closingBefore: z.coerce.date().optional(),
    deleted: booleanFlag,
    limit: z.coerce.number().int().min(1).max(100).default(25),
    cursor: z.string().uuid().optional(),
    sort: z
      .enum(['created_at', 'updated_at', 'value', 'expected_close_date'])
      .default('created_at'),
    direction: z.enum(['asc', 'desc']).default('desc'),
  })
  .strict();
export type ListDealsQuery = z.infer<typeof listDealsSchema>;

export const dealBoardSchema = z
  .object({
    pipelineId: z.string().uuid().optional(),
    /** Per column, like the lead board: a column with 14 000 deals must return ten. */
    limit: z.coerce.number().int().min(1).max(50).default(10),
  })
  .strict();
export type DealBoardQuery = z.infer<typeof dealBoardSchema>;

export const dealTimelineSchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(50),
    /** Opaque and base64url: it carries both halves of `activities`' partitioned key. */
    cursor: z.string().max(200).optional(),
  })
  .strict();
export type DealTimelineQuery = z.infer<typeof dealTimelineSchema>;
