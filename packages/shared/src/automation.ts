/**
 * The automation registry (`FR-AUT-1`, `FR-AUT-2`, `FR-AUT-3`, `FR-AUT-4`, `FR-AUT-8`).
 *
 * Phase 6's first exit criterion is the one that shapes this whole file: **"adding a new action
 * type requires no engine change and no frontend release."** That rules out the two obvious
 * designs. A `switch` in an executor is an engine change. A Zod schema per action is an engine
 * change too, because a browser cannot read a Zod object — so the editor would need a hand-written
 * form per action and every new action would be a frontend release.
 *
 * What is left is a **declaration the API serves and both halves read**: each trigger, condition
 * and action carries a list of parameter fields with a type, a label and, where the value is a row
 * in this workspace, which kind of row. The editor renders inputs from that list; the write path
 * validates against the same list; the executor (step 2) dispatches on the key. Adding an action
 * is one entry here plus one handler — and the handler is what step 2's registry reconciliation
 * will insist on, the way a provider's declared capabilities are reconciled against its adapter at
 * boot.
 *
 * **Nothing about a tenant is hardcoded** (rule 4). A field whose value is a status, a stage, a
 * member or a template declares `reference`, and the screen fetches that list — so a workspace's
 * own statuses appear in a picker without this file naming any of them.
 */

/** What a parameter is, for the editor that renders it and the validator that checks it. */
export const PARAM_TYPES = [
  'text',
  'textarea',
  'number',
  'boolean',
  'select',
  /** A whole number of minutes, rendered as a friendlier "2 hours" control. */
  'duration',
  /** A row in this workspace, named by `reference`. */
  'reference',
] as const;
export type ParamType = (typeof PARAM_TYPES)[number];

/**
 * The kinds of row a parameter can point at.
 *
 * Each one is a list the editor fetches rather than a vocabulary this file knows: a workspace's
 * statuses, stages, task types and members are rows, so naming them here would be the hardcoding
 * rule 4 forbids.
 */
export const REFERENCE_KINDS = [
  'user',
  'team',
  'lead_status',
  'pipeline',
  'pipeline_stage',
  'task_type',
  'lead_source',
  'whatsapp_template',
  'workflow',
  'webhook_endpoint',
] as const;
export type ReferenceKind = (typeof REFERENCE_KINDS)[number];

export interface ParamField {
  readonly key: string;
  readonly label: string;
  readonly hint?: string;
  readonly type: ParamType;
  readonly required: boolean;
  /** For `select`: the fixed choices. A tenant's own rows are a `reference` instead. */
  readonly options?: readonly { readonly value: string; readonly label: string }[];
  readonly reference?: ReferenceKind;
  readonly max?: number;
  readonly min?: number;
}

/**
 * What a trigger is: a domain event, or a schedule, or a person pressing a button.
 *
 * `event` is the key of an outbox event — which is why `automation.spec.ts` reconciles this list
 * against `WEBHOOK_EVENT_TYPES` and the subscription table: a trigger offered on a screen with no
 * event behind it is a workflow that can never run, and would look built.
 */
export interface TriggerSpec {
  readonly key: string;
  readonly label: string;
  readonly hint: string;
  readonly group: 'lead' | 'task' | 'conversation' | 'money' | 'time' | 'manual';
  /** The outbox event that fires it. Null for `schedule` and `manual`, which have no event. */
  readonly event: string | null;
  /** What the run is about: every trigger in this product starts from a lead today. */
  readonly subject: 'lead';
  readonly params: readonly ParamField[];
}

export interface ActionSpec {
  readonly key: string;
  readonly label: string;
  readonly hint: string;
  readonly group: 'ownership' | 'followup' | 'message' | 'record' | 'flow';
  /**
   * Whether the **engine** knows this shape rather than a handler.
   *
   * `wait`, `branch`, `stop` and `enroll` change the shape of a run — a branch carries nested
   * steps, a wait suspends it — so they are the executor's own vocabulary and not plug-in handlers.
   * Saying so here is what keeps the first exit criterion honest: "adding an action needs no engine
   * change" is a claim about the other kind, and four control shapes pretending to be plug-ins
   * would make it a false claim nobody could check.
   */
  readonly control: boolean;
  readonly params: readonly ParamField[];
}

