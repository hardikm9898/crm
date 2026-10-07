import { describe, expect, it } from 'vitest';
import {
  ESCALATION_LEVELS,
  SLA_CLOCK_STATES,
  SLA_TARGETS,
  matchSlaPolicy,
  policyMatches,
  policySpecificity,
  slaHealth,
  targetMinutes,
  warnMinutes,
  wasMetOnTime,
  type SlaPolicyLike,
} from './sla.js';

function policy(over: Partial<SlaPolicyLike> = {}): SlaPolicyLike {
  return {
    id: 'p1',
    priority: 0,
    appliesTo: {},
    firstResponseMinutes: 60,
    nextResponseMinutes: null,
    resolutionMinutes: null,
    businessHoursOnly: true,
    warnAtPercent: 80,
    ...over,
  };
}

describe('policyMatches', () => {
  it('matches everything when nothing is constrained', () => {
    expect(policyMatches(policy(), { leadSourceId: 'anything', priority: 'low' })).toBe(true);
  });

  it('filters on a condition that is present', () => {
    const urgent = policy({ appliesTo: { priorities: ['high', 'urgent'] } });
    expect(policyMatches(urgent, { priority: 'urgent' })).toBe(true);
    expect(policyMatches(urgent, { priority: 'low' })).toBe(false);
  });

  it('treats an empty array as “any”, not as “nothing”', () => {
    // A tenant who clears the last source from a condition means "stop filtering on source". A
    // policy that silently matched nothing would be an SLA that quietly stopped existing.
    const cleared = policy({ appliesTo: { sourceIds: [] } });
    expect(policyMatches(cleared, { leadSourceId: 'facebook' })).toBe(true);
  });

  it('does not match a lead that is missing the thing being filtered on', () => {
    // A policy for Facebook leads must not claim a lead with no source at all.
    const bySource = policy({ appliesTo: { sourceIds: ['s1'] } });
    expect(policyMatches(bySource, { leadSourceId: null })).toBe(false);
  });

  it('requires every present condition, not any of them', () => {
    const both = policy({ appliesTo: { sourceIds: ['s1'], priorities: ['urgent'] } });
    expect(policyMatches(both, { leadSourceId: 's1', priority: 'urgent' })).toBe(true);
    expect(policyMatches(both, { leadSourceId: 's1', priority: 'low' })).toBe(false);
  });
});

describe('matchSlaPolicy', () => {
  it('takes the lowest priority number, which is the tenant’s own ordering', () => {
    const chosen = matchSlaPolicy(
      [policy({ id: 'late', priority: 10 }), policy({ id: 'early', priority: 1 })],
      {},
    );
    expect(chosen?.id).toBe('early');
  });

  it('breaks a tie by specificity, so the narrower promise wins', () => {
    const chosen = matchSlaPolicy(
      [
        policy({ id: 'catch-all', priority: 0, appliesTo: {} }),
        policy({ id: 'urgent-only', priority: 0, appliesTo: { priorities: ['urgent'] } }),
      ],
      { priority: 'urgent' },
    );
    expect(chosen?.id).toBe('urgent-only');
  });

  it('breaks a remaining tie by id, so a lead’s promise does not flip between recomputes', () => {
    const first = matchSlaPolicy([policy({ id: 'bbb' }), policy({ id: 'aaa' })], {});
    const second = matchSlaPolicy([policy({ id: 'aaa' }), policy({ id: 'bbb' })], {});
    expect(first?.id).toBe('aaa');
    expect(second?.id).toBe('aaa');
  });

  it('answers null when nothing applies, rather than inventing a promise', () => {
    expect(
      matchSlaPolicy([policy({ appliesTo: { priorities: ['urgent'] } })], { priority: 'low' }),
    ).toBeNull();
    expect(matchSlaPolicy([], {})).toBeNull();
  });

  it('counts specificity by constrained conditions only', () => {
    expect(policySpecificity({})).toBe(0);
    expect(policySpecificity({ sourceIds: [] })).toBe(0);
    expect(policySpecificity({ sourceIds: ['a'], priorities: ['urgent'] })).toBe(2);
  });
});

