'use client';

import { useActionState } from 'react';
import { IDLE, type ActionState } from '@/lib/action-state';
import { Button, ErrorNotice, Field, controlClassName } from '@/components/ui';
import { describeTargetMinutes, type SlaPolicy } from '@/lib/sla';
import {
  acknowledgeEscalation,
  createSlaPolicy,
  deleteSlaPolicy,
  updateSlaPolicy,
} from '../actions';

function errorOf(state: ActionState, key: string): string | undefined {
  return state.status === 'error' ? state.fieldErrors?.[key] : undefined;
}

function valueOf(state: ActionState, key: string, fallback: string): string {
  return state.status === 'error' ? (state.values?.[key] ?? fallback) : fallback;
}

/** "I have seen it." An escalation nobody acknowledges is the one a manager needs to chase. */
export function AcknowledgeButton({ escalationId }: { escalationId: string }) {
  const [state, action, pending] = useActionState(acknowledgeEscalation, IDLE);
  return (
    <form action={action} className="inline">
      <input type="hidden" name="id" value={escalationId} />
      <Button type="submit" variant="secondary" pending={pending}>
        {pending ? 'Marking…' : 'Mark as seen'}
      </Button>
      {state.status === 'error' && <ErrorNotice>{state.message}</ErrorNotice>}
    </form>
  );
}

/**
 * Each row prints its own name and its promise as **text** above the editor.
 *
 * Seven editable rows render as seven identical "Name" labels otherwise — a settings list has to be
 * readable before it is editable, and it is also the only thing a browser check can trust.
 */
export function SlaPolicyRow({ policy }: { policy: SlaPolicy }) {
  const [saveState, saveAction, saving] = useActionState(updateSlaPolicy, IDLE);
  const [deleteState, deleteAction, deleting] = useActionState(deleteSlaPolicy, IDLE);
  const conditions = policy.appliesTo.priorities?.length
    ? `only ${policy.appliesTo.priorities.join(', ')} leads`
    : 'every lead';

  return (
    <div className="flex flex-col gap-2 border-b border-[var(--color-border)]/60 py-3">
      <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
        <span data-policy-name>{policy.name}</span>
        <span className="text-xs font-normal text-[var(--color-text-muted)]">
          first response in{' '}
          {describeTargetMinutes(policy.firstResponseMinutes, policy.businessHoursOnly)}
        </span>
        <span className="text-xs font-normal text-[var(--color-text-muted)]">· {conditions}</span>
        <span className="text-xs font-normal text-[var(--color-text-muted)]">
          · warns at {policy.warnAtPercent}%
        </span>
        {policy.clockCount > 0 && (
          <span className="text-xs font-normal text-[var(--color-text-muted)]">
            · {policy.clockCount} {policy.clockCount === 1 ? 'clock' : 'clocks'}
          </span>
        )}
        {!policy.isActive && (
          <span className="rounded bg-slate-100 px-2 py-0.5 text-xs font-normal text-slate-700">
            not applied
          </span>
        )}
      </p>
      <div className="flex flex-wrap items-end gap-3">
        <form action={saveAction} className="flex flex-wrap items-end gap-3">
          <input type="hidden" name="id" value={policy.id} />
          <Field label="Name">
            <input name="name" className={controlClassName} defaultValue={policy.name} />
          </Field>
          <Field label="First response (minutes)">
            <input
              name="firstResponseMinutes"
              type="number"
              min={1}
              className={controlClassName}
              defaultValue={String(policy.firstResponseMinutes)}
            />
          </Field>
          <Field label="Warn at (%)" hint="Strictly inside the target.">
            <input
              name="warnAtPercent"
              type="number"
              min={1}
              max={99}
              className={controlClassName}
              defaultValue={String(policy.warnAtPercent)}
            />
          </Field>
          <label className="flex items-center gap-2 pb-2 text-sm">
            <input
              type="checkbox"
              name="businessHoursOnly"
              defaultChecked={policy.businessHoursOnly}
            />
            Working hours only
          </label>
          <label className="flex items-center gap-2 pb-2 text-sm">
            <input type="checkbox" name="isActive" defaultChecked={policy.isActive} />
            Applied to new leads
          </label>
          <Button type="submit" variant="secondary" pending={saving}>
            {saving ? 'Saving…' : 'Save'}
          </Button>
        </form>
        <form action={deleteAction}>
          <input type="hidden" name="id" value={policy.id} />
          <Button type="submit" variant="quiet" pending={deleting}>
            {deleting ? 'Removing…' : 'Remove'}
          </Button>
        </form>
      </div>
      {saveState.status === 'error' && <ErrorNotice>{saveState.message}</ErrorNotice>}
      {deleteState.status === 'error' && <ErrorNotice>{deleteState.message}</ErrorNotice>}
      {saveState.status === 'success' && (
        <span data-policy-saved className="text-sm text-[var(--color-text-muted)]">
          {saveState.message} Clocks already running keep the target they were started with.
        </span>
      )}
    </div>
  );
}

