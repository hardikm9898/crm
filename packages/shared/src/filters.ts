/**
 * The lead filter DSL and its field catalogue (`FR-VIEW-2`, `FR-VIEW-3`).
 *
 * Three things have to be true of a filter for saved views to be worth having:
 *
 *  1. **It is data, not a query.** A saved view is a row a business owns; it must survive the
 *     addition of a custom field, a rename of a status, and a deploy.
 *  2. **It is validated before it is stored.** A view that fails at read time fails on somebody's
 *     dashboard, at the moment they are trying to work.
 *  3. **Its date filters are relative.** "Today's Follow-ups" saved with an absolute date is a view
 *     that is wrong tomorrow and misleading forever. So a date condition may carry a *named
 *     window* resolved against the organization's clock at read time.
 *
 * The shape is the same flat AND-within-group / OR-across-groups form the assignment and scoring
 * rules use. One vocabulary, three features.
 */

import {
  FILTER_OPERATORS,
  customFieldSpec,
  type CustomFieldType,
  type FilterOperator,
} from './custom-fields.js';
import { addDays, dateKeyInZone, endOfDayInZone, startOfDayInZone } from './time.js';

/** What kind of value a filterable field holds, which decides its operators and value shapes. */
export type FilterFieldKind =
  'text' | 'number' | 'money' | 'date' | 'boolean' | 'reference' | 'enum' | 'tags' | 'band';

export interface FilterField {
  /** The key a condition names. `custom.<key>` for a custom field. */
  readonly field: string;
  readonly label: string;
  readonly kind: FilterFieldKind;
  readonly operators: readonly FilterOperator[];
  /** For `reference` and `enum`: where the UI fetches the choices. */
  readonly optionsFrom?: string;
  /**
   * The JSON sub-path a custom field's comparable value lives at, when its type stores an object.
   * Empty for everything else.
   */
  readonly valuePath?: readonly string[];
  /** Set to `minor` when a value must be sent in minor units, as money always is here. */
  readonly valueUnit?: 'minor';
  /** True for the handful of fields that are computed rather than stored. */
  readonly computed?: boolean;
  readonly describe?: string;
}

