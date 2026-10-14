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
 * One row per type, with a box per channel the product can actually deliver on.
 *
 * Not one form with a Save button: a screen where somebody flips a switch, walks away, and is woken
 * at midnight by the notification they believed they had turned off is worse than one that saves on
 * change. The row submits the **whole** channel set, because the set is the intended final answer —
 * the same PUT semantics the lead tag picker uses, and for the same reason.
 *
 * `email` appeared here in Phase 3 step 7, when there was a sender behind it. The channels this
 * release cannot deliver on are not rendered at all: a greyed-out tick box invites somebody to try
 * it, and a live one would be a promise the product breaks.
 */
export function TypeSwitch({
  entry,
  channels,
}: {
  entry: NotificationTypePreference;
  /** What the API says it can deliver. Rendered in this order, in-app first. */
  channels: readonly string[];
}) {
  const [state, submit, pending] = useActionState(saveNotificationType, IDLE);
  const chosen = entry.effectiveChannels;
  const on = chosen.length > 0;

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
      <div className="flex flex-wrap items-center gap-3">
        {/*
          The state as text, not only as a control. A settings row whose value lives inside an
          input is one nothing can read back — the lesson the payment-methods list paid for.
        */}
        <span className="text-xs text-[var(--color-text-muted)]" data-type-state={entry.type}>
          {on ? chosen.map((channel) => CHANNEL_LABELS[channel] ?? channel).join(' + ') : 'Off'}
          {entry.channels === null && on ? ' (default)' : ''}
        </span>
        <input type="hidden" name="type" value={entry.type} />
        {channels.map((channel) => (
          <label key={channel} className="flex items-center gap-1.5 text-sm">
            <input
              type="checkbox"
              name="channels"
              value={channel}
              defaultChecked={chosen.includes(channel)}
              data-channel={`${entry.type}:${channel}`}
            />
            {CHANNEL_LABELS[channel] ?? channel}
          </label>
        ))}
        <Button type="submit" variant="secondary" pending={pending}>
          {pending ? 'Saving…' : 'Save'}
        </Button>
      </div>
    </form>
  );
}

/** The words a person reads, rather than the column values. */
const CHANNEL_LABELS: Record<string, string> = {
  in_app: 'In the app',
  email: 'Email',
  whatsapp: 'WhatsApp',
  push: 'Push',
};
