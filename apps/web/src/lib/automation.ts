import { request } from '@/lib/api';

/**
 * Automation, on the web side (`FR-AUT-1`).
 *
 * This file is deliberately **short on vocabulary**, and that is the point of the whole step.
 * `webhooks.ts`, `tasks.ts` and `forms.ts` each hand-write a copy of a list that lives in
 * `@leados/shared` — they have to, because that package's entry point reaches
 * `node:async_hooks` and a client component importing it fails `next build` — and each pays for
 * it with a spec that reconciles the two copies.
 *
 * There is nothing to reconcile here. The triggers, the conditions, the actions and every
 * parameter they take arrive from `GET /automation/catalogue` as **data**, so the editor renders
 * what the API declares and a new action needs no change to this file, no new component and no
 * release of the web app. The types below describe the shape of that declaration; they name no
 * trigger and no action, which is what makes the claim checkable rather than merely stated.
 */

export interface ParamOption {
  readonly value: string;
  readonly label: string;
}

export interface ParamField {
  readonly key: string;
  readonly label: string;
  readonly hint?: string;
  readonly type: 'text' | 'textarea' | 'number' | 'boolean' | 'select' | 'duration' | 'reference';
  readonly required: boolean;
  readonly options?: readonly ParamOption[];
  readonly reference?: string;
  readonly min?: number;
  readonly max?: number;
}

export interface TriggerSpec {
  readonly key: string;
  readonly label: string;
  readonly hint: string;
  readonly group: string;
  readonly event: string | null;
  readonly params: readonly ParamField[];
}

export interface ActionSpec {
  readonly key: string;
  readonly label: string;
  readonly hint: string;
  readonly group: string;
  readonly control: boolean;
  readonly params: readonly ParamField[];
}

export interface ConditionFieldSpec {
  readonly key: string;
  readonly label: string;
  readonly group: string;
  readonly operators: readonly string[];
  readonly type: ParamField['type'];
  readonly reference?: string;
  readonly options?: readonly ParamOption[];
}

export interface AutomationCatalogue {
  readonly triggers: readonly TriggerSpec[];
  readonly actions: readonly ActionSpec[];
  readonly conditionFields: readonly ConditionFieldSpec[];
  readonly operators: readonly string[];
  readonly valuelessOperators: readonly string[];
  readonly references: readonly { readonly kind: string; readonly source: string }[];
  readonly statuses: readonly string[];
  readonly reentryPolicies: readonly string[];
  readonly limits: { readonly maxSteps: number; readonly maxBranchDepth: number };
}

export interface DefinitionProblem {
  readonly field: string;
  readonly code: string;
  readonly message: string;
}

export interface WorkflowStep {
  readonly id: string;
  readonly action: string;
  readonly params?: Record<string, unknown>;
  readonly then?: readonly WorkflowStep[];
  readonly otherwise?: readonly WorkflowStep[];
}

export interface WorkflowDefinition {
  readonly trigger: { readonly type: string; readonly params?: Record<string, unknown> };
  readonly steps: readonly WorkflowStep[];
}

export interface WorkflowVersionSummary {
  readonly id: string;
  readonly version: number;
  readonly isDraft: boolean;
  readonly publishedAt: string | null;
  readonly createdAt: string;
}

export interface WorkflowVersion extends WorkflowVersionSummary {
  readonly definition: WorkflowDefinition;
}

export interface WorkflowSummary {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly status: string;
  readonly killSwitch: boolean;
  readonly currentVersionId: string | null;
  readonly reentryPolicy: string;
  readonly cooldownHours: number | null;
  readonly maxRunsPerEntity: number | null;
  readonly updatedAt: string;
  readonly trigger: { readonly type: string; readonly event: string | null } | null;
}

export interface WorkflowRecord extends WorkflowSummary {
  readonly draft: WorkflowVersion | null;
  readonly current: WorkflowVersion | null;
  readonly problems: readonly DefinitionProblem[];
  readonly publishBlockedReason: string | null;
  readonly versions: readonly WorkflowVersionSummary[];
}

/** The lists a `reference` parameter needs, fetched once and handed to every picker. */
export interface ReferenceLists {
  readonly [kind: string]: readonly ParamOption[];
}

export async function loadCatalogue(
  token: string | null | undefined,
): Promise<AutomationCatalogue> {
  const response = await request<AutomationCatalogue>('/automation/catalogue', { token });
  return response.data;
}

