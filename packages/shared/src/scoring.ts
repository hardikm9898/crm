/**
 * Lead scoring (`FR-SCR-1`–`FR-SCR-3`), evaluated purely.
 *
 * **The score is the running total of its score events.** `leads.score` is a cache of
 * `sum(delta)` over that lead's `lead_score_events`, clamped to the allowed range. Everything else
 * here follows from that one decision:
 *
 *  * explainability (`FR-SCR-2`) is exact rather than approximate — the breakdown a manager reads
 *    *is* the arithmetic that produced the number, so it always adds up;
 *  * recomputation is re-summing, not re-deriving, so it cannot drift from history;
 *  * idempotency is a unique constraint on `(lead, rule, source_event)` rather than application
 *    logic, so an at-least-once redelivery of an event scores once.
 *
 * A scoring engine whose number cannot be explained is one a business stops trusting the first time
 * it disagrees with them, and then the feature is worse than not having it.
 */

import { FILTER_OPERATORS, type FilterOperator } from './custom-fields.js';
import { applyOperator, type RuleCondition } from './assignment.js';

/** The range `leads.score` is constrained to by `leads_score_range`. */
export const SCORE_MIN = 0;
export const SCORE_MAX = 1000;

/**
 * The events a scoring rule may be triggered by.
 *
 * `live` is the important column. `FR-SCR-1` names website behaviour, WhatsApp engagement and email
 * engagement as scoring inputs, and none of those events exist yet. A rule configured against an
 * event that will never fire is worse than a missing feature: the business believes their scoring
 * covers engagement, and nothing tells them otherwise. So a dormant trigger is refused at
 * configuration time with the phase it arrives in, rather than accepted and silently inert.
 */
export interface ScoringTriggerSpec {
  readonly event: string;
  readonly label: string;
  /** False while the event is not emitted by any code path yet. */
  readonly live: boolean;
  /** What a rule on this trigger can sensibly say, for the rule builder. */
  readonly describe: string;
  /** Named when `live` is false, so the refusal can say when it arrives. */
  readonly arrivesIn?: string;
}

/** The trigger a decay rule uses: the nightly sweep rather than a domain event. */
export const DECAY_TRIGGER = 'schedule.decay';

export const SCORING_TRIGGERS: readonly ScoringTriggerSpec[] = [
  {
    event: 'lead.created',
    label: 'A lead is captured',
    live: true,
    describe: 'Score the lead as it arrives — its source, its form answers, its value.',
  },
  {
    event: 'lead.updated',
    label: 'A lead’s details change',
    live: true,
    describe: 'Score details that arrive later, such as a budget filled in by the executive.',
  },
  {
    event: 'lead.status_changed',
    label: 'A lead’s status changes',
    live: true,
    describe: 'Reward real progress — contacted, qualified, quoted.',
  },
  {
    event: 'lead.stage_changed',
    label: 'A lead moves stage',
    live: true,
    describe: 'Score movement along the pipeline.',
  },
  {
    event: 'lead.assigned',
    label: 'A lead is assigned',
    live: true,
    describe: 'Rarely useful for scoring; here because it is available.',
  },
  {
    event: 'lead.touchpoint_added',
    label: 'The same lead comes back',
    live: true,
    describe:
      'A repeat enquiry is the strongest early signal a small business has — the same person asking twice.',
  },
  {
    event: DECAY_TRIGGER,
    label: 'Nightly decay sweep',
    live: true,
    describe: 'Take points away from a lead nobody has touched, so an old score cannot look hot.',
  },
  {
    event: 'message.received',
    label: 'A WhatsApp reply arrives',
    live: false,
    arrivesIn: 'Phase 5 (WhatsApp)',
    describe: 'Engagement scoring: a reply, a question, a fast response.',
  },
  {
    event: 'email.opened',
    label: 'An email is opened or clicked',
    live: false,
    arrivesIn: 'Phase 8 (marketing automation)',
    describe: 'Email engagement scoring.',
  },
  {
    event: 'analytics.page_viewed',
    label: 'A tracked page is viewed',
    live: false,
    arrivesIn: 'Phase 9 (website analytics)',
    describe: 'Website behaviour: the pricing page, a repeat visit, a started checkout.',
  },
];

