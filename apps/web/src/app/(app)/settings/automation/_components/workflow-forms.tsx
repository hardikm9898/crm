'use client';

import { useActionState, useState } from 'react';
import Link from 'next/link';
import { Button, ErrorNotice, Field, controlClassName } from '@/components/ui';
import { IDLE } from '@/lib/action-state';
import type { ParamOption, WorkflowSummary } from '@/lib/automation';
import {
  createWorkflow,
  deleteWorkflow,
  publishWorkflow,
  retryRun,
  testWorkflow,
  updateWorkflow,
} from '../actions';

/** A workflow starts as a name and nothing else; the graph is the next screen. */
export function NewWorkflowForm() {
  const [state, submit, pending] = useActionState(createWorkflow, IDLE);
  const echoed = state.status === 'error' ? state.values : undefined;
  return (
    <form action={submit} className="flex flex-wrap items-end gap-3" data-new-workflow>
      {state.status === 'error' && <ErrorNotice>{state.message}</ErrorNotice>}
      <div className="min-w-56 flex-1">
        <Field
          label="What should it be called?"
          hint="Something you will recognise in a list: “Call back a new website lead”."
          error={state.status === 'error' ? state.fieldErrors?.['name'] : undefined}
        >
          <input
            name="name"
            defaultValue={echoed?.['name'] ?? ''}
            required
            minLength={2}
            maxLength={120}
            className={`${controlClassName} w-full min-w-0`}
          />
        </Field>
      </div>
      <Button type="submit" pending={pending}>
        {pending ? 'Creating…' : 'Create a draft'}
      </Button>
    </form>
  );
}

/**
 * The three things somebody does to a workflow from the list.
 *
 * `status` is sent as a hidden value per button rather than as a select, because each of these is
 * one decision with one name — "Pause" and "Start" are the sentence, and a dropdown reading
 * "paused / active" is the schema's vocabulary on a screen.
 */
export function WorkflowRowActions({ workflow }: { workflow: WorkflowSummary }) {
  const [state, submit, pending] = useActionState(updateWorkflow, IDLE);
  const [stopState, stop, stopping] = useActionState(updateWorkflow, IDLE);
  const [removeState, remove, removing] = useActionState(deleteWorkflow, IDLE);
  const canRun = workflow.currentVersionId !== null;

  return (
    <div className="flex flex-col items-start gap-1" data-workflow-actions={workflow.id}>
      <div className="flex flex-wrap items-center gap-2">
        <Link href={`/settings/automation/${workflow.id}`} className="text-sm underline">
          Open
        </Link>
        {canRun && workflow.status !== 'archived' && (
          <form action={submit}>
            <input type="hidden" name="workflowId" value={workflow.id} />
            <input
              type="hidden"
              name="status"
              value={workflow.status === 'active' ? 'paused' : 'active'}
            />
            <Button type="submit" variant="secondary" pending={pending}>
              {workflow.status === 'active' ? 'Pause' : 'Start'}
            </Button>
          </form>
        )}
        {workflow.status !== 'archived' && (
          <form action={stop}>
            <input type="hidden" name="workflowId" value={workflow.id} />
            <input type="hidden" name="killSwitch" value={workflow.killSwitch ? 'false' : 'true'} />
            <Button type="submit" variant={workflow.killSwitch ? 'secondary' : 'danger'} pending={stopping}>
              {workflow.killSwitch ? 'Clear the stop' : 'Stop everything'}
            </Button>
          </form>
        )}
        <form action={remove}>
          <input type="hidden" name="workflowId" value={workflow.id} />
          <Button type="submit" variant="quiet" pending={removing}>
            Delete
          </Button>
        </form>
      </div>
      {[state, stopState, removeState].map((entry, index) =>
        entry.status === 'error' ? (
          <span key={index} className="text-xs text-[var(--color-danger)]" data-workflow-error>
            {entry.message}
          </span>
        ) : null,
      )}
    </div>
  );
}

