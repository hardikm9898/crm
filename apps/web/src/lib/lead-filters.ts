/**
 * The lead filter, as URL state.
 *
 * Filters live in the query string rather than in client state, for three reasons that matter more
 * than the convenience: a filtered list is **shareable** ("look at these six leads"), it survives a
 * reload and the back button, and the page stays a server component — one source of truth, no
 * hydration boundary, no second cache to go stale after a mutation.
 *
 * The API's filter DSL is JSON. Putting raw JSON in a URL produces something unreadable and
 * fragile, so conditions are encoded compactly:
 *
 *     ?f=city:eq:Pune~priority:in:high,urgent|score:gte:75
 *      └── group 0: city is Pune AND priority in (high, urgent)
 *                                          └── OR group 1: score at least 75
 *
 * `~` separates conditions within a group, `|` separates groups, `:` separates the three parts.
 * Values are percent-encoded, so a value containing a separator round-trips.
 */

export interface UiCondition {
  readonly field: string;
  readonly operator: string;
  /** Already decoded. A list operator carries an array; a date window carries `{ window }`. */
  readonly value?: unknown;
  readonly groupIndex: number;
}

const GROUP_SEPARATOR = '|';
const CONDITION_SEPARATOR = '~';
const PART_SEPARATOR = ':';
const LIST_SEPARATOR = ',';

/** Operators that take no value, so nothing is encoded for them. */
const VALUELESS = new Set(['is_null', 'is_not_null']);
/** Operators whose value is a list. */
const LIST_OPERATORS = new Set(['in', 'nin', 'has_any', 'has_all', 'between']);

/** Marks a named date window, distinguishing `{ window: 'today' }` from the literal word. */
const WINDOW_PREFIX = '@';

export function encodeFilter(conditions: readonly UiCondition[]): string {
  if (conditions.length === 0) return '';
  const groups = new Map<number, UiCondition[]>();
  for (const condition of conditions) {
    const group = groups.get(condition.groupIndex) ?? [];
    group.push(condition);
    groups.set(condition.groupIndex, group);
  }
  return [...groups.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, group]) => group.map(encodeCondition).join(CONDITION_SEPARATOR))
    .join(GROUP_SEPARATOR);
}

function encodeCondition(condition: UiCondition): string {
  const head = `${condition.field}${PART_SEPARATOR}${condition.operator}`;
  if (VALUELESS.has(condition.operator)) return head;
  return `${head}${PART_SEPARATOR}${encodeValue(condition.value)}`;
}

function encodeValue(value: unknown): string {
  if (Array.isArray(value)) return value.map((entry) => encodeScalar(entry)).join(LIST_SEPARATOR);
  return encodeScalar(value);
}

function encodeScalar(value: unknown): string {
  if (value !== null && typeof value === 'object' && 'window' in value) {
    return `${WINDOW_PREFIX}${String((value as { window: unknown }).window)}`;
  }
  // `encodeURIComponent` leaves the unreserved marks `~ ! * ' ( )` alone, and `~` is the condition
  // separator — so a company called "Sharma ~ Motors" silently truncated the filter at the tilde.
  // Escaped by hand; `decodeURIComponent` turns `%7E` back into `~` on the way out.
  return encodeURIComponent(String(value ?? '')).replace(/~/g, '%7E');
}

/**
 * Parses the `f` parameter back into conditions.
 *
 * Deliberately forgiving: a malformed condition is **dropped**, not thrown. A URL is something
 * people edit, truncate and paste into chat, and a filter bar that shows an error page because one
 * chip was mangled is worse than one that shows the chips it understood.
 */
export function decodeFilter(encoded: string | null | undefined): UiCondition[] {
  if (!encoded) return [];
  const conditions: UiCondition[] = [];
  encoded.split(GROUP_SEPARATOR).forEach((groupText, groupIndex) => {
    for (const conditionText of groupText.split(CONDITION_SEPARATOR)) {
      if (conditionText.trim() === '') continue;
      const [field, operator, ...rest] = conditionText.split(PART_SEPARATOR);
      if (!field || !operator) continue;
      if (VALUELESS.has(operator)) {
        conditions.push({ field, operator, groupIndex });
        continue;
      }
      const raw = rest.join(PART_SEPARATOR);
      if (raw === '') continue;
      conditions.push({ field, operator, value: decodeValue(operator, raw), groupIndex });
    }
  });
  return conditions;
}

function decodeValue(operator: string, raw: string): unknown {
  if (LIST_OPERATORS.has(operator)) {
    return raw.split(LIST_SEPARATOR).map((entry) => decodeScalar(entry));
  }
  return decodeScalar(raw);
}

