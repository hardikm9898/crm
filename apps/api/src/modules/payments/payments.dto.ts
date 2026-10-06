import { z } from 'zod';

/**
 * Request shapes for payments (`FR-DEAL-3`).
 *
 * Money is integer minor units, like everywhere else: the only place a rupee becomes paise is the
 * screen a person types into.
 */
const booleanFlag = z
  .enum(['true', 'false'])
  .optional()
  .transform((value) => (value === undefined ? undefined : value === 'true'));

export const PAYMENT_STATUSES = ['pending', 'succeeded', 'failed', 'refunded'] as const;

const amountMinor = z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER);

export const recordPaymentSchema = z
  .object({
    /** `payments_has_subject` requires one of these four. Money from nobody is not a receipt. */
    dealId: z.string().uuid().optional(),
    quotationId: z.string().uuid().optional(),
    leadId: z.string().uuid().optional(),
    customerId: z.string().uuid().optional(),
    amountMinor,
    currency: z.string().trim().length(3).toUpperCase().optional(),
    methodId: z.string().uuid().optional(),
    reference: z.string().trim().max(120).nullish(),
    /**
     * Defaults to `succeeded`, because somebody typing a payment in has almost always just taken
     * the money. `pending` is for a cheque that has not cleared.
     */
    status: z.enum(['pending', 'succeeded']).default('succeeded'),
    /** Backdating is normal: the bank statement follows the cheque. */
    paidAt: z.coerce.date().optional(),
    note: z.string().trim().max(1000).optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.dealId !== undefined ||
      value.quotationId !== undefined ||
      value.leadId !== undefined ||
      value.customerId !== undefined,
    { message: 'Say what the payment is for — a deal, a quotation, a lead or a customer' },
  );
export type RecordPaymentInput = z.infer<typeof recordPaymentSchema>;

export const updatePaymentSchema = z
  .object({
    amountMinor: amountMinor.optional(),
    methodId: z.string().uuid().nullish(),
    reference: z.string().trim().max(120).nullish(),
    paidAt: z.coerce.date().optional(),
    note: z.string().trim().max(1000).nullish(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, { message: 'Nothing to update' });
export type UpdatePaymentInput = z.infer<typeof updatePaymentSchema>;

export const confirmPaymentSchema = z
  .object({ paidAt: z.coerce.date().optional(), note: z.string().trim().max(1000).optional() })
  .strict();
export type ConfirmPaymentInput = z.infer<typeof confirmPaymentSchema>;

export const failPaymentSchema = z
  .object({ failedAt: z.coerce.date().optional(), note: z.string().trim().max(1000).optional() })
  .strict();
export type FailPaymentInput = z.infer<typeof failPaymentSchema>;

export const refundPaymentSchema = z
  .object({ refundedAt: z.coerce.date().optional(), note: z.string().trim().max(1000).optional() })
  .strict();
export type RefundPaymentInput = z.infer<typeof refundPaymentSchema>;

export const listPaymentsSchema = z
  .object({
    dealId: z.string().uuid().optional(),
    quotationId: z.string().uuid().optional(),
    leadId: z.string().uuid().optional(),
    customerId: z.string().uuid().optional(),
    methodId: z.string().uuid().optional(),
    status: z.enum(PAYMENT_STATUSES).optional(),
    receivedFrom: z.coerce.date().optional(),
    receivedTo: z.coerce.date().optional(),
    deleted: booleanFlag,
    limit: z.coerce.number().int().min(1).max(100).default(25),
    cursor: z.string().uuid().optional(),
    sort: z.enum(['paid_at', 'amount', 'created_at']).default('paid_at'),
    direction: z.enum(['asc', 'desc']).default('desc'),
  })
  .strict();
export type ListPaymentsQuery = z.infer<typeof listPaymentsSchema>;

export const createPaymentMethodSchema = z
  .object({
    name: z.string().trim().min(1).max(60),
    requiresReference: z.boolean().default(false),
    sortOrder: z.coerce.number().int().min(0).max(999).optional(),
  })
  .strict();
export type CreatePaymentMethodInput = z.infer<typeof createPaymentMethodSchema>;

export const updatePaymentMethodSchema = createPaymentMethodSchema
  .partial()
  .extend({ isActive: z.boolean().optional() })
  .strict()
  .refine((value) => Object.keys(value).length > 0, { message: 'Nothing to update' });
export type UpdatePaymentMethodInput = z.infer<typeof updatePaymentMethodSchema>;