export async function loadWorkflows(
  token: string | null | undefined,
  query = '?limit=50',
): Promise<{ items: WorkflowSummary[]; total: number }> {
  const response = await request<WorkflowSummary[]>(`/automation/workflows${query}`, { token });
  const pagination = response.meta?.pagination as { total?: number } | undefined;
  return { items: response.data, total: pagination?.total ?? response.data.length };
}

export async function loadWorkflow(
  token: string | null | undefined,
  id: string,
): Promise<WorkflowRecord> {
  const response = await request<WorkflowRecord>(`/automation/workflows/${id}`, { token });
  return response.data;
}

/**
 * What each status means, in the words of somebody running a business.
 *
 * `draft` and `paused` are the pair worth distinguishing on a screen: one has never run, the other
 * has and was stopped, and "inactive" for both is how somebody switches off the wrong one.
 */
export const STATUS_LABELS: Record<string, string> = {
  draft: 'Draft',
  active: 'Running',
  paused: 'Paused',
  archived: 'Archived',
};

export const STATUS_TONES: Record<string, 'neutral' | 'success' | 'warning' | 'danger'> = {
  draft: 'neutral',
  active: 'success',
  paused: 'warning',
  archived: 'danger',
};

export const REENTRY_LABELS: Record<string, string> = {
  once: 'Once per lead',
  cooldown: 'Again after a wait',
  always: 'Every time',
};

/** A sentence for the list: what starts this, and whether anything will. */
export function describeWorkflow(
  workflow: WorkflowSummary,
  catalogue: AutomationCatalogue,
): string {
  if (workflow.killSwitch) return 'Stopped — nothing will run until it is started again';
  if (workflow.currentVersionId === null) return 'Not published yet, so nothing runs';
  const spec = catalogue.triggers.find((entry) => entry.key === workflow.trigger?.type);
  const start = spec?.label ?? workflow.trigger?.type ?? 'Nothing';
  if (workflow.status === 'paused') return `Paused. Would run when: ${start.toLowerCase()}`;
  if (workflow.status === 'archived') return 'Archived';
  return `Runs when: ${start.toLowerCase()}`;
}

/**
 * The problems that belong to one field, keyed by the path the API used.
 *
 * The mapping editor paid for the version of this where only the summary message reached the
 * screen: "two fields both write to phone" is the sentence somebody can act on, and printing it
 * against the row it names is the whole difference.
 */
export function problemsAt(
  problems: readonly DefinitionProblem[],
  field: string,
): DefinitionProblem[] {
  return problems.filter((problem) => problem.field === field);
}

/** The value an unfilled parameter starts at, by type. */
export function paramDefault(field: ParamField): unknown {
  switch (field.type) {
    case 'boolean':
      return false;
    case 'number':
    case 'duration':
      return field.min ?? 0;
    default:
      return '';
  }
}

/**
 * One parameter, read back out of a form control.
 *
 * `Number('')` is 0, and 0 is a meaningful duration — "remind me at the due moment" — so an empty
 * box is `undefined` and never a zero somebody did not type. A coercion used on untrusted input
 * has to refuse what `Number()` accepts rather than reuse it.
 */
export function coerceParam(field: ParamField, raw: string | boolean): unknown {
  if (field.type === 'boolean') return raw === true || raw === 'true';
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  if (trimmed === '') return undefined;
  if (field.type === 'number' || field.type === 'duration') {
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return trimmed;
}

/** A step the editor can add: the action's key, and every parameter at its default. */
export function blankStep(spec: ActionSpec, index: number): WorkflowStep {
  const params: Record<string, unknown> = {};
  for (const field of spec.params) params[field.key] = paramDefault(field);
  return { id: `${spec.key.replace(/[^a-z0-9]+/g, '-')}-${index}`, action: spec.key, params };
}

/**
 * Drops the parameters nobody filled in, so a definition carries values rather than blanks.
 *
 * Without it an untouched optional text box is saved as `''`, which the validator reads as "a
 * value of the wrong kind" rather than as "not set" — a refusal on a field the person never
 * touched, which reads as the product being broken.
 */
export function cleanDefinition(definition: WorkflowDefinition): WorkflowDefinition {
  const clean = (params: Record<string, unknown> | undefined) => {
    const kept: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(params ?? {})) {
      if (value === '' || value === undefined || value === null) continue;
      kept[key] = value;
    }
    return kept;
  };
  return {
    trigger: { type: definition.trigger.type, params: clean(definition.trigger.params) },
    steps: definition.steps.map((step) => ({
      id: step.id,
      action: step.action,
      params: clean(step.params),
      ...(step.then ? { then: step.then } : {}),
      ...(step.otherwise ? { otherwise: step.otherwise } : {}),
    })),
  };
}