/** Publishing, which is the only button on this screen whose refusal is a list of fields. */
export function PublishButton({
  workflowId,
  blockedReason,
  hasDraft,
}: {
  workflowId: string;
  blockedReason: string | null;
  hasDraft: boolean;
}) {
  const [state, submit, pending] = useActionState(publishWorkflow, IDLE);
  return (
    <form action={submit} className="flex flex-col gap-1" data-publish={workflowId}>
      <input type="hidden" name="workflowId" value={workflowId} />
      <div>
        <Button type="submit" pending={pending} disabled={blockedReason !== null || !hasDraft}>
          {pending ? 'Publishing…' : 'Publish'}
        </Button>
      </div>
      {/* The API's own sentence, never a paraphrase: "There are details to correct before this can
          be published" is what it says, and a copy table that replaced it with "Not allowed"
          cost this codebase a product-wide dead end. */}
      {blockedReason !== null && (
        <span className="text-xs text-[var(--color-text-muted)]" data-publish-blocked>
          {blockedReason}
        </span>
      )}
      {state.status === 'error' && <ErrorNotice>{state.message}</ErrorNotice>}
      {state.status === 'success' && (
        <span className="text-xs text-[var(--color-success)]" data-publish-result>
          {state.message}
        </span>
      )}
    </form>
  );
}

/**
 * The guardrails (`FR-AUT-6`), which the executor will read and this screen already writes.
 *
 * The policy select is the one on this screen that **has** to be reactive, because the rest of the
 * form depends on it: choosing "Again after a wait" has to reveal the hours box. The first draft
 * reused the agent-picker shape — `key` + `defaultValue`, uncontrolled — and the box never
 * appeared, so somebody chose a cooldown, saved, and got "Say how long to wait before a lead can
 * enter again" with nowhere to say it. Found by the browser check.
 *
 * So the value is held in state, seeded from the echo, and reset in render when a refusal echoes a
 * different one — React's own "adjusting state when a prop changes". The select keeps its `key` so
 * it remounts with the echoed default rather than keeping a stale `selectedIndex`.
 */
export function GuardrailsForm({ workflow }: { workflow: WorkflowSummary }) {
  const [state, submit, pending] = useActionState(updateWorkflow, IDLE);
  const echoed = state.status === 'error' ? state.values : undefined;
  const echoedPolicy = echoed?.['reentryPolicy'] ?? workflow.reentryPolicy;
  const [policy, setPolicy] = useState(echoedPolicy);
  const [seenPolicy, setSeenPolicy] = useState(echoedPolicy);
  if (seenPolicy !== echoedPolicy) {
    setSeenPolicy(echoedPolicy);
    setPolicy(echoedPolicy);
  }
  return (
    <form action={submit} className="flex flex-wrap items-end gap-3" data-guardrails={workflow.id}>
      <input type="hidden" name="workflowId" value={workflow.id} />
      <Field label="How often may one lead go through this?">
        {/* `key` + `defaultValue`, not `value`: a <select> does not come back from a refused
            submission through `defaultValue` alone, and a controlled `value` lost the choice
            because React re-created the options in the same commit. */}
        <select
          name="reentryPolicy"
          key={`reentry-${echoedPolicy}`}
          defaultValue={echoedPolicy}
          onChange={(event) => setPolicy(event.target.value)}
          className={controlClassName}
          data-reentry-policy
        >
          <option value="once">Once, ever</option>
          <option value="cooldown">Again after a wait</option>
          <option value="always">Every time it triggers</option>
        </select>
      </Field>
      {policy === 'cooldown' && (
        <Field
          label="Wait how many hours?"
          error={state.status === 'error' ? state.fieldErrors?.['cooldownHours'] : undefined}
        >
          <input
            name="cooldownHours"
            type="number"
            min={1}
            defaultValue={echoed?.['cooldownHours'] ?? workflow.cooldownHours ?? 24}
            className={`${controlClassName} w-28`}
          />
        </Field>
      )}
      <Field label="At most, per lead" hint="Leave empty for no cap.">
        <input
          name="maxRunsPerEntity"
          type="number"
          min={1}
          defaultValue={echoed?.['maxRunsPerEntity'] ?? workflow.maxRunsPerEntity ?? ''}
          className={`${controlClassName} w-28`}
        />
      </Field>
      <Button type="submit" variant="secondary" pending={pending}>
        {pending ? 'Saving…' : 'Save limits'}
      </Button>
      {state.status === 'error' && <ErrorNotice>{state.message}</ErrorNotice>}
      {state.status === 'success' && (
        <span className="text-xs text-[var(--color-success)]" data-guardrails-result>
          {state.message}
        </span>
      )}
    </form>
  );
}

