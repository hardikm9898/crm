/**
 * The executor's arithmetic (`FR-AUT-6`, `FR-AUT-7`).
 *
 * Everything in this file is **pure**, and that is the point: the engine is the
 * highest-consequence subsystem in the product — a single bad workflow must never be able to
 * message a tenant's entire customer base — and the decisions that make it safe are the ones most
 * worth testing without a database. Walking a graph, deciding whether a lead may enter again,
 * evaluating a condition and interpolating a template are all here; reading rows and writing them
 * is the service's job.
 */

/*
 * The exported names here are prefixed `Automation…` deliberately: `@leados/shared` is one
 * barrel, `assignment.ts` already exports a `ConditionOutcome` and an `evaluateConditions`, and a
 * second one turns the whole package into a `TS2308` whose message names neither file's author.
 */
import {
  VALUELESS_OPERATORS,
  type ConditionGroup,
  type ConditionLeaf,
  type ConditionOperator,
  type ReentryPolicy,
  type WorkflowDefinition,
  type WorkflowStep,
} from './automation.js';

/**
 * How deep a chain of automation-caused events may go before the dispatcher refuses.
 *
 * Loop detection without a cycle checker: a workflow whose action re-triggers it (change the
 * status, which fires `lead.status_changed`, which triggers the same workflow) climbs this by one
 * each time. Five is the doc's number, and it is deliberately small — a legitimate chain of five
 * workflows reacting to each other is already a workspace nobody can reason about.
 */
export const MAX_CAUSATION_DEPTH = 5;

/**
 * The daily cap on actions a workspace's automation may take, when the workspace has not set one.
 *
 * **Absent must not mean unlimited.** `leadRecycleDays` reads an absent setting as "the feature is
 * off", which is right for a convenience and catastrophic for a safety limit: the failure this cap
 * exists to prevent is a workflow messaging everybody, and a workspace that has never opened the
 * automation settings is exactly the one it would happen to.
 */
export const DEFAULT_DAILY_ACTION_CAP = 1000;

/** How many steps one run may execute, whatever the graph says. */
export const MAX_STEPS_PER_RUN = 100;

// ── Walking the graph ─────────────────────────────────────────────────────────

/**
 * Every step of a definition, flattened in execution order, each with the path that reaches it.
 *
 * The flattening is what makes a **resumable** run possible: a run stores `current_step_id`, and
 * after a wait the engine has to find "the step after that one" in a graph it did not keep in
 * memory. A nested branch is expanded in place, which means the order here is exactly the order a
 * person reading the editor would expect.
 */
export interface FlatStep {
  readonly step: WorkflowStep;
  /** `definition.steps[1].then[0]`, for the run-step log and for error messages. */
  readonly path: string;
  readonly depth: number;
  /** The branch arm this step sits under, or null at the top level. */
  readonly branchOf: { readonly stepId: string; readonly arm: 'then' | 'otherwise' } | null;
}

export function flattenSteps(definition: WorkflowDefinition): FlatStep[] {
  const flat: FlatStep[] = [];
  const walk = (
    steps: readonly WorkflowStep[],
    path: string,
    depth: number,
    branchOf: FlatStep['branchOf'],
  ) => {
    steps.forEach((step, index) => {
      const here = `${path}[${index}]`;
      flat.push({ step, path: here, depth, branchOf });
      if (step.then) walk(step.then, `${here}.then`, depth + 1, { stepId: step.id, arm: 'then' });
      if (step.otherwise) {
        walk(step.otherwise, `${here}.otherwise`, depth + 1, { stepId: step.id, arm: 'otherwise' });
      }
    });
  };
  walk(definition.steps, 'definition.steps', 0, null);
  return flat;
}

/**
 * The step a run should execute next.
 *
 * `null` for "the run is finished", which is the honest answer and not an error: a workflow whose
 * last step has run is complete. The arm a branch did **not** take is skipped wholesale — which is
 * why this takes the decisions made so far rather than only the current step: resuming a run after
 * a two-day wait has to know which way the branch above it went, and the run's own step log is the
 * only record of that.
 */
export function nextStep(
  definition: WorkflowDefinition,
  options: {
    readonly after: string | null;
    /** `stepId → 'then' | 'otherwise'`, from the run's recorded branch decisions. */
    readonly branchDecisions: Readonly<Record<string, 'then' | 'otherwise'>>;
  },
): FlatStep | null {
  const flat = flattenSteps(definition);
  const startIndex =
    options.after === null ? 0 : flat.findIndex((entry) => entry.step.id === options.after) + 1;
  // An `after` the graph does not contain means the version moved under a run, which cannot
  // happen (a published version is immutable) — but answering "finished" is safer than running
  // the first step again.
  if (options.after !== null && startIndex === 0) return null;

  for (let index = startIndex; index < flat.length; index += 1) {
    const candidate = flat[index]!;
    if (candidate.branchOf === null) return candidate;
    const taken = options.branchDecisions[candidate.branchOf.stepId];
    // A step under an arm nobody decided on is unreachable: either the branch has not run yet
    // (impossible, it is above us in execution order) or it took the other way.
    if (taken === candidate.branchOf.arm) return candidate;
  }
  return null;
}

