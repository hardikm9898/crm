'use client';

import { useActionState, useEffect, useState } from 'react';
import { IDLE, type ActionState } from '@/lib/action-state';
import { Button, ErrorNotice, Field, controlClassName } from '@/components/ui';
import {
  PRIORITY_LABELS,
  defaultDue,
  dueFields,
  type RescheduleReason,
  type TaskConfig,
  type TaskSummary,
} from '@/lib/tasks';
import { cancelTask, completeTask, createTask, deleteTask, rescheduleTask } from '../actions';

function errorOf(state: ActionState, key: string): string | undefined {
  return state.status === 'error' ? state.fieldErrors?.[key] : undefined;
}

function valueOf(state: ActionState, key: string, fallback: string): string {
  return state.status === 'error' ? (state.values?.[key] ?? fallback) : fallback;
}

/**
 * The browser's offset, in minutes, as a hidden field.
 *
 * The server renders in UTC; a follow-up "at 10:00" means ten o'clock where the person typing it
 * is. Reading `getTimezoneOffset()` in an effect rather than during render is deliberate — the
 * server has no such value, and using it in the first paint is a hydration mismatch.
 */
function TimezoneOffset() {
  const [offset, setOffset] = useState<number | null>(null);
  useEffect(() => setOffset(new Date().getTimezoneOffset()), []);
  return offset === null ? null : (
    <input type="hidden" name="timezoneOffset" value={String(offset)} />
  );
}

function ReminderChoice({ defaultValue }: { defaultValue: number[] }) {
  const options: { minutes: number; label: string }[] = [
    { minutes: 0, label: 'At the time' },
    { minutes: 10, label: '10 minutes before' },
    { minutes: 60, label: 'An hour before' },
    { minutes: 1440, label: 'The day before' },
  ];
  return (
    <fieldset className="flex flex-col gap-1.5 text-sm">
      <legend className="font-medium">Remind me</legend>
      <div className="flex flex-wrap gap-3">
        {options.map((option) => (
          <label key={option.minutes} className="flex items-center gap-1.5 text-sm">
            <input
              type="checkbox"
              name="reminderOffsets"
              value={String(option.minutes)}
              defaultChecked={defaultValue.includes(option.minutes)}
            />
            {option.label}
          </label>
        ))}
      </div>
      <span className="text-xs text-[var(--color-text-muted)]">
        A reminder whose moment has already gone is not sent — that is what the overdue notice is
        for.
      </span>
    </fieldset>
  );
}

/**
 * Scheduling a follow-up.
 *
 * One screenful: who it is about is already known from where the form is, so what is left is what
 * kind, when, and how urgent. Picking a type fills in its reminder defaults, which is the whole
 * reason the type carries them.
 */
