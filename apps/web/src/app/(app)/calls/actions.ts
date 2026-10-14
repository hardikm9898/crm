'use server';

import { revalidatePath } from 'next/cache';
import { describeError, request } from '@/lib/api';
import { callApi, fieldErrorsOf, submittedValues, text } from '@/lib/server-action';
import { readAccessToken } from '@/lib/session';
import { durationSeconds } from '@/lib/calls';
import type { ActionState } from '@/lib/action-state';

/**
 * Call mutations (`FR-CALL-1..3`).
 *
 * Logging and recording the outcome of a dialled call are separate actions against separate
 * endpoints, because they are separate transitions on the API: one creates the record of a call
 * that happened elsewhere, the other closes a row the product itself opened. The PATCH is for
 * attributing an unknown number to a lead, and for fixing a note.
 */
function refresh(leadId?: string | null): void {
  revalidatePath('/calls');
  revalidatePath('/today');
  if (leadId) {
    revalidatePath(`/leads/${leadId}`);
    revalidatePath('/leads');
  }
}

/**
 * `tel:` is handed back to the browser rather than opened here.
 *
 * The server cannot open anything on the person's phone, and the whole value of click-to-call with
 * the manual driver is that the device dials. So the action's success message carries the link the
 * client then follows — which also means a provider driver, which really does place the call,
 * needs no change on this side at all.
 */
export async function dialCall(_previous: ActionState, form: FormData): Promise<ActionState> {
  const token = await readAccessToken();
  if (!token) return { status: 'error', message: 'Please sign in again.' };

  const leadId = text(form, 'leadId');
  const body: Record<string, unknown> = {
    ...(leadId ? { leadId } : {}),
    ...(text(form, 'to') ? { to: text(form, 'to') } : {}),
    ...(text(form, 'taskId') ? { taskId: text(form, 'taskId') } : {}),
  };

  try {
    const response = await request<{
      call: { id: string };
      dial: { mode: 'device'; href: string } | { mode: 'provider'; provider: string };
    }>('/calls/dial', { method: 'POST', body, token });
    refresh(leadId);
    return {
      status: 'success',
      message: response.message ?? 'Dialling',
      data: {
        callId: response.data.call.id,
        // `device` means the product did not place the call — the phone will, once the browser
        // follows this. A provider driver answers `mode: 'provider'` and there is nothing to open.
        ...(response.data.dial.mode === 'device' ? { href: response.data.dial.href } : {}),
      },
    };
  } catch (error) {
    return {
      status: 'error',
      message: describeError(error),
      ...fieldErrorsOf(error),
      values: submittedValues(form),
    };
  }
}

export async function logCall(_previous: ActionState, form: FormData): Promise<ActionState> {
  const leadId = text(form, 'leadId');
  const outcomeId = text(form, 'outcomeId');
  if (!outcomeId) {
    return {
      status: 'error',
      message: 'Some details need correcting.',
      fieldErrors: { outcomeId: 'Say what happened on the call.' },
      values: submittedValues(form),
    };
  }

  const seconds = durationSeconds(
    text(form, 'durationMinutes') ?? null,
    text(form, 'durationSeconds') ?? null,
  );
  const status = text(form, 'status') ?? 'completed';
  const taskId = text(form, 'taskId');
  const state = await callApi(
    '/calls',
    {
      method: 'POST',
      body: {
        ...(leadId ? { leadId } : {}),
        ...(taskId ? { taskId } : {}),
        direction: text(form, 'direction') === 'inbound' ? 'inbound' : 'outbound',
        status,
        outcomeId,
        ...(text(form, 'toE164') ? { toE164: text(form, 'toE164') } : {}),
        ...(text(form, 'fromE164') ? { fromE164: text(form, 'fromE164') } : {}),
        // A duration only belongs to a call that connected — the API and the database both say so,
        // and sending one on a no-answer would be a refusal the person did not cause.
        ...(seconds !== null && status === 'completed' ? { durationSeconds: seconds } : {}),
        ...(text(form, 'notes') ? { notes: text(form, 'notes') } : {}),
        // Closing the loop `FR-TSK-6` opened: one action, from the person's point of view.
        ...(taskId && text(form, 'finishOutcomeId')
          ? {
              finishFollowUp: {
                outcomeId: text(form, 'finishOutcomeId'),
                ...(text(form, 'notes') ? { note: text(form, 'notes') } : {}),
              },
            }
          : {}),
      },
    },
    'Call logged',
    form,
  );
  refresh(leadId);
  return state;
}

