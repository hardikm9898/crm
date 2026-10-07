'use server';

import { revalidatePath } from 'next/cache';
import { callApi, text } from '@/lib/server-action';
import type { ActionState } from '@/lib/action-state';

/**
 * SLA mutations.
 *
 * There is deliberately **no action that starts or satisfies a clock**. Both happen as part of the
 * write that caused them — a lead being captured, a follow-up being completed — inside the same
 * transaction. A control that let somebody mark their own SLA met would make the measurement
 * worthless.
 */
function refresh(): void {
  revalidatePath('/sla');
  revalidatePath('/settings/sla');
  revalidatePath('/dashboard');
}

export async function acknowledgeEscalation(
  _previous: ActionState,
  form: FormData,
): Promise<ActionState> {
  const id = String(form.get('id') ?? '');
  const state = await callApi(
    `/sla/escalations/${id}/acknowledge`,
    { method: 'POST', body: {} },
    'Marked as seen.',
  );
  refresh();
  return state;
}

function minutesOf(form: FormData, key: string): number | undefined {
  const raw = text(form, key);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : undefined;
}

export async function createSlaPolicy(
  _previous: ActionState,
  form: FormData,
): Promise<ActionState> {
  const first = minutesOf(form, 'firstResponseMinutes');
  if (first === undefined) {
    return {
      status: 'error',
      message: 'Some details need correcting.',
      fieldErrors: { firstResponseMinutes: 'Enter a number of minutes, like 60.' },
    };
  }
  const priorities = form
    .getAll('priorities')
    .filter((value): value is string => typeof value === 'string');

  const state = await callApi(
    '/sla/policies',
    {
      method: 'POST',
      body: {
        name: text(form, 'name') ?? '',
        firstResponseMinutes: first,
        ...(minutesOf(form, 'resolutionMinutes')
          ? { resolutionMinutes: minutesOf(form, 'resolutionMinutes') }
          : {}),
        businessHoursOnly: form.get('businessHoursOnly') === 'on',
        ...(minutesOf(form, 'warnAtPercent')
          ? { warnAtPercent: minutesOf(form, 'warnAtPercent') }
          : {}),
        // An empty list means "any", which is what makes a policy with no conditions the catch-all.
        appliesTo: priorities.length > 0 ? { priorities } : {},
        ...(text(form, 'priority') ? { priority: Number(text(form, 'priority')) } : {}),
      },
    },
    'SLA policy created.',
    form,
  );
  refresh();
  return state;
}

export async function updateSlaPolicy(
  _previous: ActionState,
  form: FormData,
): Promise<ActionState> {
  const id = String(form.get('id') ?? '');
  const state = await callApi(
    `/sla/policies/${id}`,
    {
      method: 'PATCH',
      body: {
        ...(text(form, 'name') ? { name: text(form, 'name') } : {}),
        ...(minutesOf(form, 'firstResponseMinutes')
          ? { firstResponseMinutes: minutesOf(form, 'firstResponseMinutes') }
          : {}),
        ...(minutesOf(form, 'warnAtPercent')
          ? { warnAtPercent: minutesOf(form, 'warnAtPercent') }
          : {}),
        businessHoursOnly: form.get('businessHoursOnly') === 'on',
        ...(form.get('isActive') === null ? {} : { isActive: form.get('isActive') === 'on' }),
      },
    },
    'SLA policy saved.',
    form,
  );
  refresh();
  return state;
}

export async function deleteSlaPolicy(
  _previous: ActionState,
  form: FormData,
): Promise<ActionState> {
  const id = String(form.get('id') ?? '');
  const state = await callApi(`/sla/policies/${id}`, { method: 'DELETE' }, 'SLA policy removed.');
  refresh();
  return state;
}