const TRIGGER_BY_EVENT = new Map(SCORING_TRIGGERS.map((spec) => [spec.event, spec]));

export function scoringTrigger(event: string): ScoringTriggerSpec | undefined {
  return TRIGGER_BY_EVENT.get(event);
}

export function liveScoringTriggers(): readonly ScoringTriggerSpec[] {
  return SCORING_TRIGGERS.filter((spec) => spec.live);
}

/**
 * A decay rule's shape.
 *
 * "After 14 days with no activity, take 5 points off every 7 days, but never below 20." Expressed
 * as a period rather than a per-day rate because that is how a business says it, and because a
 * per-day rate makes the sweep's own schedule part of the arithmetic — miss a night and the score
 * is wrong. Here, the deduction is a function of *elapsed time*, so a missed sweep catches up.
 */
export interface DecaySpec {
  /** Days of inactivity before any decay applies. */
  readonly afterDays: number;
  /** Points removed per period. Stored positive; applied as a negative delta. */
  readonly points: number;
  /** Length of a period, in days. */
  readonly everyDays: number;
  /** Decay never takes the score below this. */
  readonly floor: number;
}

export interface DecayProblem {
  readonly field: string;
  readonly message: string;
}

export function validateDecay(decay: unknown): readonly DecayProblem[] {
  const problems: DecayProblem[] = [];
  if (typeof decay !== 'object' || decay === null || Array.isArray(decay)) {
    return [
      { field: 'decay', message: 'A decay rule needs afterDays, points, everyDays and floor.' },
    ];
  }
  const candidate = decay as Record<string, unknown>;
  const int = (key: string, min: number, max: number) => {
    const value = candidate[key];
    if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
      problems.push({
        field: `decay.${key}`,
        message: `Must be a whole number between ${min} and ${max}.`,
      });
      return null;
    }
    return value;
  };
  int('afterDays', 0, 3650);
  const points = int('points', 1, SCORE_MAX);
  int('everyDays', 1, 365);
  const floor = int('floor', SCORE_MIN, SCORE_MAX);
  if (points !== null && floor !== null && floor >= SCORE_MAX) {
    problems.push({
      field: 'decay.floor',
      message: 'A floor at the maximum score means decay can never apply.',
    });
  }
  return problems;
}

/**
 * How many points a decay rule should have removed by `at`, given the last activity.
 *
 * Returns a **negative** delta, or 0 when nothing is due. `alreadyRemoved` is the decay this rule
 * has already taken off this lead, which is what makes the sweep idempotent without needing to know
 * when it last ran: the answer is always "the total that should be gone by now, minus what is".
 */
export function decayDue(input: {
  readonly decay: DecaySpec;
  readonly lastActivityAt: Date | null;
  readonly at: Date;
  readonly currentScore: number;
  readonly alreadyRemoved: number;
}): number {
  const { decay, lastActivityAt, at, currentScore, alreadyRemoved } = input;
  if (!lastActivityAt) return 0;
  const idleDays = Math.floor((at.getTime() - lastActivityAt.getTime()) / 86_400_000);
  if (idleDays < decay.afterDays) return 0;

  const periods = Math.floor((idleDays - decay.afterDays) / decay.everyDays) + 1;
  const shouldBeRemoved = periods * decay.points;
  const outstanding = shouldBeRemoved - alreadyRemoved;
  if (outstanding <= 0) return 0;

  // The floor is on the resulting score, not on the deduction, so a lead already at the floor
  // decays by nothing rather than by a clamped amount that would look like an applied rule.
  const room = currentScore - decay.floor;
  if (room <= 0) return 0;
  return -Math.min(outstanding, room);
}

/** A band (`FR-SCR-3`): a contiguous slice of the score range with a name a business chose. */
export interface ScoreBandSpec {
  readonly name: string;
  readonly minScore: number;
  readonly maxScore: number;
  readonly colour?: string | null;
}

export interface BandProblem {
  readonly index: number;
  readonly code: string;
  readonly message: string;
}

