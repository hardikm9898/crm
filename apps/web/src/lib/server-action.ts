import { describeError, request, type RequestOptions } from './api';
import { readAccessToken } from './session';
import type { ActionState } from './action-state';

/**
 * Server-side half of the form plumbing.
 *
 * Mutations go through server actions rather than browser fetches for one reason: the access token
 * lives in an httpOnly cookie, so only the server can attach it. There is deliberately no
 * general-purpose `/api/proxy/*` route — a route that forwards any path with the caller's token
 * attached is a confused deputy waiting to happen (docs/security.md §2).
 */

/** Calls the API as the signed-in caller and normalizes both outcomes for a form. */
export async function callApi<T>(
  path: string,
  options: Omit<RequestOptions, 'token'>,
  successMessage: string,
  /**
   * The submission, echoed back on a refusal.
   *
   * A server action re-renders the server tree and the client form remounts, so without this a
   * refused submission comes back empty and every field has to be retyped.
   */
  form?: FormData,
): Promise<ActionState> {
  const token = await readAccessToken();
  if (!token) return { status: 'error', message: 'Please sign in again.' };

  try {
    const response = await request<T>(path, { ...options, token });
    // The API writes its own confirmations ("Settings saved", "Branch created"); prefer them over a
    // second vocabulary for the same event.
    return { status: 'success', message: response.message ?? successMessage };
  } catch (error) {
    return {
      status: 'error',
      message: describeError(error),
      ...fieldErrorsOf(error),
      ...(form ? { values: submittedValues(form) } : {}),
    };
  }
}

/**
 * Validation details arrive as `[{ field, code, message }]` (docs/api-architecture.md §2). Turning
 * them into a field map is what lets a form point at the input that is wrong instead of showing one
 * sentence at the top.
 */
export function fieldErrorsOf(error: unknown): { fieldErrors?: Record<string, string> } {
  const details = (error as { details?: unknown } | null)?.details;
  if (!Array.isArray(details)) return {};
  const fieldErrors: Record<string, string> = {};
  for (const entry of details) {
    const field = (entry as { field?: unknown }).field;
    const message = (entry as { message?: unknown }).message;
    if (typeof field === 'string' && typeof message === 'string') fieldErrors[field] = message;
  }
  return Object.keys(fieldErrors).length > 0 ? { fieldErrors } : {};
}

/**
 * The text fields of a submission, for echoing back into a refused form.
 *
 * Files are skipped: they cannot be restored into an input, and putting a filename there would
 * suggest the upload survived when it did not.
 */
export function submittedValues(form: FormData): Record<string, string> {
  const values: Record<string, string> = {};
  for (const [key, value] of form.entries()) {
    if (typeof value === 'string') values[key] = value;
  }
  return values;
}

/** `FormData` values are strings or files; forms want trimmed strings and real absences. */
export function text(form: FormData, key: string): string | undefined {
  const value = form.get(key);
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}
