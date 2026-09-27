import { AppError, type FieldError } from './errors.js';
import {
  CUSTOM_FIELD_SPECS,
  type CustomFieldType,
  customFieldSpec,
  type ValidationKey,
} from './custom-fields.js';
import { normalizePhone, PhoneNormalizationError, type CountryCode } from './phone.js';

/**
 * Validation and canonicalization of custom-field values (ADR-0005).
 *
 * Pure: definitions in, canonical values out, or an `AppError` carrying one field error per problem.
 * Kept out of the API so it can be exercised exhaustively without a database — the Phase 2 exit
 * criterion is that a field of **every** supported type works the moment it is created, and that is
 * only credible if every type's accept/reject behaviour is tested directly.
 *
 * Three rules do most of the work:
 *
 *  1. **Unknown keys are rejected, never stored.** The API never trusts a client-sent key; a typo'd
 *     field name silently accepted would produce a value no filter, export or view can ever see.
 *  2. **One canonical stored shape per type.** "2026-01-05" and "05/01/2026" cannot both be stored,
 *     or the same field sorts, filters and exports three different ways.
 *  3. **Absent and empty are different.** Omitting a key leaves the stored value alone; sending
 *     `null` clears it. A PATCH that cleared every field it did not mention would be a data-loss bug
 *     waiting for its first user.
 */

/** The subset of a definition this validator needs; the API passes rows, tests pass literals. */
export interface CustomFieldDefinitionLike {
  readonly key: string;
  readonly label: string;
  readonly type: string;
  readonly isRequired: boolean;
  readonly isActive: boolean;
  readonly validation: Readonly<Record<string, unknown>> | null;
  readonly options?: readonly { readonly value: string; readonly isActive: boolean }[];
}

export interface ValidateOptions {
  /** Used to normalize `phone` fields to E.164, exactly as the lead's own phone columns are. */
  readonly defaultPhoneCountry?: CountryCode;
  /** The organization's currency, used when a `currency` value omits one. */
  readonly defaultCurrency?: string;
  /**
   * `create` enforces required fields; `patch` does not, because a PATCH that omits a field is
   * saying nothing about it — the value already stored satisfies the requirement.
   */
  readonly mode: 'create' | 'patch';
}

export interface ValidatedCustomValues {
  /** Only the keys the caller actually supplied, canonicalized. Merge these onto what is stored. */
  readonly values: Record<string, unknown>;
  /** Keys explicitly set to null — to be removed from the stored object. */
  readonly cleared: readonly string[];
  /** Concatenated searchable text, for `custom_search_text`. */
  readonly searchText: string;
}

export function validateCustomValues(
  definitions: readonly CustomFieldDefinitionLike[],
  input: Readonly<Record<string, unknown>>,
  options: ValidateOptions,
): ValidatedCustomValues {
  const active = definitions.filter((definition) => definition.isActive);
  const byKey = new Map(active.map((definition) => [definition.key, definition]));
  const errors: FieldError[] = [];
  const values: Record<string, unknown> = {};
  const cleared: string[] = [];

  for (const [key, raw] of Object.entries(input)) {
    const definition = byKey.get(key);
    if (!definition) {
      // Naming the available keys turns "it didn't save" into a fixable mistake, and costs nothing:
      // the definitions are already loaded, and they are the caller's own configuration.
      errors.push({
        field: `customValues.${key}`,
        code: 'UNKNOWN_FIELD',
        message:
          active.length === 0
            ? 'This organization has no custom fields defined.'
            : `Not a custom field on this record. Available: ${active
                .map((entry) => entry.key)
                .sort()
                .join(', ')}`,
      });
      continue;
    }

    if (raw === null || raw === '') {
      if (definition.isRequired) {
        errors.push({
          field: `customValues.${key}`,
          code: 'REQUIRED',
          message: `${definition.label} is required.`,
        });
        continue;
      }
      cleared.push(key);
      continue;
    }

    const coerced = coerce(definition, raw, options);
    if ('error' in coerced) {
      errors.push({ field: `customValues.${key}`, ...coerced.error });
      continue;
    }
    values[key] = coerced.value;
  }

  if (options.mode === 'create') {
    for (const definition of active) {
      if (!definition.isRequired) continue;
      if (Object.prototype.hasOwnProperty.call(values, definition.key)) continue;
      errors.push({
        field: `customValues.${definition.key}`,
        code: 'REQUIRED',
        message: `${definition.label} is required.`,
      });
    }
  }

  if (errors.length > 0) throw AppError.validation('Some details need correcting', errors);

  return { values, cleared, searchText: searchTextFor(active, values) };
}