/**
 * Checks a complete set of bands.
 *
 * Bands are edited as a set rather than one at a time, and validated as a **partition of the whole
 * score range**: no overlaps, no gaps, starting at 0 and ending at the maximum. Overlaps would make
 * a lead's band depend on evaluation order, and a gap would leave a lead with a score and no band —
 * which then quietly excludes it from every band-filtered view a business relies on.
 */
export function validateBands(bands: readonly ScoreBandSpec[]): readonly BandProblem[] {
  const problems: BandProblem[] = [];
  if (bands.length === 0) {
    return [
      { index: -1, code: 'EMPTY', message: 'Define at least one band, covering the whole range.' },
    ];
  }

  bands.forEach((band, index) => {
    if (band.name.trim() === '') {
      problems.push({ index, code: 'NO_NAME', message: 'A band needs a name.' });
    }
    if (!Number.isInteger(band.minScore) || !Number.isInteger(band.maxScore)) {
      problems.push({ index, code: 'NOT_INTEGER', message: 'Band bounds must be whole numbers.' });
      return;
    }
    if (band.minScore < SCORE_MIN || band.maxScore > SCORE_MAX) {
      problems.push({
        index,
        code: 'OUT_OF_RANGE',
        message: `Bands must stay within ${SCORE_MIN}–${SCORE_MAX}.`,
      });
    }
    if (band.maxScore < band.minScore) {
      problems.push({
        index,
        code: 'INVERTED',
        message: 'A band’s top must not be below its bottom.',
      });
    }
  });

  const names = bands.map((band) => band.name.trim().toLowerCase());
  if (new Set(names).size !== names.length) {
    problems.push({ index: -1, code: 'DUPLICATE_NAME', message: 'Two bands share a name.' });
  }
  if (problems.length > 0) return problems;

  const sorted = [...bands].sort((left, right) => left.minScore - right.minScore);
  if (sorted[0]!.minScore !== SCORE_MIN) {
    problems.push({
      index: bands.indexOf(sorted[0]!),
      code: 'GAP_AT_BOTTOM',
      message: `The lowest band must start at ${SCORE_MIN}.`,
    });
  }
  if (sorted[sorted.length - 1]!.maxScore !== SCORE_MAX) {
    problems.push({
      index: bands.indexOf(sorted[sorted.length - 1]!),
      code: 'GAP_AT_TOP',
      message: `The highest band must end at ${SCORE_MAX}.`,
    });
  }
  for (let index = 1; index < sorted.length; index += 1) {
    const previous = sorted[index - 1]!;
    const current = sorted[index]!;
    if (current.minScore <= previous.maxScore) {
      problems.push({
        index: bands.indexOf(current),
        code: 'OVERLAP',
        message: `“${current.name}” overlaps “${previous.name}”.`,
      });
    } else if (current.minScore !== previous.maxScore + 1) {
      problems.push({
        index: bands.indexOf(current),
        code: 'GAP',
        message: `Nothing covers ${previous.maxScore + 1}–${current.minScore - 1}, so a lead there would have no band.`,
      });
    }
  }
  return problems;
}

/** The band a score falls in, or null when the set does not cover it. */
export function bandFor(score: number, bands: readonly ScoreBandSpec[]): ScoreBandSpec | null {
  return bands.find((band) => score >= band.minScore && score <= band.maxScore) ?? null;
}

export function clampScore(value: number): number {
  return Math.max(SCORE_MIN, Math.min(SCORE_MAX, Math.round(value)));
}

/** The subject a scoring rule is evaluated against. */
export interface ScoringSubject {
  readonly lead: Readonly<Record<string, unknown>>;
  readonly custom: Readonly<Record<string, unknown>>;
  /** The event's own payload, so a rule can read `event.channel` on a repeat enquiry. */
  readonly event: Readonly<Record<string, unknown>>;
}

export interface ScoringRuleInput {
  readonly id: string;
  readonly name: string;
  readonly triggerEvent: string;
  readonly conditions: readonly RuleCondition[];
  readonly points: number;
  /** Null means the rule may apply as often as its trigger fires. */
  readonly maxApplications: number | null;
}

