'use server';

import { revalidatePath } from 'next/cache';
import { callApi, submittedValues, text } from '@/lib/server-action';
import type { ActionState } from '@/lib/action-state';

/**
 * Task mutations.
 *
 * Complete, reschedule and cancel are separate actions against separate endpoints, because each is
 * its own transition on the API with its own preconditions — an outcome, a reason, a note the reason
 * demands — and its own effect on the lead's next action.
 *
 * **The due time is assembled here from a date and a time**, in the browser's offset, which the
 * form sends alongside them. A `datetime-local` would be one field and is unusable on an Indian
 * Android keyboard; two fields are what somebody planning a call actually fills in.
 */
function refresh(paths: readonly (string | null | undefined)[] = []): void {
  revalidatePath('/tasks');
  revalidatePath('/leads');
  revalidatePath('/dashboard');
  for (const path of paths) if (path) revalidatePath(path);
}

/**
 * A date, a time and the browser's offset, as one instant.
 *
 * The offset is sent by the form rather than assumed, because the server renders in UTC and a
 * follow-up "at 10:00" means ten o'clock where the person typing it is. Returning `null` rather
 * than guessing is deliberate: a task due at the wrong hour is worse than a refused form.
 */
function instantFrom(form: FormData): string | null {
  const date = text(form, 'dueDate');
  const time = text(form, 'dueTime') ?? '10:00';
  if (!date) return null;
  const offset = text(form, 'timezoneOffset');
  const minutes = offset === undefined ? null : Number(offset);
  if (minutes === null || Number.isNaN(minutes)) {
    // No offset means the browser did not tell us; the server's own zone is the only other
    // answer and it is usually UTC, which would be hours out.
    const naive = new Date(`${date}T${time}:00`);
    return Number.isNaN(naive.getTime()) ? null : naive.toISOString();
  }
  const asUtc = Date.parse(`${date}T${time}:00.000Z`);
  if (Number.isNaN(asUtc)) return null;
  // `getTimezoneOffset()` is positive west of UTC, which is why this adds rather than subtracts.
  return new Date(asUtc + minutes * 60_000).toISOString();
}

function dueError(form: FormData): ActionState {
  return {
    status: 'error',
    message: 'Some details need correcting.',
    fieldErrors: { dueDate: 'Pick a date for the follow-up.' },
    // Echoed back, or the refusal costs somebody every field they just typed.
    values: submittedValues(form),
  };
}

function offsets(form: FormData): number[] | undefined {
  const raw = form
    .getAll('reminderOffsets')
    .filter((value): value is string => typeof value === 'string');
  if (raw.length === 0) return undefined;
  return raw.map((value) => Number(value)).filter((value) => Number.isInteger(value) && value >= 0);
}

export async function createTask(_previous: ActionState, form: FormData): Promise<ActionState> {
  const dueAt = instantFrom(form);
  if (!dueAt) return dueError(form);

  const reminders = offsets(form);
  const state = await callApi(
    '/tasks',
    {
      method: 'POST',
      body: {
        ...(text(form, 'leadId') ? { leadId: text(form, 'leadId') } : {}),
        ...(text(form, 'customerId') ? { customerId: text(form, 'customerId') } : {}),
        ...(text(form, 'dealId') ? { dealId: text(form, 'dealId') } : {}),
        title: text(form, 'title') ?? '',
        ...(text(form, 'description') ? { description: text(form, 'description') } : {}),
        ...(text(form, 'taskTypeId') ? { taskTypeId: text(form, 'taskTypeId') } : {}),
        dueAt,
        priority: text(form, 'priority') ?? 'medium',
        ...(text(form, 'assignedUserId') ? { assignedUserId: text(form, 'assignedUserId') } : {}),
        ...(reminders === undefined ? {} : { reminderOffsets: reminders }),
      },
    },
    'Follow-up scheduled.',
    form,
  );
  refresh([text(form, 'leadId') ? `/leads/${text(form, 'leadId')}` : null]);
  return state;
}

export async function completeTask(_previous: ActionState, form: FormData): Promise<ActionState> {
  const id = String(form.get('id') ?? '');
  const wantsFollowUp = form.get('scheduleNext') === 'on';
  const nextDueAt = wantsFollowUp ? instantFrom(form) : null;
  if (wantsFollowUp && !nextDueAt) return dueError(form);

  const state = await callApi(
    `/tasks/${id}/complete`,
    {
      method: 'POST',
      body: {
        outcomeId: text(form, 'outcomeId') ?? '',
        ...(text(form, 'note') ? { note: text(form, 'note') } : {}),
        ...(nextDueAt
          ? {
              nextFollowUp: {
                ...(text(form, 'nextTitle') ? { title: text(form, 'nextTitle') } : {}),
                ...(text(form, 'nextTaskTypeId')
                  ? { taskTypeId: text(form, 'nextTaskTypeId') }
                  : {}),
                dueAt: nextDueAt,
              },
            }
          : {}),
      },
    },
    'Follow-up completed.',
    form,
  );
  refresh([text(form, 'leadId') ? `/leads/${text(form, 'leadId')}` : null]);
  return state;
}

export async function rescheduleTask(_previous: ActionState, form: FormData): Promise<ActionState> {
  const id = String(form.get('id') ?? '');
  const dueAt = instantFrom(form);
  if (!dueAt) return dueError(form);

  const state = await callApi(
    `/tasks/${id}/reschedule`,
    {
      method: 'POST',
      body: {
        dueAt,
        reasonId: text(form, 'reasonId') ?? '',
        ...(text(form, 'note') ? { note: text(form, 'note') } : {}),
      },
    },
    'Follow-up moved.',
    form,
  );
  refresh([text(form, 'leadId') ? `/leads/${text(form, 'leadId')}` : null]);
  return state;
}

