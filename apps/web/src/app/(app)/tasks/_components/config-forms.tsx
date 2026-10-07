'use client';

import { useActionState } from 'react';
import { IDLE, type ActionState } from '@/lib/action-state';
import { Button, ErrorNotice, Field, controlClassName } from '@/components/ui';
import type { RescheduleReason, TaskOutcome, TaskType } from '@/lib/tasks';
import {
  createRescheduleReason,
  createTaskOutcome,
  createTaskType,
  deleteRescheduleReason,
  deleteTaskOutcome,
  deleteTaskType,
  updateRescheduleReason,
  updateTaskOutcome,
  updateTaskType,
} from '../actions';

function Messages({ states }: { states: ActionState[] }) {
  return (
    <>
      {states.map((state, index) =>
        state.status === 'error' ? (
          <ErrorNotice key={index}>{state.message}</ErrorNotice>
        ) : state.status === 'success' ? (
          <span key={index} className="text-sm text-[var(--color-text-muted)]">
            {state.message}
          </span>
        ) : null,
      )}
    </>
  );
}

/**
 * Each row prints its own name as **text** above its editor.
 *
 * Seven editable rows render as seven identical "Name" labels otherwise, and somebody scanning for
 * "Site visit" cannot find it — a settings list has to be readable before it is editable, and it is
 * also the only thing a browser check can trust.
 */
export function TaskTypeRow({ type }: { type: TaskType }) {
  const [saveState, saveAction, saving] = useActionState(updateTaskType, IDLE);
  const [deleteState, deleteAction, deleting] = useActionState(deleteTaskType, IDLE);
  return (
    <div className="flex flex-col gap-2 border-b border-[var(--color-border)]/60 py-3">
      <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
        <span data-task-type-name>{type.name}</span>
        {type.isActive === false && (
          <span className="rounded bg-slate-100 px-2 py-0.5 text-xs font-normal text-slate-700">
            not offered
          </span>
        )}
        {type.defaultReminderOffsets.length > 0 && (
          <span className="text-xs font-normal text-[var(--color-text-muted)]">
            reminds {type.defaultReminderOffsets.map(describeOffset).join(' and ')}
          </span>
        )}
        {typeof type.taskCount === 'number' && type.taskCount > 0 && (
          <span className="text-xs font-normal text-[var(--color-text-muted)]">
            {type.taskCount} {type.taskCount === 1 ? 'follow-up' : 'follow-ups'}
          </span>
        )}
      </p>
      <div className="flex flex-wrap items-end gap-3">
        <form action={saveAction} className="flex flex-wrap items-end gap-3">
          <input type="hidden" name="id" value={type.id} />
          <Field label="Name">
            <input name="name" className={controlClassName} defaultValue={type.name} />
          </Field>
          <label className="flex items-center gap-2 pb-2 text-sm">
            <input type="checkbox" name="isActive" defaultChecked={type.isActive !== false} />
            Offered on the form
          </label>
          <Button type="submit" variant="secondary" pending={saving}>
            {saving ? 'Saving…' : 'Save'}
          </Button>
        </form>
        <form action={deleteAction}>
          <input type="hidden" name="id" value={type.id} />
          <Button type="submit" variant="quiet" pending={deleting}>
            {deleting ? 'Removing…' : 'Remove'}
          </Button>
        </form>
      </div>
      <Messages states={[saveState, deleteState]} />
    </div>
  );
}

export function NewTaskTypeForm() {
  const [state, action, pending] = useActionState(createTaskType, IDLE);
  return (
    <form action={action} className="flex flex-col gap-3">
      <Field label="Name" hint="“Site visit”, “Document collection” — whatever this business does.">
        <input name="name" required maxLength={60} className={controlClassName} />
      </Field>
      <Field label="Usually takes (minutes)">
        <input
          name="defaultDurationMinutes"
          type="number"
          min={1}
          max={1440}
          className={controlClassName}
        />
      </Field>
      <fieldset className="flex flex-col gap-1.5 text-sm">
        <legend className="font-medium">Remind by default</legend>
        <div className="flex flex-wrap gap-3">
          {[10, 60, 1440].map((minutes) => (
            <label key={minutes} className="flex items-center gap-1.5">
              <input
                type="checkbox"
                name="reminderOffsets"
                value={String(minutes)}
                defaultChecked={minutes === 60}
              />
              {describeOffset(minutes)}
            </label>
          ))}
        </div>
      </fieldset>
      <Button type="submit" pending={pending}>
        {pending ? 'Adding…' : 'Add type'}
      </Button>
      <Messages states={[state]} />
    </form>
  );
}