// ── Conditions ────────────────────────────────────────────────────────────────

/**
 * The facts a condition is evaluated against: `lead.statusId`, `lead.score`, and so on.
 *
 * A flat map rather than a nested object, keyed by exactly the strings `CONDITION_FIELDS`
 * declares, so "the field the editor offered" and "the fact the engine reads" cannot drift.
 */
export type AutomationFacts = Readonly<Record<string, unknown>>;

export interface AutomationConditionOutcome {
  readonly passed: boolean;
  /** Which leaf decided it, in words, for the skip reason on the timeline. */
  readonly reason: string;
}

export function evaluateAutomationConditions(group: ConditionGroup | undefined, facts: AutomationFacts): AutomationConditionOutcome {
  if (group === undefined) return { passed: true, reason: 'no conditions' };
  return evaluateGroup(group, facts);
}

function evaluateGroup(group: ConditionGroup, facts: AutomationFacts): AutomationConditionOutcome {
  if (Array.isArray(group.all)) {
    if (group.all.length === 0) return { passed: true, reason: 'no conditions' };
    for (const entry of group.all) {
      const outcome = evaluateEntry(entry, facts);
      // The first failure is the explanation: "all of these" fails for one reason, and naming the
      // rest would be noise on a timeline.
      if (!outcome.passed) return outcome;
    }
    return { passed: true, reason: 'every condition matched' };
  }
  if (Array.isArray(group.any)) {
    if (group.any.length === 0) return { passed: true, reason: 'no conditions' };
    const reasons: string[] = [];
    for (const entry of group.any) {
      const outcome = evaluateEntry(entry, facts);
      if (outcome.passed) return outcome;
      reasons.push(outcome.reason);
    }
    return { passed: false, reason: reasons.join('; and ') };
  }
  return { passed: true, reason: 'no conditions' };
}

function evaluateEntry(entry: ConditionLeaf | ConditionGroup, facts: AutomationFacts): AutomationConditionOutcome {
  if ('all' in entry || 'any' in entry) return evaluateGroup(entry as ConditionGroup, facts);
  return evaluateLeaf(entry as ConditionLeaf, facts);
}

function evaluateLeaf(leaf: ConditionLeaf, facts: AutomationFacts): AutomationConditionOutcome {
  const actual = facts[leaf.field];
  const passed = compare(leaf.operator, actual, leaf.value);
  return {
    passed,
    reason: passed
      ? `${leaf.field} ${describeOperator(leaf.operator)} ${describeValue(leaf.value)}`
      : `${leaf.field} is ${describeValue(actual)}, not ${describeOperator(leaf.operator)} ${describeValue(leaf.value)}`,
  };
}

function compare(operator: ConditionOperator, actual: unknown, expected: unknown): boolean {
  if (VALUELESS_OPERATORS.includes(operator)) {
    const empty =
      actual === null ||
      actual === undefined ||
      actual === '' ||
      (Array.isArray(actual) && actual.length === 0);
    return operator === 'is_empty' ? empty : !empty;
  }

  // `changed_to` is `equals` against the **new** value, which is what the fact map already holds:
  // the trigger has fired because the field changed, so "did it change to X" is "is it X now".
  // Keeping it a separate operator is what lets the editor say the right words. (The comment is
  // above the switch rather than between the two cases, where `no-fallthrough` reads it as a
  // statement and refuses the deliberate pairing.)
  switch (operator) {
    case 'equals':
    case 'changed_to':
      return sameValue(actual, expected);
    case 'not_equals':
      return !sameValue(actual, expected);
    case 'contains': {
      if (Array.isArray(actual)) {
        return actual.some((entry) => sameValue(entry, expected));
      }
      if (typeof actual !== 'string' || typeof expected !== 'string') return false;
      return actual.toLowerCase().includes(expected.toLowerCase());
    }
    case 'greater_than':
    case 'less_than': {
      const left = asNumber(actual);
      const right = asNumber(expected);
      // A comparison against something that is not a number is **false**, not an exception: a
      // workflow comparing a blank score must not stop the run, it must not match.
      if (left === null || right === null) return false;
      return operator === 'greater_than' ? left > right : left < right;
    }
    case 'in': {
      const list = Array.isArray(expected) ? expected : String(expected ?? '').split(',');
      return list.some((entry) =>
        sameValue(actual, typeof entry === 'string' ? entry.trim() : entry),
      );
    }
    default:
      return false;
  }
}

function sameValue(actual: unknown, expected: unknown): boolean {
  if (typeof actual === 'boolean' || typeof expected === 'boolean') {
    return asBoolean(actual) === asBoolean(expected);
  }
  if (typeof actual === 'number' || typeof expected === 'number') {
    const left = asNumber(actual);
    const right = asNumber(expected);
    if (left !== null && right !== null) return left === right;
  }
  if (actual === null || actual === undefined) return expected === null || expected === undefined;
  return String(actual) === String(expected);
}