/**
 * How a row of each reference kind reads in a picker.
 *
 * This is the **one** thing the catalogue cannot declare: the endpoint it names answers that
 * kind's own shape, and "which field is the name" is a fact about `/users` rather than about
 * automation. So adding an **action** needs nothing here — which is the exit criterion — while a
 * brand-new *kind* of row needs one line, and the catalogue's `source` is what keeps it to one.
 *
 * `automation.spec.ts` runs in Node, imports `@leados/shared`, and asserts this map covers every
 * kind the registry declares: a kind with no label function is a picker that renders ids.
 */
export const REFERENCE_LABELS: Record<
  string,
  (row: Record<string, unknown>) => ParamOption | null
> = {
  // A person-reference in this product is a membership's **user** id, which is what every
  // assignment column stores — not the membership's own id.
  user: (row) => option(row['userId'], row['name'] ?? row['email']),
  team: (row) => option(row['id'], row['name']),
  lead_status: (row) => option(row['id'], row['name']),
  pipeline: (row) => option(row['id'], row['name']),
  pipeline_stage: () => null,
  task_type: (row) => option(row['id'], row['name']),
  lead_source: (row) => option(row['id'], row['name']),
  whatsapp_template: (row) =>
    option(row['id'], `${String(row['name'])} · ${String(row['status'])}`),
  workflow: (row) => option(row['id'], row['name']),
  webhook_endpoint: (row) => option(row['id'], row['url']),
};

function option(value: unknown, label: unknown): ParamOption | null {
  if (typeof value !== 'string' || value === '') return null;
  return { value, label: typeof label === 'string' && label !== '' ? label : value };
}

/**
 * Every list a picker might need, fetched from the sources the catalogue named.
 *
 * Stages are the one kind that is not its own list: they arrive inside their pipeline, so a stage
 * picker is a pipeline picker one level down, and the option's label carries the pipeline's name
 * because two pipelines may each have a "Negotiation".
 *
 * A source that fails does not fail the page: a workspace with no WhatsApp connection has no
 * templates, and a picker that says "nothing to choose from yet" is the truth. What it must never
 * do is swallow the whole screen — which is why the catalogue and the workflow itself are loaded
 * by throwing loaders and these are not.
 */
export async function loadReferenceLists(
  token: string | null | undefined,
  catalogue: AutomationCatalogue,
): Promise<ReferenceLists> {
  const lists: Record<string, ParamOption[]> = {};
  await Promise.all(
    catalogue.references.map(async ({ kind, source }) => {
      try {
        const response = await request<Record<string, unknown>[]>(source, { token });
        const rows = Array.isArray(response.data) ? response.data : [];
        if (kind === 'pipeline_stage') {
          lists[kind] = rows.flatMap((pipeline) => {
            const stages = pipeline['stages'];
            if (!Array.isArray(stages)) return [];
            return stages.flatMap((stage: Record<string, unknown>) => {
              const entry = option(
                stage['id'],
                `${String(pipeline['name'])} → ${String(stage['name'])}`,
              );
              return entry === null ? [] : [entry];
            });
          });
          return;
        }
        const label = REFERENCE_LABELS[kind];
        if (label === undefined) {
          lists[kind] = [];
          return;
        }
        lists[kind] = rows.flatMap((row) => {
          const entry = label(row);
          return entry === null ? [] : [entry];
        });
      } catch {
        lists[kind] = [];
      }
    }),
  );
  return lists;
}

// ── What the engine did (`FR-AUT-7`) ─────────────────────────────────────────

export interface RunStep {
  readonly id: string;
  readonly stepId: string;
  readonly action: string;
  readonly attempt: number;
  readonly status: string;
  readonly decision: string | null;
  readonly reason: string | null;
  readonly error: string | null;
  readonly startedAt: string;
  readonly finishedAt: string | null;
}

export interface RunSummary {
  readonly id: string;
  /**
   * Present on the list as well as the detail.
   *
   * It was optional at first and the list did not send it, so both screens rendered a run row with
   * no steps behind it — on the panels whose whole job is "why". Required here is what makes that
   * a type error rather than an empty disclosure.
   */
  readonly steps: readonly RunStep[];
  readonly status: string;
  readonly trigger: string;
  readonly workflow: { readonly id: string; readonly name: string };
  readonly lead: { readonly id: string; readonly fullName: string };
  /**
   * Null for a **preview**, which is enrolled in nothing — that is what "executes nothing" means.
   * Nullable here rather than defaulted to 1, because "this is the lead's second time through"
   * and "this never counted" are different facts and a 1 would state the first of them falsely.
   */
  readonly cycle: number | null;
  readonly dryRun: boolean;
  readonly version: number;
  readonly currentStepId: string | null;
  readonly resumeAt: string | null;
  readonly stepsRun: number;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly error: string | null;
}

