import { z } from 'zod';
import {
  CALL_DIRECTIONS,
  CALL_OUTCOME_CATEGORIES,
  CALL_STATUSES,
  MAX_CALL_SECONDS,
  SETTLED_CALL_STATUSES,
} from '@leados/shared';

/**
 * Request shapes for calls (`FR-CALL-1..3`).
 *
 * Three decisions live in this file rather than in the service, because a refusal that arrives from
 * the database names a constraint and a refusal from a schema names a field:
 *
 *  * **A logged call is a call that is over.** `POST /calls` refuses `dialing`: that status exists
 *    for the row click-to-call writes before anybody knows what happened, and a client that could
 *    post it directly would be able to create an attempt that no screen ever asks about again.
 *  * **An outcome is required, on every settled call.** The same reasoning as a task's completion
 *    outcome: "prompt for outcome" is worth nothing if the prompt can be dismissed, and "what
 *    happened on those forty calls" has to have an answer a month later. The status is what the
 *    telephony saw; the outcome is what it meant, and only one of them is a judgement.
 *  * **A duration belongs to a call that connected.** The database says so too
 *    (`calls_duration_needs_completion`); saying it here attaches the message to the field.
 */

/** Absent means "either" — never folded to `false`, which silently halves a list. */
const threeWayFlag = z
  .enum(['true', 'false'])
  .optional()
  .transform((value) => (value === undefined ? undefined : value === 'true'));

const booleanFlag = z
  .enum(['true', 'false'])
  .optional()
  .transform((value) => value === 'true');

/**
 * E.164 and nothing else.
 *
 * The same shape `calls_to_e164_format` enforces, so a number a client sends in a national format
 * is refused with a sentence under the field rather than stored as something no lead will ever
 * join on.
 */
const e164 = z
  .string()
  .trim()
  .regex(/^\+[1-9][0-9]{6,19}$/, 'Use the full international number, starting with +');

const durationSeconds = z.coerce.number().int().min(0).max(MAX_CALL_SECONDS);

/** The statuses a call that is over may carry. `dialing` is not one of them. */
const settledStatus = z.enum(SETTLED_CALL_STATUSES);

/** What happened on the call, as recorded by whoever made it. */
const result = {
  status: settledStatus,
  outcomeId: z.string().uuid(),
  durationSeconds: durationSeconds.optional(),
  notes: z.string().trim().max(4000).optional(),
  endedAt: z.coerce.date().optional(),
};

const durationNeedsCompletion = (value: { status: string; durationSeconds?: number }) =>
  value.durationSeconds === undefined || value.status === 'completed';
const durationRefusal = {
  message: 'A call that did not connect has no duration — leave it blank',
  path: ['durationSeconds'] as PropertyKey[],
};