/** A comparison an editor offers, and the validator checks the operand count of. */
export const CONDITION_OPERATORS = [
  'equals',
  'not_equals',
  'contains',
  'greater_than',
  'less_than',
  'is_empty',
  'is_not_empty',
  'in',
  'changed_to',
] as const;
export type ConditionOperator = (typeof CONDITION_OPERATORS)[number];

/** Operators that take no value: `is_empty` with a value is a condition somebody mis-saved. */
export const VALUELESS_OPERATORS: readonly ConditionOperator[] = ['is_empty', 'is_not_empty'];

export interface ConditionFieldSpec {
  readonly key: string;
  readonly label: string;
  readonly group: 'lead' | 'score' | 'source' | 'time' | 'assignee';
  readonly operators: readonly ConditionOperator[];
  readonly type: ParamType;
  readonly reference?: ReferenceKind;
  readonly options?: readonly { readonly value: string; readonly label: string }[];
}

// ── The triggers (`FR-AUT-2`) ─────────────────────────────────────────────────
//
// Only events this product **actually emits**, which is the same rule `WEBHOOK_EVENT_TYPES`
// follows and for the same reason: a trigger a screen offers with nothing behind it is a workflow
// that never runs, and looks built. §8's wish list has `website event`, `email event` and
// `payment.completed`; the first two arrive with Phase 8, and money arrives here as
// `payment.received`.
export const WORKFLOW_TRIGGERS: readonly TriggerSpec[] = [
  {
    key: 'lead.created',
    label: 'A new lead arrives',
    hint: 'However it arrives — a form, WhatsApp, an ad, an import or somebody typing it in.',
    group: 'lead',
    event: 'lead.created',
    subject: 'lead',
    params: [],
  },
  {
    key: 'lead.assigned',
    label: 'A lead is assigned',
    hint: 'Including by an assignment rule. Fires again on every reassignment.',
    group: 'lead',
    event: 'lead.assigned',
    subject: 'lead',
    params: [],
  },
  {
    key: 'lead.status_changed',
    label: 'A lead’s status changes',
    hint: 'Leave the status empty for any change, or pick one to fire only when it reaches that.',
    group: 'lead',
    event: 'lead.status_changed',
    subject: 'lead',
    params: [
      {
        key: 'toStatusId',
        label: 'Only when it becomes',
        hint: 'Any status if you leave this empty.',
        type: 'reference',
        reference: 'lead_status',
        required: false,
      },
    ],
  },
  {
    key: 'lead.stage_changed',
    label: 'A lead moves stage',
    hint: 'Pick a stage to fire only on arrival there.',
    group: 'lead',
    event: 'lead.stage_changed',
    subject: 'lead',
    params: [
      {
        key: 'toStageId',
        label: 'Only when it reaches',
        type: 'reference',
        reference: 'pipeline_stage',
        required: false,
      },
    ],
  },
  {
    key: 'lead.score_changed',
    label: 'A lead’s score changes',
    hint: 'Useful with a condition on the score band — "when they become Hot".',
    group: 'lead',
    event: 'lead.score_changed',
    subject: 'lead',
    params: [],
  },
  {
    key: 'task.completed',
    label: 'A follow-up is completed',
    hint: 'What somebody does next after a call is made or a meeting is held.',
    group: 'task',
    event: 'task.completed',
    subject: 'lead',
    params: [],
  },
  {
    key: 'task.overdue',
    label: 'A follow-up goes overdue',
    hint: 'The sweep notices within a minute; this fires from the same event that notifies.',
    group: 'task',
    event: 'task.overdue',
    subject: 'lead',
    params: [],
  },
  {
    key: 'whatsapp.received',
    label: 'They reply on WhatsApp',
    hint: 'Any inbound message. The classic use is stopping a nurture the moment somebody answers.',
    group: 'conversation',
    event: 'whatsapp.message_received',
    subject: 'lead',
    params: [],
  },
  {
    key: 'sla.breached',
    label: 'A promise is missed',
    hint: 'When a first-response or next-response SLA passes its due time.',
    group: 'time',
    event: 'sla.breached',
    subject: 'lead',
    params: [],
  },
  {
    key: 'payment.received',
    label: 'A payment arrives',
    hint: 'The event the brief calls "payment completed".',
    group: 'money',
    event: 'payment.received',
    subject: 'lead',
    params: [],
  },
  {
    key: 'manual',
    label: 'Somebody runs it',
    hint: 'No event: a person picks a lead and starts this workflow. Useful for testing one, too.',
    group: 'manual',
    event: null,
    subject: 'lead',
    params: [],
  },
];

