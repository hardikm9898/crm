'use server';

import { revalidatePath } from 'next/cache';
import { ApiError, describeError, request } from '@/lib/api';
import { readAccessToken } from '@/lib/session';

/**
 * The two actions `/today`'s cards can take, shaped for the queue rather than for a form.
 *
 * Every other mutation in the app is a `useActionState` server action returning an `ActionState`,
 * which is right for a form somebody is sitting in front of. These return a small result the
 * browser-side queue can act on, because the queue has to decide something no form ever does:
 * **whether trying again could possibly help.**
 *
 *  * A refusal — a missing outcome, a reason the workspace requires a note for, a follow-up
 *    somebody else already finished — is `retryable: false`. Sending it three more times produces
 *    the same refusal three more times and buries the one sentence that explains it.
 *  * A connection that died, or a 5xx, is `retryable: true`. That is the case the queue exists for.
 *
 * They are still server actions, not a browser fetch: the access token is in an httpOnly cookie, so
 * only the server can attach it, and there is deliberately no general-purpose proxy route
 * (`docs/security.md` §2).
 */

export interface QueuedResult {
  readonly ok: boolean;
  /** The sentence to show. The API's own wording, which was written for a person. */
  readonly message: string;
  readonly retryable: boolean;
}

function refreshed(): void {
  revalidatePath('/today');
  revalidatePath('/tasks');
  revalidatePath('/leads');
  revalidatePath('/dashboard');
}

/**
 * A 4xx is an answer; anything else is a reason to try again.
 *
 * 408 and 429 are the two 4xx codes that *are* worth retrying — a timeout and a rate limit both
 * mean "not now" rather than "not ever".
 */
function retryable(error: unknown): boolean {
  if (error instanceof ApiError)
    return error.status === 408 || error.status === 429 || error.status >= 500;
  // Not an `ApiError` at all: the request never got an answer. That is exactly the flaky
  // connection this screen is built for.
  return true;
}

async function send(path: string, body: unknown, success: string): Promise<QueuedResult> {
  const token = await readAccessToken();
  if (!token) {
    return { ok: false, message: 'Please sign in again.', retryable: false };
  }
  try {
    const response = await request<unknown>(path, { method: 'POST', body, token });
    refreshed();
    return { ok: true, message: response.message ?? success, retryable: false };
  } catch (error) {
    return { ok: false, message: describeError(error), retryable: retryable(error) };
  }
}

export async function completeFollowUp(input: {
  taskId: string;
  outcomeId: string;
  note?: string;
  nextTitle?: string;
  nextDueAt?: string;
}): Promise<QueuedResult> {
  return send(
    `/tasks/${input.taskId}/complete`,
    {
      outcomeId: input.outcomeId,
      ...(input.note ? { note: input.note } : {}),
      ...(input.nextDueAt
        ? {
            nextFollowUp: {
              ...(input.nextTitle ? { title: input.nextTitle } : {}),
              dueAt: input.nextDueAt,
            },
          }
        : {}),
    },
    'Follow-up completed.',
  );
}

export async function rescheduleFollowUp(input: {
  taskId: string;
  dueAt: string;
  reasonId: string;
  note?: string;
}): Promise<QueuedResult> {
  return send(
    `/tasks/${input.taskId}/reschedule`,
    {
      dueAt: input.dueAt,
      reasonId: input.reasonId,
      ...(input.note ? { note: input.note } : {}),
    },
    'Follow-up moved.',
  );
}