/**
 * The searchable projection of a value set.
 *
 * Only types the registry marks searchable contribute, so a budget or a rating does not pollute a
 * name search with stray numbers.
 */
export function searchTextFor(
  definitions: readonly CustomFieldDefinitionLike[],
  values: Readonly<Record<string, unknown>>,
): string {
  const parts: string[] = [];
  for (const definition of definitions) {
    const spec = customFieldSpec(definition.type);
    if (!spec?.searchable) continue;
    const value = values[definition.key];
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) parts.push(...value.map((entry) => String(entry)));
    else parts.push(String(value));
  }
  return parts.join(' ').trim();
}

type CoerceResult =
  | { readonly value: unknown }
  | { readonly error: { readonly code: string; readonly message: string } };

function coerce(
  definition: CustomFieldDefinitionLike,
  raw: unknown,
  options: ValidateOptions,
): CoerceResult {
  const spec = customFieldSpec(definition.type);
  if (!spec) {
    // A definition carrying a type this build does not know about: refuse the value rather than
    // store something nothing can read back.
    return {
      error: {
        code: 'UNSUPPORTED_TYPE',
        message: `${definition.label} uses a field type this version does not support.`,
      },
    };
  }

  const rules = (definition.validation ?? {}) as Partial<Record<ValidationKey, unknown>>;
  const label = definition.label;

  switch (definition.type as CustomFieldType) {
    case 'text':
    case 'textarea':
      return coerceText(raw, label, rules);
    case 'email':
      return coerceEmail(raw, label, rules);
    case 'url':
      return coerceUrl(raw, label, rules);
    case 'phone':
      return coercePhone(raw, label, options.defaultPhoneCountry ?? 'IN');
    case 'number':
      return coerceNumber(raw, label, rules, { integer: true });
    case 'decimal':
      return coerceNumber(raw, label, rules, { integer: false });
    case 'rating':
      return coerceNumber(raw, label, { min: 1, max: 5, ...rules }, { integer: true });
    case 'currency':
      return coerceCurrency(raw, label, rules, options.defaultCurrency);
    case 'boolean':
      return coerceBoolean(raw, label);
    case 'date':
      return coerceDate(raw, label, rules, { time: false });
    case 'datetime':
      return coerceDate(raw, label, rules, { time: true });
    case 'select':
    case 'radio':
      return coerceChoice(raw, definition);
    case 'multiselect':
    case 'checkbox_group':
      return coerceChoiceSet(raw, definition, rules);
    case 'file':
      return coerceFile(raw, label, rules);
  }
}

function asString(raw: unknown): string | null {
  if (typeof raw === 'string') return raw;
  if (typeof raw === 'number' || typeof raw === 'boolean') return String(raw);
  return null;
}