const TEXT_OPS: readonly FilterOperator[] = [
  'eq',
  'ne',
  'contains',
  'starts_with',
  'in',
  'nin',
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
const DATE_OPS: readonly FilterOperator[] = [
  'eq',
  'gt',
  'gte',
  'lt',
  'lte',
  'between',
  'is_null',
  'is_not_null',
];
const REFERENCE_OPS: readonly FilterOperator[] = [
  'eq',
  'ne',
  'in',
  'nin',
  'is_null',
  'is_not_null',
];
const TAG_OPS: readonly FilterOperator[] = ['has_any', 'has_all', 'is_null', 'is_not_null'];
const BOOLEAN_OPS: readonly FilterOperator[] = ['eq'];

/**
 * The standard lead fields a filter may name.
 *
 * Deliberately a list rather than "every column": `search_vector`, the merge pointers and the
 * consent flags are either not meaningful to filter on or are answered better by a dedicated
 * parameter. Everything `FR-VIEW-2` names is here.
 */
export const LEAD_FILTER_FIELDS: readonly FilterField[] = [
  { field: 'fullName', label: 'Name', kind: 'text', operators: TEXT_OPS },
  { field: 'phoneE164', label: 'Phone', kind: 'text', operators: TEXT_OPS },
  { field: 'whatsappE164', label: 'WhatsApp number', kind: 'text', operators: TEXT_OPS },
  { field: 'email', label: 'Email', kind: 'text', operators: TEXT_OPS },
  { field: 'company', label: 'Company', kind: 'text', operators: TEXT_OPS },
  { field: 'city', label: 'City', kind: 'text', operators: TEXT_OPS },
  { field: 'state', label: 'State', kind: 'text', operators: TEXT_OPS },
  { field: 'postalCode', label: 'Postal code', kind: 'text', operators: TEXT_OPS },
  {
    field: 'statusId',
    label: 'Status',
    kind: 'reference',
    operators: REFERENCE_OPS,
    optionsFrom: '/crm/statuses',
  },
  {
    field: 'stageId',
    label: 'Stage',
    kind: 'reference',
    operators: REFERENCE_OPS,
    optionsFrom: '/crm/pipelines',
  },
  {
    field: 'pipelineId',
    label: 'Pipeline',
    kind: 'reference',
    operators: REFERENCE_OPS,
    optionsFrom: '/crm/pipelines',
  },
  {
    field: 'leadSourceId',
    label: 'Source',
    kind: 'reference',
    operators: REFERENCE_OPS,
    optionsFrom: '/crm/sources',
  },
  {
    field: 'lostReasonId',
    label: 'Lost reason',
    kind: 'reference',
    operators: REFERENCE_OPS,
    optionsFrom: '/crm/lost-reasons',
  },
  {
    field: 'assignedUserId',
    label: 'Assigned to',
    kind: 'reference',
    operators: REFERENCE_OPS,
    optionsFrom: '/users',
    describe: 'Use “is empty” for the unassigned pool.',
  },
  {
    field: 'teamId',
    label: 'Team',
    kind: 'reference',
    operators: REFERENCE_OPS,
    optionsFrom: '/teams',
  },
  {
    field: 'branchId',
    label: 'Branch',
    kind: 'reference',
    operators: REFERENCE_OPS,
    optionsFrom: '/branches',
  },
  {
    field: 'priority',
    label: 'Priority',
    kind: 'enum',
    operators: REFERENCE_OPS,
    optionsFrom: 'priority',
  },
  {
    field: 'createdVia',
    label: 'Captured via',
    kind: 'enum',
    operators: REFERENCE_OPS,
    optionsFrom: 'createdVia',
  },
  { field: 'score', label: 'Score', kind: 'number', operators: NUMBER_OPS },
  {
    field: 'scoreBand',
    label: 'Score band',
    kind: 'band',
    operators: REFERENCE_OPS,
    optionsFrom: '/scoring/bands',
  },
  {
    field: 'valueMinor',
    label: 'Value',
    kind: 'money',
    operators: NUMBER_OPS,
    valueUnit: 'minor',
    describe: 'In minor units — paise, cents — as money is stored everywhere here.',
  },
  { field: 'touchCount', label: 'Times enquired', kind: 'number', operators: NUMBER_OPS },
  { field: 'openTasksCount', label: 'Open tasks', kind: 'number', operators: NUMBER_OPS },
  { field: 'createdAt', label: 'Captured', kind: 'date', operators: DATE_OPS },
  { field: 'updatedAt', label: 'Last updated', kind: 'date', operators: DATE_OPS },
  { field: 'lastActivityAt', label: 'Last activity', kind: 'date', operators: DATE_OPS },
  { field: 'lastContactedAt', label: 'Last contacted', kind: 'date', operators: DATE_OPS },
  {
    field: 'nextActionAt',
    label: 'Next action due',
    kind: 'date',
    operators: DATE_OPS,
    describe: 'Use “is empty” to find leads with nobody doing anything next.',
  },
  { field: 'convertedAt', label: 'Converted', kind: 'date', operators: DATE_OPS },
  { field: 'lostAt', label: 'Lost', kind: 'date', operators: DATE_OPS },
  {
    field: 'tagIds',
    label: 'Tags',
    kind: 'tags',
    operators: TAG_OPS,
    optionsFrom: '/crm/tags',
    computed: true,
    describe: 'Tags live in their own table, so this filter is a join rather than a column.',
  },
  {
    field: 'ageInDays',
    label: 'Age in days',
    kind: 'number',
    operators: NUMBER_OPS,
    computed: true,
    describe: 'Days since capture. Compiled to a date bound, so it stays index-friendly.',
  },
  {
    field: 'idleDays',
    label: 'Days since last activity',
    kind: 'number',
    operators: NUMBER_OPS,
    computed: true,
    describe: 'The ageing question a manager actually asks: who has gone quiet.',
  },
  {
    field: 'isDuplicate',
    label: 'Flagged as a possible duplicate',
    kind: 'boolean',
    operators: BOOLEAN_OPS,
    computed: true,
  },
];

const LEAD_FIELD_BY_KEY = new Map(LEAD_FILTER_FIELDS.map((field) => [field.field, field]));

/** A custom field definition, as much of it as the catalogue needs. */
export interface CustomFieldForFilter {
  readonly key: string;
  readonly label: string;
  readonly type: string;
  readonly isFilterable?: boolean;
}

export function kindForCustomFieldType(type: CustomFieldType): FilterFieldKind {
  switch (type) {
    case 'number':
    case 'decimal':
    case 'rating':
      return 'number';
    case 'currency':
      return 'money';
    case 'date':
    case 'datetime':
      return 'date';
    case 'boolean':
      return 'boolean';
    // A set of chosen values behaves like tags: "has any of", "has all of".
    case 'multiselect':
    case 'checkbox_group':
      return 'tags';
    default:
      return 'text';
  }
}

/**
 * The whole catalogue for an entity: standard fields plus this tenant's filterable custom fields.
 *
 * Built at request time from rows, not from a constant, because a custom field added a minute ago
 * must be filterable without a deploy (`FR-LEAD-6`).
 */
export function leadFilterCatalogue(
  customFields: readonly CustomFieldForFilter[],
): readonly FilterField[] {
  const custom: FilterField[] = [];
  for (const definition of customFields) {
    if (definition.isFilterable === false) continue;
    const spec = customFieldSpec(definition.type);
    if (!spec) continue;
    custom.push({
      field: `custom.${definition.key}`,
      label: definition.label,
      kind: kindForCustomFieldType(spec.type),
      operators: spec.operators,
      ...(spec.comparablePath ? { valuePath: spec.comparablePath } : {}),
      ...(spec.comparableUnit ? { valueUnit: spec.comparableUnit } : {}),
    });
  }
  return [...LEAD_FILTER_FIELDS, ...custom];
}

export function filterField(
  field: string,
  catalogue: readonly FilterField[],
): FilterField | undefined {
  return catalogue.find((entry) => entry.field === field) ?? LEAD_FIELD_BY_KEY.get(field);
}

/**
 * The named date windows a date condition may use instead of a fixed timestamp.
 *
 * This is what makes a saved view keep meaning what it said. `overdue` is listed among them because
 * "next action in the past" is the single most-used filter in the product and nobody should have to
 * express it as a comparison against now.
 */
export const DATE_WINDOWS = [
  'today',
  'tomorrow',
  'yesterday',
  'this_week',
  'last_week',
  'next_week',
  'this_month',
  'last_month',
  'last_7_days',
  'last_30_days',
  'next_7_days',
  'overdue',
] as const;
export type DateWindow = (typeof DATE_WINDOWS)[number];

export interface RelativeDate {
  readonly window: DateWindow;
}

export function isRelativeDate(value: unknown): value is RelativeDate {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as RelativeDate).window === 'string' &&
    (DATE_WINDOWS as readonly string[]).includes((value as RelativeDate).window)
  );
}

