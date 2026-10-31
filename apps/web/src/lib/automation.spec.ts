import { describe, expect, it } from 'vitest';
import { REFERENCE_KINDS, WORKFLOW_ACTIONS, WORKFLOW_TRIGGERS } from '@leados/shared';
import {
  REENTRY_LABELS,
  REFERENCE_LABELS,
  STATUS_LABELS,
  STATUS_TONES,
  blankStep,
  cleanDefinition,
  coerceParam,
  describeRun,
  describeWorkflow,
  paramDefault,
  problemsAt,
  type ActionSpec,
  type AutomationCatalogue,
  type ParamField,
  type RunSummary,
  type WorkflowSummary,
} from './automation';

/**
 * The web half of the automation registry.
 *
 * A spec may import `@leados/shared` — it runs in Node — and that is what makes this file the
 * reconciliation `TASK_BUCKETS` needs and `webhooks.spec.ts` performs. The difference here is what
 * there is to reconcile: **not** a copied list of triggers and actions, because this screen has
 * none, only the one thing a declaration cannot carry, which is how a row of each reference kind
 * reads in a picker.
 */

const catalogue: AutomationCatalogue = {
  triggers: [
    {
      key: 'lead.created',
      label: 'A new lead arrives',
      hint: 'Anybody captured from anywhere.',
      group: 'lead',
      event: 'lead.created',
      params: [],
    },
  ],
  actions: [],
  conditionFields: [],
  operators: ['equals'],
  valuelessOperators: ['is_empty'],
  references: [],
  statuses: ['draft', 'active', 'paused', 'archived'],
  reentryPolicies: ['once', 'cooldown', 'always'],
  limits: { maxSteps: 50, maxBranchDepth: 3 },
};

function summary(overrides: Partial<WorkflowSummary> = {}): WorkflowSummary {
  return {
    id: 'w1',
    name: 'Nurture',
    description: null,
    status: 'active',
    killSwitch: false,
    currentVersionId: 'v1',
    reentryPolicy: 'once',
    cooldownHours: null,
    maxRunsPerEntity: null,
    updatedAt: new Date().toISOString(),
    trigger: { type: 'lead.created', event: 'lead.created' },
    ...overrides,
  };
}

describe('the vocabulary this screen does declare', () => {
  it('labels every status and re-entry policy the API can answer', () => {
    for (const status of catalogue.statuses) {
      expect(STATUS_LABELS[status], status).toBeTruthy();
      expect(STATUS_TONES[status], status).toBeTruthy();
    }
    for (const policy of catalogue.reentryPolicies) {
      expect(REENTRY_LABELS[policy], policy).toBeTruthy();
    }
  });

  /**
   * The one real reconciliation. A reference kind with no label function renders a picker full of
   * UUIDs, which is the "a stored option value is not the answer somebody gave" lesson in a
   * dropdown.
   */
  it('knows how to label a row of every reference kind the registry declares', () => {
    for (const kind of REFERENCE_KINDS) {
      expect(Object.keys(REFERENCE_LABELS), kind).toContain(kind);
    }
  });

  it('labels a person by their membership’s user id, not by the row’s own id', () => {
    const option = REFERENCE_LABELS['user']!({
      id: 'membership-1',
      userId: 'user-1',
      name: 'Asha',
    });
    // Every assignment column in this product stores a user id; labelling by `id` would offer a
    // picker whose every choice the API refuses.
    expect(option).toEqual({ value: 'user-1', label: 'Asha' });
  });

  it('falls back to the id rather than printing "undefined"', () => {
    expect(REFERENCE_LABELS['team']!({ id: 't1' })).toEqual({ value: 't1', label: 't1' });
    expect(REFERENCE_LABELS['team']!({ name: 'No id' })).toBeNull();
  });
});

describe('describeWorkflow', () => {
  it('says what starts it', () => {
    expect(describeWorkflow(summary(), catalogue)).toBe('Runs when: a new lead arrives');
  });

  it('says a stop is a stop, before anything else', () => {
    expect(describeWorkflow(summary({ killSwitch: true }), catalogue)).toContain('Stopped');
  });

  it('distinguishes "never published" from "paused"', () => {
    expect(describeWorkflow(summary({ currentVersionId: null }), catalogue)).toContain(
      'Not published yet',
    );
    expect(describeWorkflow(summary({ status: 'paused' }), catalogue)).toContain('Paused');
  });
});

/**
 * The proof of Phase 6's first exit criterion, on the web side: an action **this release has
 * never seen** is rendered and collected by the code below. If the editor knew its actions, this
 * test could not be written.
 */
