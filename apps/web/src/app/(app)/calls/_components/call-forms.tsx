'use client';

import { useActionState, useEffect, useState } from 'react';
import { IDLE, type ActionState } from '@/lib/action-state';
import { Button, ErrorNotice, Field, controlClassName } from '@/components/ui';
import {
  CATEGORY_LABELS,
  STATUS_CLASSES,
  STATUS_LABELS,
  statusForCategory,
  type CallConfig,
  type CallOutcome,
  type CallRecord,
} from '@/lib/calls';
import type { TaskOutcome } from '@/lib/tasks';
import {
  createCallOutcome,
  deleteCall,
  deleteCallOutcome,
  dialCall,
  logCall,
  recordCallOutcome,
  updateCallOutcome,
} from '../actions';

function errorOf(state: ActionState, key: string): string | undefined {
  return state.status === 'error' ? state.fieldErrors?.[key] : undefined;
}

function valueOf(state: ActionState, key: string, fallback: string): string {
  return state.status === 'error' ? (state.values?.[key] ?? fallback) : fallback;
}

/**
 * The outcome dropdown, and the note the chosen outcome may demand.
 *
 * One question, not two: the connection status is derived from the category (see
 * `statusForCategory`) and submitted as a hidden field, because "did it connect" and "what
 * happened" are the same question to the person who made the call.
 *
 * The `key` on the select is the trick the payments form paid for: a refused submission re-renders
 * the server tree, the client form remounts, and a `<select>` does not come back from
 * `state.values` through `defaultValue` alone — React re-creates the options in the same commit and
 * the DOM keeps `selectedIndex: 0`. Remounting exactly when the echo changes is what restores it,
 * and leaves the control alone while somebody is typing.
 */
function OutcomeChoice({
  outcomes,
  state,
  label = 'What happened',
}: {
  outcomes: CallOutcome[];
  state: ActionState;
  label?: string;
}) {
  const echoed = state.status === 'error' ? (state.values?.['outcomeId'] ?? '') : '';
  const [outcomeId, setOutcomeId] = useState(echoed);
  const chosen = outcomes.find((row) => row.id === (outcomeId || echoed));

  return (
    <>
      <input type="hidden" name="status" value={chosen ? statusForCategory(chosen.category) : ''} />
      <Field
        label={label}
        {...(errorOf(state, 'outcomeId') ? { error: errorOf(state, 'outcomeId') } : {})}
      >
        <select
          key={`call-outcome-${echoed}`}
          name="outcomeId"
          required
          defaultValue={echoed}
          onChange={(event) => setOutcomeId(event.target.value)}
          className={controlClassName}
          data-call-outcome
        >
          <option value="">Choose an outcome</option>
          {outcomes.map((row) => (
            <option key={row.id} value={row.id}>
              {row.name}
            </option>
          ))}
        </select>
      </Field>

      {/* The duration only means anything on a call that connected, and the API refuses it
          otherwise — so the boxes appear only when they apply. */}
      {chosen && statusForCategory(chosen.category) === 'completed' && (
        <div className="flex items-end gap-2">
          <Field label="Minutes">
            <input
              name="durationMinutes"
              type="number"
              min={0}
              max={480}
              className={controlClassName}
              defaultValue={valueOf(state, 'durationMinutes', '')}
              data-call-minutes
            />
          </Field>
          <Field label="Seconds">
            <input
              name="durationSeconds"
              type="number"
              min={0}
              max={59}
              className={controlClassName}
              defaultValue={valueOf(state, 'durationSeconds', '')}
            />
          </Field>
        </div>
      )}

      <Field
        label={chosen?.requiresNote ? 'Note (required for this outcome)' : 'Note'}
        {...(errorOf(state, 'notes') ? { error: errorOf(state, 'notes') } : {})}
      >
        <textarea
          name="notes"
          rows={2}
          required={chosen?.requiresNote === true}
          className={controlClassName}
          defaultValue={valueOf(state, 'notes', '')}
          data-call-note
        />
      </Field>
    </>
  );
}

