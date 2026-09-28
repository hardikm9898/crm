import { describe, expect, it } from 'vitest';
import { FILTER_OPERATORS } from './custom-fields.js';
import {
  ASSIGNMENT_STRATEGIES,
  STRATEGY_SPECS,
  applyOperator,
  evaluateConditions,
  nextInRoundRobin,
  resolveFieldPath,
  strategySpec,
  type AssignmentSubject,
  type RuleCondition,
} from './assignment.js';

function subject(overrides: Partial<AssignmentSubject> = {}): AssignmentSubject {
  return {
    lead: { city: 'Pune', valueMinor: 500000, priority: 'high', leadSourceId: 'src-1' },
    custom: { budget: 4500000, interests: ['flats', 'plots'] },
    hour: 11,
    dayOfWeek: 2,
    ...overrides,
  };
}

function condition(
  overrides: Partial<RuleCondition> & { fieldPath: string; operator: string },
): RuleCondition {
  return { value: null, groupIndex: 0, ...overrides };
}

describe('resolveFieldPath', () => {
  it('reads a lead column, a custom field and the clock', () => {
    const s = subject();
    expect(resolveFieldPath('city', s)).toBe('Pune');
    expect(resolveFieldPath('custom.budget', s)).toBe(4500000);
    expect(resolveFieldPath('time.hour', s)).toBe(11);
    expect(resolveFieldPath('time.dayOfWeek', s)).toBe(2);
  });

  it('returns undefined for an unknown clock field rather than a lead column of the same name', () => {
    expect(resolveFieldPath('time.minute', subject())).toBeUndefined();
  });
});

describe('applyOperator', () => {
  it('implements every operator the filter DSL exposes', () => {
    // Each operator is given values of a kind it is meant for: `gt` against two words correctly
    // reports "not comparable", which is a different thing from being unimplemented.
    const samples: Record<string, [unknown, unknown]> = {
      eq: ['x', 'x'],
      ne: ['x', 'y'],
      in: ['x', ['x']],
      nin: ['x', ['y']],
      contains: ['axb', 'x'],
      starts_with: ['xb', 'x'],
      gt: [2, 1],
      gte: [1, 1],
      lt: [1, 2],
      lte: [1, 1],
      between: [2, [1, 3]],
      is_null: [null, null],
      is_not_null: ['x', null],
      has_any: [['x'], ['x']],
      has_all: [['x'], ['x']],
    };
    for (const operator of FILTER_OPERATORS) {
      const sample = samples[operator];
      expect(sample, `${operator} has no sample — add one when adding an operator`).toBeDefined();
      const result = applyOperator(operator, sample![0], sample![1]);
      expect(result.problem, `${operator} is unimplemented`).toBeUndefined();
      expect(result.matched, `${operator} did not match its own sample`).toBe(true);
    }
  });

  it('names an operator it does not know, instead of silently not matching', () => {
    const result = applyOperator('approximately', 'x', 'x');
    expect(result.matched).toBe(false);
    expect(result.problem).toContain('approximately');
  });

  it('compares text case-insensitively, because nobody writing a rule thinks about case', () => {
    expect(applyOperator('eq', 'Pune', 'pune').matched).toBe(true);
    expect(applyOperator('contains', 'Baner, Pune', 'baner').matched).toBe(true);
    expect(applyOperator('starts_with', 'Pune', 'pu').matched).toBe(true);
  });

  it('compares a number given as a string, because a form sends strings', () => {
    expect(applyOperator('gte', 500, '500').matched).toBe(true);
    expect(applyOperator('gt', '600', 500).matched).toBe(true);
    expect(applyOperator('lt', 400, 500).matched).toBe(true);
  });

  it('handles membership in both directions', () => {
    expect(applyOperator('in', 'pune', ['Pune', 'Mumbai']).matched).toBe(true);
    expect(applyOperator('nin', 'delhi', ['Pune', 'Mumbai']).matched).toBe(true);
    expect(applyOperator('has_any', ['flats', 'plots'], ['plots']).matched).toBe(true);
    expect(applyOperator('has_all', ['flats', 'plots'], ['flats', 'plots']).matched).toBe(true);
    expect(applyOperator('has_all', ['flats'], ['flats', 'plots']).matched).toBe(false);
  });

  it('treats between as inclusive and needs two bounds', () => {
    expect(applyOperator('between', 5, [1, 10]).matched).toBe(true);
    expect(applyOperator('between', 1, [1, 10]).matched).toBe(true);
    expect(applyOperator('between', 11, [1, 10]).matched).toBe(false);
    expect(applyOperator('between', 5, [1]).problem).toContain('two bounds');
  });

  it('is false rather than an error against a missing value', () => {
    // A rule about the city of a lead with no city has simply not matched.
    for (const operator of ['eq', 'contains', 'gt', 'in', 'has_any'] as const) {
      expect(applyOperator(operator, null, 'anything').matched, operator).toBe(false);
      expect(applyOperator(operator, undefined, 'anything').matched, operator).toBe(false);
      expect(applyOperator(operator, '', 'anything').matched, operator).toBe(false);
    }
  });

  it('distinguishes "not set" from "not equal"', () => {
    expect(applyOperator('is_null', null, null).matched).toBe(true);
    expect(applyOperator('is_null', 'Pune', null).matched).toBe(false);
    expect(applyOperator('is_not_null', 'Pune', null).matched).toBe(true);
    // A missing value is NOT `ne` anything, which is the distinction that matters: a rule saying
    // "city is not Pune" must not scoop up every lead with no city at all.
    expect(applyOperator('ne', null, 'Pune').matched).toBe(false);
  });

  it('coerces booleans written the way forms send them', () => {
    expect(applyOperator('eq', true, 'true').matched).toBe(true);
    expect(applyOperator('eq', false, 'false').matched).toBe(true);
    expect(applyOperator('eq', true, 'yes').matched).toBe(true);
  });

  it('compares ISO dates by instant, not by string', () => {
    expect(applyOperator('gt', '2026-03-15T10:00:00Z', '2026-03-15T09:00:00Z').matched).toBe(true);
    expect(applyOperator('lt', '2026-01-01', '2026-06-01').matched).toBe(true);
  });

  it('reports incomparable values rather than guessing', () => {
    expect(applyOperator('gt', 'hello', 'world').problem).toContain('comparable');
  });
});