describe('an action nobody has written a component for', () => {
  const invented: ActionSpec = {
    key: 'send_pigeon',
    label: 'Send a pigeon',
    hint: 'Weather permitting.',
    group: 'message',
    control: false,
    params: [
      { key: 'message', label: 'What it carries', type: 'text', required: true, max: 140 },
      { key: 'delayMinutes', label: 'Wait first', type: 'duration', required: false, min: 0 },
      { key: 'ringed', label: 'Ringed bird only', type: 'boolean', required: false },
    ],
  };

  it('builds a step with every parameter at its default', () => {
    expect(blankStep(invented, 1)).toEqual({
      id: 'send-pigeon-1',
      action: 'send_pigeon',
      params: { message: '', delayMinutes: 0, ringed: false },
    });
  });

  it('reads each parameter back out of its control', () => {
    const [message, delay, ringed] = invented.params as ParamField[];
    expect(coerceParam(message!, ' Fly north ')).toBe('Fly north');
    expect(coerceParam(delay!, '90')).toBe(90);
    expect(coerceParam(ringed!, true)).toBe(true);
  });

  it('refuses what Number() accepts, rather than inventing a zero', () => {
    const delay = invented.params[1]!;
    // `Number('')` is 0 and 0 is a meaningful duration, so an empty box has to be absent.
    expect(coerceParam(delay, '')).toBeUndefined();
    expect(coerceParam(delay, 'soon')).toBeUndefined();
    expect(coerceParam(delay, '0')).toBe(0);
  });

  it('starts a boolean at false and a text box empty', () => {
    expect(paramDefault(invented.params[2]!)).toBe(false);
    expect(paramDefault(invented.params[0]!)).toBe('');
  });
});

describe('cleanDefinition', () => {
  it('drops what nobody filled in, so a blank is not saved as a value', () => {
    const cleaned = cleanDefinition({
      trigger: { type: 'lead.created', params: { toStatusId: '' } },
      steps: [{ id: 's1', action: 'add_note', params: { body: 'Hello', extra: undefined } }],
    });
    expect(cleaned.trigger.params).toEqual({});
    expect(cleaned.steps[0]?.params).toEqual({ body: 'Hello' });
  });

  it('keeps a false and a zero, which are answers', () => {
    const cleaned = cleanDefinition({
      trigger: { type: 'lead.created' },
      steps: [{ id: 's1', action: 'wait', params: { minutes: 0, workingHoursOnly: false } }],
    });
    expect(cleaned.steps[0]?.params).toEqual({ minutes: 0, workingHoursOnly: false });
  });
});

describe('problemsAt', () => {
  it('returns only the problems for the field it names', () => {
    const problems = [
      { field: 'definition.steps[0].params.body', code: 'PARAM_REQUIRED', message: 'Needed' },
      { field: 'definition.trigger.type', code: 'TRIGGER_MISSING', message: 'Choose one' },
    ];
    expect(problemsAt(problems, 'definition.trigger.type')).toHaveLength(1);
    expect(problemsAt(problems, 'definition.steps[1].params.body')).toEqual([]);
  });
});

describe('the registry the API serves is the one the editor renders', () => {
  it('offers at least one trigger and one action, so the screen is not empty', () => {
    // A guard against the registry being emptied by a refactor: the editor renders what it is
    // handed, which means an empty list is a screen with no automation and no error.
    expect(WORKFLOW_TRIGGERS.length).toBeGreaterThan(0);
    expect(WORKFLOW_ACTIONS.length).toBeGreaterThan(0);
  });
});

describe('describeRun', () => {
  const run = (over: Partial<RunSummary>): RunSummary => ({
    id: 'r1',
    steps: [],
    status: 'completed',
    trigger: 'lead.created',
    workflow: { id: 'w1', name: 'Call back' },
    lead: { id: 'l1', fullName: 'Asha Rao' },
    cycle: 1,
    dryRun: false,
    version: 1,
    currentStepId: null,
    resumeAt: null,
    stepsRun: 2,
    startedAt: '2026-10-26T04:00:00.000Z',
    finishedAt: '2026-10-26T04:00:01.000Z',
    error: null,
    ...over,
  });

  it('counts to one in words, rather than printing “1 steps”', () => {
    expect(describeRun(run({ stepsRun: 1 }))).toBe('Finished after 1 step.');
    expect(describeRun(run({ stepsRun: 3 }))).toBe('Finished after 3 steps.');
  });

  it('says a preview was a preview before it says anything else', () => {
    // Every other sentence this function produces reads as something that happened to a
    // customer, so the one thing a preview must not be mistaken for is a thing that happened.
    expect(describeRun(run({ dryRun: true }))).toBe(
      'Preview — nothing was sent. Finished after 2 steps.',
    );
    expect(describeRun(run({ dryRun: true, status: 'failed', error: 'no template' }))).toBe(
      'Preview — nothing was sent. Failed: no template.',
    );
  });

  it('carries the engine’s own reason for a failure, never a paraphrase', () => {
    expect(describeRun(run({ status: 'failed', error: 'that template is not approved' }))).toBe(
      'Failed: that template is not approved.',
    );
    expect(describeRun(run({ status: 'failed', error: null }))).toBe('Failed: no reason recorded.');
  });
});
