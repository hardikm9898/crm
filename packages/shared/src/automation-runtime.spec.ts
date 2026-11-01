import { describe, expect, it } from 'vitest';
import {
  DEFAULT_DAILY_ACTION_CAP,
  MAX_CAUSATION_DEPTH,
  UnknownPlaceholderError,
  evaluateAutomationConditions,
  flattenSteps,
  interpolate,
  nextStep,
  placeholdersIn,
  reentryDecision,
} from './automation-runtime.js';
import type { WorkflowDefinition } from './automation.js';

const note = (id: string) => ({ id, action: 'add_note', params: { body: id } });

function definition(steps: WorkflowDefinition['steps']): WorkflowDefinition {
  return { trigger: { type: 'lead.created' }, steps };
}

describe('walking the graph', () => {
  const branched = definition([
    note('first'),
    {
      id: 'decide',
      action: 'branch',
      conditions: { all: [{ field: 'lead.score', operator: 'greater_than', value: 50 }] },
      then: [note('hot-one'), note('hot-two')],
      otherwise: [note('cold')],
    },
    note('last'),
  ]);

  it('flattens in the order somebody reading the editor would expect', () => {
    expect(flattenSteps(branched).map((entry) => entry.step.id)).toEqual([
      'first',
      'decide',
      'hot-one',
      'hot-two',
      'cold',
      'last',
    ]);
  });

  it('records the path and the arm each step sits under', () => {
    const flat = flattenSteps(branched);
    expect(flat[2]?.path).toBe('definition.steps[1].then[0]');
    expect(flat[2]?.branchOf).toEqual({ stepId: 'decide', arm: 'then' });
    expect(flat[0]?.branchOf).toBeNull();
  });

  it('starts at the first step', () => {
    expect(nextStep(branched, { after: null, branchDecisions: {} })?.step.id).toBe('first');
  });

  it('skips the whole arm a branch did not take', () => {
    expect(
      nextStep(branched, { after: 'decide', branchDecisions: { decide: 'otherwise' } })?.step.id,
    ).toBe('cold');
    expect(
      nextStep(branched, { after: 'cold', branchDecisions: { decide: 'otherwise' } })?.step.id,
    ).toBe('last');
  });

  it('follows the arm it did take, step by step', () => {
    expect(
      nextStep(branched, { after: 'decide', branchDecisions: { decide: 'then' } })?.step.id,
    ).toBe('hot-one');
    expect(
      nextStep(branched, { after: 'hot-one', branchDecisions: { decide: 'then' } })?.step.id,
    ).toBe('hot-two');
    // And out of the arm again, rather than into the other one.
    expect(
      nextStep(branched, { after: 'hot-two', branchDecisions: { decide: 'then' } })?.step.id,
    ).toBe('last');
  });

  it('answers null when the run is finished', () => {
    expect(nextStep(branched, { after: 'last', branchDecisions: { decide: 'then' } })).toBeNull();
  });

  it('answers null for a step the version does not contain, rather than starting again', () => {
    // A run whose `current_step_id` is not in its pinned version cannot happen — a published
    // version is immutable — and re-running step one would be the expensive way to be wrong.
    expect(
      nextStep(branched, { after: 'a-step-from-another-graph', branchDecisions: {} }),
    ).toBeNull();
  });

  it('treats an un-decided branch arm as unreachable', () => {
    expect(nextStep(branched, { after: 'decide', branchDecisions: {} })?.step.id).toBe('last');
  });
});

