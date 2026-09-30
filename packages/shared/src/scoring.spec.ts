import { describe, expect, it } from 'vitest';
import {
  DECAY_TRIGGER,
  SCORE_MAX,
  SCORING_TRIGGERS,
  bandFor,
  clampScore,
  decayDue,
  evaluateScoringRules,
  liveScoringTriggers,
  resolveScoringPath,
  scoringTrigger,
  validateBands,
  validateDecay,
  type ScoreBandSpec,
  type ScoringRuleInput,
} from './scoring.js';

const HOT_COLD: ScoreBandSpec[] = [
  { name: 'Cold', minScore: 0, maxScore: 39 },
  { name: 'Warm', minScore: 40, maxScore: 74 },
  { name: 'Hot', minScore: 75, maxScore: 1000 },
];

describe('the trigger registry', () => {
  it('describes every trigger it lists', () => {
    for (const spec of SCORING_TRIGGERS) {
      expect(scoringTrigger(spec.event)).toBe(spec);
      expect(spec.label.length).toBeGreaterThan(0);
      expect(spec.describe.length).toBeGreaterThan(0);
    }
  });

  it('says when a dormant trigger arrives, so a refusal can be specific', () => {
    // A rule on an event nothing emits is worse than a missing feature: the business believes
    // their scoring covers WhatsApp engagement and nothing tells them it does not.
    for (const spec of SCORING_TRIGGERS.filter((entry) => !entry.live)) {
      expect(
        spec.arrivesIn,
        `${spec.event} is dormant but does not say when it arrives`,
      ).toBeTruthy();
    }
  });

  it('includes the decay sweep among the live triggers', () => {
    expect(liveScoringTriggers().map((spec) => spec.event)).toContain(DECAY_TRIGGER);
  });

  it('has at least one dormant trigger, or the honesty check above proves nothing', () => {
    expect(SCORING_TRIGGERS.some((spec) => !spec.live)).toBe(true);
  });
});

describe('bands are a partition of the score range', () => {
  it('accepts a contiguous set covering the whole range', () => {
    expect(validateBands(HOT_COLD)).toEqual([]);
  });

  it('refuses an overlap, because the band would depend on evaluation order', () => {
    const problems = validateBands([
      { name: 'Cold', minScore: 0, maxScore: 50 },
      { name: 'Hot', minScore: 40, maxScore: 1000 },
    ]);
    expect(problems.map((problem) => problem.code)).toContain('OVERLAP');
  });

  it('refuses a gap, because a lead in it would have no band and vanish from band views', () => {
    const problems = validateBands([
      { name: 'Cold', minScore: 0, maxScore: 39 },
      { name: 'Hot', minScore: 75, maxScore: 1000 },
    ]);
    const gap = problems.find((problem) => problem.code === 'GAP');
    expect(gap?.message).toContain('40');
  });

  it('refuses a set that does not start at zero or reach the maximum', () => {
    expect(
      validateBands([{ name: 'Middle', minScore: 10, maxScore: 900 }])
        .map((p) => p.code)
        .sort(),
    ).toEqual(['GAP_AT_BOTTOM', 'GAP_AT_TOP']);
  });

  it('refuses two bands with the same name', () => {
    const problems = validateBands([
      { name: 'Hot', minScore: 0, maxScore: 39 },
      { name: 'hot ', minScore: 40, maxScore: 1000 },
    ]);
    expect(problems.map((problem) => problem.code)).toContain('DUPLICATE_NAME');
  });

  it('refuses an inverted band', () => {
    const problems = validateBands([{ name: 'Backwards', minScore: 100, maxScore: 10 }]);
    expect(problems.map((problem) => problem.code)).toContain('INVERTED');
  });

  it('refuses an empty set rather than leaving every lead bandless', () => {
    expect(validateBands([]).map((problem) => problem.code)).toEqual(['EMPTY']);
  });

  it('places a score in exactly one band, including at the boundaries', () => {
    expect(bandFor(0, HOT_COLD)?.name).toBe('Cold');
    expect(bandFor(39, HOT_COLD)?.name).toBe('Cold');
    expect(bandFor(40, HOT_COLD)?.name).toBe('Warm');
    expect(bandFor(74, HOT_COLD)?.name).toBe('Warm');
    expect(bandFor(75, HOT_COLD)?.name).toBe('Hot');
    expect(bandFor(1000, HOT_COLD)?.name).toBe('Hot');
  });
});

