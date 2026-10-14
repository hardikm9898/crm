/**
 * Dynamic capture forms (`FR-CAP-2`, `FR-CAP-5`).
 *
 * A form is a tenant's own question list, rendered on somebody else's website and answered by
 * somebody who has never seen this product. Three things therefore live here as pure functions
 * rather than inside a service:
 *
 *  * **Which standard lead fields a form may ask for.** Not every column is a question a stranger
 *    can answer: a status, a pipeline stage, an owner or a tag is the workspace's own decision, and
 *    a public form offering them would let anybody set them. The list below is deliberately shorter
 *    than `IMPORTABLE_LEAD_FIELDS` for that reason, and it is the only list the API will accept.
 *  * **What a submission's answers mean.** The renderer, the public submit endpoint and the
 *    builder's preview all have to agree on "is this required", "is this an email", "what is the
 *    stored shape" — and the one that disagreed would be the one that ran.
 *  * **Which answers are not lead columns at all.** A consent tick writes `consent_whatsapp`; a
 *    free-text message is not a column in this schema and goes on the lead's **timeline**, where a
 *    business owner reads it. Both are declared as a mapping rather than special-cased by the
 *    caller, so adding a field type is one edit here.
 */

/** Where a standard field's answer goes. */
export type FormFieldTarget = 'lead' | 'consent' | 'message';

export interface FormStandardField {
  /** The key a `form_fields` row carries in `standard_field_key`. */
  readonly key: string;
  /** The default label. A form may override it — "Mobile number" reads better than "Phone". */
  readonly label: string;
  /** How the renderer draws it, and what the submit endpoint will accept. */
  readonly kind: 'text' | 'email' | 'phone' | 'number' | 'textarea' | 'checkbox';
  readonly target: FormFieldTarget;
  /** The property on the capture input, for `target: 'lead'`. */
  readonly leadField?: string;
  /** The consent flag, for `target: 'consent'`. */
  readonly consentKey?: 'whatsapp' | 'email' | 'calls';
  readonly maxLength?: number;
  /** Shown under the field in the builder, so an admin knows what they are adding. */
  readonly describe?: string;
}

/**
 * The standard questions a public form may ask.
 *
 * `fullName` is offered as well as the two halves because most real forms ask one name question,
 * and the capture path already splits it. `valueMinor` is "budget" to the person filling it in and
 * **major units** on the wire for the same reason: a stranger types 50000, not 5000000.
 */
export const FORM_STANDARD_FIELDS: readonly FormStandardField[] = [
  {
    key: 'fullName',
    label: 'Your name',
    kind: 'text',
    target: 'lead',
    leadField: 'fullName',
    maxLength: 160,
    describe: 'Split into first and last name by the capture path.',
  },
  {
    key: 'firstName',
    label: 'First name',
    kind: 'text',
    target: 'lead',
    leadField: 'firstName',
    maxLength: 80,
  },
  {
    key: 'lastName',
    label: 'Last name',
    kind: 'text',
    target: 'lead',
    leadField: 'lastName',
    maxLength: 80,
  },
  {
    key: 'phone',
    label: 'Phone number',
    kind: 'phone',
    target: 'lead',
    leadField: 'phone',
    maxLength: 32,
    describe: 'Normalized to E.164 using the workspace’s country.',
  },
  {
    key: 'email',
    label: 'Email address',
    kind: 'email',
    target: 'lead',
    leadField: 'email',
    maxLength: 180,
  },
  {
    key: 'company',
    label: 'Company',
    kind: 'text',
    target: 'lead',
    leadField: 'company',
    maxLength: 160,
  },
  {
    key: 'jobTitle',
    label: 'Job title',
    kind: 'text',
    target: 'lead',
    leadField: 'jobTitle',
    maxLength: 120,
  },
  { key: 'city', label: 'City', kind: 'text', target: 'lead', leadField: 'city', maxLength: 120 },
  {
    key: 'state',
    label: 'State',
    kind: 'text',
    target: 'lead',
    leadField: 'state',
    maxLength: 120,
  },
  {
    key: 'postalCode',
    label: 'PIN code',
    kind: 'text',
    target: 'lead',
    leadField: 'postalCode',
    maxLength: 20,
  },
  {
    key: 'budget',
    label: 'Budget',
    kind: 'number',
    target: 'lead',
    leadField: 'valueMinor',
    describe: 'Asked in whole rupees and stored in minor units.',
  },
  {
    key: 'message',
    label: 'What do you need?',
    kind: 'textarea',
    target: 'message',
    maxLength: 2000,
    describe: 'Written to the lead’s timeline, where whoever calls them will read it.',
  },
  {
    key: 'consentWhatsapp',
    label: 'You may contact me on WhatsApp',
    kind: 'checkbox',
    target: 'consent',
    consentKey: 'whatsapp',
    describe: 'An unticked box is a refusal, and marketing will honour it.',
  },
  {
    key: 'consentEmail',
    label: 'You may email me',
    kind: 'checkbox',
    target: 'consent',
    consentKey: 'email',
  },
  {
    key: 'consentCalls',
    label: 'You may call me',
    kind: 'checkbox',
    target: 'consent',
    consentKey: 'calls',
  },
];

