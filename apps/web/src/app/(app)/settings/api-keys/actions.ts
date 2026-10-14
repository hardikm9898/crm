'use server';

import { revalidatePath } from 'next/cache';
import { describeError, request } from '@/lib/api';
import { callApi, fieldErrorsOf, submittedValues, text } from '@/lib/server-action';
import { readAccessToken } from '@/lib/session';
import type { ActionState } from '@/lib/action-state';
import type { CreatedApiKey } from '@/lib/ingestion';

/**
 * API key mutations (`FR-CAP-7`, `FR-API-2`).
 *
 * `create` and `rotate` are the only two actions in this app that hand a **credential** back to the
 * browser, and they are the reason `ActionState.data` exists: the API answers the secret exactly
 * once and no endpoint will answer it again, so it cannot come from the re-rendered server tree the
 * way every other value on this screen does. It travels in `data`, the form prints it, and a
 * refresh loses it — which is the behaviour, not a defect.
 */
function refresh(): void {
  revalidatePath('/settings/api-keys');
}

/** One address or range per line, or comma-separated — whichever way somebody pastes them. */
function allowlist(form: FormData): string[] | undefined {
  const raw = text(form, 'ipAllowlist');
  if (raw === undefined) return undefined;
  const entries = raw
    .split(/[\s,]+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
  return entries;
}

function scopes(form: FormData): string[] {
  return form
    .getAll('scopes')
    .filter((value): value is string => typeof value === 'string')
    .map((value) => value.trim())
    .filter((value) => value !== '');
}

export async function createApiKey(_previous: ActionState, form: FormData): Promise<ActionState> {
  const token = await readAccessToken();
  if (!token) return { status: 'error', message: 'Please sign in again.' };

  const list = allowlist(form);
  const limit = text(form, 'rateLimitPerMin');
  const expires = text(form, 'expiresAt');
  const body = {
    name: text(form, 'name') ?? '',
    scopes: scopes(form),
    ...(list && list.length > 0 ? { ipAllowlist: list } : {}),
    ...(limit ? { rateLimitPerMin: limit } : {}),
    ...(expires ? { expiresAt: expires } : {}),
  };

  try {
    const created = await request<CreatedApiKey>('/api-keys', { method: 'POST', body, token });
    refresh();
    return {
      status: 'success',
      message: created.message ?? 'Key created',
      // The pair, once. `keyId` is public and belongs in the integration's config beside it.
      data: { keyId: created.data.keyId, secret: created.data.secret, name: created.data.name },
    };
  } catch (error) {
    return {
      status: 'error',
      message: describeError(error),
      ...fieldErrorsOf(error),
      // The scopes are echoed **explicitly**, joined, because `submittedValues` keeps one value per
      // name and a checkbox group submits its name several times — so a refusal would come back
      // with whichever box happened to be last and silently drop the others.
      values: { ...submittedValues(form), scopes: scopes(form).join(',') },
    };
  }
}

export async function rotateApiKey(_previous: ActionState, form: FormData): Promise<ActionState> {
  const id = text(form, 'id');
  if (!id) return { status: 'error', message: 'Which key?' };
  const token = await readAccessToken();
  if (!token) return { status: 'error', message: 'Please sign in again.' };

  try {
    const rotated = await request<CreatedApiKey>(`/api-keys/${id}/rotate`, {
      method: 'POST',
      token,
    });
    refresh();
    return {
      status: 'success',
      message: rotated.message ?? 'New secret created',
      data: { keyId: rotated.data.keyId, secret: rotated.data.secret, name: rotated.data.name },
    };
  } catch (error) {
    return { status: 'error', message: describeError(error) };
  }
}

export async function updateApiKey(_previous: ActionState, form: FormData): Promise<ActionState> {
  const id = text(form, 'id');
  if (!id) return { status: 'error', message: 'Which key?' };
  const list = allowlist(form);
  const limit = text(form, 'rateLimitPerMin');

  const state = await callApi(
    `/api-keys/${id}`,
    {
      method: 'PATCH',
      body: {
        ...(text(form, 'name') ? { name: text(form, 'name') } : {}),
        ...(scopes(form).length > 0 ? { scopes: scopes(form) } : {}),
        // An empty box means "no allowlist", which is a real choice and must not read as "leave it
        // alone": a key somebody meant to open up would otherwise stay locked to an old address.
        ...(list ? { ipAllowlist: list } : {}),
        // `null` clears the per-key limit back to the workspace default; absent leaves it.
        ...(form.get('rateLimitPerMin') !== null ? { rateLimitPerMin: limit ?? null } : {}),
      },
    },
    'Key updated',
    form,
  );
  if (state.status === 'success') refresh();
  return state;
}

/**
 * Revoking is a timestamp, not a delete: every payload the key ever sent still points at it, and
 * "which key sent this" has to stay answerable.
 */
export async function revokeApiKey(_previous: ActionState, form: FormData): Promise<ActionState> {
  const id = text(form, 'id');
  if (!id) return { status: 'error', message: 'Which key?' };
  const state = await callApi(
    `/api-keys/${id}/revoke`,
    { method: 'POST' },
    'Key revoked — anything still using it stops working now',
  );
  if (state.status === 'success') refresh();
  return state;
}
