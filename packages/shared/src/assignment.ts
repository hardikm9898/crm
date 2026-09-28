import { FILTER_OPERATORS, type FilterOperator } from './custom-fields.js';

/**
 * Assignment rule conditions (`FR-ASG-2`), evaluated purely.
 *
 * The shape is deliberately flat: AND within a `groupIndex`, OR across groups. A nested expression
 * tree would be more general and materially harder to build a UI for — and in the businesses this
 * product serves, "Facebook leads in Pune or Mumbai, worth over five lakh" is the ceiling. When a
 * rule genuinely needs more, a second rule at a different priority says it more clearly than a
 * nested tree would.
 *
 * Evaluation is here rather than in the service so that "why did this rule choose this person" can
 * be answered without a database — which is what makes the rule tester (`FR-ASG-4`) honest: it runs
 * the same code the real assignment does, not a reimplementation of it.
 */

export const ASSIGNMENT_STRATEGIES = [
  'specific_user',
  'team',
  'round_robin',
  'weighted_round_robin',
  'least_open_leads',
  'top_performer',
] as const;

export type AssignmentStrategyName = (typeof ASSIGNMENT_STRATEGIES)[number];

export interface StrategySpec {
  readonly strategy: AssignmentStrategyName;
  readonly label: string;
  /** What `target` must carry. */
  readonly requires: 'userId' | 'teamId' | 'pool' | 'none';
  /** True when the strategy needs `assignment_pool_members` rows. */
  readonly usesPool: boolean;
  readonly describe: string;
}

export const STRATEGY_SPECS: Readonly<Record<AssignmentStrategyName, StrategySpec>> = {
  specific_user: {
    strategy: 'specific_user',
    label: 'A specific person',
    requires: 'userId',
    usesPool: false,
    describe: 'Always the same person. Useful for a named account manager.',
  },
  team: {
    strategy: 'team',
    label: 'Anyone on a team',
    requires: 'teamId',
    usesPool: false,
    describe: 'The team member holding the fewest open leads.',
  },
  round_robin: {
    strategy: 'round_robin',
    label: 'Round-robin',
    requires: 'pool',
    usesPool: true,
    describe: 'Each eligible member in turn, so the split is even over time.',
  },
  weighted_round_robin: {
    strategy: 'weighted_round_robin',
    label: 'Weighted round-robin',
    requires: 'pool',
    usesPool: true,
    describe: 'Round-robin where a weight of 3 takes three turns to another member’s one.',
  },
  least_open_leads: {
    strategy: 'least_open_leads',
    label: 'Whoever has the fewest open leads',
    requires: 'pool',
    usesPool: true,
    describe: 'Balances current load rather than long-run count.',
  },
  top_performer: {
    strategy: 'top_performer',
    label: 'Best recent conversion rate',
    requires: 'pool',
    usesPool: true,
    describe: 'The pool member who has converted the most leads recently.',
  },
};

export function strategySpec(strategy: string): StrategySpec | undefined {
  return (STRATEGY_SPECS as Record<string, StrategySpec>)[strategy];
}

/** What happens when nobody is eligible (`FR-ASG-4`). Never silent. */
export const FALLBACK_MODES = ['unassigned_pool', 'specific_user', 'team'] as const;
export type FallbackMode = (typeof FALLBACK_MODES)[number];

export interface RuleCondition {
  readonly fieldPath: string;
  readonly operator: string;
  readonly value: unknown;
  readonly groupIndex: number;
}

/**
 * The subject a rule is evaluated against: the lead's own fields, its custom values, and the clock.
 *
 * The clock is part of the subject rather than read inside the evaluator so that the rule tester can
 * ask "what would have happened at 9pm on a Sunday" — a question a business asks precisely because
 * that is when leads go unanswered.
 */
export interface AssignmentSubject {
  readonly lead: Readonly<Record<string, unknown>>;
  readonly custom: Readonly<Record<string, unknown>>;
  /** 0–23, in the organization's timezone. */
  readonly hour: number;
  /** 0 = Sunday … 6 = Saturday, in the organization's timezone. */
  readonly dayOfWeek: number;
}

export interface ConditionOutcome {
  readonly condition: RuleCondition;
  readonly actual: unknown;
  readonly matched: boolean;
  /** Set when the condition could not be evaluated at all, rather than simply not matching. */
  readonly problem?: string;
}

export interface RuleEvaluation {
  readonly matched: boolean;
  /** Per-condition detail, in the order given, so the tester can show its working. */
  readonly outcomes: readonly ConditionOutcome[];
  /** Human sentence explaining the verdict. */
  readonly explanation: string;
}