export function NewSlaPolicyForm() {
  const [state, action, pending] = useActionState(createSlaPolicy, IDLE);
  return (
    <form action={action} className="flex flex-col gap-3">
      {state.status === 'error' && <ErrorNotice>{state.message}</ErrorNotice>}
      <Field label="Name" hint="What the promise is called, in the business's own words.">
        <input
          name="name"
          required
          maxLength={120}
          className={controlClassName}
          placeholder="Urgent leads in ten minutes"
          defaultValue={valueOf(state, 'name', '')}
        />
      </Field>
      <Field
        label="First response (minutes)"
        {...(errorOf(state, 'firstResponseMinutes')
          ? { error: errorOf(state, 'firstResponseMinutes') }
          : {})}
      >
        <input
          name="firstResponseMinutes"
          type="number"
          min={1}
          required
          className={controlClassName}
          defaultValue={valueOf(state, 'firstResponseMinutes', '60')}
        />
      </Field>
      <Field
        label="Closing out (minutes)"
        hint="Optional. Most businesses have no such promise, and one invented on their behalf breaches all week."
      >
        <input
          name="resolutionMinutes"
          type="number"
          min={1}
          className={controlClassName}
          defaultValue={valueOf(state, 'resolutionMinutes', '')}
        />
      </Field>
      <fieldset className="flex flex-col gap-1.5 text-sm">
        <legend className="font-medium">Which leads</legend>
        <div className="flex flex-wrap gap-3">
          {['low', 'medium', 'high', 'urgent'].map((priority) => (
            <label key={priority} className="flex items-center gap-1.5">
              <input type="checkbox" name="priorities" value={priority} />
              {priority}
            </label>
          ))}
        </div>
        <span className="text-xs text-[var(--color-text-muted)]">
          Tick none for every lead. A narrower policy wins over a broader one at the same order.
        </span>
      </fieldset>
      <Field label="Warn at (%)" hint="Strictly inside the target: 100 % arrives with the breach.">
        <input
          name="warnAtPercent"
          type="number"
          min={1}
          max={99}
          className={controlClassName}
          defaultValue={valueOf(state, 'warnAtPercent', '80')}
        />
      </Field>
      <Field label="Order" hint="Lower numbers are consulted first.">
        <input
          name="priority"
          type="number"
          min={0}
          className={controlClassName}
          defaultValue={valueOf(state, 'priority', '0')}
        />
      </Field>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" name="businessHoursOnly" defaultChecked />
        Count working hours only
      </label>
      <Button type="submit" pending={pending}>
        {pending ? 'Creating…' : 'Create policy'}
      </Button>
      {state.status === 'success' && (
        <span className="text-sm text-[var(--color-success)]">{state.message}</span>
      )}
    </form>
  );
}
