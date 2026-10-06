'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { describeError, request } from '@/lib/api';
import { callApi, fieldErrorsOf, submittedValues, text } from '@/lib/server-action';
import { readAccessToken } from '@/lib/session';
import type { ActionState } from '@/lib/action-state';
import { parseAmountMinor, parseLineItems } from '@/lib/line-items-form';

/**
 * Deal mutations.
 *
 * Winning, losing, reopening and moving are each their own action posting to their own endpoint,
 * because each is its own transition on the API with its own preconditions — the same reason a
 * lead's status, stage and owner are three forms rather than one.
 *
 * **Money arrives as rupees and leaves as paise**, converted by `parseAmountMinor` in
 * `lib/line-items-form` — shared with the quotation actions, which edit the same table.
 */

export async function createDeal(_previous: ActionState, form: FormData): Promise<ActionState> {
  const token = await readAccessToken();
  if (!token) return { status: 'error', message: 'Please sign in again.' };

  const value = parseAmountMinor(text(form, 'value'));
  if (Number.isNaN(value)) {
    return {
      status: 'error',
      message: 'Some details need correcting.',
      fieldErrors: { value: 'Enter an amount, like 250000 or 2,50,000.' },
      values: submittedValues(form),
    };
  }

  const body: Record<string, unknown> = {
    name: text(form, 'name') ?? '',
    ...(text(form, 'leadId') ? { leadId: text(form, 'leadId') } : {}),
    ...(text(form, 'customerId') ? { customerId: text(form, 'customerId') } : {}),
    ...(text(form, 'stageId') ? { stageId: text(form, 'stageId') } : {}),
    ...(value === null ? {} : { valueMinor: value }),
    ...(text(form, 'expectedCloseDate')
      ? { expectedCloseDate: text(form, 'expectedCloseDate') }
      : {}),
  };

  let id: string;
  try {
    id = (await request<{ id: string }>('/deals', { method: 'POST', body, token })).data.id;
  } catch (error) {
    return {
      status: 'error',
      message: describeError(error),
      ...fieldErrorsOf(error),
      values: submittedValues(form),
    };
  }

  revalidatePath('/deals');
  redirect(`/deals/${id}`);
}

export async function moveDeal(_previous: ActionState, form: FormData): Promise<ActionState> {
  const id = String(form.get('id') ?? '');
  const state = await callApi(
    `/deals/${id}/stage`,
    { method: 'POST', body: { stageId: text(form, 'stageId') } },
    'Deal moved.',
  );
  revalidatePath('/deals');
  revalidatePath(`/deals/${id}`);
  return state;
}

export async function winDeal(_previous: ActionState, form: FormData): Promise<ActionState> {
  const id = String(form.get('id') ?? '');
  const note = text(form, 'note');
  const state = await callApi(
    `/deals/${id}/win`,
    { method: 'POST', body: note ? { note } : {} },
    'Marked won.',
    form,
  );
  revalidatePath('/deals');
  revalidatePath(`/deals/${id}`);
  return state;
}

export async function loseDeal(_previous: ActionState, form: FormData): Promise<ActionState> {
  const id = String(form.get('id') ?? '');
  const state = await callApi(
    `/deals/${id}/lose`,
    {
      method: 'POST',
      body: {
        ...(text(form, 'lostReasonId') ? { lostReasonId: text(form, 'lostReasonId') } : {}),
        ...(text(form, 'note') ? { note: text(form, 'note') } : {}),
      },
    },
    'Marked lost.',
    form,
  );
  revalidatePath('/deals');
  revalidatePath(`/deals/${id}`);
  return state;
}

export async function reopenDeal(_previous: ActionState, form: FormData): Promise<ActionState> {
  const id = String(form.get('id') ?? '');
  const state = await callApi(`/deals/${id}/reopen`, { method: 'POST' }, 'Reopened.');
  revalidatePath('/deals');
  revalidatePath(`/deals/${id}`);
  return state;
}

/**
 * Replacing the line items, as the whole table.
 *
 * The form submits parallel arrays — `line-name[]`, `line-quantity[]` and so on — because that is
 * what a table of inputs produces, and the API takes the list whole. A row with no name and no
 * product is a blank row somebody left behind, and is dropped rather than refused.
 */
export async function setDealItems(_previous: ActionState, form: FormData): Promise<ActionState> {
  const id = String(form.get('id') ?? '');
  const { items, fieldErrors } = parseLineItems(form);
  if (Object.keys(fieldErrors).length > 0) {
    return { status: 'error', message: 'Some lines need correcting.', fieldErrors };
  }

  const state = await callApi(
    `/deals/${id}/items`,
    { method: 'PUT', body: { items } },
    'Line items saved.',
  );
  revalidatePath(`/deals/${id}`);
  revalidatePath('/deals');
  return state;
}

export async function deleteDeal(_previous: ActionState, form: FormData): Promise<ActionState> {
  const id = String(form.get('id') ?? '');
  const state = await callApi(`/deals/${id}`, { method: 'DELETE' }, 'Deal deleted.');
  revalidatePath('/deals');
  return state;
}

// ── Products ────────────────────────────────────────────────────────────────

export async function createProduct(_previous: ActionState, form: FormData): Promise<ActionState> {
  const price = parseAmountMinor(text(form, 'price'));
  if (Number.isNaN(price)) {
    return {
      status: 'error',
      message: 'Some details need correcting.',
      fieldErrors: { price: 'Enter an amount, like 5000 or 5,000.' },
      values: submittedValues(form),
    };
  }
  const state = await callApi(
    '/products',
    {
      method: 'POST',
      body: {
        name: text(form, 'name') ?? '',
        ...(text(form, 'sku') ? { sku: text(form, 'sku') } : {}),
        ...(text(form, 'unit') ? { unit: text(form, 'unit') } : {}),
        ...(price === null ? {} : { priceMinor: price }),
        ...(text(form, 'taxPercent') ? { taxPercent: Number(text(form, 'taxPercent')) } : {}),
      },
    },
    'Product created.',
    form,
  );
  revalidatePath('/settings/products');
  return state;
}

export async function setProductActive(
  _previous: ActionState,
  form: FormData,
): Promise<ActionState> {
  const id = String(form.get('id') ?? '');
  const active = String(form.get('isActive') ?? '') === 'true';
  const state = await callApi(
    `/products/${id}`,
    { method: 'PATCH', body: { isActive: active } },
    active ? 'Product reactivated.' : 'Product deactivated.',
  );
  revalidatePath('/settings/products');
  return state;
}