/** Which prefixes a `fieldPath` may use, and what they read. */
export const FIELD_PATH_PREFIXES = ['custom.', 'time.'] as const;

/** The clock fields a condition may name. */
export const TIME_FIELDS = ['hour', 'dayOfWeek'] as const;

export function resolveFieldPath(path: string, subject: AssignmentSubject): unknown {
  if (path.startsWith('custom.')) return subject.custom[path.slice('custom.'.length)];
  if (path === 'time.hour') return subject.hour;
  if (path === 'time.dayOfWeek') return subject.dayOfWeek;
  if (path.startsWith('time.')) return undefined;
  return subject.lead[path];
}

/**
 * Evaluates a rule's conditions.
 *
 * A rule with **no** conditions matches everything, which is what makes a catch-all rule at the
 * lowest priority the natural way to express "and everyone else goes here".
 */
export function evaluateConditions(
  conditions: readonly RuleCondition[],
  subject: AssignmentSubject,
): RuleEvaluation {
  if (conditions.length === 0) {
    return {
      matched: true,
      outcomes: [],
      explanation: 'No conditions, so this rule matches every lead.',
    };
  }

  const outcomes: ConditionOutcome[] = conditions.map((condition) => {
    const actual = resolveFieldPath(condition.fieldPath, subject);
    const result = applyOperator(condition.operator, actual, condition.value);
    return {
      condition,
      actual,
      matched: result.matched,
      ...(result.problem ? { problem: result.problem } : {}),
    };
  });

  const groups = new Map<number, ConditionOutcome[]>();
  for (const outcome of outcomes) {
    const group = groups.get(outcome.condition.groupIndex) ?? [];
    group.push(outcome);
    groups.set(outcome.condition.groupIndex, group);
  }

  const groupResults = [...groups.entries()]
    .sort(([a], [b]) => a - b)
    .map(([index, group]) => ({
      index,
      matched: group.every((outcome) => outcome.matched),
      group,
    }));

  const matched = groupResults.some((group) => group.matched);
  return { matched, outcomes, explanation: explain(groupResults, matched) };
}

function explain(
  groups: readonly { index: number; matched: boolean; group: readonly ConditionOutcome[] }[],
  matched: boolean,
): string {
  if (matched) {
    const winner = groups.find((group) => group.matched);
    const description = winner?.group
      .map(
        (outcome) =>
          `${outcome.condition.fieldPath} ${outcome.condition.operator} ${format(outcome.condition.value)}`,
      )
      .join(' and ');
    return `Matched because ${description}.`;
  }
  // Naming the *closest* failure is more useful than listing every one: a rule with four groups
  // that all failed on the same field has one problem, not four.
  const failures = groups.flatMap((group) => group.group).filter((outcome) => !outcome.matched);
  const first = failures[0];
  if (!first) return 'Did not match.';
  const because = failures
    .slice(0, 3)
    .map(
      (outcome) =>
        `${outcome.condition.fieldPath} is ${format(outcome.actual)}, not ${outcome.condition.operator} ${format(outcome.condition.value)}`,
    )
    .join('; ');
  return `Did not match: ${because}.`;
}

function format(value: unknown): string {
  if (value === null) return 'empty';
  if (value === undefined) return 'not set';
  if (Array.isArray(value)) return value.map((entry) => String(entry)).join('/');
  return String(value);
}

interface OperatorResult {
  readonly matched: boolean;
  readonly problem?: string;
}

/**
 * The operators a condition may use — the same list the custom-field filter DSL exposes, so a
 * business learns one vocabulary rather than two.
 *
 * Comparisons are deliberately forgiving about type: a condition written against a text field whose
 * value arrives as a number should still work, because the person writing the rule was not thinking
 * about JSON types.
 */
