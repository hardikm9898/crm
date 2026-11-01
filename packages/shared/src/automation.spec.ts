import { describe, expect, it } from 'vitest';
import {
  CONDITION_FIELDS,
  CONDITION_OPERATORS,
  MAX_STEPS,
  PARAM_TYPES,
  REFERENCE_KINDS,
  VALUELESS_OPERATORS,
  WORKFLOW_ACTIONS,
  WORKFLOW_TRIGGERS,
  conditionField,
  publishProblem,
  referencesIn,
  validateWorkflowDefinition,
  workflowAction,
  workflowTrigger,
  type WorkflowDefinition,
} from './automation.js';

/** A definition that passes, so each test below can break exactly one thing. */
function definition(overrides: Partial<WorkflowDefinition> = {}): WorkflowDefinition {
  return {
    trigger: { type: 'lead.created' },
    steps: [{ id: 'note', action: 'add_note', params: { body: 'A new lead arrived.' } }],
    ...overrides,
  };
}

describe('the registry itself', () => {
  it('declares a parameter every editor can render', () => {
    for (const spec of [...WORKFLOW_TRIGGERS, ...WORKFLOW_ACTIONS]) {
      for (const field of spec.params) {
        expect(PARAM_TYPES, `${spec.key}.${field.key}`).toContain(field.type);
        // A `select` with no options renders an empty box; a `reference` with no kind is a list
        // the screen cannot fetch. Either one looks like a workspace with nothing in it.
        if (field.type === 'select')
          expect(field.options?.length, `${spec.key}.${field.key}`).toBeGreaterThan(0);
        if (field.type === 'reference') {
          expect(REFERENCE_KINDS, `${spec.key}.${field.key}`).toContain(field.reference);
        }
        if (field.type !== 'reference') expect(field.reference).toBeUndefined();
      }
    }
  });

  it('declares condition fields whose operators exist', () => {
    for (const field of CONDITION_FIELDS) {
      expect(field.operators.length, field.key).toBeGreaterThan(0);
      for (const operator of field.operators) {
        expect(CONDITION_OPERATORS, `${field.key} → ${operator}`).toContain(operator);
      }
    }
  });

  it('gives every key one entry', () => {
    for (const list of [WORKFLOW_TRIGGERS, WORKFLOW_ACTIONS, CONDITION_FIELDS]) {
      const keys = list.map((spec) => spec.key);
      expect(new Set(keys).size).toBe(keys.length);
    }
  });

  it('looks a key up, and answers undefined for one that does not exist', () => {
    expect(workflowTrigger('lead.created')?.subject).toBe('lead');
    expect(workflowAction('create_task')?.group).toBe('followup');
    expect(conditionField('lead.score')?.type).toBe('number');
    // A deliberately fictional key: a test that names a real-but-unbuilt one passes for the wrong
    // reason the day it is built.
    expect(workflowAction('send_telegram')).toBeUndefined();
  });

  it('marks as control exactly the four shapes the engine owns', () => {
    const control = WORKFLOW_ACTIONS.filter((spec) => spec.control)
      .map((spec) => spec.key)
      .sort();
    expect(control).toEqual(['branch', 'enroll', 'stop', 'wait']);
  });

  /**
   * Phase 6's first exit criterion, which asks that adding an action take **no engine change and
   * no frontend release** — "proven by adding one". `change_priority` is that one, and this is the
   * half of the proof a unit test can carry: it is a declaration, it is not a control shape, and
   * its parameter is a `select` the editor already knows how to render. The other half is the
   * engine's own boot check, which refuses to start if nothing handles it.
   */
  it('declares change_priority as data the editor can already render', () => {
    const spec = workflowAction('change_priority');
    expect(spec?.control).toBe(false);
    const priority = spec?.params.find((param) => param.key === 'priority');
    expect(priority?.type).toBe('select');
    expect(priority?.options?.map((option) => option.value)).toEqual([
      'low',
      'medium',
      'high',
      'urgent',
    ]);
  });

  it('validates a workflow using change_priority without knowing anything about it', () => {
    expect(
      validateWorkflowDefinition({
        trigger: { type: 'lead.score_changed' },
        steps: [{ id: 'raise', action: 'change_priority', params: { priority: 'high' } }],
      }),
    ).toEqual([]);
    // And refuses a value the declaration does not offer, from the same declaration.
    expect(
      validateWorkflowDefinition({
        trigger: { type: 'lead.score_changed' },
        steps: [{ id: 'raise', action: 'change_priority', params: { priority: 'blazing' } }],
      }).map((problem) => problem.field),
    ).toEqual(['definition.steps[0].params.priority']);
  });
});

