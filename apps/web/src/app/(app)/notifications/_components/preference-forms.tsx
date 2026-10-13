'use client';

import { useActionState } from 'react';
import { Button, Field, controlClassName } from '@/components/ui';
import { IDLE, type ActionState } from '@/lib/action-state';
import {
  formatMinuteOfDay,
  type NotificationPreferences,
  type NotificationTypePreference,
} from '@/lib/notifications';
import { saveNotificationType, saveQuietHours } from '../actions';

/** The two readers every form in this app needs. Narrowing `ActionState` inline is unreadable. */
function errorOf(state: ActionState, key: string): string | undefined {
  return state.status === 'error' ? state.fieldErrors?.[key] : undefined;
}

function valueOf(state: ActionState, key: string, fallback: string): string {
  return state.status === 'error' ? (state.values?.[key] ?? fallback) : fallback;
}

/**
 * The quiet window.
 *
 * Two time inputs and a zone, because that is what the setting is: "do not tell me between these
 * hours, where I am". The zone is a plain text box rather than a four-hundred-entry select — the
 * API validates it against the runtime's own zone list and refuses anything else, and the common
 * case is leaving it blank to follow the workspace.
 */
export function QuietHoursForm({ preferences }: { preferences: NotificationPreferences }) {
  const [state, submit, pending] = useActionState(saveQuietHours, IDLE);

  // Echoed back on a refusal, or a rejected window costs somebody all three fields.
  const start = valueOf(
    state,
    'quietStart',
    preferences.quietHours ? formatMinuteOfDay(preferences.quietHours.startMinute) : '21:30',
  );
  const end = valueOf(
    state,
    'quietEnd',
    preferences.quietHours ? formatMinuteOfDay(preferences.quietHours.endMinute) : '07:00',
  );
  const zone = valueOf(state, 'timeZone', preferences.timeZone ?? '');

  return (
    <form action={submit} className="flex flex-col gap-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field
          label="From"
          error={errorOf(state, 'quietStart')}
          hint="When the quiet window opens."
        >
          <input
            type="time"
            name="quietStart"
            defaultValue={start}
            className={controlClassName}
            data-quiet-start
          />
        </Field>
        <Field
          label="Until"
          hint="When it closes — the next morning, if it is earlier than the start."
        >
          <input
            type="time"
            name="quietEnd"
            defaultValue={end}
            className={controlClassName}
            data-quiet-end
          />
        </Field>
      </div>

      <Field
        label="Your timezone"
        error={errorOf(state, 'timeZone')}
        hint={`Leave blank to follow the workspace (${preferences.workspaceTimeZone}).`}
      >
        <input
          type="text"
          name="timeZone"
          defaultValue={zone}
          placeholder={preferences.workspaceTimeZone}
          className={controlClassName}
          data-quiet-zone
        />
      </Field>

      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" name="quietHoursOff" data-quiet-off />
        <span>Turn quiet hours off entirely</span>
      </label>

      {state.status === 'error' && (
        <p role="alert" className="text-sm text-[var(--color-danger)]" data-quiet-error>
          {state.message}
        </p>
      )}
      {state.status === 'success' && (
        <p className="text-sm text-[var(--color-success)]" data-quiet-saved>
          {state.message}
        </p>
      )}

      <div>
        <Button type="submit" pending={pending}>
          {pending ? 'Saving…' : 'Save quiet hours'}
        </Button>
      </div>
    </form>
  );
}

/**
 * One switch per type, each its own form.
 *
 * Not one form with a Save button: a screen where somebody flips a switch, walks away, and is
 * woken at midnight by the notification they believed they had turned off is worse than one that
 * takes a tap per change. The button says what it will do, not what the state is, so there is
 * never a moment where the control and the truth disagree.
 */
export function TypeSwitch({ entry }: { entry: NotificationTypePreference }) {
  const [state, submit, pending] = useActionState(saveNotificationType, IDLE);
  const on = entry.effectiveChannels.length > 0;

  if (!entry.optOut) {
    return (
      <div
        className="flex flex-wrap items-center justify-between gap-2 py-3"
        data-type={entry.type}
      >
        <div className="min-w-0">
          <p className="text-sm font-medium" data-type-label={entry.type}>
            {entry.label}
          </p>
          <p className="text-sm text-[var(--color-text-muted)]">{entry.hint}</p>
        </div>
        <span
          className="rounded bg-slate-100 px-2 py-0.5 text-xs text-slate-700"
          data-type-state={entry.type}
        >
          Always on
        </span>
      </div>
    );
  }

  return (
    <form
      action={submit}
      className="flex flex-wrap items-center justify-between gap-2 py-3"
      data-type={entry.type}
    >
      <div className="min-w-0">
        <p className="text-sm font-medium" data-type-label={entry.type}>
          {entry.label}
        </p>
        <p className="text-sm text-[var(--color-text-muted)]">{entry.hint}</p>
        {state.status === 'error' && (
          <p role="alert" className="mt-1 text-sm text-[var(--color-danger)]">
            {state.message}
          </p>
        )}
      </div>
      <div className="flex items-center gap-3">
        {/*
          The state as text, not only as a control. A settings row whose value lives inside an
          input is one nothing can read back — the lesson the payment-methods list paid for.
        */}
        <span className="text-xs text-[var(--color-text-muted)]" data-type-state={entry.type}>
          {on ? 'On' : 'Off'}
          {entry.channels === null && on ? ' (default)' : ''}
        </span>
        <input type="hidden" name="type" value={entry.type} />
        <input type="hidden" name="on" value={on ? 'false' : 'true'} />
        <Button type="submit" variant="secondary" pending={pending}>
          {pending ? 'Saving…' : on ? 'Turn off' : 'Turn on'}
        </Button>
      </div>
    </form>
  );
}
