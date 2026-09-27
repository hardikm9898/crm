'use server';

import { revalidatePath } from 'next/cache';
import { callApi, text } from '@/lib/server-action';
import type { ActionState } from '@/lib/action-state';

/**
 * Marking notifications read.
 *
 * The badge in the shell is rendered server-side, so both actions revalidate the layout's path as
 * well as this page — otherwise the count would stay stale until the next full navigation.
 */
export async function markRead(_previous: ActionState, form: FormData): Promise<ActionState> {
  const id = text(form, 'notificationId');
  if (!id) return { status: 'error', message: 'Nothing to mark.' };

  const result = await callApi(
    `/notifications/${encodeURIComponent(id)}/read`,
    { method: 'POST', body: {} },
    'Marked as read',
  );
  if (result.status === 'success') {
    revalidatePath('/notifications');
    revalidatePath('/dashboard');
  }
  return result;
}

export async function markAllRead(): Promise<ActionState> {
  const result = await callApi(
    '/notifications/read-all',
    { method: 'POST', body: {} },
    'All caught up',
  );
  if (result.status === 'success') {
    revalidatePath('/notifications');
    revalidatePath('/dashboard');
  }
  return result;
}