function coerceText(
  raw: unknown,
  label: string,
  rules: Partial<Record<ValidationKey, unknown>>,
): CoerceResult {
  const text = asString(raw);
  if (text === null) return { error: { code: 'INVALID_TYPE', message: `${label} must be text.` } };
  const trimmed = text.trim();

  const minLength = numberRule(rules['minLength']);
  if (minLength !== undefined && trimmed.length < minLength) {
    return {
      error: {
        code: 'TOO_SHORT',
        message: `${label} must be at least ${minLength} characters.`,
      },
    };
  }
  const maxLength = numberRule(rules['maxLength']);
  if (maxLength !== undefined && trimmed.length > maxLength) {
    return {
      error: { code: 'TOO_LONG', message: `${label} must be at most ${maxLength} characters.` },
    };
  }
  const pattern = rules['regex'];
  if (typeof pattern === 'string' && pattern.length > 0) {
    let expression: RegExp;
    try {
      expression = new RegExp(pattern);
    } catch {
      // A malformed pattern is the definition's problem, not the value's. Refusing the value would
      // block every write until an administrator noticed; saying so names the real fault.
      return {
        error: {
          code: 'INVALID_DEFINITION',
          message: `${label} has an invalid validation pattern. Ask an administrator to correct it.`,
        },
      };
    }
    if (!expression.test(trimmed)) {
      return {
        error: { code: 'PATTERN_MISMATCH', message: `${label} is not in the expected format.` },
      };
    }
  }
  return { value: trimmed };
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

function coerceEmail(
  raw: unknown,
  label: string,
  rules: Partial<Record<ValidationKey, unknown>>,
): CoerceResult {
  const text = asString(raw);
  if (text === null) return { error: { code: 'INVALID_TYPE', message: `${label} must be text.` } };
  const normalized = text.trim().toLowerCase();
  if (!EMAIL_PATTERN.test(normalized)) {
    return { error: { code: 'INVALID_EMAIL', message: `${label} must be a valid email address.` } };
  }
  const maxLength = numberRule(rules['maxLength']) ?? 254;
  if (normalized.length > maxLength) {
    return { error: { code: 'TOO_LONG', message: `${label} is too long.` } };
  }
  return { value: normalized };
}

function coerceUrl(
  raw: unknown,
  label: string,
  rules: Partial<Record<ValidationKey, unknown>>,
): CoerceResult {
  const text = asString(raw);
  if (text === null) return { error: { code: 'INVALID_TYPE', message: `${label} must be text.` } };
  const trimmed = text.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { error: { code: 'INVALID_URL', message: `${label} must be a valid web address.` } };
  }
  // Only http(s): a stored `javascript:` or `data:` URL becomes an attack the moment a screen
  // renders it as a link.
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return {
      error: { code: 'INVALID_URL', message: `${label} must start with http:// or https://.` },
    };
  }
  const maxLength = numberRule(rules['maxLength']) ?? 2000;
  if (trimmed.length > maxLength) {
    return { error: { code: 'TOO_LONG', message: `${label} is too long.` } };
  }
  return { value: parsed.toString() };
}

function coercePhone(raw: unknown, label: string, defaultCountry: CountryCode): CoerceResult {
  const text = asString(raw);
  if (text === null) return { error: { code: 'INVALID_TYPE', message: `${label} must be text.` } };
  try {
    return { value: normalizePhone(text, defaultCountry).e164 };
  } catch (error) {
    const reason = error instanceof PhoneNormalizationError ? error.reason : 'invalid';
    return {
      error: {
        code: 'INVALID_PHONE',
        message: `${label} is not a valid phone number (${reason}).`,
      },
    };
  }
}

function coerceNumber(
  raw: unknown,
  label: string,
  rules: Partial<Record<ValidationKey, unknown>>,
  shape: { integer: boolean },
): CoerceResult {
  const numeric =
    typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw.trim()) : NaN;
  if (!Number.isFinite(numeric)) {
    return { error: { code: 'INVALID_NUMBER', message: `${label} must be a number.` } };
  }
  if (shape.integer && !Number.isInteger(numeric)) {
    return { error: { code: 'INVALID_NUMBER', message: `${label} must be a whole number.` } };
  }

  const min = numberRule(rules['min']);
  if (min !== undefined && numeric < min) {
    return { error: { code: 'TOO_SMALL', message: `${label} must be at least ${min}.` } };
  }
  const max = numberRule(rules['max']);
  if (max !== undefined && numeric > max) {
    return { error: { code: 'TOO_LARGE', message: `${label} must be at most ${max}.` } };
  }

  const precision = numberRule(rules['precision']);
  if (!shape.integer && precision !== undefined) {
    const rounded = Number(numeric.toFixed(precision));
    return { value: rounded };
  }
  return { value: numeric };
}