export interface ScoringVerdict {
  readonly ruleId: string;
  readonly ruleName: string;
  readonly applies: boolean;
  readonly delta: number;
  /** Stored on the score event, and shown in the breakdown. */
  readonly reason: string;
  /** Present when the rule matched but was not applied. */
  readonly skipped?: 'max_applications' | 'no_change';
}

/**
 * Which of a trigger's rules apply to this subject, and for how many points.
 *
 * Pure, so `POST /scoring/test` answers with the same code the write path runs — the property that
 * makes a rule tester worth having. `appliedCounts` is how often each rule has already applied to
 * this lead, which is the only state the decision needs.
 */
export function evaluateScoringRules(input: {
  readonly rules: readonly ScoringRuleInput[];
  readonly subject: ScoringSubject;
  readonly appliedCounts: Readonly<Record<string, number>>;
}): readonly ScoringVerdict[] {
  const verdicts: ScoringVerdict[] = [];
  for (const rule of input.rules) {
    const outcome = evaluateRuleConditions(rule.conditions, input.subject);
    if (!outcome.matched) {
      verdicts.push({
        ruleId: rule.id,
        ruleName: rule.name,
        applies: false,
        delta: 0,
        reason: outcome.explanation,
      });
      continue;
    }

    const already = input.appliedCounts[rule.id] ?? 0;
    if (rule.maxApplications !== null && already >= rule.maxApplications) {
      verdicts.push({
        ruleId: rule.id,
        ruleName: rule.name,
        applies: false,
        delta: 0,
        reason: `Already applied ${already} of ${rule.maxApplications} times.`,
        skipped: 'max_applications',
      });
      continue;
    }

    verdicts.push({
      ruleId: rule.id,
      ruleName: rule.name,
      applies: true,
      delta: rule.points,
      reason: rule.name,
    });
  }
  return verdicts;
}

/**
 * Condition evaluation for a scoring rule.
 *
 * The same flat AND-within-group / OR-across-groups shape as an assignment rule, deliberately: a
 * business that has learnt to write one rule can write the other, and both run through
 * `applyOperator` so "contains" means the same thing in each.
 */
export function evaluateRuleConditions(
  conditions: readonly RuleCondition[],
  subject: ScoringSubject,
): { matched: boolean; explanation: string } {
  if (conditions.length === 0) {
    return { matched: true, explanation: 'Applies to every lead on this trigger.' };
  }

  const groups = new Map<number, { matched: boolean; failures: string[] }>();
  for (const condition of conditions) {
    const actual = resolveScoringPath(condition.fieldPath, subject);
    const result = applyOperator(condition.operator, actual, condition.value);
    const group = groups.get(condition.groupIndex) ?? { matched: true, failures: [] };
    if (!result.matched) {
      group.matched = false;
      group.failures.push(
        `${condition.fieldPath} is ${describe(actual)}, not ${condition.operator} ${describe(condition.value)}`,
      );
    }
    groups.set(condition.groupIndex, group);
  }

  const entries = [...groups.entries()].sort(([left], [right]) => left - right);
  const matched = entries.some(([, group]) => group.matched);
  if (matched) return { matched, explanation: 'Conditions met.' };
  const failures = entries.flatMap(([, group]) => group.failures).slice(0, 3);
  return { matched, explanation: `Not applied: ${failures.join('; ')}.` };
}

/** `custom.*` reads the lead's custom values, `event.*` the triggering event, anything else a column. */
export function resolveScoringPath(path: string, subject: ScoringSubject): unknown {
  if (path.startsWith('custom.')) return subject.custom[path.slice('custom.'.length)];
  if (path.startsWith('event.')) return subject.event[path.slice('event.'.length)];
  return subject.lead[path];
}

/** The operators a scoring condition may use — one vocabulary across the product. */
export const SCORING_OPERATORS: readonly FilterOperator[] = FILTER_OPERATORS;

function describe(value: unknown): string {
  if (value === null) return 'empty';
  if (value === undefined) return 'not set';
  if (Array.isArray(value)) return value.map((entry) => String(entry)).join('/');
  return String(value);
}
