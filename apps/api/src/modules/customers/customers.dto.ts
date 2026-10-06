import { z } from 'zod';

/**
 * Request shapes for customers.
 *
 * Phone numbers are accepted as typed and normalized by the service, which needs the
 * organization's default country — exactly as on leads, and for the same reason.
 */
const optionalText = (max: number) => z.string().trim().max(max).nullish();

/**
 * A `?flag=true` query parameter.
 *
 * A query string carries strings, so `z.boolean()` refuses `"true"`. The transform keeps
 * `undefined` as `undefined` rather than folding it to `false`, which matters for a three-way
 * filter: `converted` absent means "both kinds", and collapsing it would silently return only the
 * customers who were never leads.
 */
const booleanFlag = z
  .enum(['true', 'false'])
  .optional()
  .transform((value) => (value === undefined ? undefined : value === 'true'));

const identity = {
  firstName: optionalText(80),
  lastName: optionalText(80),
  company: optionalText(160),
  jobTitle: optionalText(120),
  phone: z.string().trim().min(4).max(32).nullish(),
  whatsapp: z.string().trim().min(4).max(32).nullish(),
  email: z.string().trim().toLowerCase().email().max(254).nullish(),
  timezone: optionalText(64),
};

const billing = {
  billingLine1: optionalText(200),
  billingLine2: optionalText(200),
  city: optionalText(80),
  state: optionalText(80),
  country: z.string().trim().length(2).toUpperCase().nullish(),
  postalCode: optionalText(20),
  /** GSTIN, VAT number, whatever this country uses. Bounded, not pattern-checked. */
  taxId: z.string().trim().min(4).max(40).nullish(),
};

const consent = z
  .object({
    whatsapp: z.boolean().optional(),
    email: z.boolean().optional(),
    calls: z.boolean().optional(),
  })
  .strict();

/**
 * Converting a lead (`FR-DEAL-4`).
 *
 * Everything is optional because the lead already knows it. What the body is *for* is the handful of
 * things a lead does not have: who manages the account, and where the invoice goes.
 */
export const convertLeadSchema = z
  .object({
    ownerUserId: z.string().uuid().nullish(),
    ...billing,
    /** Recorded on the timeline entry, so "why did this become a customer" has an answer. */
    note: z.string().trim().max(1000).optional(),
    /**
     * The status to move the lead to. Defaults to the tenant's first `won` status — a conversion
     * that left the lead sitting in "Negotiating" would make every pipeline report wrong.
     */
    statusId: z.string().uuid().optional(),
  })
  .strict();
export type ConvertLeadInput = z.infer<typeof convertLeadSchema>;

/** A customer who was never a lead: a walk-in, or a migration of an existing book of business. */
export const createCustomerSchema = z
  .object({
    ...identity,
    ...billing,
    ownerUserId: z.string().uuid().nullish(),
    branchId: z.string().uuid().nullish(),
    teamId: z.string().uuid().nullish(),
    consent: consent.optional(),
    customValues: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
export type CreateCustomerInput = z.infer<typeof createCustomerSchema>;

export const updateCustomerSchema = z
  .object({
    ...identity,
    ...billing,
    ownerUserId: z.string().uuid().nullish(),
    branchId: z.string().uuid().nullish(),
    teamId: z.string().uuid().nullish(),
    consent: consent.optional(),
    customValues: z.record(z.string(), z.unknown()).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, { message: 'Nothing to update' });
export type UpdateCustomerInput = z.infer<typeof updateCustomerSchema>;

export const listCustomersSchema = z
  .object({
    search: z.string().trim().min(1).max(120).optional(),
    ownerUserId: z.string().uuid().optional(),
    branchId: z.string().uuid().optional(),
    teamId: z.string().uuid().optional(),
    /** Only those who came from a lead, or only those who did not. Absent means both. */
    converted: booleanFlag,
    /** The recycle bin, for parity with `GET /leads`. */
    deleted: booleanFlag,
    limit: z.coerce.number().int().min(1).max(100).default(25),
    cursor: z.string().uuid().optional(),
    sort: z.enum(['created_at', 'updated_at', 'last_activity_at', 'full_name']).optional(),
    direction: z.enum(['asc', 'desc']).default('desc'),
  })
  .strict();
export type ListCustomersQuery = z.infer<typeof listCustomersSchema>;

export const customerTimelineSchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(50),
    /**
     * Opaque, and base64url — it carries both halves of `activities`' key, because the table is
     * partitioned by `occurred_at` and an id alone does not identify a row.
     */
    cursor: z.string().max(200).optional(),
  })
  .strict();
export type CustomerTimelineQuery = z.infer<typeof customerTimelineSchema>;