export interface RunRecord extends RunSummary {
  readonly exitReason: string | null;
}

export const RUN_STATUS_LABELS: Record<string, string> = {
  running: 'Running',
  waiting: 'Waiting',
  completed: 'Finished',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

export const RUN_STATUS_TONES: Record<string, 'neutral' | 'success' | 'warning' | 'danger'> = {
  running: 'neutral',
  waiting: 'warning',
  completed: 'success',
  failed: 'danger',
  cancelled: 'neutral',
};

export const STEP_STATUS_TONES: Record<string, 'neutral' | 'success' | 'warning' | 'danger'> = {
  pending: 'neutral',
  succeeded: 'success',
  skipped: 'warning',
  failed: 'danger',
};

export async function loadRuns(
  token: string | null | undefined,
  query: string,
): Promise<{ items: RunSummary[]; total: number }> {
  const response = await request<RunSummary[]>(`/automation/runs${query}`, { token });
  const pagination = response.meta?.pagination as { total?: number } | undefined;
  return { items: response.data, total: pagination?.total ?? response.data.length };
}

/**
 * The leads a preview can be run against.
 *
 * A short list rather than a search box: the dry run is a thing somebody does once or twice while
 * writing a workflow, against a lead they can see. There is no `reference: 'lead'` kind in the
 * catalogue on purpose — a lead is the run's **subject**, not a parameter of a step, and declaring
 * it as a reference would offer it inside every action's parameter list.
 */
export async function loadLeadChoices(
  token: string | null | undefined,
  limit = 25,
): Promise<ParamOption[]> {
  try {
    const response = await request<{ id: string; fullName: string }[]>(`/leads?limit=${limit}`, {
      token,
    });
    const rows = Array.isArray(response.data) ? response.data : [];
    return rows.flatMap((row) => {
      const entry = option(row.id, row.fullName);
      return entry === null ? [] : [entry];
    });
  } catch {
    // A workspace with no leads yet, or a caller whose scope excludes them all: the form says so
    // itself rather than the page failing to render.
    return [];
  }
}

export async function loadRun(token: string | null | undefined, id: string): Promise<RunRecord> {
  const response = await request<RunRecord>(`/automation/runs/${id}`, { token });
  return response.data;
}

/**
 * What a step did, in the words of the business rather than the registry's key.
 *
 * The engine's own `reason` is preferred when there is one — "sent the template “Site visit”",
 * "nobody owns this lead, so there was nobody to tell" — because a row reading `send_whatsapp_template`
 * and `skipped` makes somebody ask the two questions this screen exists to answer. The action key
 * is still shown beside it, for whoever is debugging rather than reading.
 */
export function describeStep(step: RunStep, catalogue: AutomationCatalogue | null): string {
  const spec = catalogue?.actions.find((entry) => entry.key === step.action);
  const name = spec?.label ?? step.action;
  if (step.status === 'failed') return `${name} — failed: ${step.error ?? 'no reason recorded'}`;
  if (step.status === 'skipped') return `${name} — skipped: ${step.reason ?? 'no reason recorded'}`;
  if (step.decision !== null)
    return `${name} — took the “${step.decision}” path: ${step.reason ?? ''}`.trim();
  return step.reason === null ? name : `${name} — ${step.reason}`;
}

/** A sentence for a run's own state, which is the first thing somebody reads. */
export function describeRun(run: RunSummary): string {
  // A preview says so **first**. Every sentence below reads as something that happened to this
  // customer, and the one thing a preview must never be mistaken for is a thing that happened.
  const prefix = run.dryRun ? 'Preview — nothing was sent. ' : '';
  return prefix + runState(run);
}

function runState(run: RunSummary): string {
  switch (run.status) {
    case 'waiting':
      return run.resumeAt === null
        ? 'Waiting.'
        : `Waiting until ${new Date(run.resumeAt).toLocaleString()}.`;
    case 'failed':
      return `Failed: ${run.error ?? 'no reason recorded'}.`;
    case 'running':
      return `Running — ${run.stepsRun} ${run.stepsRun === 1 ? 'step' : 'steps'} so far.`;
    case 'cancelled':
      return 'Cancelled.';
    default:
      return `Finished after ${run.stepsRun} ${run.stepsRun === 1 ? 'step' : 'steps'}.`;
  }
}