export interface ResolvedRange {
  readonly from: Date | null;
  readonly to: Date | null;
}

/**
 * Turns a named window into an instant range in the organization's timezone.
 *
 * The timezone matters more than it looks: a business in Asia/Kolkata asking for "today's
 * follow-ups" at 9am means their today, and a UTC day boundary would show them yesterday's list for
 * five and a half hours every morning.
 */
export function resolveDateWindow(window: DateWindow, at: Date, timeZone: string): ResolvedRange {
  const startOfToday = startOfDayInZone(at, timeZone);
  const endOfToday = endOfDayInZone(at, timeZone);
  const dayOfWeek = new Date(`${dateKeyInZone(at, timeZone)}T00:00:00Z`).getUTCDay();
  // Monday-first, because every business this product serves works a Monday–Saturday week.
  const daysSinceMonday = (dayOfWeek + 6) % 7;

  switch (window) {
    case 'today':
      return { from: startOfToday, to: endOfToday };
    case 'tomorrow':
      return {
        from: startOfDayInZone(addDays(at, 1), timeZone),
        to: endOfDayInZone(addDays(at, 1), timeZone),
      };
    case 'yesterday':
      return {
        from: startOfDayInZone(addDays(at, -1), timeZone),
        to: endOfDayInZone(addDays(at, -1), timeZone),
      };
    case 'this_week':
      return {
        from: startOfDayInZone(addDays(at, -daysSinceMonday), timeZone),
        to: endOfDayInZone(addDays(at, 6 - daysSinceMonday), timeZone),
      };
    case 'last_week':
      return {
        from: startOfDayInZone(addDays(at, -daysSinceMonday - 7), timeZone),
        to: endOfDayInZone(addDays(at, -daysSinceMonday - 1), timeZone),
      };
    case 'next_week':
      return {
        from: startOfDayInZone(addDays(at, 7 - daysSinceMonday), timeZone),
        to: endOfDayInZone(addDays(at, 13 - daysSinceMonday), timeZone),
      };
    case 'this_month':
      return { from: startOfMonth(at, timeZone, 0), to: endOfMonth(at, timeZone, 0) };
    case 'last_month':
      return { from: startOfMonth(at, timeZone, -1), to: endOfMonth(at, timeZone, -1) };
    case 'last_7_days':
      return { from: startOfDayInZone(addDays(at, -6), timeZone), to: endOfToday };
    case 'last_30_days':
      return { from: startOfDayInZone(addDays(at, -29), timeZone), to: endOfToday };
    case 'next_7_days':
      return { from: startOfToday, to: endOfDayInZone(addDays(at, 6), timeZone) };
    case 'overdue':
      // Open-ended below, and bounded by *now* rather than by the end of today: a follow-up due at
      // 10am is overdue at 11am, not at midnight.
      return { from: null, to: at };
  }
}