/** `Number('')` is 0 and `Number(null)` is 0, and 0 is a meaningful score. */
function asNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

function asBoolean(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return value === 'true';
  return value === 1;
}

function describeOperator(operator: ConditionOperator): string {
  switch (operator) {
    case 'equals':
      return 'is';
    case 'changed_to':
      return 'changed to';
    case 'not_equals':
      return 'is not';
    case 'contains':
      return 'contains';
    case 'greater_than':
      return 'is above';
    case 'less_than':
      return 'is below';
    case 'in':
      return 'is one of';
    case 'is_empty':
      return 'is empty';
    case 'is_not_empty':
      return 'is set';
  }
}

function describeValue(value: unknown): string {
  if (value === null || value === undefined || value === '') return 'nothing';
  if (Array.isArray(value)) return value.map((entry) => String(entry)).join(', ');
  return String(value);
}

// ── Re-entry (`FR-AUT-6`) ─────────────────────────────────────────────────────

export interface ReentryDecision {
  readonly allowed: boolean;
  /** The cycle a new enrollment would take. The unique on it is what makes this a guarantee. */
  readonly cycle: number;
  /** Why not, in a sentence for the lead's timeline. */
  readonly reason: string;
}

/**
 * May this lead enter this workflow (again)?
 *
 * Pure, and separate from the database on purpose: this is the decision that stops somebody being
 * messaged twenty times, and it is worth being able to test every shape of it in milliseconds.
 * The **unique** on `(organization_id, workflow_id, lead_id, cycle)` is what makes the answer hold
 * when two jobs ask at once; this function is what makes it the right answer.
 */
export function reentryDecision(input: {
  readonly policy: ReentryPolicy;
  readonly cooldownHours: number | null;
  readonly maxRunsPerEntity: number | null;
  readonly cycles: number;
  readonly lastEnrolledAt: Date | null;
  readonly hasLiveRun: boolean;
  readonly now: Date;
}): ReentryDecision {
  const nextCycle = input.cycles + 1;

  // A run already going for this lead is never doubled, whatever the policy says. Two runs of one
  // workflow on one lead is the shape of "they got the message twice".
  if (input.hasLiveRun) {
    return {
      allowed: false,
      cycle: nextCycle,
      reason: 'this workflow is already running for this lead',
    };
  }

  if (input.maxRunsPerEntity !== null && input.cycles >= input.maxRunsPerEntity) {
    return {
      allowed: false,
      cycle: nextCycle,
      reason:
        input.maxRunsPerEntity === 1
          ? 'this lead has already been through this workflow'
          : `this lead has already been through this workflow ${input.maxRunsPerEntity} times, which is the limit`,
    };
  }

  if (input.policy === 'once' && input.cycles >= 1) {
    return {
      allowed: false,
      cycle: nextCycle,
      reason: 'this workflow runs once per lead, and this lead has been through it',
    };
  }

  if (input.policy === 'cooldown' && input.cycles >= 1) {
    const hours = input.cooldownHours ?? 0;
    const last = input.lastEnrolledAt;
    if (last === null) {
      // A cycle with no instant is a row the CHECK would not allow; refusing is still safer than
      // treating a missing date as "long ago".
      return { allowed: false, cycle: nextCycle, reason: 'the last run has no recorded start' };
    }
    const readyAt = new Date(last.getTime() + hours * 3_600_000);
    if (readyAt > input.now) {
      return {
        allowed: false,
        cycle: nextCycle,
        reason: `this lead went through this workflow less than ${hours} hours ago`,
      };
    }
  }

  return { allowed: true, cycle: nextCycle, reason: 'allowed' };
}

// ── Interpolation ─────────────────────────────────────────────────────────────

export class UnknownPlaceholderError extends Error {
  constructor(readonly placeholder: string) {
    super(`Nothing is known for “${placeholder}”.`);
    this.name = 'UnknownPlaceholderError';
  }
}

/**
 * `{{lead.fullName}}` against the run's own facts.
 *
 * Unknown paths **throw**. A WhatsApp template rendered with `undefined` is worse than no message,
 * and a note reading "Call Mr undefined back" is the kind of thing a business sends once and then
 * stops trusting the product. The failure becomes a failed step with a sentence, which is exactly
 * what the run log is for.
 */
export function interpolate(template: string, facts: AutomationFacts): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g, (_match, path: string) => {
    const value = facts[path];
    if (value === undefined) throw new UnknownPlaceholderError(path);
    if (value === null) return '';
    if (Array.isArray(value)) return value.map((entry) => String(entry)).join(', ');
    return String(value);
  });
}

/** Every placeholder a string names, for a pre-flight check that needs no values. */
export function placeholdersIn(template: string): string[] {
  const found = new Set<string>();
  for (const match of template.matchAll(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g)) {
    if (match[1]) found.add(match[1]);
  }
  return [...found];
}