// ── The conditions (`FR-AUT-3`) ───────────────────────────────────────────────
export const CONDITION_FIELDS: readonly ConditionFieldSpec[] = [
  {
    key: 'lead.statusId',
    label: 'Status',
    group: 'lead',
    type: 'reference',
    reference: 'lead_status',
    operators: ['equals', 'not_equals', 'in', 'changed_to'],
  },
  {
    key: 'lead.stageId',
    label: 'Stage',
    group: 'lead',
    type: 'reference',
    reference: 'pipeline_stage',
    operators: ['equals', 'not_equals', 'in', 'changed_to'],
  },
  {
    key: 'lead.priority',
    label: 'Priority',
    group: 'lead',
    type: 'select',
    options: [
      { value: 'low', label: 'Low' },
      { value: 'medium', label: 'Medium' },
      { value: 'high', label: 'High' },
      { value: 'urgent', label: 'Urgent' },
    ],
    operators: ['equals', 'not_equals', 'in'],
  },
  {
    key: 'lead.scoreBand',
    label: 'Score band',
    group: 'score',
    // Text rather than a `select`: the bands are **rows** (`score_bands`), named by the workspace,
    // so a fixed list here would be the hardcoding rule 4 forbids. There is no `reference` kind for
    // them because they are compared by name rather than by id — which is what the scoring rules
    // already do.
    type: 'text',
    operators: ['equals', 'not_equals', 'in'],
  },
  {
    key: 'lead.score',
    label: 'Score',
    group: 'score',
    type: 'number',
    operators: ['greater_than', 'less_than', 'equals'],
  },
  {
    key: 'lead.leadSourceId',
    label: 'Source',
    group: 'source',
    type: 'reference',
    reference: 'lead_source',
    operators: ['equals', 'not_equals', 'in'],
  },
  {
    key: 'lead.city',
    label: 'City',
    group: 'lead',
    type: 'text',
    operators: ['equals', 'not_equals', 'contains', 'is_empty', 'is_not_empty'],
  },
  {
    key: 'lead.tags',
    label: 'Tags',
    group: 'lead',
    type: 'text',
    operators: ['contains', 'is_empty', 'is_not_empty'],
  },
  {
    key: 'lead.assignedUserId',
    label: 'Owner',
    group: 'assignee',
    type: 'reference',
    reference: 'user',
    operators: ['equals', 'not_equals', 'is_empty', 'is_not_empty'],
  },
  {
    key: 'lead.consentWhatsapp',
    label: 'Agreed to WhatsApp marketing',
    group: 'lead',
    type: 'boolean',
    operators: ['equals'],
  },
  {
    key: 'time.withinWorkingHours',
    label: 'Inside the business’s working hours',
    group: 'time',
    type: 'boolean',
    operators: ['equals'],
  },
];

