'use server';

import { revalidatePath } from 'next/cache';
import { callApi, text } from '@/lib/server-action';
import type { ActionState } from '@/lib/action-state';

/**
 * Inbox mutations (`FR-WA-1`, `FR-WA-7`, `FR-WA-9`).
 *
 * Marking read, replying, and trying a refused message again. Assignment, transfer and close are
 * the shared inbox's own step and are deliberately absent — a button that pretended to do one of
 * them would be worse than its absence.
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

/**
 * Sends a reply, or a template.
 *
 * One action for both because the form is one form: a composer with a template picker, where the
 * picker's presence is the only difference. The refusal the API writes — the window has closed, the
 * template is not approved, a variable cannot be filled — is printed as it came, because it is the
 * sentence that says what to do instead.
 */
export async function sendMessage(_previous: ActionState, form: FormData): Promise<ActionState> {
  const conversationId = String(form.get('conversationId') ?? '');
  // `text()` answers **undefined** for a field the form does not have — and the picker is absent
  // entirely when a workspace has no approved template. A check written for `null` or `''` took the
  // template branch with no template, and the API rightly refused a body with no `templateId`;
  // the symptom was a composer whose Send did nothing but print "some details need correcting".
  const templateId = text(form, 'templateId') ?? '';
  const variables: Record<string, string> = {};
  for (const [key, value] of form.entries()) {
    const match = /^variable-(\d+)$/.exec(key);
    if (match && typeof value === 'string' && value.trim() !== '') {
      variables[match[1] as string] = value.trim();
    }
  }

  const body =
    templateId === ''
      ? { kind: 'text' as const, body: text(form, 'body') ?? '' }
      : { kind: 'template' as const, templateId, variables };

  const result = await callApi(
    `/conversations/${conversationId}/messages`,
    { method: 'POST', body },
    'On its way.',
    form,
  );
  if (result.status === 'success') {
    revalidatePath('/inbox');
    revalidatePath('/today');
  }
  return result;
}

/** Tries a refused message again, on the same row (`FR-WA-9`). */
export async function retryMessage(_previous: ActionState, form: FormData): Promise<ActionState> {
  const conversationId = String(form.get('conversationId') ?? '');
  const messageId = String(form.get('messageId') ?? '');
  const result = await callApi(
    `/conversations/${conversationId}/messages/${messageId}/retry`,
    { method: 'POST', body: {} },
    'Trying again.',
  );
  if (result.status === 'success') revalidatePath('/inbox');
  return result;
}
