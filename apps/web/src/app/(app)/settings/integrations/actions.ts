'use server';

import { revalidatePath } from 'next/cache';
import { describeError, request } from '@/lib/api';
import { callApi, fieldErrorsOf, submittedValues, text } from '@/lib/server-action';
import { readAccessToken } from '@/lib/session';
import type { ActionState } from '@/lib/action-state';
import type { CreatedConnection, FieldMapping, MappingTransform } from '@/lib/integrations';

/**
 * Integration mutations (Phase 4 step 6).
 *
 * The generated secret travels back in `ActionState.data`, for the reason the API keys and webhook
 * screens both state: the API answers it exactly once and nothing will answer it again, so it
 * cannot come from the re-rendered server tree. A refresh loses it, which is the behaviour and not
 * a defect.
 */
function refresh(): void {
  revalidatePath('/settings/integrations');
}

/**
 * The settings the connect form submitted, under one prefix.
 *
 * Read by prefix rather than by a list the action keeps, because the fields are rendered from the
 * provider registry: an action with its own copy of each provider's settings would be a second
 * list, wrong on the day somebody adds a provider.
 */
function settingsOf(form: FormData): Record<string, string> {
  const settings: Record<string, string> = {};
  for (const [key, value] of form.entries()) {
    if (!key.startsWith('settings.') || typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (trimmed !== '') settings[key.slice('settings.'.length)] = trimmed;
  }
  return settings;
}

/**
 * The mapping rows the editor submitted.
 *
 * Rows arrive as three parallel arrays — a row with no source *and* no target is an empty row
 * somebody left alone and is dropped, rather than being sent as a mapping with two blank halves
 * and refused.
 */
function mappingOf(form: FormData): FieldMapping[] {
  const sources = form.getAll('mapSource').map((value) => String(value ?? '').trim());
  const targets = form.getAll('mapTarget').map((value) => String(value ?? '').trim());
  const transforms = form.getAll('mapTransform').map((value) => String(value ?? '').trim());
  const rows: FieldMapping[] = [];
  for (let index = 0; index < Math.max(sources.length, targets.length); index += 1) {
    const source = sources[index] ?? '';
    const target = targets[index] ?? '';
    if (source === '' && target === '') continue;
    const transform = transforms[index];
    rows.push({
      source,
      target,
      ...(transform && transform !== 'none' ? { transform: transform as MappingTransform } : {}),
    });
  }
  return rows;
}

export async function connectIntegration(
  _previous: ActionState,
  form: FormData,
): Promise<ActionState> {
  const token = await readAccessToken();
  if (!token) return { status: 'error', message: 'Please sign in again.' };

  const provider = text(form, 'provider') ?? '';
  const credential = text(form, 'credential');
  const mapping = mappingOf(form);
  const body = {
    provider,
    name: text(form, 'name') ?? '',
    ...(credential ? { credential } : {}),
    settings: settingsOf(form),
    ...(mapping.length > 0 ? { fieldMappings: mapping } : {}),
  };

  try {
    const created = await request<CreatedConnection>('/integrations', {
      method: 'POST',
      body,
      token,
    });
    refresh();
    return {
      status: 'success',
      message: created.message ?? 'Connected',
      data: {
        ...(created.data.secret ? { secret: created.data.secret } : {}),
        connectionId: created.data.id,
        provider: created.data.provider,
        name: created.data.name,
      },
    };
  } catch (error) {
    return {
      status: 'error',
      message: describeError(error),
      ...fieldErrorsOf(error),
      values: { ...submittedValues(form), provider },
    };
  }
}

export async function updateIntegration(
  _previous: ActionState,
  form: FormData,
): Promise<ActionState> {
  const id = text(form, 'connectionId') ?? '';
  const credential = text(form, 'credential');
  const settings = settingsOf(form);
  const name = text(form, 'name');
  const state = await callApi(
    `/integrations/${id}`,
    {
      method: 'PATCH',
      body: {
        ...(name ? { name } : {}),
        ...(credential ? { credential } : {}),
        ...(Object.keys(settings).length > 0 ? { settings } : {}),
      },
    },
    'Saved',
    form,
  );
  if (state.status === 'success') refresh();
  return state;
}

export async function saveMapping(_previous: ActionState, form: FormData): Promise<ActionState> {
  const token = await readAccessToken();
  if (!token) return { status: 'error', message: 'Please sign in again.' };
  const id = text(form, 'connectionId') ?? '';
  const fieldMappings = mappingOf(form);

  try {
    const saved = await request<{ id: string }>(`/integrations/${id}`, {
      method: 'PATCH',
      body: { fieldMappings },
      token,
    });
    refresh();
    return { status: 'success', message: saved.message ?? 'Mapping saved' };
  } catch (error) {
    return {
      status: 'error',
      message: describeError(error),
      ...fieldErrorsOf(error),
      /**
       * The whole mapping, echoed as JSON.
       *
       * `submittedValues` keeps one value per name, and this form submits `mapSource` once per row
       * — so a refusal would come back with whichever row happened to be last and silently drop
       * the others, which is the trap the webhook event picker paid for. The editor rebuilds its
       * rows from this, so a refused save returns the mapping somebody wrote with the refusal
       * printed against the row it belongs to.
       */
      values: { mapping: JSON.stringify(fieldMappings) },
    };
  }
}

/**
 * Probe it now.
 *
 * The outcome is in `ActionState.data` as well as the message, because the row below it is
 * re-rendered from the server tree and will already carry the new standing — the message says what
 * just happened, and the row says where that leaves it.
 */
export async function checkIntegration(
  _previous: ActionState,
  form: FormData,
): Promise<ActionState> {
  const token = await readAccessToken();
  if (!token) return { status: 'error', message: 'Please sign in again.' };
  const id = text(form, 'connectionId') ?? '';
  try {
    const checked = await request<{ outcome: string; statusAfter: string; latencyMs: number | null }>(
      `/integrations/${id}/check`,
      { method: 'POST', token },
    );
    refresh();
    return {
      status: 'success',
      message:
        checked.data.outcome === 'ok'
          ? `Answered in ${checked.data.latencyMs} ms.`
          : `The provider ${checked.data.outcome === 'unauthorized' ? 'refused the credential' : 'did not answer properly'}.`,
      data: { outcome: checked.data.outcome, statusAfter: checked.data.statusAfter },
    };
  } catch (error) {
    return { status: 'error', message: describeError(error) };
  }
}

export async function rotateConnectionSecret(
  _previous: ActionState,
  form: FormData,
): Promise<ActionState> {
  const token = await readAccessToken();
  if (!token) return { status: 'error', message: 'Please sign in again.' };
  const id = text(form, 'connectionId') ?? '';
  try {
    const rotated = await request<CreatedConnection>(`/integrations/${id}/rotate-secret`, {
      method: 'POST',
      token,
    });
    refresh();
    return {
      status: 'success',
      message: rotated.message ?? 'Rotated',
      data: { secret: rotated.data.secret ?? '', connectionId: id, name: rotated.data.name },
    };
  } catch (error) {
    return { status: 'error', message: describeError(error) };
  }
}

export async function disconnectIntegration(
  _previous: ActionState,
  form: FormData,
): Promise<ActionState> {
  const id = text(form, 'connectionId') ?? '';
  const state = await callApi(
    `/integrations/${id}/disconnect`,
    { method: 'POST' },
    'Disconnected',
  );
  if (state.status === 'success') refresh();
  return state;
}