export function applyOperator(
  operator: string,
  actual: unknown,
  expected: unknown,
): OperatorResult {
  if (!(FILTER_OPERATORS as readonly string[]).includes(operator)) {
    return { matched: false, problem: `Unknown operator “${operator}”.` };
  }

  const op = operator as FilterOperator;
  const missing = actual === null || actual === undefined || actual === '';

  switch (op) {
    case 'is_null':
      return { matched: missing };
    case 'is_not_null':
      return { matched: !missing };
    default:
      break;
  }

  // Everything else is false against a missing value rather than throwing: a rule about the city of
  // a lead with no city has simply not matched.
  if (missing) return { matched: false };

  switch (op) {
    case 'eq':
      return { matched: same(actual, expected) };
    case 'ne':
      return { matched: !same(actual, expected) };
    case 'in':
      return { matched: asList(expected).some((entry) => same(actual, entry)) };
    case 'nin':
      return { matched: !asList(expected).some((entry) => same(actual, entry)) };
    case 'contains':
      return { matched: text(actual).includes(text(expected)) };
    case 'starts_with':
      return { matched: text(actual).startsWith(text(expected)) };
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      const comparison = compare(actual, expected);
      if (comparison === null) return { matched: false, problem: 'Values are not comparable.' };
      if (op === 'gt') return { matched: comparison > 0 };
      if (op === 'gte') return { matched: comparison >= 0 };
      if (op === 'lt') return { matched: comparison < 0 };
      return { matched: comparison <= 0 };
    }
    case 'between': {
      const bounds = asList(expected);
      if (bounds.length !== 2) return { matched: false, problem: 'Between needs two bounds.' };
      const low = compare(actual, bounds[0]);
      const high = compare(actual, bounds[1]);
      if (low === null || high === null)
        return { matched: false, problem: 'Values are not comparable.' };
      return { matched: low >= 0 && high <= 0 };
    }
    case 'has_any': {
      const actualList = asList(actual);
      return {
        matched: asList(expected).some((entry) => actualList.some((value) => same(value, entry))),
      };
    }
    case 'has_all': {
      const actualList = asList(actual);
      return {
        matched: asList(expected).every((entry) => actualList.some((value) => same(value, entry))),
      };
    }
    default:
      return { matched: false, problem: `Operator “${operator}” is not supported here.` };
  }
}

function same(left: unknown, right: unknown): boolean {
  if (typeof left === 'boolean' || typeof right === 'boolean') {
    return toBoolean(left) === toBoolean(right);
  }
  if (typeof left === 'number' || typeof right === 'number') {
    const a = Number(left);
    const b = Number(right);
    if (Number.isFinite(a) && Number.isFinite(b)) return a === b;
  }
  return text(left) === text(right);
}

function toBoolean(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  const asText = text(value);
  return asText === 'true' || asText === '1' || asText === 'yes';
}

function text(value: unknown): string {
  return String(value ?? '')
    .trim()
    .toLowerCase();
}

function asList(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [value];
}

/** −1, 0, 1, or null when the two values cannot be ordered meaningfully. */
function compare(left: unknown, right: unknown): number | null {
  const a = Number(left);
  const b = Number(right);
  if (Number.isFinite(a) && Number.isFinite(b)) return a === b ? 0 : a < b ? -1 : 1;

  // ISO dates and datetimes compare correctly as strings, which is why they are stored that way.
  if (typeof left === 'string' && typeof right === 'string') {
    const leftTime = Date.parse(left);
    const rightTime = Date.parse(right);
    if (Number.isFinite(leftTime) && Number.isFinite(rightTime)) {
      return leftTime === rightTime ? 0 : leftTime < rightTime ? -1 : 1;
    }
  }
  return null;
}

/**
 * Whose turn it is in a round-robin, given the durable cursor.
 *
 * Pure, so fairness is testable without a database. The caller advances the stored cursor inside the
 * assigning transaction — that row lock is what stops two simultaneous captures taking the same turn.
 */
export interface PoolTurn {
  readonly userId: string;
  readonly nextCursorIndex: number;
  readonly nextWeightConsumed: number;
}

export function nextInRoundRobin(
  pool: readonly { readonly userId: string; readonly weight: number }[],
  state: { readonly cursorIndex: number; readonly weightConsumed: number },
  weighted: boolean,
): PoolTurn | null {
  if (pool.length === 0) return null;

  // A cursor can outlive the pool it indexed — someone leaves, the pool shrinks. Wrapping rather
  // than failing is the only behaviour that does not strand assignment on a stale number.
  const index = ((state.cursorIndex % pool.length) + pool.length) % pool.length;
  const member = pool[index];
  /* c8 ignore next */
  if (!member) return null;

  if (!weighted) {
    return {
      userId: member.userId,
      nextCursorIndex: (index + 1) % pool.length,
      nextWeightConsumed: 0,
    };
  }

  const weight = Math.max(1, member.weight);
  const consumed = state.weightConsumed + 1;
  return consumed >= weight
    ? { userId: member.userId, nextCursorIndex: (index + 1) % pool.length, nextWeightConsumed: 0 }
    : { userId: member.userId, nextCursorIndex: index, nextWeightConsumed: consumed };
}