// ── The actions (`FR-AUT-4`) ──────────────────────────────────────────────────
export const WORKFLOW_ACTIONS: readonly ActionSpec[] = [
  {
    key: 'assign',
    label: 'Assign it to somebody',
    hint: 'A person, or leave empty to let the workspace’s assignment rules decide.',
    group: 'ownership',
    control: false,
    params: [
      { key: 'userId', label: 'Person', type: 'reference', reference: 'user', required: false },
      {
        key: 'useRules',
        label: 'Use the assignment rules instead',
        hint: 'Round-robin, load-balanced — whatever this workspace has set up.',
        type: 'boolean',
        required: false,
      },
    ],
  },
  {
    key: 'create_task',
    label: 'Create a follow-up',
    hint: 'The thing that stops a lead going quiet.',
    group: 'followup',
    control: false,
    params: [
      { key: 'title', label: 'What to do', type: 'text', required: true, max: 200 },
      {
        key: 'taskTypeId',
        label: 'Kind',
        type: 'reference',
        reference: 'task_type',
        required: false,
      },
      {
        key: 'dueInMinutes',
        label: 'Due in',
        hint: 'From when this step runs. Working hours are respected.',
        type: 'duration',
        required: true,
        min: 0,
        max: 60 * 24 * 90,
      },
      {
        key: 'assigneeFrom',
        label: 'Who it is for',
        type: 'select',
        required: false,
        options: [
          { value: 'lead_owner', label: 'Whoever owns the lead' },
          { value: 'specific', label: 'A specific person' },
        ],
      },
      { key: 'userId', label: 'That person', type: 'reference', reference: 'user', required: false },
    ],
  },
  {
    key: 'send_whatsapp_template',
    label: 'Send a WhatsApp template',
    hint: 'The only thing that reaches somebody outside the 24-hour window. Consent still applies.',
    group: 'message',
    control: false,
    params: [
      {
        key: 'templateId',
        label: 'Template',
        type: 'reference',
        reference: 'whatsapp_template',
        required: true,
      },
    ],
  },
  {
    key: 'change_status',
    label: 'Change the status',
    group: 'record',
    hint: 'Moves the lead along without anybody opening it.',
    control: false,
    params: [
      {
        key: 'statusId',
        label: 'To',
        type: 'reference',
        reference: 'lead_status',
        required: true,
      },
    ],
  },
  {
    key: 'change_stage',
    label: 'Move it to a stage',
    group: 'record',
    hint: 'Within the lead’s own pipeline.',
    control: false,
    params: [
      {
        key: 'stageId',
        label: 'To',
        type: 'reference',
        reference: 'pipeline_stage',
        required: true,
      },
    ],
  },
  {
    key: 'add_tag',
    label: 'Add a tag',
    group: 'record',
    /**
     * A **lead's** tags are rows with display names — `ensureTag` finds or creates one by the name
     * as typed. The slug-shaped hint this originally carried was borrowed from
     * `conversations.tags`, which is a text array the API lower-cases and hyphenates; two different
     * things called tags, and the hint described the wrong one. Found by an HTTP check that
     * asserted the lower-cased form and read back `Nurtured`.
     */
    hint: 'Matched by name, and created if this workspace does not have it yet.',
    control: false,
    params: [{ key: 'tag', label: 'Tag', type: 'text', required: true, max: 40 }],
  },
  {
    key: 'add_note',
    label: 'Add a note',
    group: 'record',
    hint: 'On the lead’s timeline, attributed to the workflow rather than to a person.',
    control: false,
    params: [{ key: 'body', label: 'Note', type: 'textarea', required: true, max: 2000 }],
  },
  {
    key: 'notify',
    label: 'Tell somebody',
    group: 'message',
    hint: 'In their inbox here. Their quiet hours and their own settings still apply.',
    control: false,
    params: [
      {
        key: 'recipient',
        label: 'Who',
        type: 'select',
        required: true,
        options: [
          { value: 'lead_owner', label: 'Whoever owns the lead' },
          { value: 'specific', label: 'A specific person' },
        ],
      },
      { key: 'userId', label: 'That person', type: 'reference', reference: 'user', required: false },
      { key: 'title', label: 'What to say', type: 'text', required: true, max: 200 },
    ],
  },
  {
    key: 'call_webhook',
    label: 'Call a webhook',
    group: 'message',
    hint: 'One of this workspace’s endpoints, signed and retried like every other delivery.',
    control: false,
    params: [
      {
        key: 'endpointId',
        label: 'Endpoint',
        type: 'reference',
        reference: 'webhook_endpoint',
        required: true,
      },
    ],
  },
  // ── The four the engine itself knows ───────────────────────────────────────
  {
    key: 'wait',
    label: 'Wait',
    group: 'flow',
    hint: 'Working-hours aware: "two hours" at 5 pm means two working hours, not overnight.',
    control: true,
    params: [
      {
        key: 'minutes',
        label: 'For',
        type: 'duration',
        required: true,
        min: 1,
        max: 60 * 24 * 90,
      },
      {
        key: 'workingHoursOnly',
        label: 'Count working hours only',
        type: 'boolean',
        required: false,
      },
    ],
  },
  {
    key: 'branch',
    label: 'If…',
    group: 'flow',
    hint: 'Two paths. Steps under each are run in order, and a path may be empty.',
    control: true,
    params: [],
  },
  {
    key: 'stop',
    label: 'Stop',
    group: 'flow',
    hint: 'Ends this run, with the reason on the lead’s timeline.',
    control: true,
    params: [{ key: 'reason', label: 'Why', type: 'text', required: false, max: 200 }],
  },
  {
    key: 'enroll',
    label: 'Start another workflow',
    group: 'flow',
    hint: 'The re-entry and loop guards still apply, which is why this cannot run away with itself.',
    control: true,
    params: [
      { key: 'workflowId', label: 'Workflow', type: 'reference', reference: 'workflow', required: true },
    ],
  },
];

