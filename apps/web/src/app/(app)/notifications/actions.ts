'use server';

import { revalidatePath } from 'next/cache';
import { callApi, submittedValues, text } from '@/lib/server-action';
import type { ActionState } from '@/lib/action-state';

/**
 * Marking notifications read.
 *
 * The badge in the shell is rendered server-side, so both actions revalidate the layout's path as
 * well as this page — otherwise the count would stay stale until the next full navigation.
 */
export async function markRead(_previous: ActionState, form: FormData): Promise<ActionState> {
  const id = text(form, 'notificationId');
  if (!id) return { status: 'error', message: 'Nothing to mark.' };

  const result = await callApi(
    `/notifications/${encodeURIComponent(id)}/read`,
    { method: 'POST', body: {} },
    'Marked as read',
  );
  if (result.status === 'success') {
    revalidatePath('/notifications');
    revalidatePath('/dashboard');
  }
  return result;
}

export async function markAllRead(): Promise<ActionState> {
  const result = await callApi(
    '/notifications/read-all',
    { method: 'POST', body: {} },
    'All caught up',
  );
  if (result.status === 'success') {
    revalidatePath('/notifications');
    revalidatePath('/dashboard');
  }
  return result;
}

/**
 * The quiet window (`FR-NOT-3`).
 *
 * Sent as two times of day and a zone, which is what the form holds; the API turns them into
 * minutes on a local day. `PATCH`, so saving this half cannot clear the type switches below it.
 */
export async function saveQuietHours(_previous: ActionState, form: FormData): Promise<ActionState> {
  const off = form.get('quietHoursOff') === 'on';
  const start = text(form, 'quietStart');
  const end = text(form, 'quietEnd');
  const zone = text(form, 'timeZone');

  if (!off && (!start || !end)) {
    return {
      status: 'error',
      message: 'Some details need correcting.',
      fieldErrors: { quietStart: 'Pick the window you do not want to be told in.' },
      values: submittedValues(form),
    };
  }

  const result = await callApi(
    '/notifications/preferences',
    {
      method: 'PATCH',
      body: {
        quietHours: off ? null : { start, end },
        // An empty zone means "follow the workspace", which is `null` rather than a missing key:
        // absent would leave whatever was there, and somebody clearing the box means to clear it.
        timeZone: zone ?? null,
      },
    },
    'Quiet hours saved',
    form,
  );
  if (result.status === 'success') {
    revalidatePath('/notifications');
    revalidatePath('/dashboard');
  }
  return result;
}

/**
 * One type's switch.
 *
 * One action per switch rather than a single form for all of them: a screen with seven checkboxes
 * and one Save button is one where somebody flips a switch, walks away, and is woken up at
 * midnight by the notification they thought they had turned off.
 */
export async function saveNotificationType(
  _previous: ActionState,
  form: FormData,
): Promise<ActionState> {
  const type = text(form, 'type');
  if (!type) return { status: 'error', message: 'Nothing to change.' };
  const on = form.get('on') === 'true';

  const result = await callApi(
    '/notifications/preferences',
    { method: 'PATCH', body: { types: [{ type, channels: on ? ['in_app'] : [] }] } },
    on ? 'Turned on' : 'Turned off',
    form,
  );
  if (result.status === 'success') {
    revalidatePath('/notifications');
    revalidatePath('/dashboard');
  }
  return result;
}
