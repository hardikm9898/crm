'use server';

import { revalidatePath } from 'next/cache';
import { callApi, text } from '@/lib/server-action';
import type { ActionState } from '@/lib/action-state';

/**
 * Canned replies (`FR-WA-7`).
 *
 * The shortcut is sent as somebody typed it: the API adds the slash and hyphenates, because making
 * a person type punctuation exactly is how a feature goes unused — and a screen that did its own
 * cleaning would be a second answer to one question, with the two eventually disagreeing.
 */
export async function createCannedReply(
  _previous: ActionState,
  form: FormData,
): Promise<ActionState> {
  const result = await callApi(
    '/canned-replies',
    {
      method: 'POST',
      body: {
        shortcut: text(form, 'shortcut') ?? '',
        body: text(form, 'body') ?? '',
        visibility: text(form, 'visibility') ?? 'shared',
      },
    },
    'Saved.',
    form,
  );
  if (result.status === 'success') {
    revalidatePath('/settings/whatsapp/replies');
    revalidatePath('/inbox');
  }
  return result;
}

export async function updateCannedReply(
  _previous: ActionState,
  form: FormData,
): Promise<ActionState> {
  const id = String(form.get('replyId') ?? '');
  const result = await callApi(
    `/canned-replies/${id}`,
    { method: 'PATCH', body: { body: text(form, 'body') ?? '' } },
    'Saved.',
    form,
  );
  if (result.status === 'success') {
    revalidatePath('/settings/whatsapp/replies');
    revalidatePath('/inbox');
  }
  return result;
}

/** Takes it out of the picker. The row stays: a sent reply has messages pointing at it. */
export async function archiveCannedReply(
  _previous: ActionState,
  form: FormData,
): Promise<ActionState> {
  const id = String(form.get('replyId') ?? '');
  const result = await callApi(
    `/canned-replies/${id}`,
    { method: 'DELETE' },
    'Removed from the picker.',
  );
  if (result.status === 'success') {
    revalidatePath('/settings/whatsapp/replies');
    revalidatePath('/inbox');
  }
  return result;
}
