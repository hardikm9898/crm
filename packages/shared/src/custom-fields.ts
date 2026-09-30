/**
 * The custom-field type registry (ADR-0005, docs/database-design.md §5).
 *
 * The Phase 2 exit criterion is that creating a field of **any** supported type needs no migration and
 * no deploy, and that the field is immediately filterable, importable, exportable and usable in a
 * view. That only holds if there is exactly one description of what each type is — what it accepts,
 * how it is stored, which validators apply to it, and which filter operators it supports. This is
 * that description; the API validates against it and the UI renders from it.
 *
 * **Canonical storage matters more than it looks.** Values live in a JSONB column, so "2026-01-05"
 * and "05/01/2026" would both be accepted by a naive implementation and then sort, filter and export
 * differently. Every type therefore has one stored shape, stated here, and the coercion that gets
 * there is the API's job rather than the caller's.
 */

export const CUSTOM_FIELD_TYPES = [
  'text',
  'textarea',
  'number',
  'decimal',
  'currency',
  'boolean',
  'date',
  'datetime',
  'select',
  'multiselect',
  'radio',
  'checkbox_group',
  'email',
  'phone',
  'url',
  'rating',
  'file',
] as const;

export type CustomFieldType = (typeof CUSTOM_FIELD_TYPES)[number];

/** The entities that can carry custom fields. Extended as later phases add entities. */
export const CUSTOM_FIELD_ENTITIES = ['lead', 'customer', 'deal', 'task', 'conversation'] as const;
export type CustomFieldEntity = (typeof CUSTOM_FIELD_ENTITIES)[number];

/** Which `validation` keys a type honours; anything else on a definition is rejected at write time. */
export const VALIDATION_KEYS = [
  'min',
  'max',
  'minLength',
  'maxLength',
  'regex',
  'precision',
  'fileTypes',
  'maxSizeKb',
] as const;
export type ValidationKey = (typeof VALIDATION_KEYS)[number];

/** The filter operators the DSL exposes per type (docs/api-architecture.md §4). */
export const FILTER_OPERATORS = [
  'eq',
  'ne',
  'in',
  'nin',
  'contains',
  'starts_with',
  'gt',
  'gte',
  'lt',
  'lte',
  'between',
  'is_null',
  'is_not_null',
  'has_any',
  'has_all',
] as const;
export type FilterOperator = (typeof FILTER_OPERATORS)[number];

export interface CustomFieldTypeSpec {
  readonly type: CustomFieldType;
  /** How a value is stored inside the JSONB column. */
  readonly storage: 'string' | 'number' | 'boolean' | 'string[]' | 'object';
  /** True when the definition must have options (`select`, `radio`, …). */
  readonly requiresOptions: boolean;
  /** True when a value is a set rather than a single choice. */
  readonly multiValue: boolean;
  /** Validation keys this type accepts. */
  readonly validation: readonly ValidationKey[];
  /** Filter operators this type supports. */
  readonly operators: readonly FilterOperator[];
  /** Whether values contribute to `custom_search_text`. */
  readonly searchable: boolean;
  /** Human sentence used by the field-builder UI and by import error messages. */
  readonly describe: string;
  /**
   * For a type stored as an object: the JSON sub-path holding the value worth comparing.
   *
   * A currency value is stored as `{ currency, amountMinor }`, so a filter on it has to compare
   * `budget.amountMinor`, not `budget`. Declared here rather than in the filter compiler because
   * this file is where "how is this type stored" is decided, and a compiler that guessed would
   * compare an object against a number and match nothing — silently, which is how this was found.
   */
  readonly comparablePath?: readonly string[];
  /** Units the comparable value is in, so a client knows what to send. */
  readonly comparableUnit?: 'minor';
}

const TEXT_OPS: readonly FilterOperator[] = [
  'eq',
  'ne',
  'in',
  'nin',
  'contains',
  'starts_with',
  'is_null',
  'is_not_null',
];
const NUMBER_OPS: readonly FilterOperator[] = [
  'eq',
  'ne',
  'gt',
  'gte',
  'lt',
  'lte',
  'between',
  'is_null',
  'is_not_null',
];
const CHOICE_OPS: readonly FilterOperator[] = ['eq', 'ne', 'in', 'nin', 'is_null', 'is_not_null'];
const SET_OPS: readonly FilterOperator[] = ['has_any', 'has_all', 'is_null', 'is_not_null'];
const DATE_OPS: readonly FilterOperator[] = [
  'eq',
  'ne',
  'gt',
  'gte',
  'lt',
  'lte',
  'between',
  'is_null',
  'is_not_null',
];

