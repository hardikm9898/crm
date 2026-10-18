'use server';

import { revalidatePath } from 'next/cache';
import { describeError, request } from '@/lib/api';
import { callApi, fieldErrorsOf, submittedValues, text } from '@/lib/server-action';
import { readAccessToken } from '@/lib/session';
import type { ActionState } from '@/lib/action-state';
import type { CreatedWebhookEndpoint } from '@/lib/webhooks';

/**
 * Outbound webhook mutations (`FR-API-4`).
 *
 * The signing secret travels back in `ActionState.data`, for the reason the API keys screen states:
 * the API answers it exactly once and no endpoint will answer it again, so it cannot come from the
 * re-rendered server tree. A refresh loses it, which is the behaviour and not a defect.
 */
function refresh(): void {
  revalidatePath('/settings/webhooks');
}

function eventTypes(form: FormData): string[] {
  return form
    .getAll('eventTypes')
    .filter((value): value is string => typeof value === 'string')
    .map((value) => value.trim())
    .filter((value) => value !== '');
}

export async function createWebhookEndpoint(
  _previous: ActionState,
  form: FormData,
): Promise<ActionState> {
  const token = await readAccessToken();
  if (!token) return { status: 'error', message: 'Please sign in again.' };

  const body = {
    url: text(form, 'url') ?? '',
    ...(text(form, 'description') ? { description: text(form, 'description') } : {}),
    eventTypes: eventTypes(form),
  };

  try {
    const created = await request<CreatedWebhookEndpoint>('/webhooks', {
      method: 'POST',
      body,
      token,
    });
    refresh();
    return {
      status: 'success',
      message: created.message ?? 'Endpoint created',
      data: { secret: created.data.secret, url: created.data.url },
    };
  } catch (error) {
    return {
      status: 'error',
      message: describeError(error),
      ...fieldErrorsOf(error),
      // The events are echoed explicitly and joined, because `submittedValues` keeps one value per
      // name and a checkbox group submits its name many times — so a refusal would come back with
      // whichever box happened to be last and silently drop the others.
      values: { ...submittedValues(form), eventTypes: eventTypes(form).join(',') },
    };
  }
}

export async function updateWebhookEndpoint(
  _previous: ActionState,
  form: FormData,
): Promise<ActionState> {
  const id = text(form, 'id');
  if (!id) return { status: 'error', message: 'Which endpoint?' };
  const chosen = eventTypes(form);

  const state = await callApi(
    `/webhooks/${id}`,
    {
      method: 'PATCH',
      body: {
        ...(text(form, 'url') ? { url: text(form, 'url') } : {}),
        ...(form.get('description') !== null
          ? { description: text(form, 'description') ?? null }
          : {}),
        ...(chosen.length > 0 ? { eventTypes: chosen } : {}),
      },
    },
    'Endpoint updated',
    form,
  );
  if (state.status === 'success') refresh();
  return state;
}

/** Switching an endpoint on also clears its failure count, which the API does for us. */
export async function setWebhookEndpointActive(
  _previous: ActionState,
  form: FormData,
): Promise<ActionState> {
  const id = text(form, 'id');
  if (!id) return { status: 'error', message: 'Which endpoint?' };
  const isActive = text(form, 'isActive') === 'true';
  const state = await callApi(
    `/webhooks/${id}`,
    { method: 'PATCH', body: { isActive } },
    isActive ? 'Endpoint switched on' : 'Endpoint switched off — nothing more will be sent to it',
  );
  if (state.status === 'success') refresh();
  return state;
}

export async function rotateWebhookSecret(
  _previous: ActionState,
  form: FormData,
): Promise<ActionState> {
  const id = text(form, 'id');
  if (!id) return { status: 'error', message: 'Which endpoint?' };
  const token = await readAccessToken();
  if (!token) return { status: 'error', message: 'Please sign in again.' };

  try {
    const rotated = await request<CreatedWebhookEndpoint>(`/webhooks/${id}/rotate-secret`, {
      method: 'POST',
      token,
    });
    refresh();
    return {
      status: 'success',
      message: rotated.message ?? 'New signing secret created',
      data: { secret: rotated.data.secret, url: rotated.data.url },
    };
  } catch (error) {
    return { status: 'error', message: describeError(error) };
  }
}

/** A real, signed, logged delivery of the reserved `webhook.test` event. */
export async function sendWebhookTest(
  _previous: ActionState,
  form: FormData,
): Promise<ActionState> {
  const id = text(form, 'id');
  if (!id) return { status: 'error', message: 'Which endpoint?' };
  const state = await callApi(
    `/webhooks/${id}/test`,
    { method: 'POST' },
    'Test queued — it will appear in the log below',
  );
  if (state.status === 'success') refresh();
  return state;
}

export async function deleteWebhookEndpoint(
  _previous: ActionState,
  form: FormData,
): Promise<ActionState> {
  const id = text(form, 'id');
  if (!id) return { status: 'error', message: 'Which endpoint?' };
  const state = await callApi(
    `/webhooks/${id}`,
    { method: 'DELETE' },
    'Endpoint deleted, with everything we sent it',
  );
  if (state.status === 'success') refresh();
  return state;
}

/**
 * Sending one delivery again.
 *
 * No success message here: a retry revalidates the screen and the row re-renders from the server
 * tree with its new state, which is where the outcome belongs — the lesson the ingestion log's
 * replay button paid for, where a confirmation was rendered from state the re-render had unmounted.
 */
export async function retryWebhookDelivery(
  _previous: ActionState,
  form: FormData,
): Promise<ActionState> {
  const id = text(form, 'id');
  if (!id) return { status: 'error', message: 'Which delivery?' };
  const state = await callApi(
    `/webhooks/deliveries/${id}/retry`,
    { method: 'POST' },
    'Sending it again now',
  );
  if (state.status === 'success') refresh();
  return state;
}