function startOfMonth(at: Date, timeZone: string, monthOffset: number): Date {
  const key = dateKeyInZone(at, timeZone);
  const [year, month] = key.split('-').map(Number) as [number, number, number];
  const shifted = new Date(Date.UTC(year, month - 1 + monthOffset, 1));
  return startOfDayInZone(new Date(`${shifted.toISOString().slice(0, 10)}T12:00:00Z`), timeZone);
}

function endOfMonth(at: Date, timeZone: string, monthOffset: number): Date {
  const key = dateKeyInZone(at, timeZone);
  const [year, month] = key.split('-').map(Number) as [number, number, number];
  const shifted = new Date(Date.UTC(year, month + monthOffset, 0));
  return endOfDayInZone(new Date(`${shifted.toISOString().slice(0, 10)}T12:00:00Z`), timeZone);
}

/** One condition of a filter. The same shape as an assignment or scoring condition. */
export interface FilterCondition {
  readonly field: string;
  readonly operator: string;
  readonly value?: unknown;
  /** AND within a group, OR across groups. Absent means group 0. */
  readonly groupIndex?: number;
}

export interface FilterSpec {
  readonly conditions: readonly FilterCondition[];
}

export interface FilterProblem {
  readonly index: number;
  readonly field: string;
  readonly code: string;
  readonly message: string;
}

/** Operators that need no value at all; giving one is a sign the filter was built wrong. */
const VALUELESS_OPERATORS: readonly FilterOperator[] = ['is_null', 'is_not_null'];
const LIST_OPERATORS: readonly FilterOperator[] = ['in', 'nin', 'has_any', 'has_all'];

/**
 * Validates a filter against a catalogue, before it is stored or run.
 *
 * Every refusal here is one that would otherwise surface as an empty list or a 500 on somebody's
 * dashboard: an unknown field (a custom field that was deleted), an operator the field's type
 * cannot support (`contains` on a date), a `between` with one bound, an `in` with a bare string.
 */