export async function recordCallOutcome(
  _previous: ActionState,
  form: FormData,
): Promise<ActionState> {
  const id = text(form, 'id');
  const leadId = text(form, 'leadId');
  const outcomeId = text(form, 'outcomeId');
  if (!id || !outcomeId) {
    return {
      status: 'error',
      message: 'Some details need correcting.',
      fieldErrors: { outcomeId: 'Say what happened on the call.' },
      values: submittedValues(form),
    };
  }
  const seconds = durationSeconds(
    text(form, 'durationMinutes') ?? null,
    text(form, 'durationSeconds') ?? null,
  );
  const status = text(form, 'status') ?? 'completed';
  const state = await callApi(
    `/calls/${id}/outcome`,
    {
      method: 'POST',
      body: {
        status,
        outcomeId,
        ...(seconds !== null && status === 'completed' ? { durationSeconds: seconds } : {}),
        ...(text(form, 'notes') ? { notes: text(form, 'notes') } : {}),
      },
    },
    'Call outcome saved',
    form,
  );
  refresh(leadId);
  return state;
}

/** Attributing a call from a number nobody recognised, and fixing a note. */
export async function updateCall(_previous: ActionState, form: FormData): Promise<ActionState> {
  const id = text(form, 'id');
  if (!id) return { status: 'error', message: 'Which call?' };
  const leadId = text(form, 'leadId');
  const body: Record<string, unknown> = {};
  if (form.has('leadId')) body['leadId'] = leadId ?? null;
  if (form.has('notes')) body['notes'] = text(form, 'notes') ?? null;
  const state = await callApi(`/calls/${id}`, { method: 'PATCH', body }, 'Call saved', form);
  refresh(leadId);
  return state;
}

export async function deleteCall(_previous: ActionState, form: FormData): Promise<ActionState> {
  const id = text(form, 'id');
  if (!id) return { status: 'error', message: 'Which call?' };
  const state = await callApi(`/calls/${id}`, { method: 'DELETE' }, 'Call removed');
  refresh(text(form, 'leadId'));
  return state;
}

// ── The outcome vocabulary ───────────────────────────────────────────────────

function refreshSettings(): void {
  revalidatePath('/settings/calls');
  revalidatePath('/calls');
}

export async function createCallOutcome(
  _previous: ActionState,
  form: FormData,
): Promise<ActionState> {
  const name = text(form, 'name');
  const category = text(form, 'category');
  if (!name || !category) {
    return {
      status: 'error',
      message: 'Some details need correcting.',
      fieldErrors: {
        ...(name ? {} : { name: 'Give the outcome a name.' }),
        ...(category ? {} : { category: 'Say which kind of outcome this is.' }),
      },
      values: submittedValues(form),
    };
  }
  const state = await callApi(
    '/settings/call-outcomes',
    {
      method: 'POST',
      body: {
        name,
        category,
        requiresNote: form.get('requiresNote') === 'on',
        ...(text(form, 'sortOrder') ? { sortOrder: Number(text(form, 'sortOrder')) } : {}),
      },
    },
    'Call outcome added',
    form,
  );
  refreshSettings();
  return state;
}

export async function updateCallOutcome(
  _previous: ActionState,
  form: FormData,
): Promise<ActionState> {
  const id = text(form, 'id');
  if (!id) return { status: 'error', message: 'Which outcome?' };
  const state = await callApi(
    `/settings/call-outcomes/${id}`,
    {
      method: 'PATCH',
      body: {
        ...(text(form, 'name') ? { name: text(form, 'name') } : {}),
        ...(text(form, 'category') ? { category: text(form, 'category') } : {}),
        requiresNote: form.get('requiresNote') === 'on',
        isActive: form.get('isActive') === 'on',
      },
    },
    'Call outcome saved',
    form,
  );
  refreshSettings();
  return state;
}

export async function deleteCallOutcome(
  _previous: ActionState,
  form: FormData,
): Promise<ActionState> {
  const id = text(form, 'id');
  if (!id) return { status: 'error', message: 'Which outcome?' };
  const state = await callApi(
    `/settings/call-outcomes/${id}`,
    { method: 'DELETE' },
    'Call outcome removed',
  );
  refreshSettings();
  return state;
}