function coerceCurrency(
  raw: unknown,
  label: string,
  rules: Partial<Record<ValidationKey, unknown>>,
  defaultCurrency: string | undefined,
): CoerceResult {
  // Accepts either a plain number (interpreted in the organization's currency) or the canonical
  // object. Stored always as the object, in minor units, for the same reason money is integer
  // everywhere else in this codebase.
  let amountMinor: number;
  let currency: string;

  if (typeof raw === 'number' || typeof raw === 'string') {
    const numeric = typeof raw === 'number' ? raw : Number(raw.trim());
    if (!Number.isFinite(numeric)) {
      return { error: { code: 'INVALID_NUMBER', message: `${label} must be an amount.` } };
    }
    amountMinor = Math.round(numeric * 100);
    currency = (defaultCurrency ?? 'INR').toUpperCase();
  } else if (typeof raw === 'object' && raw !== null) {
    const record = raw as Record<string, unknown>;
    const supplied = record['amountMinor'] ?? record['amount_minor'];
    const numeric = typeof supplied === 'number' ? supplied : Number(supplied);
    if (!Number.isInteger(numeric)) {
      return {
        error: {
          code: 'INVALID_NUMBER',
          message: `${label} must carry a whole number of minor units.`,
        },
      };
    }
    amountMinor = numeric;
    const suppliedCurrency = record['currency'];
    currency = (
      typeof suppliedCurrency === 'string' ? suppliedCurrency : (defaultCurrency ?? 'INR')
    ).toUpperCase();
  } else {
    return { error: { code: 'INVALID_TYPE', message: `${label} must be an amount.` } };
  }

  if (!/^[A-Z]{3}$/.test(currency)) {
    return {
      error: { code: 'INVALID_CURRENCY', message: `${label} has an invalid currency code.` },
    };
  }
  if (amountMinor < 0) {
    return { error: { code: 'TOO_SMALL', message: `${label} cannot be negative.` } };
  }
  // min/max on a currency field are stated in major units, because that is how a person writing the
  // field definition thinks about money.
  const min = numberRule(rules['min']);
  if (min !== undefined && amountMinor < Math.round(min * 100)) {
    return { error: { code: 'TOO_SMALL', message: `${label} must be at least ${min}.` } };
  }
  const max = numberRule(rules['max']);
  if (max !== undefined && amountMinor > Math.round(max * 100)) {
    return { error: { code: 'TOO_LARGE', message: `${label} must be at most ${max}.` } };
  }

  return { value: { amountMinor, currency } };
}