describe('targetMinutes', () => {
  it('returns the promise for each measurement, and null where there is none', () => {
    const p = policy({ nextResponseMinutes: 240, resolutionMinutes: null });
    expect(targetMinutes(p, 'first_response')).toBe(60);
    expect(targetMinutes(p, 'next_response')).toBe(240);
    expect(targetMinutes(p, 'resolution')).toBeNull();
  });

  it('has an answer for every target in the vocabulary', () => {
    for (const target of SLA_TARGETS) {
      expect(() => targetMinutes(policy(), target)).not.toThrow();
    }
  });
});

describe('warnMinutes', () => {
  it('is a share of the target', () => {
    expect(warnMinutes(60, 80)).toBe(48);
    expect(warnMinutes(240, 50)).toBe(120);
  });

  it('always warns before it breaches, even on a one-minute target', () => {
    // A warning that arrives at the same instant as the breach is not a warning.
    expect(warnMinutes(2, 99)).toBe(1);
    expect(warnMinutes(1, 80)).toBe(1);
  });

  it('clamps a nonsense percentage rather than producing a nonsense instant', () => {
    expect(warnMinutes(100, 0)).toBe(1);
    expect(warnMinutes(100, 150)).toBe(99);
  });
});

describe('slaHealth', () => {
  const dueAt = new Date('2026-04-02T10:00:00.000Z');
  const warnAt = new Date('2026-04-02T09:48:00.000Z');

  it('reads a running clock past its due instant as breached, before any sweep has run', () => {
    // A manager refreshing a board at 10:01 must not be told a 10:00 promise is still fine because
    // a cron has not fired. The stored status is about having escalated; this is about what is true.
    expect(
      slaHealth({ state: 'running', dueAt, warnAt }, new Date('2026-04-02T10:01:00.000Z')),
    ).toBe('breached');
  });

  it('reads the warning window as at risk', () => {
    expect(
      slaHealth({ state: 'running', dueAt, warnAt }, new Date('2026-04-02T09:50:00.000Z')),
    ).toBe('at_risk');
    expect(
      slaHealth({ state: 'running', dueAt, warnAt }, new Date('2026-04-02T09:30:00.000Z')),
    ).toBe('running');
  });

  it('reports what happened once something has, whatever the clock says', () => {
    const long = new Date('2030-01-01T00:00:00.000Z');
    expect(slaHealth({ state: 'satisfied', dueAt, warnAt }, long)).toBe('met');
    expect(slaHealth({ state: 'breached', dueAt, warnAt }, long)).toBe('breached');
    expect(slaHealth({ state: 'cancelled', dueAt, warnAt }, long)).toBe('cancelled');
    expect(slaHealth({ state: 'paused', dueAt, warnAt }, long)).toBe('paused');
  });

  it('has a reading for every state in the vocabulary', () => {
    for (const state of SLA_CLOCK_STATES) {
      expect(slaHealth({ state, dueAt, warnAt }, dueAt)).toBeTruthy();
    }
  });
});

describe('wasMetOnTime', () => {
  const dueAt = new Date('2026-04-02T10:00:00.000Z');
  const warnAt = new Date('2026-04-02T09:48:00.000Z');

  it('is null while nothing has happened', () => {
    expect(wasMetOnTime({ state: 'running', dueAt, warnAt })).toBeNull();
  });

  it('distinguishes a late answer from a timely one', () => {
    expect(
      wasMetOnTime({
        state: 'satisfied',
        dueAt,
        warnAt,
        satisfiedAt: new Date('2026-04-02T09:59:00.000Z'),
      }),
    ).toBe(true);
    // Answered, but late. A report that counted this as met would be the report nobody trusts.
    expect(
      wasMetOnTime({
        state: 'satisfied',
        dueAt,
        warnAt,
        satisfiedAt: new Date('2026-04-02T10:01:00.000Z'),
      }),
    ).toBe(false);
  });
});

describe('escalation levels', () => {
  it('numbers the warning below the breach, which is what makes “exactly once per level” work', () => {
    expect(ESCALATION_LEVELS.atRisk).toBe(1);
    expect(ESCALATION_LEVELS.breached).toBe(2);
  });
});