// ── A workflow definition ─────────────────────────────────────────────────────

export interface ConditionLeaf {
  readonly field: string;
  readonly operator: ConditionOperator;
  readonly value?: unknown;
}

/** AND/OR, nestable once — which is as deep as anybody edits without a visual builder. */
export interface ConditionGroup {
  readonly all?: readonly (ConditionLeaf | ConditionGroup)[];
  readonly any?: readonly (ConditionLeaf | ConditionGroup)[];
}

export interface WorkflowStep {
  /** Stable within the version, so a run can say which step it is on and be retried from it. */
  readonly id: string;
  readonly action: string;
  readonly params?: Readonly<Record<string, unknown>>;
  /** `branch` only. */
  readonly conditions?: ConditionGroup;
  readonly then?: readonly WorkflowStep[];
  readonly otherwise?: readonly WorkflowStep[];
}

export interface WorkflowDefinition {
  readonly trigger: { readonly type: string; readonly params?: Readonly<Record<string, unknown>> };
  readonly conditions?: ConditionGroup;
  readonly steps: readonly WorkflowStep[];
}

export function workflowTrigger(key: string): TriggerSpec | undefined {
  return WORKFLOW_TRIGGERS.find((spec) => spec.key === key);
}

export function workflowAction(key: string): ActionSpec | undefined {
  return WORKFLOW_ACTIONS.find((spec) => spec.key === key);
}

export function conditionField(key: string): ConditionFieldSpec | undefined {
  return CONDITION_FIELDS.find((spec) => spec.key === key);
}

/** One problem with a definition, in the shape the field-error contract uses. */
export interface DefinitionProblem {
  readonly field: string;
  readonly code: string;
  readonly message: string;
}

/** How deep a branch may nest, and how many steps a workflow may have. */
export const MAX_STEPS = 50;
export const MAX_BRANCH_DEPTH = 3;

/**
 * Checks a definition against the registry (`FR-AUT-8`).
 *
 * Pure, and in `@leados/shared` so the write path and the editor's preview agree. Every message is
 * written for the person editing: "there is no action called `send_sms`" is actionable and
 * "invalid definition" is not — which is the `ERROR_COPY` lesson applied before it costs anything.
 *
 * It deliberately does **not** check that a referenced id exists: that needs the workspace's rows,
 * which a pure function does not have, and the import's dry run already paid for the version of
 * this mistake where a schema was asked a question only the tenant's data could answer. The
 * service checks ids; this checks shape.
 */