/**
 * Click-to-call (`FR-CALL-3`).
 *
 * The button logs the attempt and then **the browser** follows the `tel:` link the API handed
 * back: the server cannot open anything on somebody's phone, and the point of the manual driver is
 * that the device dials. A provider driver answers `mode: 'provider'` instead and there is nothing
 * for the client to open, which is why the href is optional rather than assumed.
 */
export function DialButton({
  leadId,
  taskId,
  phone,
  placesCalls,
}: {
  leadId: string;
  taskId?: string;
  phone: string | null;
  placesCalls: boolean;
}) {
  const [state, action, pending] = useActionState(dialCall, IDLE);
  const href = state.status === 'success' ? state.data?.['href'] : undefined;

  useEffect(() => {
    // In an effect, not during render: a redirect on the render pass would fire on a replay and is
    // not something React promises to run once.
    if (href) window.location.href = href;
  }, [href]);

  if (!phone) {
    return (
      <p className="text-sm text-[var(--color-text-muted)]">
        No phone number on record, so there is nothing to call.
      </p>
    );
  }

  // `data-dial` is on the **form**, not on `<Button>`: a hyphenated attribute passed to a React
  // component is accepted by TypeScript (JSX allows any `data-*`) and then silently dropped,
  // because `Button` takes a closed prop list and does not spread the rest. The browser check that
  // looked for it timed out against a button that was plainly on the screen.
  return (
    <form action={action} className="flex flex-col gap-1" data-dial>
      <input type="hidden" name="leadId" value={leadId} />
      {taskId && <input type="hidden" name="taskId" value={taskId} />}
      <Button type="submit" pending={pending}>
        {pending ? 'Logging the call…' : `Call ${phone}`}
      </Button>
      <span className="text-xs text-[var(--color-text-muted)]">
        {placesCalls
          ? 'The product places the call and records it.'
          : 'This opens your phone, and logs the attempt here so you can say what happened.'}
      </span>
      {state.status === 'error' && <ErrorNotice>{state.message}</ErrorNotice>}
      {state.status === 'success' && (
        <span role="status" className="text-xs text-[var(--color-success)]" data-dial-done>
          {state.message}
        </span>
      )}
    </form>
  );
}

/**
 * Logging a call that already happened (`FR-CALL-1`).
 *
 * The path every workspace uses on day one, which is why it is the form on the lead rather than a
 * fallback behind a provider. `finishFollowUp` is offered when the call was made for a follow-up:
 * one action, because that is what it is to the person doing it.
 */