describe('the score stays inside the range the database allows', () => {
  it('clamps both ends', () => {
    expect(clampScore(-40)).toBe(0);
    expect(clampScore(5000)).toBe(SCORE_MAX);
    expect(clampScore(37.6)).toBe(38);
  });
});

describe('decay', () => {
  const decay = { afterDays: 14, points: 5, everyDays: 7, floor: 20 };
  const at = new Date('2026-03-01T02:00:00Z');
  const daysAgo = (days: number) => new Date(at.getTime() - days * 86_400_000);

  it('does nothing before the grace period is up', () => {
    expect(
      decayDue({ decay, lastActivityAt: daysAgo(13), at, currentScore: 80, alreadyRemoved: 0 }),
    ).toBe(0);
  });

  it('takes one period off as soon as the grace period passes', () => {
    expect(
      decayDue({ decay, lastActivityAt: daysAgo(14), at, currentScore: 80, alreadyRemoved: 0 }),
    ).toBe(-5);
  });

  it('catches up after a missed sweep instead of losing the deduction', () => {
    // The deduction is a function of elapsed time, not of how many times the sweep ran — which is
    // the whole reason it is computed this way. Three periods due, none taken.
    expect(
      decayDue({ decay, lastActivityAt: daysAgo(28), at, currentScore: 80, alreadyRemoved: 0 }),
    ).toBe(-15);
  });

  it('does not take the same period off twice', () => {
    expect(
      decayDue({ decay, lastActivityAt: daysAgo(28), at, currentScore: 65, alreadyRemoved: 15 }),
    ).toBe(0);
  });

  it('stops at the floor, and stops entirely once there', () => {
    expect(
      decayDue({ decay, lastActivityAt: daysAgo(200), at, currentScore: 24, alreadyRemoved: 0 }),
    ).toBe(-4);
    expect(
      decayDue({ decay, lastActivityAt: daysAgo(200), at, currentScore: 20, alreadyRemoved: 0 }),
    ).toBe(0);
  });

  it('does nothing for a lead that has never had any activity recorded', () => {
    // Not "decay from creation": a lead captured an hour ago with no activity yet is new, not stale.
    expect(decayDue({ decay, lastActivityAt: null, at, currentScore: 80, alreadyRemoved: 0 })).toBe(
      0,
    );
  });

  it('validates its own shape', () => {
    expect(validateDecay(decay)).toEqual([]);
    expect(validateDecay({ afterDays: 1, points: 0, everyDays: 7, floor: 0 })[0]?.field).toBe(
      'decay.points',
    );
    expect(validateDecay({ afterDays: 1, points: 5, everyDays: 0, floor: 0 })[0]?.field).toBe(
      'decay.everyDays',
    );
    expect(validateDecay('soon').length).toBeGreaterThan(0);
    expect(
      validateDecay({ afterDays: 1, points: 5, everyDays: 7, floor: 1000 }).map((p) => p.field),
    ).toContain('decay.floor');
  });
});