export const CUSTOM_FIELD_SPECS: Readonly<Record<CustomFieldType, CustomFieldTypeSpec>> = {
  text: {
    type: 'text',
    storage: 'string',
    requiresOptions: false,
    multiValue: false,
    validation: ['minLength', 'maxLength', 'regex'],
    operators: TEXT_OPS,
    searchable: true,
    describe: 'A single line of text',
  },
  textarea: {
    type: 'textarea',
    storage: 'string',
    requiresOptions: false,
    multiValue: false,
    validation: ['minLength', 'maxLength'],
    operators: TEXT_OPS,
    searchable: true,
    describe: 'Several lines of text',
  },
  number: {
    type: 'number',
    storage: 'number',
    requiresOptions: false,
    multiValue: false,
    validation: ['min', 'max'],
    operators: NUMBER_OPS,
    searchable: false,
    describe: 'A whole number',
  },
  decimal: {
    type: 'decimal',
    storage: 'number',
    requiresOptions: false,
    multiValue: false,
    validation: ['min', 'max', 'precision'],
    operators: NUMBER_OPS,
    searchable: false,
    describe: 'A number with decimal places',
  },
  currency: {
    // Stored as `{ amountMinor, currency }` for the same reason money is everywhere else in this
    // codebase: a float cannot represent 0.1 and an invoice cannot be off by a paisa.
    type: 'currency',
    storage: 'object',
    comparablePath: ['amountMinor'],
    comparableUnit: 'minor',
    requiresOptions: false,
    multiValue: false,
    validation: ['min', 'max'],
    operators: NUMBER_OPS,
    searchable: false,
    describe: 'An amount of money',
  },
  boolean: {
    type: 'boolean',
    storage: 'boolean',
    requiresOptions: false,
    multiValue: false,
    validation: [],
    operators: ['eq', 'ne', 'is_null', 'is_not_null'],
    searchable: false,
    describe: 'Yes or no',
  },
  date: {
    // ISO-8601 date only. A date has no timezone: a birthday is the same day everywhere.
    type: 'date',
    storage: 'string',
    requiresOptions: false,
    multiValue: false,
    validation: ['min', 'max'],
    operators: DATE_OPS,
    searchable: false,
    describe: 'A date',
  },
  datetime: {
    // ISO-8601 instant, always stored in UTC with an offset; rendered in the organization's timezone.
    type: 'datetime',
    storage: 'string',
    requiresOptions: false,
    multiValue: false,
    validation: ['min', 'max'],
    operators: DATE_OPS,
    searchable: false,
    describe: 'A date and time',
  },
  select: {
    type: 'select',
    storage: 'string',
    requiresOptions: true,
    multiValue: false,
    validation: [],
    operators: CHOICE_OPS,
    searchable: true,
    describe: 'One choice from a list',
  },
  multiselect: {
    type: 'multiselect',
    storage: 'string[]',
    requiresOptions: true,
    multiValue: true,
    validation: ['min', 'max'],
    operators: SET_OPS,
    searchable: true,
    describe: 'Several choices from a list',
  },
  radio: {
    type: 'radio',
    storage: 'string',
    requiresOptions: true,
    multiValue: false,
    validation: [],
    operators: CHOICE_OPS,
    searchable: true,
    describe: 'One choice, all options visible',
  },
  checkbox_group: {
    type: 'checkbox_group',
    storage: 'string[]',
    requiresOptions: true,
    multiValue: true,
    validation: ['min', 'max'],
    operators: SET_OPS,
    searchable: true,
    describe: 'Several choices, all options visible',
  },
  email: {
    type: 'email',
    storage: 'string',
    requiresOptions: false,
    multiValue: false,
    validation: ['maxLength'],
    operators: TEXT_OPS,
    searchable: true,
    describe: 'An email address',
  },
  phone: {
    // Normalized to E.164 on write, using the organization's default country for local numbers —
    // the same normalization the lead's own phone columns get, so the two are comparable.
    type: 'phone',
    storage: 'string',
    requiresOptions: false,
    multiValue: false,
    validation: [],
    operators: TEXT_OPS,
    searchable: true,
    describe: 'A phone number',
  },
  url: {
    type: 'url',
    storage: 'string',
    requiresOptions: false,
    multiValue: false,
    validation: ['maxLength'],
    operators: TEXT_OPS,
    searchable: false,
    describe: 'A web address',
  },
  rating: {
    type: 'rating',
    storage: 'number',
    requiresOptions: false,
    multiValue: false,
    validation: ['min', 'max'],
    operators: NUMBER_OPS,
    searchable: false,
    describe: 'A rating out of a maximum',
  },
  file: {
    // Stored as a reference, never the bytes: `{ documentId, name, size, mime }`.
    type: 'file',
    storage: 'object',
    requiresOptions: false,
    multiValue: false,
    validation: ['fileTypes', 'maxSizeKb'],
    operators: ['is_null', 'is_not_null'],
    searchable: false,
    describe: 'An uploaded file',
  },
};

export function customFieldSpec(type: string): CustomFieldTypeSpec | undefined {
  return (CUSTOM_FIELD_SPECS as Record<string, CustomFieldTypeSpec>)[type];
}

export function isCustomFieldType(value: string): value is CustomFieldType {
  return value in CUSTOM_FIELD_SPECS;
}

/**
 * A field key is used in JSONB paths, filter expressions, import headers and expression index
 * definitions, so it is deliberately narrow: lowercase, starting with a letter, no dots (which would
 * be read as a JSON path) and no quotes (which would end up in generated SQL).
 */
const KEY_PATTERN = /^[a-z][a-z0-9_]{1,48}$/;

export function isValidCustomFieldKey(key: string): boolean {
  return KEY_PATTERN.test(key) && !RESERVED_FIELD_KEYS.has(key);
}

/**
 * Keys a custom field may not take, because a filter or an import header naming them would be
 * ambiguous with the lead's own columns.
 */
export const RESERVED_FIELD_KEYS = new Set([
  'id',
  'organization_id',
  'created_at',
  'updated_at',
  'deleted_at',
  'first_name',
  'last_name',
  'full_name',
  'company',
  'email',
  'phone',
  'phone_e164',
  'whatsapp_e164',
  'city',
  'state',
  'country',
  'postal_code',
  'status',
  'stage',
  'pipeline',
  'source',
  'priority',
  'score',
  'tags',
  'owner',
  'assigned_to',
  'value',
  'currency',
  'notes',
]);