function coerceBoolean(raw: unknown, label: string): CoerceResult {
  if (typeof raw === 'boolean') return { value: raw };
  if (raw === 'true' || raw === 1 || raw === '1' || raw === 'yes') return { value: true };
  if (raw === 'false' || raw === 0 || raw === '0' || raw === 'no') return { value: false };
  return { error: { code: 'INVALID_TYPE', message: `${label} must be yes or no.` } };
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

function coerceDate(
  raw: unknown,
  label: string,
  rules: Partial<Record<ValidationKey, unknown>>,
  shape: { time: boolean },
): CoerceResult {
  const text = asString(raw);
  if (text === null)
    return { error: { code: 'INVALID_TYPE', message: `${label} must be a date.` } };
  const trimmed = text.trim();

  if (!shape.time) {
    // A date has no timezone: a birthday is the same day everywhere, so anything carrying a time is
    // rejected rather than silently truncated in whichever zone the server happens to run in.
    if (!DATE_ONLY.test(trimmed)) {
      return {
        error: { code: 'INVALID_DATE', message: `${label} must be a date in YYYY-MM-DD form.` },
      };
    }
    const parsed = new Date(`${trimmed}T00:00:00Z`);
    if (Number.isNaN(parsed.getTime())) {
      return { error: { code: 'INVALID_DATE', message: `${label} is not a real date.` } };
    }
    // Round-trip catches 2026-02-31, which `Date` would happily roll into March.
    if (parsed.toISOString().slice(0, 10) !== trimmed) {
      return { error: { code: 'INVALID_DATE', message: `${label} is not a real date.` } };
    }
    return withDateBounds(trimmed, label, rules);
  }

  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) {
    return {
      error: { code: 'INVALID_DATE', message: `${label} must be a date and time.` },
    };
  }
  return withDateBounds(parsed.toISOString(), label, rules);
}

function withDateBounds(
  stored: string,
  label: string,
  rules: Partial<Record<ValidationKey, unknown>>,
): CoerceResult {
  const min = rules['min'];
  if (typeof min === 'string' && stored < min) {
    return { error: { code: 'TOO_EARLY', message: `${label} cannot be before ${min}.` } };
  }
  const max = rules['max'];
  if (typeof max === 'string' && stored > max) {
    return { error: { code: 'TOO_LATE', message: `${label} cannot be after ${max}.` } };
  }
  return { value: stored };
}

function coerceChoice(raw: unknown, definition: CustomFieldDefinitionLike): CoerceResult {
  const text = asString(raw);
  if (text === null) {
    return { error: { code: 'INVALID_TYPE', message: `${definition.label} must be a choice.` } };
  }
  const trimmed = text.trim();
  const options = definition.options ?? [];
  const match = options.find((option) => option.value === trimmed);
  if (!match) {
    return {
      error: {
        code: 'INVALID_CHOICE',
        message: `${definition.label} must be one of: ${options
          .filter((option) => option.isActive)
          .map((option) => option.value)
          .join(', ')}`,
      },
    };
  }
  // A deactivated option can still be *read* on existing records — history should stay truthful —
  // but it cannot be newly chosen.
  if (!match.isActive) {
    return {
      error: {
        code: 'INACTIVE_CHOICE',
        message: `“${trimmed}” is no longer available for ${definition.label}.`,
      },
    };
  }
  return { value: trimmed };
}

function coerceChoiceSet(
  raw: unknown,
  definition: CustomFieldDefinitionLike,
  rules: Partial<Record<ValidationKey, unknown>>,
): CoerceResult {
  const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : null;
  if (list === null) {
    return {
      error: { code: 'INVALID_TYPE', message: `${definition.label} must be a list of choices.` },
    };
  }

  const chosen: string[] = [];
  for (const entry of list) {
    const result = coerceChoice(entry, definition);
    if ('error' in result) return result;
    const value = result.value as string;
    // Duplicates in, one out: a repeated checkbox is a client bug, not a reason to fail a save.
    if (!chosen.includes(value)) chosen.push(value);
  }

  const min = numberRule(rules['min']);
  if (min !== undefined && chosen.length < min) {
    return {
      error: { code: 'TOO_FEW', message: `${definition.label} needs at least ${min} choices.` },
    };
  }
  const max = numberRule(rules['max']);
  if (max !== undefined && chosen.length > max) {
    return {
      error: { code: 'TOO_MANY', message: `${definition.label} allows at most ${max} choices.` },
    };
  }
  return { value: chosen };
}