const BY_KEY = new Map(FORM_STANDARD_FIELDS.map((field) => [field.key, field]));

export function formStandardField(key: string): FormStandardField | undefined {
  return BY_KEY.get(key);
}

/**
 * The fields a form must have at least one of.
 *
 * A capture with no way to reach the person is not a lead, it is a page view — and the create path
 * refuses it with a field error nobody filling in a public form could act on. So the **builder**
 * refuses to save such a form, which is the same lesson as the import's dry run: a check that needs
 * information the schema does not have belongs where that information is.
 */
export const FORM_CONTACT_KEYS = [
  'phone',
  'email',
  'fullName',
  'firstName',
  'lastName',
  'company',
] as const;

export type FormType = 'embed' | 'landing' | 'popup';
export const FORM_TYPES: readonly FormType[] = ['embed', 'landing', 'popup'];

/**
 * What became of a submission.
 *
 * `received` is an amendment to `docs/database-design.md` §8, which listed only the four outcomes.
 * A row written **after** the capture cannot be the never-lose-a-lead store the requirement asks
 * for (`FR-CAP-3`): the submission that crashed the pipeline would be the one with no row. So the
 * row is written first, in its own transaction, as `received`, and the outcome is an update.
 */
export type FormSubmissionStatus = 'received' | 'processed' | 'duplicate' | 'rejected' | 'error';
export const FORM_SUBMISSION_STATUSES: readonly FormSubmissionStatus[] = [
  'received',
  'processed',
  'duplicate',
  'rejected',
  'error',
];

/** How many steps a form may have. More than this is a questionnaire, not a capture. */
export const FORM_MAX_STEPS = 5;

/** The honeypot's field name. Fixed, so the renderer and the endpoint cannot disagree. */
export const FORM_HONEYPOT_FIELD = 'website_url';

/** A field as the renderer and the validator see it. */
export interface FormFieldView {
  readonly id: string;
  readonly label: string;
  readonly kind:
    | 'text'
    | 'email'
    | 'phone'
    | 'number'
    | 'textarea'
    | 'checkbox'
    | 'select'
    | 'multiselect'
    | 'radio'
    | 'date'
    | 'url'
    | 'rating';
  /** `standard:phone` or `custom:<definition id>` — the name used in the submitted payload. */
  readonly name: string;
  readonly required: boolean;
  readonly stepIndex: number;
  readonly options?: readonly { readonly value: string; readonly label: string }[];
  readonly placeholder?: string | null;
  readonly helpText?: string | null;
  readonly maxLength?: number;
}

export interface FormFieldError {
  readonly field: string;
  readonly code: string;
  readonly message: string;
}

/**
 * Validates a submission against the form's own fields.
 *
 * Only the shapes a *stranger* can get wrong: a required answer left blank, something that is not
 * an email in an email box, a number that is not a number, an answer longer than the column, a
 * choice that is not one of the offered options, a required consent box left unticked. Everything
 * else — a phone that cannot be normalized, a custom field's own validation — is the capture
 * path's job, because it needs the workspace's country and its field definitions.
 *
 * The messages are written for the person filling the form in, not for the admin who built it.
 */