export function TaskOutcomeRow({ outcome }: { outcome: TaskOutcome }) {
  const [saveState, saveAction, saving] = useActionState(updateTaskOutcome, IDLE);
  const [deleteState, deleteAction, deleting] = useActionState(deleteTaskOutcome, IDLE);
  return (
    <div className="flex flex-col gap-2 border-b border-[var(--color-border)]/60 py-3">
      <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
        <span data-outcome-name>{outcome.name}</span>
        <span className="text-xs font-normal text-[var(--color-text-muted)]">
          {outcome.isPositive === true
            ? 'counts as progress'
            : outcome.isPositive === false
              ? 'counts against'
              : 'neither'}
        </span>
        {outcome.requiresNote && (
          <span className="text-xs font-normal text-[var(--color-text-muted)]">needs a note</span>
        )}
        {outcome.isActive === false && (
          <span className="rounded bg-slate-100 px-2 py-0.5 text-xs font-normal text-slate-700">
            not offered
          </span>
        )}
      </p>
      <div className="flex flex-wrap items-end gap-3">
        <form action={saveAction} className="flex flex-wrap items-end gap-3">
          <input type="hidden" name="id" value={outcome.id} />
          <Field label="Name">
            <input name="name" className={controlClassName} defaultValue={outcome.name} />
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
      <Messages states={[saveState, deleteState]} />
    </div>
  );
}

export function NewTaskOutcomeForm() {
  const [state, action, pending] = useActionState(createTaskOutcome, IDLE);
  return (
    <form action={action} className="flex flex-col gap-3">
      <Field label="Name">
        <input name="name" required maxLength={60} className={controlClassName} />
      </Field>
      <fieldset className="flex flex-col gap-1.5 text-sm">
        <legend className="font-medium">Does it mean progress?</legend>
        {/*
          Three choices, not a checkbox: a no-answer is neither a success nor a failure, and
          forcing it into one of two buckets is what makes an outcome report meaningless.
        */}
        {[
          { value: 'yes', label: 'Yes — the lead moved forward' },
          { value: 'neither', label: 'Neither' },
          { value: 'no', label: 'No — this one is going nowhere' },
        ].map((choice) => (
          <label key={choice.value} className="flex items-center gap-2">
            <input
              type="radio"
              name="isPositive"
              value={choice.value}
              defaultChecked={choice.value === 'neither'}
            />
            {choice.label}
          </label>
        ))}
      </fieldset>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" name="requiresNote" />
        Ask for a note
      </label>
      <Button type="submit" pending={pending}>
        {pending ? 'Adding…' : 'Add outcome'}
      </Button>
      <Messages states={[state]} />
    </form>
  );
}

export function RescheduleReasonRow({ reason }: { reason: RescheduleReason }) {
  const [saveState, saveAction, saving] = useActionState(updateRescheduleReason, IDLE);
  const [deleteState, deleteAction, deleting] = useActionState(deleteRescheduleReason, IDLE);
  return (
    <div className="flex flex-col gap-2 border-b border-[var(--color-border)]/60 py-3">
      <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
        <span data-reason-name>{reason.name}</span>
        {reason.requiresNote && (
          <span className="text-xs font-normal text-[var(--color-text-muted)]">needs a note</span>
        )}
        {typeof reason.useCount === 'number' && reason.useCount > 0 && (
          <span className="text-xs font-normal text-[var(--color-text-muted)]">
            given {reason.useCount} {reason.useCount === 1 ? 'time' : 'times'}
          </span>
        )}
        {reason.isActive === false && (
          <span className="rounded bg-slate-100 px-2 py-0.5 text-xs font-normal text-slate-700">
            not offered
          </span>
        )}
      </p>
      <div className="flex flex-wrap items-end gap-3">
        <form action={saveAction} className="flex flex-wrap items-end gap-3">
          <input type="hidden" name="id" value={reason.id} />
          <Field label="Name">
            <input name="name" className={controlClassName} defaultValue={reason.name} />
          </Field>
          <label className="flex items-center gap-2 pb-2 text-sm">
            <input type="checkbox" name="requiresNote" defaultChecked={reason.requiresNote} />
            Needs a note
          </label>
          <label className="flex items-center gap-2 pb-2 text-sm">
            <input type="checkbox" name="isActive" defaultChecked={reason.isActive !== false} />
            Offered on the form
          </label>
          <Button type="submit" variant="secondary" pending={saving}>
            {saving ? 'Saving…' : 'Save'}
          </Button>
        </form>
        <form action={deleteAction}>
          <input type="hidden" name="id" value={reason.id} />
          <Button type="submit" variant="quiet" pending={deleting}>
            {deleting ? 'Removing…' : 'Remove'}
          </Button>
        </form>
      </div>
      <Messages states={[saveState, deleteState]} />
    </div>
  );
}

export function NewRescheduleReasonForm() {
  const [state, action, pending] = useActionState(createRescheduleReason, IDLE);
  return (
    <form action={action} className="flex flex-col gap-3">
      <Field label="Name" hint="Why a follow-up moves. Somebody has to pick one every time.">
        <input name="name" required maxLength={80} className={controlClassName} />
      </Field>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" name="requiresNote" />
        Ask for a note
      </label>
      <Button type="submit" pending={pending}>
        {pending ? 'Adding…' : 'Add reason'}
      </Button>
      <Messages states={[state]} />
    </form>
  );
}

function describeOffset(minutes: number): string {
  if (minutes === 0) return 'at the time';
  if (minutes < 60) return `${minutes} minutes before`;
  if (minutes % (24 * 60) === 0) {
    const days = minutes / (24 * 60);
    return days === 1 ? 'the day before' : `${days} days before`;
  }
  const hours = Math.round(minutes / 60);
  return hours === 1 ? 'an hour before' : `${hours} hours before`;
}
