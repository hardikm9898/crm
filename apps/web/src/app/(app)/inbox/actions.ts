'use server';

import { revalidatePath } from 'next/cache';
import { describeError, request } from '@/lib/api';
import { callApi, fieldErrorsOf, text } from '@/lib/server-action';
import { readAccessToken } from '@/lib/session';
import type { ActionState } from '@/lib/action-state';

/** The largest attachment the API stores, repeated here only to refuse before uploading 16 MB. */
const MAX_ATTACHMENT_BYTES = 16 * 1024 * 1024;

/**
 * Inbox mutations (`FR-WA-1`, `FR-WA-7`, `FR-WA-9`).
 *
 * Marking read, replying, sending a file, and trying a refused message again. Assignment, transfer and close are
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

/**
 * Sends a file (`FR-WA-3`).
 *
 * The bytes **are** the request body, with the name and the caption in the query — the import
 * upload's shape, for the same reason: one file and nothing else, so multipart would add a parser
 * and a second limit for no second part.
 *
 * The size is checked here as well as by the API, which is not a second answer to one question: it
 * is the same number, and refusing locally saves somebody waiting for a sixteen-megabyte upload to
 * be told no. The API's refusal is still the one that decides.
 */
export async function sendAttachment(
  _previous: ActionState,
  form: FormData,
): Promise<ActionState> {
  const conversationId = String(form.get('conversationId') ?? '');
  const token = await readAccessToken();
  if (!token) return { status: 'error', message: 'Please sign in again.' };

  const file = form.get('file');
  if (!(file instanceof File) || file.size === 0) {
    return {
      status: 'error',
      message: 'Choose a file to send.',
      fieldErrors: { file: 'No file was attached.' },
    };
  }
  if (file.size > MAX_ATTACHMENT_BYTES) {
    return {
      status: 'error',
      message: 'That file is too large to send on WhatsApp.',
      fieldErrors: {
        file: `Up to ${Math.floor(MAX_ATTACHMENT_BYTES / (1024 * 1024))} MB, and less for a photo.`,
      },
    };
  }

  const caption = (text(form, 'caption') ?? '').trim();
  const query = new URLSearchParams({ fileName: file.name });
  if (caption !== '') query.set('caption', caption);

  try {
    const response = await request<{ id: string }>(
      `/conversations/${conversationId}/attachments?${query.toString()}`,
      {
        method: 'POST',
        token,
        rawBody: {
          content: new Uint8Array(await file.arrayBuffer()),
          // The file's own type, so the API can tell a photo from a document — `typeForMime` is
          // what decides which WhatsApp kind it becomes.
          contentType: file.type || 'application/octet-stream',
        },
      },
    );
    revalidatePath('/inbox');
    revalidatePath('/today');
    return {
      status: 'success',
      message: response.message ?? 'On its way. The thread will show when WhatsApp has it.',
    };
  } catch (error) {
    // The caption is echoed back; the file cannot be, which is why the notice says so rather than
    // leaving somebody to wonder whether it went.
    return {
      status: 'error',
      message: describeError(error),
      ...fieldErrorsOf(error),
      values: { caption },
    };
  }
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