export const logCallSchema = z
  .object({
    leadId: z.string().uuid().optional(),
    /** The follow-up this call was made for, closing the loop `FR-TSK-6` opened. */
    taskId: z.string().uuid().optional(),
    direction: z.enum(CALL_DIRECTIONS).default('outbound'),
    toE164: e164.optional(),
    fromE164: e164.optional(),
    startedAt: z.coerce.date().optional(),
    ...result,
    /**
     * Finish the follow-up this call was for, in the same action.
     *
     * `FR-TSK-6` and `FR-CALL-1` describe one thing to the person doing it: they rang, it did not
     * connect, and the follow-up is done. Two requests would leave the commonest path through the
     * product with a task still open on a call that was definitely made.
     */
    finishFollowUp: z
      .object({
        /** A **task** outcome, not a call outcome: the two vocabularies are different lists. */
        outcomeId: z.string().uuid(),
        note: z.string().trim().max(4000).optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.leadId !== undefined || value.toE164 !== undefined || value.fromE164 !== undefined,
    {
      message: 'Say who the call was with — a lead, or the number',
      path: ['leadId'],
    },
  )
  .refine(durationNeedsCompletion, durationRefusal)
  .refine((value) => value.finishFollowUp === undefined || value.taskId !== undefined, {
    message: 'Say which follow-up this call finishes',
    path: ['taskId'],
  });
export type LogCallInput = z.infer<typeof logCallSchema>;

/**
 * Click-to-call (`FR-CALL-2`).
 *
 * Writes the attempt **before** asking the telephony port, so a provider that fails leaves a
 * logged attempt rather than nothing. No outcome and no status: nobody knows yet, which is the
 * honest state and the reason `dialing` exists.
 */
export const dialCallSchema = z
  .object({
    leadId: z.string().uuid().optional(),
    taskId: z.string().uuid().optional(),
    /** Omitted means "the lead's own number", which is what the button on a lead sends. */
    to: e164.optional(),
  })
  .strict()
  .refine((value) => value.leadId !== undefined || value.to !== undefined, {
    message: 'Say who to call — a lead, or a number',
    path: ['to'],
  });
export type DialCallInput = z.infer<typeof dialCallSchema>;

/**
 * What happened on a call that was dialled from the product.
 *
 * Its own endpoint rather than a `status` on the PATCH, exactly as a task's completion is: it has
 * preconditions (the call must still be open), it writes the lead's first contact, it satisfies an
 * SLA promise and it emits the event scoring reads — and a PATCH that happened to carry a status
 * could check none of them.
 */
export const settleCallSchema = z
  .object({ ...result })
  .strict()
  .refine(durationNeedsCompletion, durationRefusal);
export type SettleCallInput = z.infer<typeof settleCallSchema>;

/**
 * Corrections, and attribution.
 *
 * `leadId` is here because an inbound call from a number nobody recognises is logged against the
 * numbers and linked to a lead once somebody works out who it was — which is the whole reason
 * `calls.lead_id` is nullable.
 */
export const updateCallSchema = z
  .object({
    leadId: z.string().uuid().nullish(),
    notes: z.string().trim().max(4000).nullish(),
  })
  .strict();
export type UpdateCallInput = z.infer<typeof updateCallSchema>;

export const listCallsSchema = z
  .object({
    leadId: z.string().uuid().optional(),
    taskId: z.string().uuid().optional(),
    agentUserId: z.string().uuid().optional(),
    outcomeId: z.string().uuid().optional(),
    direction: z.enum(CALL_DIRECTIONS).optional(),
    status: z.enum(CALL_STATUSES).optional(),
    category: z.enum(CALL_OUTCOME_CATEGORIES).optional(),
    /** Mine only — what the person on the phone all day wants to see. */
    mine: booleanFlag,
    /** `false` is the queue the nullable `lead_id` creates: inbound calls nobody has attributed. */
    linked: threeWayFlag,
    /** Still open: an attempt whose outcome nobody has recorded. */
    open: threeWayFlag,
    from: z.coerce.date().optional(),
    to: z.coerce.date().optional(),
    deleted: booleanFlag,
    limit: z.coerce.number().int().min(1).max(100).default(25),
    cursor: z.string().uuid().optional(),
  })
  .strict();
export type ListCallsQuery = z.infer<typeof listCallsSchema>;

// ── The tenant's outcome vocabulary (rule 4) ─────────────────────────────────

export const createCallOutcomeSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    /**
     * The machine-readable grouping. Required, and not derived from the name: the product has to
     * know that "Hot — spoke to them" means somebody was reached, and no amount of reading the
     * name tells it that.
     */
    category: z.enum(CALL_OUTCOME_CATEGORIES),
    requiresNote: z.boolean().default(false),
    sortOrder: z.coerce.number().int().min(0).max(10_000).optional(),
  })
  .strict();
export type CreateCallOutcomeInput = z.infer<typeof createCallOutcomeSchema>;

export const updateCallOutcomeSchema = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    category: z.enum(CALL_OUTCOME_CATEGORIES).optional(),
    requiresNote: z.boolean().optional(),
    sortOrder: z.coerce.number().int().min(0).max(10_000).optional(),
    isActive: z.boolean().optional(),
  })
  .strict();
export type UpdateCallOutcomeInput = z.infer<typeof updateCallOutcomeSchema>;