export function validateWorkflowDefinition(definition: unknown): DefinitionProblem[] {
  const problems: DefinitionProblem[] = [];
  if (typeof definition !== 'object' || definition === null) {
    return [{ field: 'definition', code: 'NOT_AN_OBJECT', message: 'A workflow needs a definition.' }];
  }
  const value = definition as Partial<WorkflowDefinition>;

  const trigger = value.trigger;
  // An **empty** type is "nobody has chosen yet", which is the state a new workflow starts in —
  // not an unknown key. Reading it as unknown produced “There is nothing called “” that can start
  // a workflow”, which is the Zod-copy lesson in a hand-written sentence: a message written for
  // the machine's benefit, in front of the person who has not filled the field in yet.
  if (
    typeof trigger !== 'object' ||
    trigger === null ||
    typeof trigger.type !== 'string' ||
    trigger.type.trim() === ''
  ) {
    problems.push({
      field: 'definition.trigger',
      code: 'TRIGGER_MISSING',
      message: 'Choose what starts this workflow.',
    });
  } else {
    const spec = workflowTrigger(trigger.type);
    if (spec === undefined) {
      problems.push({
        field: 'definition.trigger.type',
        code: 'TRIGGER_UNKNOWN',
        message: `There is nothing called “${trigger.type}” that can start a workflow.`,
      });
    } else {
      problems.push(
        ...checkParams(spec.params, trigger.params ?? {}, 'definition.trigger.params'),
      );
    }
  }

  if (value.conditions !== undefined) {
    problems.push(...checkConditions(value.conditions, 'definition.conditions'));
  }

  const steps = value.steps;
  if (!Array.isArray(steps) || steps.length === 0) {
    problems.push({
      field: 'definition.steps',
      code: 'STEPS_MISSING',
      message: 'A workflow needs at least one step — otherwise it does nothing.',
    });
  } else {
    const seen = new Set<string>();
    problems.push(...checkSteps(steps, 'definition.steps', 1, seen));
    if (seen.size > MAX_STEPS) {
      problems.push({
        field: 'definition.steps',
        code: 'TOO_MANY_STEPS',
        message: `Up to ${MAX_STEPS} steps. A longer workflow is two workflows, and the second can be started from the first.`,
      });
    }
  }

  return problems;
}

function checkSteps(
  steps: readonly unknown[],
  path: string,
  depth: number,
  seen: Set<string>,
): DefinitionProblem[] {
  const problems: DefinitionProblem[] = [];
  steps.forEach((raw, index) => {
    const field = `${path}[${index}]`;
    if (typeof raw !== 'object' || raw === null) {
      problems.push({ field, code: 'STEP_NOT_AN_OBJECT', message: 'That step is not readable.' });
      return;
    }
    const step = raw as Partial<WorkflowStep>;
    if (typeof step.id !== 'string' || step.id.trim() === '') {
      problems.push({
        field: `${field}.id`,
        code: 'STEP_ID_MISSING',
        message: 'Every step needs an id, so a run can say where it got to.',
      });
    } else if (seen.has(step.id)) {
      // Two steps with one id makes "retry from the failed step" ambiguous, which is the whole
      // point of `FR-AUT-7`.
      problems.push({
        field: `${field}.id`,
        code: 'STEP_ID_DUPLICATE',
        message: `Two steps both have the id “${step.id}”.`,
      });
    } else {
      seen.add(step.id);
    }

    const spec = typeof step.action === 'string' ? workflowAction(step.action) : undefined;
    if (spec === undefined) {
      problems.push({
        field: `${field}.action`,
        code: 'ACTION_UNKNOWN',
        message:
          typeof step.action === 'string'
            ? `There is no action called “${step.action}”.`
            : 'That step does not say what to do.',
      });
      return;
    }
    problems.push(...checkParams(spec.params, step.params ?? {}, `${field}.params`));

    if (spec.key === 'branch') {
      if (step.conditions === undefined) {
        problems.push({
          field: `${field}.conditions`,
          code: 'BRANCH_NEEDS_CONDITIONS',
          message: 'An “If…” step needs something to decide on.',
        });
      } else {
        problems.push(...checkConditions(step.conditions, `${field}.conditions`));
      }
      if (depth >= MAX_BRANCH_DEPTH) {
        problems.push({
          field,
          code: 'BRANCH_TOO_DEEP',
          message: `Branches may nest ${MAX_BRANCH_DEPTH} deep. Beyond that nobody can read what a workflow does.`,
        });
      } else {
        // A path may legitimately be empty — "do nothing if they replied" is a real answer — so
        // this recurses without insisting either side has steps.
        if (Array.isArray(step.then)) {
          problems.push(...checkSteps(step.then, `${field}.then`, depth + 1, seen));
        }
        if (Array.isArray(step.otherwise)) {
          problems.push(...checkSteps(step.otherwise, `${field}.otherwise`, depth + 1, seen));
        }
      }
    } else if (step.then !== undefined || step.otherwise !== undefined) {
      problems.push({
        field,
        code: 'NOT_A_BRANCH',
        message: `“${spec.label}” is not an “If…”, so it cannot have two paths.`,
      });
    }
  });
  return problems;
}

