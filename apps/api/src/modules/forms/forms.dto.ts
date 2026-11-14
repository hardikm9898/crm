import { z } from 'zod';
import { FORM_MAX_STEPS, FORM_STANDARD_FIELDS, FORM_TYPES } from '@leados/shared';

/**
 * Request shapes for capture forms (`FR-CAP-2`).
 *
 * Two of these schemas are the product's only defence on a public endpoint, so the decisions are
 * written down here rather than left to the service:
 *
 *  * **A field names a standard key from the shared list or a custom definition, never both.** The
 *    database says so too (`form_fields_one_target`); saying it here attaches the refusal to the
 *    field instead of to a constraint name. And the key must be one of `FORM_STANDARD_FIELDS` —
 *    which is how `statusId`, `assignedUserId` and `score` are kept off a form a stranger fills in.
 *  * **The whole field set is replaced in one call.** A form's fields are an ordered list that a
 *    builder screen edits as a whole; per-field endpoints would make "move this field to step 2"
 *    three requests that can half-fail, and a partially saved form is one that captures the wrong
 *    things silently.
 */

const slug = z
  .string()
  .trim()
  .toLowerCase()
  .min(2)
  .max(60)
  // The same shape `forms_slug_is_url_safe` enforces: this is in a URL and in a unique index.
  .regex(/^[a-z0-9][a-z0-9-]*$/, 'Use lowercase letters, numbers and hyphens.');

const standardKeys = FORM_STANDARD_FIELDS.map((field) => field.key) as [string, ...string[]];

/**
 * What the thank-you screen says and where it sends people.
 *
 * `redirectUrl` is a URL on somebody else's site, so it is validated as one and length-capped: it
 * is handed back to a browser and a blank or malformed value would leave a visitor on a dead page
 * after the one interaction the business paid for.
 */
const settings = z
  .object({
    submitLabel: z.string().trim().min(1).max(40).optional(),
    thankYouMessage: z.string().trim().min(1).max(500).optional(),
    redirectUrl: z.string().trim().url().max(2000).nullish(),
    consentText: z.string().trim().max(500).nullish(),
    /** Shown above the fields. The one place a form explains itself. */
    introText: z.string().trim().max(500).nullish(),
  })
  .strict();

const formField = z
  .object({
    standardFieldKey: z.enum(standardKeys).nullish(),
    customFieldDefinitionId: z.string().uuid().nullish(),
    label: z.string().trim().min(1).max(120),
    placeholder: z.string().trim().max(120).nullish(),
    helpText: z.string().trim().max(240).nullish(),
    isRequired: z.boolean().optional(),
    stepIndex: z.coerce
      .number()
      .int()
      .min(0)
      .max(FORM_MAX_STEPS - 1)
      .optional(),
    options: z
      .array(
        z
          .object({
            value: z.string().trim().min(1).max(120),
            label: z.string().trim().min(1).max(120),
          })
          .strict(),
      )
      .max(60)
      .nullish(),
  })
  .strict()
  .refine(
    (field) =>
      ((field.standardFieldKey ?? null) !== null) !==
      ((field.customFieldDefinitionId ?? null) !== null),
    {
      message: 'A field asks for one standard field or one custom field, not both and not neither.',
      path: ['standardFieldKey'] as PropertyKey[],
    },
  );

export const createFormSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    slug: slug.optional(),
    type: z.enum(FORM_TYPES as [string, ...string[]]).optional(),
    pipelineId: z.string().uuid().nullish(),
    leadSourceId: z.string().uuid().nullish(),
    assignmentRuleId: z.string().uuid().nullish(),
    settings: settings.optional(),
    isActive: z.boolean().optional(),
    /** Offered on create so a form arrives complete; a form with no fields captures nothing. */
    fields: z.array(formField).max(40).optional(),
  })
  .strict();

export const updateFormSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    slug: slug.optional(),
    type: z.enum(FORM_TYPES as [string, ...string[]]).optional(),
    pipelineId: z.string().uuid().nullish(),
    leadSourceId: z.string().uuid().nullish(),
    assignmentRuleId: z.string().uuid().nullish(),
    settings: settings.optional(),
    isActive: z.boolean().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, { message: 'Nothing to update' });

/** The whole ordered set, in the order it is sent. */
export const setFormFieldsSchema = z.object({ fields: z.array(formField).max(40) }).strict();

export const listFormsSchema = z
  .object({
    search: z.string().trim().min(1).max(120).optional(),
    /** Absent means both: folding it to `false` would silently hide every inactive form. */
    active: z
      .enum(['true', 'false'])
      .optional()
      .transform((value) => (value === undefined ? undefined : value === 'true')),
    limit: z.coerce.number().int().min(1).max(100).default(25),
    cursor: z.string().uuid().optional(),
  })
  .strict();

export const listSubmissionsSchema = z
  .object({
    formId: z.string().uuid().optional(),
    status: z.enum(['received', 'processed', 'duplicate', 'rejected', 'error']).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(25),
    cursor: z.string().uuid().optional(),
  })
  .strict();

/**
 * A public submission.
 *
 * `answers` is a free-form record on purpose: the fields are the tenant's own, and a schema that
 * enumerated them would have to be generated per form. What a stranger sends is checked against
 * the form's real field set by `validateFormSubmission`, and **kept whole** in
 * `form_submissions.raw_payload` either way — including answers to fields that no longer exist,
 * which is the only way to answer "what did they actually type" (`FR-CAP-3`, `FR-CAP-5`).
 */
export const submitFormSchema = z
  .object({
    answers: z.record(z.string().max(120), z.unknown()),
    utm: z.record(z.string().max(40), z.unknown()).optional(),
    pageUrl: z.string().trim().max(2000).optional(),
    referrer: z.string().trim().max(2000).optional(),
    sessionId: z.string().trim().max(120).optional(),
    visitorId: z.string().trim().max(120).optional(),
    /**
     * `mobile`, `tablet` or `desktop`, as the page saw it (`FR-WEB-6`).
     *
     * Sent by the page rather than derived from the user agent here, because the page knows what it
     * is: a viewport and a pointer type are facts the browser can answer directly, while parsing a
     * user-agent string is a guess that needs a library and ages badly. A missing or unexpected
     * value is simply absent, never a refusal — a visitor's browser is not a thing to validate.
     */
    device: z.enum(['mobile', 'tablet', 'desktop']).optional(),
  })
  .strict();

export type CreateFormInput = z.infer<typeof createFormSchema>;
export type UpdateFormInput = z.infer<typeof updateFormSchema>;
export type SetFormFieldsInput = z.infer<typeof setFormFieldsSchema>;
export type ListFormsQuery = z.infer<typeof listFormsSchema>;
export type ListSubmissionsQuery = z.infer<typeof listSubmissionsSchema>;
export type SubmitFormInput = z.infer<typeof submitFormSchema>;
