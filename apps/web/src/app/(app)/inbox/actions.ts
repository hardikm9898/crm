'use server';

import { revalidatePath } from 'next/cache';
import { callApi } from '@/lib/server-action';
import type { ActionState } from '@/lib/action-state';

/**
 * Inbox mutations (`FR-WA-7`).
 *
 * One, for now, and deliberately: marking a conversation read is the only thing this step can
 * honestly do to one. Replying is the next step, and a button that queued a message nothing could
 * deliver would be worse than its absence.
 */
export async function markConversationRead(
  _previous: ActionState,
  form: FormData,
): Promise<ActionState> {
  const id = String(form.get('conversationId') ?? '');
  const result = await callApi(
    `/conversations/${id}/read`,
    { method: 'POST', body: {} },
    'Marked as read.',
  );
  if (result.status === 'success') {
    revalidatePath('/inbox');
    // The unread badge on the shell reads the same predicate the list does, so both have to be
    // re-rendered or the badge keeps counting a conversation somebody has just read.
    revalidatePath('/today');
  }
  return result;
}
