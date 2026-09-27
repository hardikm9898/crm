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
): Promise<ActionState> {
  const token = await readAccessToken();
  if (!token) return { status: 'error', message: 'Please sign in again.' };

  try {
    const response = await request<T>(path, { ...options, token });
    // The API writes its own confirmations ("Settings saved", "Branch created"); prefer them over a
    // second vocabulary for the same event.
    return { status: 'success', message: response.message ?? successMessage };
  } catch (error) {
    return { status: 'error', message: describeError(error), ...fieldErrorsOf(error) };
  }
}

/**
 * Validation details arrive as `[{ field, code, message }]` (docs/api-architecture.md §2). Turning
 * them into a field map is what lets a form point at the input that is wrong instead of showing one
 * sentence at the top.
 */
function fieldErrorsOf(error: unknown): { fieldErrors?: Record<string, string> } {
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

/** `FormData` values are strings or files; forms want trimmed strings and real absences. */
export function text(form: FormData, key: string): string | undefined {
  const value = form.get(key);
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}