describe('validateWorkflowDefinition', () => {
  it('accepts a workflow that is ready', () => {
    expect(validateWorkflowDefinition(definition())).toEqual([]);
  });

  it('refuses something that is not a definition at all', () => {
    expect(validateWorkflowDefinition(null)[0]?.code).toBe('NOT_AN_OBJECT');
    expect(validateWorkflowDefinition('a workflow')[0]?.code).toBe('NOT_AN_OBJECT');
  });

  it('says there is nothing called that, naming it', () => {
    const problems = validateWorkflowDefinition(
      definition({ trigger: { type: 'lead.telepathy' } }),
    );
    expect(problems[0]?.code).toBe('TRIGGER_UNKNOWN');
    // The sentence matters as much as the code: "invalid definition" is not actionable.
    expect(problems[0]?.message).toContain('lead.telepathy');
  });

  it('wants at least one step', () => {
    expect(validateWorkflowDefinition(definition({ steps: [] }))[0]?.code).toBe('STEPS_MISSING');
  });

  it('refuses an unknown action, and a required parameter nobody filled in', () => {
    expect(
      validateWorkflowDefinition(definition({ steps: [{ id: 'a', action: 'send_sms' }] }))[0]?.code,
    ).toBe('ACTION_UNKNOWN');
    const missing = validateWorkflowDefinition(
      definition({ steps: [{ id: 'a', action: 'change_status', params: {} }] }),
    );
    expect(missing[0]?.code).toBe('PARAM_REQUIRED');
    expect(missing[0]?.field).toContain('statusId');
  });

  it('refuses two steps with the same id', () => {
    const problems = validateWorkflowDefinition(
      definition({
        steps: [
          { id: 'same', action: 'add_note', params: { body: 'one' } },
          { id: 'same', action: 'add_note', params: { body: 'two' } },
        ],
      }),
    );
    expect(problems.map((problem) => problem.code)).toContain('STEP_ID_DUPLICATE');
  });

  it('refuses a condition on a field nobody declared, and a value where none belongs', () => {
    const unknownField = validateWorkflowDefinition(
      definition({ conditions: { all: [{ field: 'lead.aura', operator: 'equals', value: 'x' }] } }),
    );
    expect(unknownField[0]?.code).toBe('CONDITION_FIELD_UNKNOWN');

    const valueless = validateWorkflowDefinition(
      definition({
        conditions: { all: [{ field: 'lead.city', operator: 'is_empty', value: 'x' }] },
      }),
    );
    expect(valueless[0]?.code).toBe('CONDITION_VALUE_IGNORED');
    expect(VALUELESS_OPERATORS).toContain('is_empty');
  });

  it('refuses an operator the field does not offer', () => {
    const problems = validateWorkflowDefinition(
      definition({
        conditions: { all: [{ field: 'lead.score', operator: 'contains', value: '5' }] },
      }),
    );
    expect(problems[0]?.code).toBe('CONDITION_OPERATOR_UNSUPPORTED');
  });

  it('counts steps inside branches towards the ceiling', () => {
    const steps = Array.from({ length: MAX_STEPS + 1 }, (_, index) => ({
      id: `step-${index}`,
      action: 'add_note',
      params: { body: 'x' },
    }));
    const problems = validateWorkflowDefinition(definition({ steps }));
    expect(problems.map((problem) => problem.code)).toContain('TOO_MANY_STEPS');
  });

  it('refuses a branch nested deeper than anybody can read', () => {
    const leaf = { id: 'leaf', action: 'add_note', params: { body: 'x' } };
    let branch: Record<string, unknown> = { id: 'b4', action: 'branch', then: [leaf] };
    for (const level of [3, 2, 1]) {
      branch = { id: `b${level}`, action: 'branch', then: [branch] };
    }
    const problems = validateWorkflowDefinition(definition({ steps: [branch as never] }));
    expect(problems.map((problem) => problem.code)).toContain('BRANCH_TOO_DEEP');
  });

  it('refuses a wait with no duration and a number out of range', () => {
    expect(
      validateWorkflowDefinition(
        definition({ steps: [{ id: 'w', action: 'wait', params: {} }] }),
      )[0]?.code,
    ).toBe('PARAM_REQUIRED');
    const tooLong = validateWorkflowDefinition(
      definition({ steps: [{ id: 'w', action: 'wait', params: { minutes: 10_000_000 } }] }),
    );
    expect(tooLong[0]?.code).toBe('PARAM_TOO_LARGE');
  });
});

describe('referencesIn', () => {
  it('finds every id a definition names, with the path it was found at', () => {
    const found = referencesIn(
      definition({
        steps: [
          { id: 'own', action: 'assign', params: { userId: 'user-1' } },
          {
            id: 'branch',
            action: 'branch',
            conditions: { all: [{ field: 'lead.score', operator: 'greater_than', value: 50 }] },
            then: [{ id: 'move', action: 'change_status', params: { statusId: 'status-1' } }],
            otherwise: [{ id: 'note', action: 'add_note', params: { body: 'later' } }],
          },
        ],
      }),
    );
    expect(found).toEqual([
      { kind: 'user', id: 'user-1', field: 'definition.steps[0].params.userId' },
      { kind: 'lead_status', id: 'status-1', field: 'definition.steps[1].then[0].params.statusId' },
    ]);
  });

  it('ignores a parameter nobody filled in, rather than reporting an empty id', () => {
    expect(
      referencesIn(definition({ steps: [{ id: 'own', action: 'assign', params: {} }] })),
    ).toEqual([]);
  });
});

describe('publishProblem', () => {
  it('lets a draft with no problems through', () => {
    expect(publishProblem({ status: 'draft', problems: [] })).toBeNull();
  });

  it('refuses an archived workflow, and says what to do instead', () => {
    expect(publishProblem({ status: 'archived', problems: [] })).toContain('Copy it');
  });

  it('refuses one with problems', () => {
    expect(
      publishProblem({
        status: 'draft',
        problems: [{ field: 'definition.steps', code: 'STEPS_MISSING', message: 'x' }],
      }),
    ).toContain('correct');
  });
});

describe('an empty trigger is "not chosen yet", not "unknown"', () => {
  it('says to choose one rather than naming nothing', () => {
    const problems = validateWorkflowDefinition({ trigger: { type: '' }, steps: [] });
    expect(problems[0]?.code).toBe('TRIGGER_MISSING');
    // The sentence a new workflow's editor shows. Found by the e2e, which created one and read
    // back “There is nothing called “” that can start a workflow”.
    expect(problems[0]?.message).toBe('Choose what starts this workflow.');
  });
});