describe('conditions', () => {
  const facts = {
    'lead.statusId': 'status-new',
    'lead.score': 62,
    'lead.city': 'Pune',
    'lead.tags': ['site-visit', 'pricing'],
    'lead.assignedUserId': null,
    'lead.consentWhatsapp': true,
    'lead.priority': 'high',
  };

  it('passes when there are no conditions at all', () => {
    expect(evaluateAutomationConditions(undefined, facts).passed).toBe(true);
    expect(evaluateAutomationConditions({ all: [] }, facts).passed).toBe(true);
  });

  it('matches equality across the string/number boundary a JSON body creates', () => {
    expect(
      evaluateAutomationConditions(
        { all: [{ field: 'lead.score', operator: 'equals', value: '62' }] },
        facts,
      ).passed,
    ).toBe(true);
  });

  it('compares numbers, and refuses rather than throws when one is not a number', () => {
    expect(
      evaluateAutomationConditions(
        { all: [{ field: 'lead.score', operator: 'greater_than', value: 50 }] },
        facts,
      ).passed,
    ).toBe(true);
    // A blank score must not stop the run; it must not match.
    expect(
      evaluateAutomationConditions(
        { all: [{ field: 'lead.score', operator: 'greater_than', value: 50 }] },
        { 'lead.score': null },
      ).passed,
    ).toBe(false);
    expect(
      evaluateAutomationConditions(
        { all: [{ field: 'lead.score', operator: 'less_than', value: 'soon' }] },
        facts,
      ).passed,
    ).toBe(false);
  });

  it('reads `contains` on an array as membership and on a string as a substring', () => {
    expect(
      evaluateAutomationConditions(
        { all: [{ field: 'lead.tags', operator: 'contains', value: 'pricing' }] },
        facts,
      ).passed,
    ).toBe(true);
    expect(
      evaluateAutomationConditions(
        { all: [{ field: 'lead.city', operator: 'contains', value: 'pun' }] },
        facts,
      ).passed,
    ).toBe(true);
  });

  it('treats null, undefined and an empty array as empty', () => {
    for (const value of [null, undefined, '', []]) {
      expect(
        evaluateAutomationConditions(
          { all: [{ field: 'lead.assignedUserId', operator: 'is_empty' }] },
          { 'lead.assignedUserId': value },
        ).passed,
        JSON.stringify(value),
      ).toBe(true);
    }
    expect(
      evaluateAutomationConditions(
        { all: [{ field: 'lead.assignedUserId', operator: 'is_not_empty' }] },
        facts,
      ).passed,
    ).toBe(false);
  });

  it('ignores a value sent with a valueless operator rather than matching nothing', () => {
    expect(
      evaluateAutomationConditions(
        { all: [{ field: 'lead.city', operator: 'is_not_empty', value: 'Pune' }] },
        facts,
      ).passed,
    ).toBe(true);
  });

  it('reads a boolean sent as a string, which is what a form submits', () => {
    expect(
      evaluateAutomationConditions(
        { all: [{ field: 'lead.consentWhatsapp', operator: 'equals', value: 'true' }] },
        facts,
      ).passed,
    ).toBe(true);
    expect(
      evaluateAutomationConditions(
        { all: [{ field: 'lead.consentWhatsapp', operator: 'equals', value: 'false' }] },
        facts,
      ).passed,
    ).toBe(false);
  });

  it('reads `in` as a list, whether it arrives as one or as a comma-separated string', () => {
    for (const value of [['status-new', 'status-old'], 'status-new, status-old']) {
      expect(
        evaluateAutomationConditions(
          { all: [{ field: 'lead.statusId', operator: 'in', value }] },
          facts,
        ).passed,
        JSON.stringify(value),
      ).toBe(true);
    }
  });

  it('reads `changed_to` against the new value, because that is what the trigger means', () => {
    expect(
      evaluateAutomationConditions(
        { all: [{ field: 'lead.statusId', operator: 'changed_to', value: 'status-new' }] },
        facts,
      ).passed,
    ).toBe(true);
  });

  it('fails an `all` on the first condition that fails, and says which', () => {
    const outcome = evaluateAutomationConditions(
      {
        all: [
          { field: 'lead.score', operator: 'greater_than', value: 50 },
          { field: 'lead.city', operator: 'equals', value: 'Mumbai' },
        ],
      },
      facts,
    );
    expect(outcome.passed).toBe(false);
    // The sentence is what reaches the timeline as "skipped because", so it is asserted rather
    // than the boolean alone.
    expect(outcome.reason).toBe('lead.city is Pune, not is Mumbai');
  });

  it('passes an `any` on the first match and explains every failure otherwise', () => {
    expect(
      evaluateAutomationConditions(
        {
          any: [
            { field: 'lead.city', operator: 'equals', value: 'Mumbai' },
            { field: 'lead.score', operator: 'greater_than', value: 50 },
          ],
        },
        facts,
      ).passed,
    ).toBe(true);
    const failed = evaluateAutomationConditions(
      {
        any: [
          { field: 'lead.city', operator: 'equals', value: 'Mumbai' },
          { field: 'lead.score', operator: 'greater_than', value: 90 },
        ],
      },
      facts,
    );
    expect(failed.passed).toBe(false);
    expect(failed.reason).toContain('and');
  });

  it('nests a group inside a group', () => {
    expect(
      evaluateAutomationConditions(
        {
          all: [
            { field: 'lead.consentWhatsapp', operator: 'equals', value: true },
            { any: [{ field: 'lead.city', operator: 'equals', value: 'Pune' }] },
          ],
        },
        facts,
      ).passed,
    ).toBe(true);
  });

  it('does not match a fact nobody supplied', () => {
    expect(
      evaluateAutomationConditions(
        { all: [{ field: 'lead.aura', operator: 'equals', value: 'golden' }] },
        facts,
      ).passed,
    ).toBe(false);
  });
});