export function ScheduleTaskForm({
  config,
  leadId,
  customerId,
  dealId,
  compact = false,
}: {
  config: TaskConfig;
  leadId?: string;
  customerId?: string;
  dealId?: string;
  compact?: boolean;
}) {
  const [state, action, pending] = useActionState(createTask, IDLE);
  const due = defaultDue();
  const submittedType = state.status === 'error' ? (state.values?.['taskTypeId'] ?? '') : '';
  const [taskTypeId, setTaskTypeId] = useState(submittedType);
  const selected = config.types.find((type) => type.id === (taskTypeId || submittedType));
  const reminders = selected?.defaultReminderOffsets ?? [60];

  if (config.types.length === 0 && config.outcomes.length === 0) {
    return (
      <p className="text-sm text-[var(--color-text-muted)]">
        Follow-up settings could not be loaded, so this form has nothing to offer. Reload the page.
      </p>
    );
  }

  return (
    <form action={action} className="flex flex-col gap-3">
      <TimezoneOffset />
      {leadId && <input type="hidden" name="leadId" value={leadId} />}
      {customerId && <input type="hidden" name="customerId" value={customerId} />}
      {dealId && <input type="hidden" name="dealId" value={dealId} />}
      {state.status === 'error' && <ErrorNotice>{state.message}</ErrorNotice>}
      {state.status === 'success' && (
        <p role="status" className="text-sm text-[var(--color-success)]">
          {state.message}
        </p>
      )}

      <Field
        label="What needs doing"
        {...(errorOf(state, 'title') ? { error: errorOf(state, 'title') } : {})}
      >
        <input
          name="title"
          required
          maxLength={200}
          className={controlClassName}
          placeholder="Call about the 3BHK"
          defaultValue={valueOf(state, 'title', '')}
        />
      </Field>

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Kind">
          {/*
            `key` on the echo, with `defaultValue` — not a controlled `value`. React re-creates the
            options in the same commit and the DOM keeps `selectedIndex: 0`, so a controlled select
            says one thing while the screen shows another. This is the payments form's lesson.
          */}
          <select
            key={`type-${submittedType}`}
            name="taskTypeId"
            defaultValue={submittedType}
            onChange={(event) => setTaskTypeId(event.target.value)}
            className={controlClassName}
          >
            <option value="">No particular kind</option>
            {config.types.map((type) => (
              <option key={type.id} value={type.id}>
                {type.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="How urgent">
          <select
            name="priority"
            defaultValue={valueOf(state, 'priority', 'medium')}
            className={controlClassName}
          >
            {(Object.keys(PRIORITY_LABELS) as (keyof typeof PRIORITY_LABELS)[]).map((value) => (
              <option key={value} value={value}>
                {PRIORITY_LABELS[value]}
              </option>
            ))}
          </select>
        </Field>
        <Field
          label="Date"
          {...(errorOf(state, 'dueDate') ? { error: errorOf(state, 'dueDate') } : {})}
        >
          <input
            type="date"
            name="dueDate"
            required
            className={controlClassName}
            defaultValue={valueOf(state, 'dueDate', due.date)}
          />
        </Field>
        <Field label="Time">
          <input
            type="time"
            name="dueTime"
            className={controlClassName}
            defaultValue={valueOf(state, 'dueTime', due.time)}
          />
        </Field>
      </div>

      {!compact && (
        <Field label="Anything to remember" hint="Shown on the follow-up, not on the timeline.">
          <textarea
            name="description"
            rows={2}
            className={controlClassName}
            defaultValue={valueOf(state, 'description', '')}
          />
        </Field>
      )}

      <ReminderChoice key={`reminders-${selected?.id ?? 'none'}`} defaultValue={reminders} />

      <div>
        <Button type="submit" pending={pending}>
          Schedule it
        </Button>
      </div>
    </form>
  );
}

/**
 * Finishing a follow-up, and planning the next one in the same breath (`FR-TSK-6`).
 *
 * The outcome cannot be skipped, because the API will not accept a completion without one — and a
 * month later "what happened on those forty calls" has to have an answer. The next follow-up is
 * offered on the same form rather than on a second screen, because somebody who has just put the
 * phone down knows when to call again and will not come back to say so.
 */
export function CompleteTaskForm({ task, config }: { task: TaskSummary; config: TaskConfig }) {
  const [state, action, pending] = useActionState(completeTask, IDLE);
  const submittedOutcome = state.status === 'error' ? (state.values?.['outcomeId'] ?? '') : '';
  const [outcomeId, setOutcomeId] = useState(submittedOutcome);
  const outcome = config.outcomes.find((row) => row.id === (outcomeId || submittedOutcome));
  const [scheduleNext, setScheduleNext] = useState(
    state.status === 'error' ? state.values?.['scheduleNext'] === 'on' : false,
  );
  const due = defaultDue();

  return (
    <form action={action} className="flex flex-col gap-3">
      <TimezoneOffset />
      <input type="hidden" name="id" value={task.id} />
      {task.leadId && <input type="hidden" name="leadId" value={task.leadId} />}
      {state.status === 'error' && <ErrorNotice>{state.message}</ErrorNotice>}
      {state.status === 'success' && (
        <p role="status" data-task-done className="text-sm text-[var(--color-success)]">
          {state.message}
        </p>
      )}

      <Field
        label="What happened"
        {...(errorOf(state, 'outcomeId') ? { error: errorOf(state, 'outcomeId') } : {})}
      >
        <select
          key={`outcome-${submittedOutcome}`}
          name="outcomeId"
          required
          defaultValue={submittedOutcome}
          onChange={(event) => setOutcomeId(event.target.value)}
          className={controlClassName}
        >
          <option value="">Choose an outcome</option>
          {config.outcomes.map((row) => (
            <option key={row.id} value={row.id}>
              {row.name}
            </option>
          ))}
        </select>
      </Field>

      <Field
        label={outcome?.requiresNote ? 'Note (required for this outcome)' : 'Note'}
        {...(errorOf(state, 'note') ? { error: errorOf(state, 'note') } : {})}
      >
        <textarea
          name="note"
          rows={2}
          required={outcome?.requiresNote === true}
          className={controlClassName}
          defaultValue={valueOf(state, 'note', '')}
        />
      </Field>

      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          name="scheduleNext"
          checked={scheduleNext}
          onChange={(event) => setScheduleNext(event.target.checked)}
        />
        Schedule the next follow-up now
      </label>

      {scheduleNext && (
        <div className="grid gap-3 rounded-md border border-[var(--color-border)] p-3 sm:grid-cols-2">
          <Field label="Next follow-up">
            <input
              name="nextTitle"
              maxLength={200}
              className={controlClassName}
              placeholder={`Follow up: ${task.title}`}
              defaultValue={valueOf(state, 'nextTitle', '')}
            />
          </Field>
          <Field label="Kind">
            <select name="nextTaskTypeId" defaultValue="" className={controlClassName}>
              <option value="">Same as this one</option>
              {config.types.map((type) => (
                <option key={type.id} value={type.id}>
                  {type.name}
                </option>
              ))}
            </select>
          </Field>
          <Field
            label="Date"
            {...(errorOf(state, 'dueDate') ? { error: errorOf(state, 'dueDate') } : {})}
          >
            <input
              type="date"
              name="dueDate"
              required
              className={controlClassName}
              defaultValue={valueOf(state, 'dueDate', due.date)}
            />
          </Field>
          <Field label="Time">
            <input
              type="time"
              name="dueTime"
              className={controlClassName}
              defaultValue={valueOf(state, 'dueTime', due.time)}
            />
          </Field>
        </div>
      )}

      <div>
        <Button type="submit" pending={pending}>
          Mark done
        </Button>
      </div>
    </form>
  );
}

/** Moving a follow-up. The reason is mandatory, and some reasons ask for a note (`FR-TSK-5`). */
export function RescheduleTaskForm({
  task,
  reasons,
}: {
  task: TaskSummary;
  reasons: RescheduleReason[];
}) {
  const [state, action, pending] = useActionState(rescheduleTask, IDLE);
  const submittedReason = state.status === 'error' ? (state.values?.['reasonId'] ?? '') : '';
  const [reasonId, setReasonId] = useState(submittedReason);
  const reason = reasons.find((row) => row.id === (reasonId || submittedReason));
  const current = dueFields(new Date(task.dueAt));

  return (
    <form action={action} className="flex flex-col gap-3">
      <TimezoneOffset />
      <input type="hidden" name="id" value={task.id} />
      {task.leadId && <input type="hidden" name="leadId" value={task.leadId} />}
      {state.status === 'error' && <ErrorNotice>{state.message}</ErrorNotice>}
      {state.status === 'success' && (
        <p role="status" data-task-moved className="text-sm text-[var(--color-success)]">
          {state.message}
        </p>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        <Field
          label="New date"
          {...(errorOf(state, 'dueAt') ? { error: errorOf(state, 'dueAt') } : {})}
          {...(errorOf(state, 'dueDate') ? { error: errorOf(state, 'dueDate') } : {})}
        >
          <input
            type="date"
            name="dueDate"
            required
            className={controlClassName}
            defaultValue={valueOf(state, 'dueDate', current.date)}
          />
        </Field>
        <Field label="New time">
          <input
            type="time"
            name="dueTime"
            className={controlClassName}
            defaultValue={valueOf(state, 'dueTime', current.time)}
          />
        </Field>
      </div>

      <Field
        label="Why it is moving"
        hint="Required. Chronic rescheduling is the signal a manager needs."
        {...(errorOf(state, 'reasonId') ? { error: errorOf(state, 'reasonId') } : {})}
      >
        <select
          key={`reason-${submittedReason}`}
          name="reasonId"
          required
          defaultValue={submittedReason}
          onChange={(event) => setReasonId(event.target.value)}
          className={controlClassName}
        >
          <option value="">Choose a reason</option>
          {reasons.map((row) => (
            <option key={row.id} value={row.id}>
              {row.name}
            </option>
          ))}
        </select>
      </Field>

      {reason?.requiresNote && (
        <Field
          label="Note (required for this reason)"
          {...(errorOf(state, 'note') ? { error: errorOf(state, 'note') } : {})}
        >
          <input
            name="note"
            required
            className={controlClassName}
            defaultValue={valueOf(state, 'note', '')}
          />
        </Field>
      )}

      <div>
        <Button type="submit" variant="secondary" pending={pending}>
          Move it
        </Button>
      </div>
    </form>
  );
}

export function CancelTaskForm({ task }: { task: TaskSummary }) {
  const [state, action, pending] = useActionState(cancelTask, IDLE);
  return (
    <form action={action} className="flex flex-wrap items-end gap-2">
      <input type="hidden" name="id" value={task.id} />
      {task.leadId && <input type="hidden" name="leadId" value={task.leadId} />}
      <Field label="Call it off" hint="Kept on the record — “we decided not to” is information.">
        <input
          name="reason"
          className={controlClassName}
          placeholder="They asked us to stop calling"
          defaultValue={valueOf(state, 'reason', '')}
        />
      </Field>
      <Button type="submit" variant="danger" pending={pending}>
        Cancel follow-up
      </Button>
      {state.status === 'error' && <ErrorNotice>{state.message}</ErrorNotice>}
    </form>
  );
}

export function DeleteTaskButton({ task }: { task: TaskSummary }) {
  const [state, action, pending] = useActionState(deleteTask, IDLE);
  return (
    <form action={action}>
      <input type="hidden" name="id" value={task.id} />
      {task.leadId && <input type="hidden" name="leadId" value={task.leadId} />}
      <Button type="submit" variant="quiet" pending={pending}>
        Delete (entered by mistake)
      </Button>
      {state.status === 'error' && <ErrorNotice>{state.message}</ErrorNotice>}
    </form>
  );
}