describe('evaluating a trigger’s rules', () => {
  const rule = (over: Partial<ScoringRuleInput> = {}): ScoringRuleInput => ({
    id: over.id ?? 'rule-1',
    name: over.name ?? 'Facebook lead',
    triggerEvent: 'lead.created',
    conditions: over.conditions ?? [],
    points: over.points ?? 20,
    maxApplications: over.maxApplications ?? null,
  });
  const subject = {
    lead: { city: 'Pune', priority: 'high' },
    custom: { budget: 5_000_000 },
    event: { channel: 'whatsapp' },
  };

  it('applies a rule with no conditions to everything on its trigger', () => {
    const [verdict] = evaluateScoringRules({ rules: [rule()], subject, appliedCounts: {} });
    expect(verdict?.applies).toBe(true);
    expect(verdict?.delta).toBe(20);
  });

  it('applies a rule whose conditions match, and says which rule earned the points', () => {
    const [verdict] = evaluateScoringRules({
      rules: [
        rule({
          name: 'High budget',
          conditions: [
            { fieldPath: 'custom.budget', operator: 'gte', value: 1_000_000, groupIndex: 0 },
          ],
          points: 30,
        }),
      ],
      subject,
      appliedCounts: {},
    });
    expect(verdict?.applies).toBe(true);
    expect(verdict?.reason).toBe('High budget');
  });

  it('explains a rule that did not apply in terms of the actual value', () => {
    const [verdict] = evaluateScoringRules({
      rules: [
        rule({
          conditions: [{ fieldPath: 'city', operator: 'eq', value: 'Mumbai', groupIndex: 0 }],
        }),
      ],
      subject,
      appliedCounts: {},
    });
    expect(verdict?.applies).toBe(false);
    expect(verdict?.reason).toContain('Pune');
  });

  it('honours a cap, and says how many of how many have been used', () => {
    const [verdict] = evaluateScoringRules({
      rules: [rule({ maxApplications: 3 })],
      subject,
      appliedCounts: { 'rule-1': 3 },
    });
    expect(verdict?.applies).toBe(false);
    expect(verdict?.skipped).toBe('max_applications');
    expect(verdict?.reason).toContain('3 of 3');
  });

  it('still applies while a cap has room left', () => {
    const [verdict] = evaluateScoringRules({
      rules: [rule({ maxApplications: 3 })],
      subject,
      appliedCounts: { 'rule-1': 2 },
    });
    expect(verdict?.applies).toBe(true);
  });

  it('reads the triggering event, so "came back on WhatsApp" is expressible', () => {
    const [verdict] = evaluateScoringRules({
      rules: [
        rule({
          conditions: [
            { fieldPath: 'event.channel', operator: 'eq', value: 'whatsapp', groupIndex: 0 },
          ],
        }),
      ],
      subject,
      appliedCounts: {},
    });
    expect(verdict?.applies).toBe(true);
  });

  it('ORs across groups and ANDs within one', () => {
    const conditions = [
      { fieldPath: 'city', operator: 'eq', value: 'Mumbai', groupIndex: 0 },
      { fieldPath: 'priority', operator: 'eq', value: 'high', groupIndex: 0 },
      { fieldPath: 'city', operator: 'eq', value: 'Pune', groupIndex: 1 },
    ];
    const [verdict] = evaluateScoringRules({
      rules: [rule({ conditions })],
      subject,
      appliedCounts: {},
    });
    expect(verdict?.applies).toBe(true);
  });

  it('resolves the three path prefixes and nothing else', () => {
    expect(resolveScoringPath('city', subject)).toBe('Pune');
    expect(resolveScoringPath('custom.budget', subject)).toBe(5_000_000);
    expect(resolveScoringPath('event.channel', subject)).toBe('whatsapp');
    expect(resolveScoringPath('nonsense', subject)).toBeUndefined();
  });

  it('never returns a delta for a rule it did not apply', () => {
    const verdicts = evaluateScoringRules({
      rules: [
        rule({
          id: 'a',
          conditions: [{ fieldPath: 'city', operator: 'eq', value: 'Nagpur', groupIndex: 0 }],
        }),
        rule({ id: 'b', maxApplications: 1 }),
      ],
      subject,
      appliedCounts: { b: 1 },
    });
    expect(verdicts.every((verdict) => verdict.applies || verdict.delta === 0)).toBe(true);
  });
});
