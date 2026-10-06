'use server';

import { revalidatePath } from 'next/cache';
import { describeError, request } from '@/lib/api';
import { callApi, fieldErrorsOf, submittedValues, text } from '@/lib/server-action';
import { readAccessToken } from '@/lib/session';
import { parseAmountMinor } from '@/lib/line-items-form';
import type { ActionState } from '@/lib/action-state';

/**
 * Payment mutations.
 *
 * Confirm, fail and refund are separate actions against separate endpoints, because each is its own
 * transition on the API with its own preconditions and its own effect on the derived totals. The
 * PATCH is only for correcting a figure somebody typed wrong.
 */
function refresh(paths: readonly (string | null | undefined)[] = []): void {
  revalidatePath('/payments');
  revalidatePath('/deals');
  revalidatePath('/customers');
  for (const path of paths) if (path) revalidatePath(path);
}

export async function recordPayment(_previous: ActionState, form: FormData): Promise<ActionState> {
  const token = await readAccessToken();
  if (!token) return { status: 'error', message: 'Please sign in again.' };

  const amount = parseAmountMinor(text(form, 'amount'));
  if (amount === null || Number.isNaN(amount)) {
    return {
      status: 'error',
      message: 'Some details need correcting.',
      fieldErrors: { amount: 'Enter an amount, like 50000 or 50,000.' },
      values: submittedValues(form),
    };
  }

  const body: Record<string, unknown> = {
    amountMinor: amount,
    ...(text(form, 'dealId') ? { dealId: text(form, 'dealId') } : {}),
    ...(text(form, 'quotationId') ? { quotationId: text(form, 'quotationId') } : {}),
    ...(text(form, 'leadId') ? { leadId: text(form, 'leadId') } : {}),
    ...(text(form, 'customerId') ? { customerId: text(form, 'customerId') } : {}),
    ...(text(form, 'methodId') ? { methodId: text(form, 'methodId') } : {}),
    ...(text(form, 'reference') ? { reference: text(form, 'reference') } : {}),
    ...(text(form, 'paidAt') ? { paidAt: text(form, 'paidAt') } : {}),
    ...(text(form, 'note') ? { note: text(form, 'note') } : {}),
    status: text(form, 'status') === 'pending' ? 'pending' : 'succeeded',
  };

  try {
    await request('/payments', { method: 'POST', body, token });
  } catch (error) {
    return {
      status: 'error',
      message: describeError(error),
      ...fieldErrorsOf(error),
      values: submittedValues(form),
    };
  }

  refresh([text(form, 'dealId') ? `/deals/${text(form, 'dealId')}` : null]);
  return { status: 'success', message: 'Payment recorded.' };
}

export async function correctPayment(_previous: ActionState, form: FormData): Promise<ActionState> {
  const id = String(form.get('id') ?? '');
  const amount = parseAmountMinor(text(form, 'amount'));
  if (amount !== null && Number.isNaN(amount)) {
    return {
      status: 'error',
      message: 'Some details need correcting.',
      fieldErrors: { amount: 'Enter an amount, like 50000 or 50,000.' },
      values: submittedValues(form),
    };
  }
  const state = await callApi(
    `/payments/${id}`,
    {
      method: 'PATCH',
      body: {
        ...(amount === null ? {} : { amountMinor: amount }),
        ...(text(form, 'reference') === undefined ? {} : { reference: text(form, 'reference') }),
        ...(text(form, 'methodId') ? { methodId: text(form, 'methodId') } : {}),
      },
    },
    'Payment corrected.',
    form,
  );
  refresh();
  return state;
}

async function transition(form: FormData, path: string, success: string): Promise<ActionState> {
  const id = String(form.get('id') ?? '');
  const state = await callApi(
    `/payments/${id}/${path}`,
    { method: 'POST', body: { ...(text(form, 'note') ? { note: text(form, 'note') } : {}) } },
    success,
    form,
  );
  refresh();
  return state;
}

export async function confirmPayment(_previous: ActionState, form: FormData): Promise<ActionState> {
  return transition(form, 'confirm', 'Payment confirmed.');
}

export async function failPayment(_previous: ActionState, form: FormData): Promise<ActionState> {
  return transition(form, 'fail', 'Marked as failed.');
}

export async function refundPayment(_previous: ActionState, form: FormData): Promise<ActionState> {
  return transition(form, 'refund', 'Marked as refunded.');
}

export async function deletePayment(_previous: ActionState, form: FormData): Promise<ActionState> {
  const id = String(form.get('id') ?? '');
  const state = await callApi(`/payments/${id}`, { method: 'DELETE' }, 'Payment deleted.');
  refresh();
  return state;
}

// ── The methods a workspace accepts ─────────────────────────────────────────

export async function createPaymentMethod(
  _previous: ActionState,
  form: FormData,
): Promise<ActionState> {
  const state = await callApi(
    '/settings/payment-methods',
    {
      method: 'POST',
      body: {
        name: text(form, 'name') ?? '',
        requiresReference: form.get('requiresReference') === 'on',
      },
    },
    'Payment method added.',
    form,
  );
  revalidatePath('/settings/payment-methods');
  return state;
}

export async function updatePaymentMethod(
  _previous: ActionState,
  form: FormData,
): Promise<ActionState> {
  const id = String(form.get('id') ?? '');
  const state = await callApi(
    `/settings/payment-methods/${id}`,
    {
      method: 'PATCH',
      body: {
        ...(text(form, 'name') ? { name: text(form, 'name') } : {}),
        requiresReference: form.get('requiresReference') === 'on',
        ...(form.get('isActive') === null ? {} : { isActive: form.get('isActive') === 'on' }),
      },
    },
    'Payment method saved.',
    form,
  );
  revalidatePath('/settings/payment-methods');
  return state;
}

export async function deletePaymentMethod(
  _previous: ActionState,
  form: FormData,
): Promise<ActionState> {
  const id = String(form.get('id') ?? '');
  const state = await callApi(
    `/settings/payment-methods/${id}`,
    { method: 'DELETE' },
    'Payment method removed.',
  );
  revalidatePath('/settings/payment-methods');
  return state;
}