/**
 * The dry run (`FR-AUT-6`): pick a lead, see what this would do, send nothing.
 *
 * The lead picker is held in state rather than left uncontrolled, because the **button's own
 * sentence** depends on it — "Test it on Asha Rao" is the confirmation that somebody is about to
 * preview against the lead they meant, which "Test it" is not. That is the `GuardrailsForm` rule
 * rather than the payment-method one: a select the rest of the form reads has to be reactive.
 */
export function TestRunForm({
  workflowId,
  leads,
}: {
  workflowId: string;
  leads: readonly ParamOption[];
}) {
  const [state, submit, pending] = useActionState(testWorkflow, IDLE);
  const echoed = state.status === 'error' ? state.values?.['leadId'] : undefined;
  const first = leads[0]?.value ?? '';
  const [leadId, setLeadId] = useState(echoed ?? first);
  const [seen, setSeen] = useState(echoed ?? first);
  if (seen !== (echoed ?? first)) {
    setSeen(echoed ?? first);
    setLeadId(echoed ?? first);
  }

  if (leads.length === 0) {
    return (
      <p className="text-sm text-[var(--color-text-muted)]" data-test-run-empty>
        There are no leads to test against yet. Add one, and this will preview what the workflow
        would do to them without sending anything.
      </p>
    );
  }

  const chosen = leads.find((lead) => lead.value === leadId);
  return (
    <form action={submit} className="flex flex-wrap items-end gap-3" data-test-run={workflowId}>
      <input type="hidden" name="workflowId" value={workflowId} />
      <Field label="Which lead?" hint="Nothing is sent, and this lead is not enrolled.">
        <select
          name="leadId"
          key={`test-lead-${seen}`}
          defaultValue={seen}
          onChange={(event) => setLeadId(event.target.value)}
          className={controlClassName}
          data-test-run-lead
        >
          {leads.map((lead) => (
            <option key={lead.value} value={lead.value}>
              {lead.label}
            </option>
          ))}
        </select>
      </Field>
      <Button type="submit" variant="secondary" pending={pending}>
        {pending ? 'Testing…' : `Test it on ${chosen?.label ?? 'this lead'}`}
      </Button>
      {/* The API's own refusal, which on this button is usually the problem list: a definition
          with a step nobody finished cannot be previewed any more than it can be published. */}
      {state.status === 'error' && <ErrorNotice>{state.message}</ErrorNotice>}
      {state.status === 'success' && (
        <span className="text-xs text-[var(--color-success)]" data-test-run-result>
          {state.message}
        </span>
      )}
    </form>
  );
}

/**
 * Trying a failed run again, from the step that failed (`FR-AUT-7`).
 *
 * Rendered only against a failed run, and it says which step rather than "Retry": somebody
 * pressing this is about to make the thing that failed happen for real, and the steps before it
 * are deliberately not repeated.
 */
export function RetryRunButton({
  runId,
  workflowId,
  leadId,
}: {
  runId: string;
  workflowId: string;
  leadId?: string;
}) {
  const [state, submit, pending] = useActionState(retryRun, IDLE);
  return (
    <form action={submit} className="flex flex-col gap-1" data-retry-run={runId}>
      <input type="hidden" name="runId" value={runId} />
      <input type="hidden" name="workflowId" value={workflowId} />
      {leadId !== undefined && <input type="hidden" name="leadId" value={leadId} />}
      <div>
        <Button type="submit" variant="secondary" pending={pending}>
          {pending ? 'Trying again…' : 'Try the failed step again'}
        </Button>
      </div>
      {state.status === 'error' && (
        <span className="text-xs text-[var(--color-danger)]" data-retry-error>
          {state.message}
        </span>
      )}
      {state.status === 'success' && (
        <span className="text-xs text-[var(--color-success)]" data-retry-result>
          {state.message}
        </span>
      )}
    </form>
  );
}
