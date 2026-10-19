'use server';

import { revalidatePath } from 'next/cache';
import { callApi, text } from '@/lib/server-action';
import type { ActionState } from '@/lib/action-state';

/**
 * The WhatsApp connection's own two actions (`FR-WA-2`).
 *
 * The credential is not here: it belongs to the integration framework, which already has the form
 * that stores it and the callback URL the provider posts to. What these do is the part that is
 * about WhatsApp rather than about a credential — discovering the numbers the token can see, and
 * saying who answers each one by default.
 */
function refresh(): void {
  revalidatePath('/settings/whatsapp');
  revalidatePath('/inbox');
}

/**
 * Discovers the WABA's numbers, and re-discovers them.
 *
 * Idempotent on purpose: pressing it again after adding a number in Meta is the honest answer to
 * "where did my new number go", and a number that has disappeared from Meta is marked inactive
 * rather than deleted — a conversation references it, and the history of what arrived at a number
 * the business no longer has is still the history.
 */
export async function connectWhatsApp(
  _previous: ActionState,
  form: FormData,
): Promise<ActionState> {
  const result = await callApi(
    '/whatsapp/accounts',
    { method: 'POST', body: { connectionId: text(form, 'connectionId') } },
    'Connected. Your numbers are listed below.',
    form,
  );
  if (result.status === 'success') refresh();
  return result;
}

export async function setDefaultAgent(
  _previous: ActionState,
  form: FormData,
): Promise<ActionState> {
  const userId = text(form, 'userId');
  const result = await callApi(
    `/whatsapp/numbers/${text(form, 'numberId')}`,
    // An empty selection is `null`, not an empty string: "nobody by default" is a real answer and
    // the API's schema says so. `Number('')` being 0 is the same family of coercion mistake.
    { method: 'PATCH', body: { userId: userId === '' ? null : userId } },
    'Saved.',
    form,
  );
  if (result.status === 'success') refresh();
  return result;
}
