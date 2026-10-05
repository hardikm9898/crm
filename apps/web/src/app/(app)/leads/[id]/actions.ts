'use server';

import { revalidatePath } from 'next/cache';
import { callApi, text } from '@/lib/server-action';
import type { ActionState } from '@/lib/action-state';

/**
 * Lead detail mutations.
 *
 * Each transition is its own action because each is its own endpoint with its own permission,
 * preconditions and history table on the API side — a single `updateLead` here would have to decide
 * which of them a form meant, which is exactly the ambiguity the API avoids by splitting them.
 */

function revalidateLead(id: string): void {
  revalidatePath(`/leads/${id}`);
  revalidatePath('/leads');
  revalidatePath('/pipeline');
}

export async function changeStatus(_previous: ActionState, form: FormData): Promise<ActionState> {
  const id = text(form, 'leadId');
  const statusId = text(form, 'statusId');
  if (!id || !statusId) return { status: 'error', message: 'Choose a status.' };
  const state = await callApi(
    `/leads/${id}/status`,
    {
      method: 'POST',
      body: {
        statusId,
        ...(text(form, 'lostReasonId') ? { lostReasonId: text(form, 'lostReasonId') } : {}),
        ...(text(form, 'lostNote') ? { lostNote: text(form, 'lostNote') } : {}),
      },
    },
    'Status updated',
  );
  revalidateLead(id);
  return state;
}

export async function changeStage(_previous: ActionState, form: FormData): Promise<ActionState> {
  const id = text(form, 'leadId');
  const stageId = text(form, 'stageId');
  if (!id || !stageId) return { status: 'error', message: 'Choose a stage.' };
  const state = await callApi(
    `/leads/${id}/stage`,
    { method: 'POST', body: { stageId } },
    'Stage updated',
  );
  revalidateLead(id);
  return state;
}

export async function assignLead(_previous: ActionState, form: FormData): Promise<ActionState> {
  const id = text(form, 'leadId');
  if (!id) return { status: 'error', message: 'Which lead?' };
  const assignedUserId = text(form, 'assignedUserId') ?? null;
  const state = await callApi(
    `/leads/${id}/assign`,
    {
      method: 'POST',
      body: { assignedUserId, ...(text(form, 'reason') ? { reason: text(form, 'reason') } : {}) },
    },
    assignedUserId ? 'Lead assigned' : 'Returned to the unassigned pool',
  );
  revalidateLead(id);
  return state;
}

export async function setTags(_previous: ActionState, form: FormData): Promise<ActionState> {
  const id = text(form, 'leadId');
  if (!id) return { status: 'error', message: 'Which lead?' };
  // PUT semantics: the checkbox set *is* the intended final set, which is why every box is
  // submitted rather than only the one that changed.
  const tagIds = form
    .getAll('tagIds')
    .filter((value): value is string => typeof value === 'string');
  const state = await callApi(
    `/leads/${id}/tags`,
    { method: 'PUT', body: { tagIds } },
    'Tags updated',
  );
  revalidateLead(id);
  return state;
}

export async function updateLead(_previous: ActionState, form: FormData): Promise<ActionState> {
  const id = text(form, 'leadId');
  if (!id) return { status: 'error', message: 'Which lead?' };

  const body: Record<string, unknown> = {};
  for (const key of [
    'firstName',
    'lastName',
    'company',
    'jobTitle',
    'email',
    'phone',
    'whatsapp',
    'city',
    'state',
    'postalCode',
  ]) {
    const value = text(form, key);
    // An empty box means "clear this", which is not the same as "leave it alone" — so a field the
    // form submitted is always sent, as a value or as null.
    if (form.has(key)) body[key] = value ?? null;
  }
  const value = text(form, 'value');
  if (form.has('value')) {
    if (value === undefined) body['valueMinor'] = null;
    else {
      const amount = Number(value);
      if (!Number.isFinite(amount) || amount < 0) {
        return {
          status: 'error',
          message: 'Some details need correcting.',
          fieldErrors: { value: 'Enter an amount, or clear the box.' },
        };
      }
      body['valueMinor'] = Math.round(amount * 100);
      body['currency'] = text(form, 'currency') ?? 'INR';
    }
  }
  const priority = text(form, 'priority');
  if (priority) body['priority'] = priority;

  const state = await callApi(`/leads/${id}`, { method: 'PATCH', body }, 'Lead updated');
  revalidateLead(id);
  return state;
}

export async function addTouchpoint(_previous: ActionState, form: FormData): Promise<ActionState> {
  const id = text(form, 'leadId');
  const channel = text(form, 'channel');
  if (!id || !channel) return { status: 'error', message: 'Which channel?' };
  const state = await callApi(
    `/leads/${id}/touchpoints`,
    {
      method: 'POST',
      body: {
        channel,
        ...(text(form, 'leadSourceId') ? { leadSourceId: text(form, 'leadSourceId') } : {}),
      },
    },
    'Touchpoint recorded',
  );
  revalidateLead(id);
  return state;
}

export async function recomputeScore(_previous: ActionState, form: FormData): Promise<ActionState> {
  const id = text(form, 'leadId');
  if (!id) return { status: 'error', message: 'Which lead?' };
  const state = await callApi(
    `/leads/${id}/recompute-score`,
    { method: 'POST' },
    'Score recalculated',
  );
  revalidateLead(id);
  return state;
}

export async function deleteLead(_previous: ActionState, form: FormData): Promise<ActionState> {
  const id = text(form, 'leadId');
  if (!id) return { status: 'error', message: 'Which lead?' };
  const state = await callApi(
    `/leads/${id}`,
    { method: 'DELETE' },
    'Moved to the recycle bin. Nothing is destroyed.',
  );
  revalidateLead(id);
  return state;
}

export async function dismissDuplicate(
  _previous: ActionState,
  form: FormData,
): Promise<ActionState> {
  const pairId = text(form, 'pairId');
  const leadId = text(form, 'leadId');
  if (!pairId) return { status: 'error', message: 'Which pair?' };
  const state = await callApi(
    `/duplicates/${pairId}/dismiss`,
    { method: 'POST' },
    'Recorded as different people',
  );
  if (leadId) revalidateLead(leadId);
  return state;
}