describe('evaluateConditions — AND within a group, OR across groups', () => {
  it('a rule with no conditions matches everything', () => {
    const result = evaluateConditions([], subject());
    expect(result.matched).toBe(true);
    // Which is what makes a catch-all at the lowest priority the natural "everyone else".
    expect(result.explanation).toContain('every lead');
  });

  it('requires every condition in a group', () => {
    const conditions = [
      condition({ fieldPath: 'city', operator: 'eq', value: 'Pune', groupIndex: 0 }),
      condition({ fieldPath: 'priority', operator: 'eq', value: 'high', groupIndex: 0 }),
    ];
    expect(evaluateConditions(conditions, subject()).matched).toBe(true);
    expect(
      evaluateConditions(conditions, subject({ lead: { city: 'Pune', priority: 'low' } })).matched,
    ).toBe(false);
  });

  it('accepts any group', () => {
    const conditions = [
      condition({ fieldPath: 'city', operator: 'eq', value: 'Mumbai', groupIndex: 0 }),
      condition({ fieldPath: 'city', operator: 'eq', value: 'Pune', groupIndex: 1 }),
    ];
    expect(evaluateConditions(conditions, subject()).matched).toBe(true);
  });

  it('explains why it matched, naming the group that fired', () => {
    const result = evaluateConditions(
      [condition({ fieldPath: 'custom.budget', operator: 'gte', value: 1000000 })],
      subject(),
    );
    expect(result.matched).toBe(true);
    expect(result.explanation).toContain('custom.budget');
    expect(result.explanation).toContain('gte');
  });

  it('explains why it did NOT match, with the actual value', () => {
    // This is the whole point of the rule tester: "why did this lead not go to the Pune team".
    const result = evaluateConditions(
      [condition({ fieldPath: 'city', operator: 'eq', value: 'Mumbai' })],
      subject(),
    );
    expect(result.matched).toBe(false);
    expect(result.explanation).toContain('Pune');
    expect(result.explanation).toContain('Mumbai');
  });

  it('returns per-condition detail in the order given', () => {
    const conditions = [
      condition({ fieldPath: 'city', operator: 'eq', value: 'Pune' }),
      condition({ fieldPath: 'priority', operator: 'eq', value: 'low' }),
    ];
    const result = evaluateConditions(conditions, subject());
    expect(result.outcomes.map((outcome) => outcome.matched)).toEqual([true, false]);
    expect(result.outcomes[1]?.actual).toBe('high');
  });

  it('evaluates a time-of-day rule against the supplied clock, not the real one', () => {
    // "Leads arriving out of hours go to the manager" has to be testable at 3pm on a Tuesday.
    const outOfHours = [
      condition({ fieldPath: 'time.hour', operator: 'gte', value: 19, groupIndex: 0 }),
      condition({ fieldPath: 'time.hour', operator: 'lt', value: 9, groupIndex: 1 }),
      condition({ fieldPath: 'time.dayOfWeek', operator: 'eq', value: 0, groupIndex: 2 }),
    ];
    expect(evaluateConditions(outOfHours, subject({ hour: 21 })).matched).toBe(true);
    expect(evaluateConditions(outOfHours, subject({ hour: 7 })).matched).toBe(true);
    expect(evaluateConditions(outOfHours, subject({ dayOfWeek: 0 })).matched).toBe(true);
    expect(evaluateConditions(outOfHours, subject({ hour: 11, dayOfWeek: 2 })).matched).toBe(false);
  });
});