function coerceFile(
  raw: unknown,
  label: string,
  rules: Partial<Record<ValidationKey, unknown>>,
): CoerceResult {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { error: { code: 'INVALID_TYPE', message: `${label} must be an uploaded file.` } };
  }
  const record = raw as Record<string, unknown>;
  const documentId = record['documentId'];
  if (typeof documentId !== 'string' || documentId.length === 0) {
    return {
      error: { code: 'INVALID_FILE', message: `${label} must reference an uploaded document.` },
    };
  }
  const name = typeof record['name'] === 'string' ? record['name'] : '';
  const mime = typeof record['mime'] === 'string' ? record['mime'] : '';
  const size = typeof record['size'] === 'number' ? record['size'] : 0;

  const fileTypes = rules['fileTypes'];
  if (Array.isArray(fileTypes) && fileTypes.length > 0) {
    const allowed = fileTypes.filter((entry): entry is string => typeof entry === 'string');
    const matches = allowed.some(
      (entry) =>
        mime === entry ||
        (entry.endsWith('/*') && mime.startsWith(entry.slice(0, -1))) ||
        name.toLowerCase().endsWith(entry.toLowerCase()),
    );
    if (!matches) {
      return {
        error: {
          code: 'INVALID_FILE_TYPE',
          message: `${label} must be one of: ${allowed.join(', ')}`,
        },
      };
    }
  }
  const maxSizeKb = numberRule(rules['maxSizeKb']);
  if (maxSizeKb !== undefined && size > maxSizeKb * 1024) {
    return {
      error: { code: 'FILE_TOO_LARGE', message: `${label} must be under ${maxSizeKb} KB.` },
    };
  }

  // Stored as a reference, never the bytes.
  return { value: { documentId, name, size, mime } };
}

function numberRule(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

/**
 * Checks a *definition* rather than a value: that its type exists, that a choice type has options,
 * and that its validation rules are ones the type honours. Called when a definition is created or
 * changed, so a nonsensical rule is refused at the point someone can still fix it.
 */
export function validateFieldDefinition(input: {
  readonly type: string;
  readonly validation?: Readonly<Record<string, unknown>> | null;
  readonly optionCount?: number;
}): readonly FieldError[] {
  const errors: FieldError[] = [];
  const spec = customFieldSpec(input.type);
  if (!spec) {
    errors.push({
      field: 'type',
      code: 'UNKNOWN_TYPE',
      message: `Unknown field type. Supported: ${Object.keys(CUSTOM_FIELD_SPECS).sort().join(', ')}`,
    });
    return errors;
  }

  if (spec.requiresOptions && (input.optionCount ?? 0) === 0) {
    errors.push({
      field: 'options',
      code: 'OPTIONS_REQUIRED',
      message: `A ${input.type} field needs at least one option.`,
    });
  }
  if (!spec.requiresOptions && (input.optionCount ?? 0) > 0) {
    errors.push({
      field: 'options',
      code: 'OPTIONS_NOT_SUPPORTED',
      message: `A ${input.type} field does not take options.`,
    });
  }

  for (const key of Object.keys(input.validation ?? {})) {
    if (!(spec.validation as readonly string[]).includes(key)) {
      errors.push({
        field: `validation.${key}`,
        code: 'RULE_NOT_SUPPORTED',
        message:
          spec.validation.length === 0
            ? `A ${input.type} field takes no validation rules.`
            : `A ${input.type} field only accepts: ${spec.validation.join(', ')}`,
      });
    }
  }

  const rules = (input.validation ?? {}) as Record<string, unknown>;
  const pattern = rules['regex'];
  if (typeof pattern === 'string' && pattern.length > 0) {
    try {
      new RegExp(pattern);
    } catch {
      errors.push({
        field: 'validation.regex',
        code: 'INVALID_REGEX',
        message: 'That is not a valid pattern.',
      });
    }
  }
  const min = numberRule(rules['min']);
  const max = numberRule(rules['max']);
  if (min !== undefined && max !== undefined && min > max) {
    errors.push({
      field: 'validation.max',
      code: 'RANGE_INVERTED',
      message: 'The maximum must not be below the minimum.',
    });
  }

  return errors;
}
