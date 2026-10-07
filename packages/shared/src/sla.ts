/**
 * SLA vocabulary and policy matching (`FR-TSK-8`).
 *
 * The arithmetic that decides *when* something is due lives in `business-hours.ts`; this file
 * decides **which promise applies** and **what state a clock is in**. Both are pure, because both
 * are read in three places — the service that starts a clock, the sweep that escalates one, and the
 * board a manager reads — and three implementations of "is this breached" would disagree on the
 * day it mattered.
 */

/** What is being measured. A lead has a first response and a resolution; a conversation has all three. */
export const SLA_TARGETS = ['first_response', 'next_response', 'resolution'] as const;
export type SlaTarget = (typeof SLA_TARGETS)[number];

export const SLA_SUBJECT_TYPES = ['lead', 'conversation', 'task'] as const;
export type SlaSubjectType = (typeof SLA_SUBJECT_TYPES)[number];

/**
 * A clock's lifecycle.
 *
 * `breached` is **stored**, unlike a task's `overdue` — and for the opposite reason. Overdue is a
 * fact about the clock that anyone can recompute; a breach is an *event* that was escalated to a
 * named person at a named moment, and recomputing it would lose who was told and when. The sweep
 * writes it once, and `escalations` has a unique key per level so it cannot be written twice.
 */
export const SLA_CLOCK_STATES = [
  'running',
  'paused',
  'satisfied',
  'breached',
  'cancelled',
] as const;
export type SlaClockState = (typeof SLA_CLOCK_STATES)[number];

/** Why somebody was escalated to. Level 1 is the warning, level 2 the breach. */
export const ESCALATION_LEVELS = { atRisk: 1, breached: 2 } as const;

/**
 * Which leads a policy applies to.
 *
 * Every field is an **allow-list that is only consulted when present**: an absent field means "any",
 * which is what makes a policy with an empty `applies_to` the catch-all. An empty *array* is
 * deliberately treated as "any" too — a tenant who clears the last source from a condition means
 * "stop filtering on source", not "match nothing", and a policy that silently matched nothing would
 * be an SLA that quietly stopped existing.
 */
export interface SlaAppliesTo {
  readonly sourceIds?: readonly string[];
  readonly priorities?: readonly string[];
  readonly pipelineIds?: readonly string[];
  readonly scoreBands?: readonly string[];
}

export interface SlaPolicyLike {
  readonly id: string;
  readonly priority: number;
  readonly appliesTo: SlaAppliesTo;
  readonly firstResponseMinutes: number;
  readonly nextResponseMinutes: number | null;
  readonly resolutionMinutes: number | null;
  readonly businessHoursOnly: boolean;
  readonly warnAtPercent: number;
}

/** What a lead looks like to a policy. */
export interface SlaSubjectFacts {
  readonly leadSourceId?: string | null;
  readonly priority?: string | null;
  readonly pipelineId?: string | null;
  readonly scoreBand?: string | null;
}

/** How many conditions a policy actually constrains — its specificity. */
export function policySpecificity(appliesTo: SlaAppliesTo): number {
  return [
    appliesTo.sourceIds,
    appliesTo.priorities,
    appliesTo.pipelineIds,
    appliesTo.scoreBands,
  ].filter((values) => Array.isArray(values) && values.length > 0).length;
}

export function policyMatches(policy: SlaPolicyLike, facts: SlaSubjectFacts): boolean {
  const { appliesTo } = policy;
  return (
    allows(appliesTo.sourceIds, facts.leadSourceId) &&
    allows(appliesTo.priorities, facts.priority) &&
    allows(appliesTo.pipelineIds, facts.pipelineId) &&
    allows(appliesTo.scoreBands, facts.scoreBand)
  );
}

/**
 * The policy that governs a lead, or `null` when none does.
 *
 * **First match wins, by the tenant's own `priority`** — the convention ADR-0014 set for duplicate
 * rules, so a business that has learned how one ordering works has learned both. A tie is broken by
 * specificity (a policy that constrains three things before one that constrains none) and then by
 * id, so the answer is stable: two policies at the same priority must not make a lead's promise
 * flip between recomputes.
 */
export function matchSlaPolicy(
  policies: readonly SlaPolicyLike[],
  facts: SlaSubjectFacts,
): SlaPolicyLike | null {
  const matching = policies.filter((policy) => policyMatches(policy, facts));
  if (matching.length === 0) return null;
  return [...matching].sort(
    (a, b) =>
      a.priority - b.priority ||
      policySpecificity(b.appliesTo) - policySpecificity(a.appliesTo) ||
      (a.id < b.id ? -1 : 1),
  )[0]!;
}

/** The target for one measurement, or `null` when this policy does not promise it. */
export function targetMinutes(policy: SlaPolicyLike, target: SlaTarget): number | null {
  switch (target) {
    case 'first_response':
      return policy.firstResponseMinutes;
    case 'next_response':
      return policy.nextResponseMinutes;
    case 'resolution':
      return policy.resolutionMinutes;
  }
}

/**
 * How many working minutes in before the warning fires (`FR-TSK-8`'s near-breach).
 *
 * Derived as a share of the target and then **added through the business calendar**, never
 * interpolated between the start and the due instant: a 60-minute target starting at 17:30 is due
 * at 09:30 the next morning, and 80 % of the elapsed span between those two instants is three in
 * the morning — a warning nobody is awake for, about a promise that has not nearly expired.
 *
 * At least one minute, so a very short target still warns before it breaches rather than at the
 * same instant.
 */
export function warnMinutes(targetMinutesValue: number, warnAtPercent: number): number {
  const percent = Math.min(99, Math.max(1, Math.round(warnAtPercent)));
  return Math.max(
    1,
    Math.min(targetMinutesValue - 1, Math.round((targetMinutesValue * percent) / 100)),
  );
}

export interface ClockLike {
  readonly state: SlaClockState;
  readonly dueAt: Date;
  readonly warnAt: Date;
  readonly satisfiedAt?: Date | null;
  readonly breachedAt?: Date | null;
}

/** How a clock reads on a screen. */
export type SlaHealth = 'met' | 'breached' | 'at_risk' | 'running' | 'paused' | 'cancelled';

/**
 * What a clock looks like right now.
 *
 * A **running** clock past its due instant reads `breached` even before the sweep has written the
 * status: a manager refreshing a board at 10:01 must not be told a 10:00 promise is still fine
 * because a cron has not run. The status in the database is about *having escalated*; this is about
 * what is true.
 */
export function slaHealth(clock: ClockLike, now: Date): SlaHealth {
  if (clock.state === 'satisfied') return 'met';
  if (clock.state === 'breached') return 'breached';
  if (clock.state === 'cancelled') return 'cancelled';
  if (clock.state === 'paused') return 'paused';
  if (now.getTime() >= clock.dueAt.getTime()) return 'breached';
  if (now.getTime() >= clock.warnAt.getTime()) return 'at_risk';
  return 'running';
}

/** Whether a satisfied clock met its promise. Used by the report, not by the sweep. */
export function wasMetOnTime(clock: ClockLike): boolean | null {
  if (!clock.satisfiedAt) return null;
  return clock.satisfiedAt.getTime() <= clock.dueAt.getTime();
}

function allows(
  permitted: readonly string[] | undefined,
  value: string | null | undefined,
): boolean {
  if (!Array.isArray(permitted) || permitted.length === 0) return true;
  if (value === null || value === undefined) return false;
  return permitted.includes(value);
}
