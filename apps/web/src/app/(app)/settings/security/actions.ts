'use server';

import { revalidatePath } from 'next/cache';
import { callApi, text } from '@/lib/server-action';
import type { ActionState } from '@/lib/action-state';

/**
 * Ending sessions.
 *
 * Both routes are scoped to the caller by the API — `DELETE /auth/sessions/:id` verifies ownership,
 * so a session id alone is not enough to sign somebody else out.
 */
export async function revokeSession(_previous: ActionState, form: FormData): Promise<ActionState> {
  const sessionId = text(form, 'sessionId');
  if (!sessionId) return { status: 'error', message: 'No session selected.' };

  const result = await callApi(
    `/auth/sessions/${encodeURIComponent(sessionId)}`,
    { method: 'DELETE' },
    'Session ended',
  );
  if (result.status === 'success') revalidatePath('/settings/security');
  return result;
}

export async function revokeAllSessions(): Promise<ActionState> {
  const result = await callApi(
    '/auth/logout-all',
    { method: 'POST', body: {} },
    'Signed out everywhere',
  );
  if (result.status === 'success') revalidatePath('/settings/security');
  return result;
}