function decodeScalar(raw: string): unknown {
  if (raw.startsWith(WINDOW_PREFIX)) return { window: raw.slice(WINDOW_PREFIX.length) };
  return safeDecode(raw);
}

function safeDecode(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    // A stray `%` from a hand-edited URL is not worth failing a page render over.
    return raw;
  }
}

/** The body `POST /leads/search` expects. */
export function toApiFilter(conditions: readonly UiCondition[]): {
  conditions: { field: string; operator: string; value?: unknown; groupIndex: number }[];
} {
  return {
    conditions: conditions.map((condition) => ({
      field: condition.field,
      operator: condition.operator,
      groupIndex: condition.groupIndex,
      ...(VALUELESS.has(condition.operator) ? {} : { value: condition.value }),
    })),
  };
}

/** A field as the catalogue describes it — only the parts the filter bar needs. */
export interface CatalogueField {
  readonly field: string;
  readonly label: string;
  readonly kind: string;
  readonly operators: readonly string[];
  readonly optionsFrom?: string;
  readonly describe?: string;
  readonly valueUnit?: string;
}

/** Operator labels a person can read, rather than the wire vocabulary. */
export const OPERATOR_LABELS: Record<string, string> = {
  eq: 'is',
  ne: 'is not',
  in: 'is any of',
  nin: 'is none of',
  contains: 'contains',
  starts_with: 'starts with',
  gt: 'is more than',
  gte: 'is at least',
  lt: 'is less than',
  lte: 'is at most',
  between: 'is between',
  is_null: 'is empty',
  is_not_null: 'is not empty',
  has_any: 'has any of',
  has_all: 'has all of',
};

/**
 * One chip's worth of text.
 *
 * Resolves ids to names through `labels` where it can. A chip reading
 * "Status is 01a0e98a-…" is a chip nobody can check, and an unresolved id is the normal case while
 * a list is still loading its options — so it degrades to a short form rather than the raw uuid.
 */
export function describeCondition(
  condition: UiCondition,
  field: CatalogueField | undefined,
  labels: Readonly<Record<string, string>> = {},
): string {
  const name = field?.label ?? condition.field;
  const operator = OPERATOR_LABELS[condition.operator] ?? condition.operator;
  if (VALUELESS.has(condition.operator)) return `${name} ${operator}`;

  const describeOne = (value: unknown): string => {
    if (value !== null && typeof value === 'object' && 'window' in value) {
      return describeWindow(String((value as { window: unknown }).window));
    }
    const text = String(value ?? '');
    if (labels[text]) return labels[text]!;
    return looksLikeId(text) ? `${text.slice(0, 8)}…` : text;
  };

  const value = Array.isArray(condition.value)
    ? condition.value.map(describeOne).join(condition.operator === 'between' ? ' and ' : ', ')
    : describeOne(condition.value);
  return `${name} ${operator} ${value}`;
}

function looksLikeId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(value);
}

export const DATE_WINDOW_LABELS: Record<string, string> = {
  today: 'today',
  tomorrow: 'tomorrow',
  yesterday: 'yesterday',
  this_week: 'this week',
  last_week: 'last week',
  next_week: 'next week',
  this_month: 'this month',
  last_month: 'last month',
  last_7_days: 'the last 7 days',
  last_30_days: 'the last 30 days',
  next_7_days: 'the next 7 days',
  overdue: 'overdue',
};

export function describeWindow(window: string): string {
  return DATE_WINDOW_LABELS[window] ?? window.replace(/_/g, ' ');
}

/** Removes one condition, keeping the groups of the rest intact. */
export function withoutCondition(conditions: readonly UiCondition[], index: number): UiCondition[] {
  return conditions.filter((_, position) => position !== index);
}

/**
 * Builds the query string for a list URL, dropping empty values so a shared link stays short and
 * `?cursor=` never survives a filter change — paging from page three of a *different* filter would
 * silently show the wrong rows.
 */
export function leadListHref(params: {
  readonly view?: string | null;
  readonly conditions?: readonly UiCondition[];
  readonly sort?: string | null;
  readonly direction?: string | null;
  readonly cursor?: string | null;
  readonly deleted?: boolean;
  readonly basePath?: string;
}): string {
  const search = new URLSearchParams();
  if (params.view) search.set('view', params.view);
  const encoded = encodeFilter(params.conditions ?? []);
  if (encoded) search.set('f', encoded);
  if (params.sort) search.set('sort', params.sort);
  if (params.direction) search.set('dir', params.direction);
  if (params.cursor) search.set('cursor', params.cursor);
  if (params.deleted) search.set('deleted', '1');
  const query = search.toString();
  const base = params.basePath ?? '/leads';
  return query === '' ? base : `${base}?${query}`;
}
