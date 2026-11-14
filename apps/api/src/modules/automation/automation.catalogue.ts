import {
  CONDITION_FIELDS,
  CONDITION_OPERATORS,
  MAX_BRANCH_DEPTH,
  MAX_STEPS,
  REENTRY_POLICIES,
  REFERENCE_KINDS,
  VALUELESS_OPERATORS,
  WORKFLOW_ACTIONS,
  WORKFLOW_STATUSES,
  WORKFLOW_TRIGGERS,
  type ReferenceKind,
} from '@leados/shared';

/**
 * Where the editor fetches each reference kind's list (`FR-AUT-1`).
 *
 * A parameter whose value is a row in this workspace declares `reference: 'lead_status'` and
 * nothing more — rule 4, because naming a workspace's statuses in the registry would be the
 * hardcoding this product does not do. But a declaration the screen cannot act on is half a
 * feature: the picker would render and be empty, which looks exactly like a workspace with no
 * statuses. So the kind and the endpoint behind it are declared **together**, the same reasoning
 * as `frontend-architecture.md` §5.4's "a number and the link behind it belong in one
 * definition" — and `automation.e2e-spec.ts` calls every path in this table, because a source
 * that 404s is a picker nobody can fill in.
 *
 * It lives here rather than in `@leados/shared` because these are this API's paths: the registry
 * is a vocabulary both halves share, and a route table is not.
 */
export const REFERENCE_SOURCES: Readonly<Record<ReferenceKind, string>> = {
  user: '/users',
  team: '/teams',
  lead_status: '/crm/statuses',
  pipeline: '/crm/pipelines',
  /** Stages arrive inside their pipeline: a stage picker is a pipeline picker one level down. */
  pipeline_stage: '/crm/pipelines',
  task_type: '/settings/task-types',
  lead_source: '/crm/sources',
  whatsapp_template: '/whatsapp/templates',
  workflow: '/automation/workflows',
  webhook_endpoint: '/webhooks',
  /**
   * Added for the website block registry's `form` block. The kind and its endpoint travel together
   * because a declaration a screen cannot act on is half a feature: a picker with no list behind it
   * renders empty, which looks exactly like a workspace with no forms.
   */
  form: '/forms',
};

/**
 * The whole registry, as one response.
 *
 * This is what makes Phase 6's first exit criterion checkable: the editor renders inputs from
 * `params`, the write path validates against the same `params`, and adding an action is an entry
 * in `WORKFLOW_ACTIONS` plus a handler in step 2's executor — no engine change in the editor, and
 * no frontend release.
 */
export function automationCatalogue() {
  return {
    triggers: WORKFLOW_TRIGGERS,
    conditionFields: CONDITION_FIELDS,
    actions: WORKFLOW_ACTIONS,
    operators: CONDITION_OPERATORS,
    valuelessOperators: VALUELESS_OPERATORS,
    references: REFERENCE_KINDS.map((kind) => ({ kind, source: REFERENCE_SOURCES[kind] })),
    statuses: WORKFLOW_STATUSES,
    reentryPolicies: REENTRY_POLICIES,
    limits: { maxSteps: MAX_STEPS, maxBranchDepth: MAX_BRANCH_DEPTH },
  };
}