function checkParams(
  fields: readonly ParamField[],
  params: Readonly<Record<string, unknown>>,
  path: string,
): DefinitionProblem[] {
  const problems: DefinitionProblem[] = [];
  for (const field of fields) {
    const value = params[field.key];
    const absent = value === undefined || value === null || value === '';
    if (field.required && absent) {
      problems.push({
        field: `${path}.${field.key}`,
        code: 'PARAM_REQUIRED',
        message: `“${field.label}” is needed.`,
      });
      continue;
    }
    if (absent) continue;

    if (field.type === 'number' || field.type === 'duration') {
      // `Number(null)` is 0 and `Number('')` is 0, and 0 is meaningful here — a wait of zero
      // minutes, a task due now. So this refuses what `Number()` accepts rather than reusing it.
      const numeric = typeof value === 'number' ? value : Number.NaN;
      if (!Number.isFinite(numeric) || !Number.isInteger(numeric)) {
        problems.push({
          field: `${path}.${field.key}`,
          code: 'PARAM_NOT_A_NUMBER',
          message: `“${field.label}” has to be a whole number.`,
        });
      } else if (field.min !== undefined && numeric < field.min) {
        problems.push({
          field: `${path}.${field.key}`,
          code: 'PARAM_TOO_SMALL',
          message: `“${field.label}” has to be at least ${field.min}.`,
        });
      } else if (field.max !== undefined && numeric > field.max) {
        problems.push({
          field: `${path}.${field.key}`,
          code: 'PARAM_TOO_LARGE',
          message: `“${field.label}” can be at most ${field.max}.`,
        });
      }
    } else if (field.type === 'boolean') {
      if (typeof value !== 'boolean') {
        problems.push({
          field: `${path}.${field.key}`,
          code: 'PARAM_NOT_A_BOOLEAN',
          message: `“${field.label}” is a yes or a no.`,
        });
      }
    } else if (field.type === 'select') {
      const allowed = (field.options ?? []).map((option) => option.value);
      if (typeof value !== 'string' || !allowed.includes(value)) {
        problems.push({
          field: `${path}.${field.key}`,
          code: 'PARAM_NOT_AN_OPTION',
          message: `“${field.label}” has to be one of: ${allowed.join(', ')}.`,
        });
      }
    } else if (typeof value !== 'string') {
      problems.push({
        field: `${path}.${field.key}`,
        code: 'PARAM_NOT_TEXT',
        message: `“${field.label}” has to be text.`,
      });
    } else if (field.max !== undefined && value.length > field.max) {
      problems.push({
        field: `${path}.${field.key}`,
        code: 'PARAM_TOO_LONG',
        message: `“${field.label}” can be up to ${field.max} characters.`,
      });
    }
  }

  // A parameter the registry does not know is almost always a typo or a stale editor, and
  // accepting it silently means a workflow that looks configured and is not.
  const known = new Set(fields.map((field) => field.key));
  for (const key of Object.keys(params)) {
    if (!known.has(key)) {
      problems.push({
        field: `${path}.${key}`,
        code: 'PARAM_UNKNOWN',
        message: `“${key}” is not something this step takes.`,
      });
    }
  }
  return problems;
}