describe('nextInRoundRobin — fairness', () => {
  const pool = [
    { userId: 'a', weight: 1 },
    { userId: 'b', weight: 1 },
    { userId: 'c', weight: 1 },
  ];

  it('gives each member a turn, in order, and wraps', () => {
    let state = { cursorIndex: 0, weightConsumed: 0 };
    const order: string[] = [];
    for (let i = 0; i < 7; i += 1) {
      const turn = nextInRoundRobin(pool, state, false)!;
      order.push(turn.userId);
      state = { cursorIndex: turn.nextCursorIndex, weightConsumed: turn.nextWeightConsumed };
    }
    expect(order).toEqual(['a', 'b', 'c', 'a', 'b', 'c', 'a']);
  });

  it('splits 300 assignments evenly across three people', () => {
    // The exit criterion is fairness, so it is asserted on a distribution rather than a sequence.
    let state = { cursorIndex: 0, weightConsumed: 0 };
    const counts = new Map<string, number>();
    for (let i = 0; i < 300; i += 1) {
      const turn = nextInRoundRobin(pool, state, false)!;
      counts.set(turn.userId, (counts.get(turn.userId) ?? 0) + 1);
      state = { cursorIndex: turn.nextCursorIndex, weightConsumed: turn.nextWeightConsumed };
    }
    expect([...counts.values()]).toEqual([100, 100, 100]);
  });

  it("honours weights: a weight of 3 takes three turns to another member's one", () => {
    const weighted = [
      { userId: 'senior', weight: 3 },
      { userId: 'junior', weight: 1 },
    ];
    let state = { cursorIndex: 0, weightConsumed: 0 };
    const order: string[] = [];
    for (let i = 0; i < 8; i += 1) {
      const turn = nextInRoundRobin(weighted, state, true)!;
      order.push(turn.userId);
      state = { cursorIndex: turn.nextCursorIndex, weightConsumed: turn.nextWeightConsumed };
    }
    expect(order).toEqual([
      'senior',
      'senior',
      'senior',
      'junior',
      'senior',
      'senior',
      'senior',
      'junior',
    ]);
  });

  it('wraps a cursor that outlived the pool it indexed', () => {
    // Someone leaves, the pool shrinks, the stored cursor is now out of range. Wrapping is the only
    // behaviour that does not strand assignment on a stale number.
    const turn = nextInRoundRobin(pool, { cursorIndex: 97, weightConsumed: 0 }, false);
    expect(turn?.userId).toBe('b');
    expect(turn?.nextCursorIndex).toBe(2);
  });

  it('survives a negative cursor', () => {
    expect(nextInRoundRobin(pool, { cursorIndex: -1, weightConsumed: 0 }, false)?.userId).toBe('c');
  });

  it('returns null for an empty pool rather than picking nobody silently', () => {
    expect(nextInRoundRobin([], { cursorIndex: 0, weightConsumed: 0 }, false)).toBeNull();
  });

  it('treats a weight below one as one, so a bad row cannot stall the rotation', () => {
    const turn = nextInRoundRobin(
      [{ userId: 'a', weight: 0 }],
      { cursorIndex: 0, weightConsumed: 0 },
      true,
    );
    expect(turn?.nextWeightConsumed).toBe(0);
    expect(turn?.nextCursorIndex).toBe(0);
  });
});

describe('the strategy registry', () => {
  it('describes every declared strategy', () => {
    for (const strategy of ASSIGNMENT_STRATEGIES) {
      const spec = strategySpec(strategy);
      expect(spec, strategy).toBeDefined();
      expect(spec!.label.length).toBeGreaterThan(0);
      expect(spec!.describe.length).toBeGreaterThan(0);
    }
    expect(Object.keys(STRATEGY_SPECS).sort()).toEqual([...ASSIGNMENT_STRATEGIES].sort());
  });

  it('marks exactly the pool strategies as needing pool members', () => {
    const pooled = ASSIGNMENT_STRATEGIES.filter((strategy) => STRATEGY_SPECS[strategy].usesPool);
    expect(pooled.sort()).toEqual(
      ['least_open_leads', 'round_robin', 'top_performer', 'weighted_round_robin'].sort(),
    );
  });

  it('states what each non-pool strategy needs in its target', () => {
    expect(STRATEGY_SPECS.specific_user.requires).toBe('userId');
    expect(STRATEGY_SPECS.team.requires).toBe('teamId');
  });
});