export function LogCallForm({
  config,
  leadId,
  taskId,
  taskTitle,
  taskOutcomes = [],
}: {
  config: CallConfig;
  leadId: string;
  taskId?: string;
  taskTitle?: string;
  taskOutcomes?: TaskOutcome[];
}) {
  const [state, action, pending] = useActionState(logCall, IDLE);
  const [finish, setFinish] = useState(false);

  if (config.outcomes.length === 0) {
    return (
      <p className="text-sm text-[var(--color-text-muted)]">
        Call outcomes could not be loaded, so this form has nothing to offer. Reload the page.
      </p>
    );
  }

  return (
    <form action={action} className="flex flex-col gap-3">
      <input type="hidden" name="leadId" value={leadId} />
      {taskId && <input type="hidden" name="taskId" value={taskId} />}
      {state.status === 'error' && <ErrorNotice>{state.message}</ErrorNotice>}
      {state.status === 'success' && (
        <p role="status" className="text-sm text-[var(--color-success)]" data-call-logged>
          {state.message}
        </p>
      )}

      <Field label="Which way">
        <select
          name="direction"
          defaultValue={valueOf(state, 'direction', 'outbound')}
          className={controlClassName}
        >
          <option value="outbound">We called them</option>
          <option value="inbound">They called us</option>
        </select>
      </Field>

      <OutcomeChoice outcomes={config.outcomes} state={state} />

      {taskId && taskOutcomes.length > 0 && (
        <div className="rounded-md border border-[var(--color-border)] p-3">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={finish}
              onChange={(event) => setFinish(event.target.checked)}
              data-finish-followup
            />
            Close the follow-up{taskTitle ? ` “${taskTitle}”` : ''} as well
          </label>
          {finish && (
            <div className="mt-2">
              <Field label="How did the follow-up end">
                <select name="finishOutcomeId" required className={controlClassName}>
                  <option value="">Choose an outcome</option>
                  {taskOutcomes.map((row) => (
                    <option key={row.id} value={row.id}>
                      {row.name}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
          )}
        </div>
      )}

      <div>
        <Button type="submit" pending={pending}>
          {pending ? 'Saving…' : 'Log the call'}
        </Button>
      </div>
    </form>
  );
}

/** What happened on a call the product dialled. The row stays amber until this is answered. */
export function RecordOutcomeForm({
  call,
  outcomes,
}: {
  call: CallRecord;
  outcomes: CallOutcome[];
}) {
  const [state, action, pending] = useActionState(recordCallOutcome, IDLE);
  return (
    <form action={action} className="flex flex-col gap-3" data-record-outcome={call.id}>
      <input type="hidden" name="id" value={call.id} />
      {call.leadId && <input type="hidden" name="leadId" value={call.leadId} />}
      {state.status === 'error' && <ErrorNotice>{state.message}</ErrorNotice>}
      {state.status === 'success' && (
        <p role="status" className="text-sm text-[var(--color-success)]" data-outcome-saved>
          {state.message}
        </p>
      )}
      <OutcomeChoice outcomes={outcomes} state={state} label="What happened on this call" />
      <div>
        <Button type="submit" variant="secondary" pending={pending}>
          {pending ? 'Saving…' : 'Save the outcome'}
        </Button>
      </div>
    </form>
  );
}

export function DeleteCallButton({ call }: { call: CallRecord }) {
  const [state, action, pending] = useActionState(deleteCall, IDLE);
  return (
    <form action={action}>
      <input type="hidden" name="id" value={call.id} />
      {call.leadId && <input type="hidden" name="leadId" value={call.leadId} />}
      <Button type="submit" variant="quiet" pending={pending}>
        {pending ? 'Removing…' : 'Remove'}
      </Button>
      {state.status === 'error' && <ErrorNotice>{state.message}</ErrorNotice>}
    </form>
  );
}

/** A status chip, with the amber one that means somebody owes an answer. */
export function CallStatusChip({ call }: { call: CallRecord }) {
  return (
    <span
      className={`rounded px-2 py-0.5 text-xs ${STATUS_CLASSES[call.status]}`}
      data-call-status={call.id}
    >
      {call.outcome?.name ?? STATUS_LABELS[call.status]}
    </span>
  );
}

// ── The outcome vocabulary (settings) ───────────────────────────────────────

const CATEGORY_OPTIONS = Object.entries(CATEGORY_LABELS) as [string, string][];

export function CallOutcomeRow({ outcome }: { outcome: CallOutcome }) {
  const [saveState, saveAction, saving] = useActionState(updateCallOutcome, IDLE);
  const [deleteState, deleteAction, deleting] = useActionState(deleteCallOutcome, IDLE);
  return (
    <div
      className="flex flex-col gap-2 border-b border-[var(--color-border)]/60 py-3"
      data-outcome-row={outcome.id}
    >
      {/* The name as text, not only as an input's value: a list of six editable rows otherwise
          reads as six identical "Name" labels, and nothing can assert against it either. */}
      <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
        <span data-outcome-name>{outcome.name}</span>
        <span className="rounded bg-[var(--color-surface-muted)] px-2 py-0.5 text-xs font-normal text-[var(--color-text-muted)]">
          {CATEGORY_LABELS[outcome.category]}
        </span>
        {outcome.isContact && (
          <span className="text-xs font-normal text-[var(--color-text-muted)]">
            counts as having reached them
          </span>
        )}
        {outcome.isActive === false && (
          <span className="rounded bg-slate-100 px-2 py-0.5 text-xs font-normal text-slate-700">
            not offered
          </span>
        )}
        {typeof outcome.callCount === 'number' && outcome.callCount > 0 && (
          <span className="text-xs font-normal text-[var(--color-text-muted)]">
            {outcome.callCount} {outcome.callCount === 1 ? 'call' : 'calls'}
          </span>
        )}
      </p>
      <div className="flex flex-wrap items-end gap-3">
        <form action={saveAction} className="flex flex-wrap items-end gap-3">
          <input type="hidden" name="id" value={outcome.id} />
          <Field label="Name">
            <input name="name" className={controlClassName} defaultValue={outcome.name} />
          </Field>
          <Field label="Kind">
            <select
              name="category"
              defaultValue={outcome.category}
              className={controlClassName}
              data-outcome-category={outcome.id}
            >
              {CATEGORY_OPTIONS.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </Field>
          <label className="flex items-center gap-2 pb-2 text-sm">
            <input type="checkbox" name="requiresNote" defaultChecked={outcome.requiresNote} />
            Needs a note
          </label>
          <label className="flex items-center gap-2 pb-2 text-sm">
            <input type="checkbox" name="isActive" defaultChecked={outcome.isActive !== false} />
            Offered on the form
          </label>
          <Button type="submit" variant="secondary" pending={saving}>
            {saving ? 'Saving…' : 'Save'}
          </Button>
        </form>
        <form action={deleteAction}>
          <input type="hidden" name="id" value={outcome.id} />
          <Button type="submit" variant="quiet" pending={deleting}>
            {deleting ? 'Removing…' : 'Remove'}
          </Button>
        </form>
      </div>
      {saveState.status === 'error' && <ErrorNotice>{saveState.message}</ErrorNotice>}
      {deleteState.status === 'error' && <ErrorNotice>{deleteState.message}</ErrorNotice>}
      {saveState.status === 'success' && (
        <span className="text-sm text-[var(--color-text-muted)]">{saveState.message}</span>
      )}
    </div>
  );
}

export function NewCallOutcomeForm() {
  const [state, action, pending] = useActionState(createCallOutcome, IDLE);
  return (
    <form action={action} className="flex flex-col gap-3">
      {state.status === 'error' && <ErrorNotice>{state.message}</ErrorNotice>}
      {state.status === 'success' && (
        <p role="status" className="text-sm text-[var(--color-success)]">
          {state.message}
        </p>
      )}
      <Field label="Name" {...(errorOf(state, 'name') ? { error: errorOf(state, 'name') } : {})}>
        <input
          name="name"
          required
          maxLength={80}
          className={controlClassName}
          defaultValue={valueOf(state, 'name', '')}
          placeholder="Spoke — wants a demo"
        />
      </Field>
      <Field
        label="Kind"
        {...(errorOf(state, 'category') ? { error: errorOf(state, 'category') } : {})}
      >
        <select
          key={`category-${valueOf(state, 'category', '')}`}
          name="category"
          required
          defaultValue={valueOf(state, 'category', '')}
          className={controlClassName}
        >
          <option value="">Choose a kind</option>
          {CATEGORY_OPTIONS.map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </Field>
      <p className="text-xs text-[var(--color-text-muted)]">
        The kind is what the product understands: three of them mean somebody was actually spoken
        to, which is what marks the lead contacted and answers a response promise.
      </p>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" name="requiresNote" />
        Needs a note
      </label>
      <div>
        <Button type="submit" pending={pending}>
          {pending ? 'Adding…' : 'Add the outcome'}
        </Button>
      </div>
    </form>
  );
}