function checkConditions(group: unknown, path: string): DefinitionProblem[] {
  if (typeof group !== 'object' || group === null) {
    return [{ field: path, code: 'CONDITIONS_NOT_AN_OBJECT', message: 'That condition is not readable.' }];
  }
  const value = group as ConditionGroup;
  const branches = [
    ...(Array.isArray(value.all) ? [['all', value.all] as const] : []),
    ...(Array.isArray(value.any) ? [['any', value.any] as const] : []),
  ];
  if (branches.length === 0) {
    return [
      {
        field: path,
        code: 'CONDITIONS_EMPTY',
        message: 'A condition needs at least one test — use “all” or “any”.',
      },
    ];
  }
  const problems: DefinitionProblem[] = [];
  for (const [key, entries] of branches) {
    entries.forEach((entry, index) => {
      const field = `${path}.${key}[${index}]`;
      if (typeof entry !== 'object' || entry === null) {
        problems.push({ field, code: 'CONDITION_NOT_AN_OBJECT', message: 'That test is not readable.' });
        return;
      }
      if ('all' in entry || 'any' in entry) {
        problems.push(...checkConditions(entry, field));
        return;
      }
      const leaf = entry as ConditionLeaf;
      const spec = conditionField(leaf.field);
      if (spec === undefined) {
        problems.push({
          field: `${field}.field`,
          code: 'CONDITION_FIELD_UNKNOWN',
          message: `There is nothing called “${String(leaf.field)}” to test.`,
        });
        return;
      }
      if (!spec.operators.includes(leaf.operator)) {
        problems.push({
          field: `${field}.operator`,
          code: 'CONDITION_OPERATOR_UNSUPPORTED',
          message: `“${spec.label}” cannot be tested with “${String(leaf.operator)}”.`,
        });
        return;
      }
      const takesValue = !VALUELESS_OPERATORS.includes(leaf.operator);
      const hasValue = leaf.value !== undefined && leaf.value !== null && leaf.value !== '';
      if (takesValue && !hasValue) {
        problems.push({
          field: `${field}.value`,
          code: 'CONDITION_VALUE_MISSING',
          message: `“${spec.label} ${leaf.operator.replace(/_/g, ' ')}” needs something to compare with.`,
        });
      }
      if (!takesValue && hasValue) {
        // Saved with a value it will never read: the editor changed operator and left the box
        // filled, and a workflow that looks configured and is not is the thing to refuse.
        problems.push({
          field: `${field}.value`,
          code: 'CONDITION_VALUE_IGNORED',
          message: `“${leaf.operator.replace(/_/g, ' ')}” takes no value — clear the box.`,
        });
      }
    });
  }
  return problems;
}

/** Every reference kind a definition actually names, for the service that checks the ids exist. */
export function referencesIn(definition: WorkflowDefinition): {
  kind: ReferenceKind;
  id: string;
  field: string;
}[] {
  const found: { kind: ReferenceKind; id: string; field: string }[] = [];
  const fromParams = (
    fields: readonly ParamField[],
    params: Readonly<Record<string, unknown>> | undefined,
    path: string,
  ) => {
    for (const field of fields) {
      if (field.type !== 'reference' || field.reference === undefined) continue;
      const value = params?.[field.key];
      if (typeof value === 'string' && value !== '') {
        found.push({ kind: field.reference, id: value, field: `${path}.${field.key}` });
      }
    }
  };
  const trigger = workflowTrigger(definition.trigger.type);
  if (trigger) fromParams(trigger.params, definition.trigger.params, 'definition.trigger.params');

  const walk = (steps: readonly WorkflowStep[], path: string) => {
    steps.forEach((step, index) => {
      const spec = workflowAction(step.action);
      if (spec) fromParams(spec.params, step.params, `${path}[${index}].params`);
      if (step.then) walk(step.then, `${path}[${index}].then`);
      if (step.otherwise) walk(step.otherwise, `${path}[${index}].otherwise`);
    });
  };
  walk(definition.steps, 'definition.steps');
  return found;
}

/** A workflow's own lifecycle. A published version is what a run pins to (`FR-AUT-5`). */
export const WORKFLOW_STATUSES = ['draft', 'active', 'paused', 'archived'] as const;
export type WorkflowStatus = (typeof WORKFLOW_STATUSES)[number];

/**
 * What happens when a lead that has already been through a workflow triggers it again
 * (`FR-AUT-6`).
 *
 * `once` is the default because it is the safe one: the commonest automation anybody writes sends
 * a message, and a lead whose status moves back and forth would otherwise receive it each time.
 */
export const REENTRY_POLICIES = ['once', 'cooldown', 'always'] as const;
export type ReentryPolicy = (typeof REENTRY_POLICIES)[number];

/** Why a workflow cannot be published, or null. */
export function publishProblem(input: {
  readonly status: WorkflowStatus;
  readonly problems: readonly DefinitionProblem[];
}): string | null {
  if (input.status === 'archived') {
    return 'That workflow is archived. Copy it if you want to run it again.';
  }
  if (input.problems.length > 0) {
    return 'There are details to correct before this can be published.';
  }
  return null;
}