describe('re-entry', () => {
  const now = new Date('2026-10-25T12:00:00Z');
  const base = {
    cooldownHours: null,
    maxRunsPerEntity: null,
    cycles: 0,
    lastEnrolledAt: null,
    hasLiveRun: false,
    now,
  } as const;

  it('lets a lead in the first time, whatever the policy', () => {
    for (const policy of ['once', 'cooldown', 'always'] as const) {
      const decision = reentryDecision({
        ...base,
        policy,
        cooldownHours: policy === 'cooldown' ? 24 : null,
      });
      expect(decision.allowed, policy).toBe(true);
      expect(decision.cycle).toBe(1);
    }
  });

  it('refuses a second time under `once`, and says why in a sentence', () => {
    const decision = reentryDecision({ ...base, policy: 'once', cycles: 1 });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain('runs once per lead');
    // The cycle it *would* take is still answered, which is what the unique would have refused.
    expect(decision.cycle).toBe(2);
  });

  it('lets a lead in again under `always`', () => {
    expect(reentryDecision({ ...base, policy: 'always', cycles: 4 }).allowed).toBe(true);
  });

  it('holds a cooldown until it has passed, counted from the last entry', () => {
    const recent = reentryDecision({
      ...base,
      policy: 'cooldown',
      cooldownHours: 24,
      cycles: 1,
      lastEnrolledAt: new Date('2026-10-25T06:00:00Z'),
    });
    expect(recent.allowed).toBe(false);
    expect(recent.reason).toContain('less than 24 hours ago');

    const old = reentryDecision({
      ...base,
      policy: 'cooldown',
      cooldownHours: 24,
      cycles: 1,
      lastEnrolledAt: new Date('2026-10-23T06:00:00Z'),
    });
    expect(old.allowed).toBe(true);
    expect(old.cycle).toBe(2);
  });

  it('caps the number of runs per lead whatever the policy says', () => {
    const decision = reentryDecision({ ...base, policy: 'always', cycles: 3, maxRunsPerEntity: 3 });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain('3 times');
  });

  it('reads a cap of one as a sentence rather than as "1 times"', () => {
    // A screen that cannot count to one reads as machine output, which is the one thing a
    // hand-written sentence exists to avoid.
    expect(
      reentryDecision({ ...base, policy: 'always', cycles: 1, maxRunsPerEntity: 1 }).reason,
    ).toBe('this lead has already been through this workflow');
  });

  it('never doubles a run that is already going, whatever the policy', () => {
    const decision = reentryDecision({ ...base, policy: 'always', cycles: 1, hasLiveRun: true });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain('already running');
  });

  it('refuses a cooldown cycle with no recorded start rather than treating it as long ago', () => {
    expect(
      reentryDecision({ ...base, policy: 'cooldown', cooldownHours: 2, cycles: 1 }).allowed,
    ).toBe(false);
  });
});

describe('interpolation', () => {
  const facts = { 'lead.fullName': 'Asha Rao', 'lead.city': null, 'lead.tags': ['a', 'b'] };

  it('fills a placeholder, and tolerates spacing inside the braces', () => {
    expect(interpolate('Hello {{lead.fullName}}', facts)).toBe('Hello Asha Rao');
    expect(interpolate('Hello {{ lead.fullName }}', facts)).toBe('Hello Asha Rao');
  });

  it('renders a known-but-empty value as nothing rather than as "null"', () => {
    expect(interpolate('City: {{lead.city}}', facts)).toBe('City: ');
  });

  it('joins a list', () => {
    expect(interpolate('{{lead.tags}}', facts)).toBe('a, b');
  });

  it('throws on a placeholder nothing can fill', () => {
    // A template rendered with `undefined` is worse than no message at all.
    expect(() => interpolate('Hello {{lead.nickname}}', facts)).toThrow(UnknownPlaceholderError);
    expect(() => interpolate('Hello {{lead.nickname}}', facts)).toThrow(/lead.nickname/);
  });

  it('lists the placeholders a template names, once each', () => {
    expect(placeholdersIn('{{a.b}} and {{a.b}} and {{c.d}}').sort()).toEqual(['a.b', 'c.d']);
    expect(placeholdersIn('nothing here')).toEqual([]);
  });
});

describe('the ceilings', () => {
  it('keeps the loop ceiling small enough that a human could still follow the chain', () => {
    expect(MAX_CAUSATION_DEPTH).toBeLessThanOrEqual(5);
  });

  it('defaults the daily cap to a number rather than to unlimited', () => {
    // Absent must not mean unlimited: the failure this cap exists to prevent is a workflow
    // messaging everybody, and it would happen to the workspace that never opened the settings.
    expect(DEFAULT_DAILY_ACTION_CAP).toBeGreaterThan(0);
    expect(Number.isFinite(DEFAULT_DAILY_ACTION_CAP)).toBe(true);
  });
});
