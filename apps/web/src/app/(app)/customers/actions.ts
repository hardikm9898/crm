'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { describeError, request } from '@/lib/api';
import { callApi, fieldErrorsOf, submittedValues, text } from '@/lib/server-action';
import { readAccessToken } from '@/lib/session';
import type { ActionState } from '@/lib/action-state';

/**
 * Customer mutations.
 *
 * Conversion posts to `POST /leads/:id/convert` — the lead's own endpoint — because it is a lead
 * transition that happens to produce a customer. Doing it any other way would mean this app knowing
 * an order of operations the API already owns.
 */
export async function convertLead(_previous: ActionState, form: FormData): Promise<ActionState> {
  const token = await readAccessToken();
  if (!token) return { status: 'error', message: 'Please sign in again.' };

  const leadId = String(form.get('leadId') ?? '');
  if (!leadId) return { status: 'error', message: 'That lead could not be found.' };

  const body: Record<string, unknown> = {};
  for (const key of ['billingLine1', 'city', 'postalCode', 'taxId', 'note']) {
    const value = text(form, key);
    if (value !== undefined) body[key] = value;
  }

  let customerId: string;
  try {
    const response = await request<{ id: string }>(`/leads/${leadId}/convert`, {
      method: 'POST',
      body,
      token,
    });
    customerId = response.data.id;
  } catch (error) {
    return {
      status: 'error',
      message: describeError(error),
      ...fieldErrorsOf(error),
      values: submittedValues(form),
    };
  }

  revalidatePath(`/leads/${leadId}`);
  revalidatePath('/customers');
  // Straight to the customer: somebody who has just closed a sale wants to see the account, not the
  // lead they have finished with.
  redirect(`/customers/${customerId}`);
}

export async function createCustomer(_previous: ActionState, form: FormData): Promise<ActionState> {
  const token = await readAccessToken();
  if (!token) return { status: 'error', message: 'Please sign in again.' };

  const body: Record<string, unknown> = {};
  for (const key of [
    'firstName',
    'lastName',
    'company',
    'jobTitle',
    'phone',
    'whatsapp',
    'email',
    'billingLine1',
    'city',
    'state',
    'postalCode',
    'taxId',
  ]) {
    const value = text(form, key);
    if (value !== undefined) body[key] = value;
  }
  const country = text(form, 'country');
  if (country) body['country'] = country.toUpperCase();

  let id: string;
  try {
    id = (await request<{ id: string }>('/customers', { method: 'POST', body, token })).data.id;
  } catch (error) {
    return {
      status: 'error',
      message: describeError(error),
      ...fieldErrorsOf(error),
      values: submittedValues(form),
    };
  }

  revalidatePath('/customers');
  redirect(`/customers/${id}`);
}

export async function updateCustomer(_previous: ActionState, form: FormData): Promise<ActionState> {
  const id = String(form.get('id') ?? '');
  const body: Record<string, unknown> = {};
  for (const [key, value] of form.entries()) {
    if (key === 'id' || typeof value !== 'string') continue;
    // An empty box means "clear this", which the API accepts as null — not "leave it alone", which
    // would make it impossible to remove a tax id somebody typed wrong.
    body[key] = value.trim() === '' ? null : value.trim();
  }
  if (typeof body['country'] === 'string') body['country'] = body['country'].toUpperCase();

  const state = await callApi(
    `/customers/${id}`,
    { method: 'PATCH', body },
    'Customer updated.',
    form,
  );
  revalidatePath(`/customers/${id}`);
  return state;
}

export async function deleteCustomer(_previous: ActionState, form: FormData): Promise<ActionState> {
  const id = String(form.get('id') ?? '');
  const state = await callApi(
    `/customers/${id}`,
    { method: 'DELETE' },
    'Customer deleted. Their history is kept — restore them from the recycle bin.',
  );
  revalidatePath('/customers');
  revalidatePath(`/customers/${id}`);
  return state;
}

export async function restoreCustomer(
  _previous: ActionState,
  form: FormData,
): Promise<ActionState> {
  const id = String(form.get('id') ?? '');
  const state = await callApi(`/customers/${id}/restore`, { method: 'POST' }, 'Customer restored.');
  revalidatePath('/customers');
  revalidatePath(`/customers/${id}`);
  return state;
}