export function validateFormSubmission(
  fields: readonly FormFieldView[],
  answers: Readonly<Record<string, unknown>>,
): FormFieldError[] {
  const errors: FormFieldError[] = [];
  for (const field of fields) {
    const raw = answers[field.name];
    const given = raw === undefined || raw === null ? '' : raw;

    if (field.kind === 'checkbox') {
      // A consent box is "ticked or not"; required means it has to be ticked, which is the only
      // honest reading of a mandatory consent.
      const ticked = given === true || given === 'true' || given === 'on' || given === '1';
      if (field.required && !ticked) {
        errors.push({
          field: field.name,
          code: 'CONSENT_REQUIRED',
          message: `Please tick “${field.label}”.`,
        });
      }
      continue;
    }

    const text = Array.isArray(given) ? given.join(',') : String(given).trim();
    if (text === '') {
      if (field.required) {
        errors.push({ field: field.name, code: 'REQUIRED', message: `${field.label} is needed.` });
      }
      continue;
    }

    if (field.maxLength !== undefined && text.length > field.maxLength) {
      errors.push({
        field: field.name,
        code: 'TOO_LONG',
        message: `${field.label} can be at most ${field.maxLength} characters.`,
      });
      continue;
    }

    if (field.kind === 'email' && !/^[^@\s]+@[^@\s.]+\.[^@\s]{2,}$/.test(text)) {
      errors.push({
        field: field.name,
        code: 'NOT_AN_EMAIL',
        message: `${field.label} does not look like an email address.`,
      });
      continue;
    }

    if ((field.kind === 'number' || field.kind === 'rating') && !Number.isFinite(Number(text))) {
      errors.push({
        field: field.name,
        code: 'NOT_A_NUMBER',
        message: `${field.label} should be a number.`,
      });
      continue;
    }

    if (field.options && field.options.length > 0) {
      const allowed = new Set(field.options.map((option) => option.value));
      const chosen = Array.isArray(given) ? given.map(String) : [text];
      if (chosen.some((value) => !allowed.has(value))) {
        errors.push({
          field: field.name,
          code: 'NOT_AN_OPTION',
          message: `Choose one of the options offered for ${field.label}.`,
        });
      }
    }
  }
  return errors;
}

/**
 * Whether a submission is a bot, by the honeypot alone.
 *
 * A hidden field a person never sees and a bot fills in because it fills everything in. Cheap,
 * silent, and worth having before a CAPTCHA, which costs every real visitor something.
 */
export function isHoneypotTripped(answers: Readonly<Record<string, unknown>>): boolean {
  const value = answers[FORM_HONEYPOT_FIELD];
  return typeof value === 'string'
    ? value.trim() !== ''
    : value !== undefined && value !== null && value !== false;
}

/** The UTM keys a capture keeps. Anything else in the query string is noise. */
export const UTM_KEYS = [
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
] as const;

/**
 * The UTM object a capture stores, from whatever the page sent.
 *
 * Trimmed, length-capped and limited to the five keys, because this is attacker-supplied text that
 * ends up in a JSONB column every report reads.
 */
export function normalizeUtm(input: unknown): Record<string, string> {
  if (input === null || typeof input !== 'object') return {};
  const source = input as Record<string, unknown>;
  const utm: Record<string, string> = {};
  for (const key of UTM_KEYS) {
    const value = source[key];
    if (typeof value !== 'string') continue;
    const trimmed = value.trim().slice(0, 200);
    if (trimmed !== '') utm[key] = trimmed;
  }
  return utm;
}

/**
 * The name a field carries in the submitted payload.
 *
 * Prefixed rather than bare, because a custom field called `city` and the standard `city` would
 * otherwise collide in one payload — and the collision would be silent, with one answer landing
 * in the wrong place.
 */
export function formFieldName(field: {
  standardFieldKey: string | null;
  customFieldDefinitionId: string | null;
}): string {
  return field.standardFieldKey !== null
    ? `standard:${field.standardFieldKey}`
    : `custom:${field.customFieldDefinitionId}`;
}