export function validateFilter(
  filter: unknown,
  catalogue: readonly FilterField[],
): readonly FilterProblem[] {
  if (typeof filter !== 'object' || filter === null || Array.isArray(filter)) {
    return [
      { index: -1, field: '', code: 'SHAPE', message: 'A filter is an object with conditions.' },
    ];
  }
  const conditions = (filter as FilterSpec).conditions;
  if (!Array.isArray(conditions)) {
    return [
      { index: -1, field: '', code: 'SHAPE', message: 'A filter needs a `conditions` array.' },
    ];
  }
  // An empty filter is legitimate: it is "everything", which is what an unfiltered list already is.
  const problems: FilterProblem[] = [];

  conditions.forEach((condition, index) => {
    const at = (code: string, message: string, field = '') =>
      problems.push({ index, field, code, message });

    if (typeof condition !== 'object' || condition === null) {
      at('SHAPE', 'Each condition is an object with a field and an operator.');
      return;
    }
    const { field, operator, value } = condition as FilterCondition;
    if (typeof field !== 'string' || field === '') {
      at('NO_FIELD', 'A condition needs a field.');
      return;
    }
    const definition = filterField(field, catalogue);
    if (!definition) {
      at(
        'UNKNOWN_FIELD',
        `“${field}” is not a filterable field. It may have been deleted since this view was saved.`,
        field,
      );
      return;
    }
    if (
      typeof operator !== 'string' ||
      !(FILTER_OPERATORS as readonly string[]).includes(operator)
    ) {
      at('UNKNOWN_OPERATOR', `“${String(operator)}” is not an operator.`, field);
      return;
    }
    const op = operator as FilterOperator;
    if (!definition.operators.includes(op)) {
      at(
        'OPERATOR_NOT_SUPPORTED',
        `${definition.label} cannot be filtered with “${op}”. Try: ${definition.operators.join(', ')}.`,
        field,
      );
      return;
    }

    if (VALUELESS_OPERATORS.includes(op)) {
      if (value !== undefined && value !== null) {
        at('UNEXPECTED_VALUE', `“${op}” takes no value.`, field);
      }
      return;
    }
    if (value === undefined) {
      at('MISSING_VALUE', `“${op}” needs a value.`, field);
      return;
    }
    if (LIST_OPERATORS.includes(op)) {
      if (!Array.isArray(value) || value.length === 0) {
        at('EXPECTED_LIST', `“${op}” needs a non-empty list of values.`, field);
      }
      return;
    }
    if (op === 'between') {
      if (!Array.isArray(value) || value.length !== 2) {
        at('EXPECTED_PAIR', '“between” needs exactly two values.', field);
      }
      return;
    }
    if (definition.kind === 'date' && !isValidDateValue(value)) {
      at(
        'BAD_DATE',
        `A date filter takes a timestamp or one of: ${DATE_WINDOWS.join(', ')}.`,
        field,
      );
      return;
    }
    if ((definition.kind === 'number' || definition.kind === 'money') && !isNumeric(value)) {
      at('BAD_NUMBER', `${definition.label} takes a number.`, field);
    }
  });

  const groups = new Set(
    conditions
      .filter(
        (condition): condition is FilterCondition =>
          typeof condition === 'object' && condition !== null,
      )
      .map((condition) => condition.groupIndex ?? 0),
  );
  if (groups.size > 10) {
    problems.push({
      index: -1,
      field: '',
      code: 'TOO_MANY_GROUPS',
      message: 'A filter with more than ten OR groups is a view nobody can read. Save two views.',
    });
  }
  return problems;
}

function isValidDateValue(value: unknown): boolean {
  if (isRelativeDate(value)) return true;
  if (Array.isArray(value)) return value.every((entry) => isValidDateValue(entry));
  if (typeof value === 'string' || typeof value === 'number') {
    return !Number.isNaN(new Date(value).getTime());
  }
  return value instanceof Date && !Number.isNaN(value.getTime());
}

function isNumeric(value: unknown): boolean {
  if (Array.isArray(value)) return value.every((entry) => isNumeric(entry));
  if (typeof value === 'number') return Number.isFinite(value);
  return typeof value === 'string' && value.trim() !== '' && !Number.isNaN(Number(value));
}

/** Groups a flat condition list into its OR groups, in ascending group order. */
export function groupConditions(
  conditions: readonly FilterCondition[],
): readonly (readonly FilterCondition[])[] {
  const groups = new Map<number, FilterCondition[]>();
  for (const condition of conditions) {
    const key = condition.groupIndex ?? 0;
    const group = groups.get(key) ?? [];
    group.push(condition);
    groups.set(key, group);
  }
  return [...groups.entries()].sort(([left], [right]) => left - right).map(([, group]) => group);
}

/** The columns a saved view may show, and the sort it may use. */
export const LEAD_SORTABLE_FIELDS = [
  'createdAt',
  'updatedAt',
  'lastActivityAt',
  'nextActionAt',
  'score',
  'valueMinor',
  'fullName',
] as const;
export type LeadSortField = (typeof LEAD_SORTABLE_FIELDS)[number];

export function isLeadSortField(value: string): value is LeadSortField {
  return (LEAD_SORTABLE_FIELDS as readonly string[]).includes(value);
}

/** Saved-view visibility (`FR-VIEW-3`). */
export const VIEW_VISIBILITIES = ['private', 'team', 'organization'] as const;
export type ViewVisibility = (typeof VIEW_VISIBILITIES)[number];
