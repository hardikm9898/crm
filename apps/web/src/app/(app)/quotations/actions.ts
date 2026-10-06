'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { describeError, request } from '@/lib/api';
import { callApi, fieldErrorsOf, submittedValues, text } from '@/lib/server-action';
import { readAccessToken } from '@/lib/session';
import { parseLineItems } from '@/lib/line-items-form';
import type { ActionState } from '@/lib/action-state';

/**
 * Quotation mutations.
 *
 * Every lifecycle move is its own action against its own endpoint — send, accept, reject, revise —
 * because each has its own preconditions on the API. A single "set status" form would be a client
 * asserting a state machine it cannot check.
 *
 * The lines go through `parseLineItems`, shared with the deal editor: the same table, read the same
 * way, so a blank row and a bad quantity behave identically on both screens.
 */

function refresh(id?: string): void {
  revalidatePath('/quotations');
  if (id) revalidatePath(`/quotations/${id}`);
  revalidatePath('/deals');
}

export async function createQuotation(
  _previous: ActionState,
  form: FormData,
): Promise<ActionState> {
  const token = await readAccessToken();
  if (!token) return { status: 'error', message: 'Please sign in again.' };

  const { items, fieldErrors } = parseLineItems(form);
  if (Object.keys(fieldErrors).length > 0) {
    return { status: 'error', message: 'Some lines need correcting.', fieldErrors };
  }

  const body: Record<string, unknown> = {
    ...(text(form, 'dealId') ? { dealId: text(form, 'dealId') } : {}),
    ...(text(form, 'leadId') ? { leadId: text(form, 'leadId') } : {}),
    ...(text(form, 'customerId') ? { customerId: text(form, 'customerId') } : {}),
    ...(text(form, 'title') ? { title: text(form, 'title') } : {}),
    ...(text(form, 'terms') ? { terms: text(form, 'terms') } : {}),
    ...(text(form, 'validUntil') ? { validUntil: text(form, 'validUntil') } : {}),
    // An empty table means "copy the deal's lines", which is what raising one from a deal means.
    ...(items.length > 0 ? { items } : {}),
  };

  let id: string;
  try {
    id = (await request<{ id: string }>('/quotations', { method: 'POST', body, token })).data.id;
  } catch (error) {
    return {
      status: 'error',
      message: describeError(error),
      ...fieldErrorsOf(error),
      values: submittedValues(form),
    };
  }

  refresh();
  redirect(`/quotations/${id}`);
}

export async function updateQuotation(
  _previous: ActionState,
  form: FormData,
): Promise<ActionState> {
  const id = String(form.get('id') ?? '');
  const body: Record<string, unknown> = {
    // A blank box clears the field, which is how a validity date somebody set by mistake goes away.
    title: text(form, 'title') ?? null,
    terms: text(form, 'terms') ?? null,
    validUntil: text(form, 'validUntil') ?? null,
  };
  const state = await callApi(
    `/quotations/${id}`,
    { method: 'PATCH', body },
    'Quotation saved.',
    form,
  );
  refresh(id);
  return state;
}

export async function setQuotationItems(
  _previous: ActionState,
  form: FormData,
): Promise<ActionState> {
  const id = String(form.get('id') ?? '');
  const { items, fieldErrors } = parseLineItems(form);
  if (Object.keys(fieldErrors).length > 0) {
    return { status: 'error', message: 'Some lines need correcting.', fieldErrors };
  }
  const state = await callApi(
    `/quotations/${id}/items`,
    { method: 'PUT', body: { items } },
    'Lines saved.',
  );
  refresh(id);
  return state;
}

export async function sendQuotation(_previous: ActionState, form: FormData): Promise<ActionState> {
  const id = String(form.get('id') ?? '');
  const state = await callApi(
    `/quotations/${id}/send`,
    {
      method: 'POST',
      body: {
        via: text(form, 'via') ?? 'manual',
        ...(text(form, 'to') ? { to: text(form, 'to') } : {}),
      },
    },
    'Marked as sent.',
    form,
  );
  refresh(id);
  return state;
}

export async function acceptQuotation(
  _previous: ActionState,
  form: FormData,
): Promise<ActionState> {
  const id = String(form.get('id') ?? '');
  const state = await callApi(
    `/quotations/${id}/accept`,
    { method: 'POST', body: { ...(text(form, 'note') ? { note: text(form, 'note') } : {}) } },
    'Quotation accepted.',
    form,
  );
  refresh(id);
  return state;
}

export async function rejectQuotation(
  _previous: ActionState,
  form: FormData,
): Promise<ActionState> {
  const id = String(form.get('id') ?? '');
  const state = await callApi(
    `/quotations/${id}/reject`,
    {
      method: 'POST',
      body: {
        ...(text(form, 'reasonId') ? { reasonId: text(form, 'reasonId') } : {}),
        ...(text(form, 'note') ? { note: text(form, 'note') } : {}),
      },
    },
    'Marked as rejected.',
    form,
  );
  refresh(id);
  return state;
}

/**
 * A revision is a **new** quotation, so this one redirects: leaving the person on the version they
 * just superseded would be showing them the document nobody should be working on.
 */
export async function reviseQuotation(
  _previous: ActionState,
  form: FormData,
): Promise<ActionState> {
  const id = String(form.get('id') ?? '');
  const token = await readAccessToken();
  if (!token) return { status: 'error', message: 'Please sign in again.' };

  let newId: string;
  try {
    newId = (
      await request<{ id: string }>(`/quotations/${id}/revise`, {
        method: 'POST',
        body: {},
        token,
      })
    ).data.id;
  } catch (error) {
    return { status: 'error', message: describeError(error) };
  }
  refresh(id);
  redirect(`/quotations/${newId}`);
}

export async function deleteQuotation(
  _previous: ActionState,
  form: FormData,
): Promise<ActionState> {
  const id = String(form.get('id') ?? '');
  const state = await callApi(`/quotations/${id}`, { method: 'DELETE' }, 'Draft deleted.');
  refresh(id);
  if (state.status === 'success') redirect('/quotations');
  return state;
}

export async function updateNumberSeries(
  _previous: ActionState,
  form: FormData,
): Promise<ActionState> {
  const nextValue = text(form, 'nextValue');
  const state = await callApi(
    '/settings/number-series/quotation',
    {
      method: 'PATCH',
      body: {
        prefix: text(form, 'prefix') ?? '',
        padding: Number(text(form, 'padding') ?? '4'),
        ...(nextValue ? { nextValue: Number(nextValue) } : {}),
      },
    },
    'Numbering saved.',
    form,
  );
  revalidatePath('/settings/quotations');
  return state;
}
