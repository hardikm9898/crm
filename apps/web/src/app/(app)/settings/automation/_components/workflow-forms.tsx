'use client';

import { useActionState, useState } from 'react';
import Link from 'next/link';
import { Button, ErrorNotice, Field, controlClassName } from '@/components/ui';
import { IDLE } from '@/lib/action-state';
import type { WorkflowSummary } from '@/lib/automation';
import { createWorkflow, deleteWorkflow, publishWorkflow, updateWorkflow } from '../actions';

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