export async function cancelTask(_previous: ActionState, form: FormData): Promise<ActionState> {
  const id = String(form.get('id') ?? '');
  const state = await callApi(
    `/tasks/${id}/cancel`,
    { method: 'POST', body: { ...(text(form, 'reason') ? { reason: text(form, 'reason') } : {}) } },
    'Follow-up called off.',
    form,
  );
  refresh([text(form, 'leadId') ? `/leads/${text(form, 'leadId')}` : null]);
  return state;
}

export async function deleteTask(_previous: ActionState, form: FormData): Promise<ActionState> {
  const id = String(form.get('id') ?? '');
  const state = await callApi(`/tasks/${id}`, { method: 'DELETE' }, 'Task deleted.');
  refresh([text(form, 'leadId') ? `/leads/${text(form, 'leadId')}` : null]);
  return state;
}

// ── The follow-up vocabulary (rule 4) ───────────────────────────────────────

function refreshSettings(): void {
  revalidatePath('/settings/follow-ups');
  revalidatePath('/tasks');
}

export async function createTaskType(_previous: ActionState, form: FormData): Promise<ActionState> {
  const state = await callApi(
    '/settings/task-types',
    {
      method: 'POST',
      body: {
        name: text(form, 'name') ?? '',
        ...(text(form, 'defaultDurationMinutes')
          ? { defaultDurationMinutes: Number(text(form, 'defaultDurationMinutes')) }
          : {}),
        ...(offsets(form) === undefined ? {} : { defaultReminderOffsets: offsets(form) }),
      },
    },
    'Task type added.',
    form,
  );
  refreshSettings();
  return state;
}

export async function updateTaskType(_previous: ActionState, form: FormData): Promise<ActionState> {
  const id = String(form.get('id') ?? '');
  const state = await callApi(
    `/settings/task-types/${id}`,
    {
      method: 'PATCH',
      body: {
        ...(text(form, 'name') ? { name: text(form, 'name') } : {}),
        ...(form.get('isActive') === null ? {} : { isActive: form.get('isActive') === 'on' }),
      },
    },
    'Task type saved.',
    form,
  );
  refreshSettings();
  return state;
}

export async function deleteTaskType(_previous: ActionState, form: FormData): Promise<ActionState> {
  const id = String(form.get('id') ?? '');
  const state = await callApi(
    `/settings/task-types/${id}`,
    { method: 'DELETE' },
    'Task type removed.',
  );
  refreshSettings();
  return state;
}

export async function createTaskOutcome(
  _previous: ActionState,
  form: FormData,
): Promise<ActionState> {
  const positive = text(form, 'isPositive');
  const state = await callApi(
    '/settings/task-outcomes',
    {
      method: 'POST',
      body: {
        name: text(form, 'name') ?? '',
        // "Neither" is a real answer — a no-answer is not a failure — so an unset radio stays null.
        isPositive: positive === 'yes' ? true : positive === 'no' ? false : null,
        requiresNote: form.get('requiresNote') === 'on',
      },
    },
    'Outcome added.',
    form,
  );
  refreshSettings();
  return state;
}

export async function updateTaskOutcome(
  _previous: ActionState,
  form: FormData,
): Promise<ActionState> {
  const id = String(form.get('id') ?? '');
  const state = await callApi(
    `/settings/task-outcomes/${id}`,
    {
      method: 'PATCH',
      body: {
        ...(text(form, 'name') ? { name: text(form, 'name') } : {}),
        requiresNote: form.get('requiresNote') === 'on',
        ...(form.get('isActive') === null ? {} : { isActive: form.get('isActive') === 'on' }),
      },
    },
    'Outcome saved.',
    form,
  );
  refreshSettings();
  return state;
}

export async function deleteTaskOutcome(
  _previous: ActionState,
  form: FormData,
): Promise<ActionState> {
  const id = String(form.get('id') ?? '');
  const state = await callApi(
    `/settings/task-outcomes/${id}`,
    { method: 'DELETE' },
    'Outcome removed.',
  );
  refreshSettings();
  return state;
}

export async function createRescheduleReason(
  _previous: ActionState,
  form: FormData,
): Promise<ActionState> {
  const state = await callApi(
    '/settings/reschedule-reasons',
    {
      method: 'POST',
      body: { name: text(form, 'name') ?? '', requiresNote: form.get('requiresNote') === 'on' },
    },
    'Reason added.',
    form,
  );
  refreshSettings();
  return state;
}

export async function updateRescheduleReason(
  _previous: ActionState,
  form: FormData,
): Promise<ActionState> {
  const id = String(form.get('id') ?? '');
  const state = await callApi(
    `/settings/reschedule-reasons/${id}`,
    {
      method: 'PATCH',
      body: {
        ...(text(form, 'name') ? { name: text(form, 'name') } : {}),
        requiresNote: form.get('requiresNote') === 'on',
        ...(form.get('isActive') === null ? {} : { isActive: form.get('isActive') === 'on' }),
      },
    },
    'Reason saved.',
    form,
  );
  refreshSettings();
  return state;
}

export async function deleteRescheduleReason(
  _previous: ActionState,
  form: FormData,
): Promise<ActionState> {
  const id = String(form.get('id') ?? '');
  const state = await callApi(
    `/settings/reschedule-reasons/${id}`,
    { method: 'DELETE' },
    'Reason removed.',
  );
  refreshSettings();
  return state;
}
