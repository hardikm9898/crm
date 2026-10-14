'use server';

import { revalidatePath } from 'next/cache';
import { describeError, request } from '@/lib/api';
import { callApi, text } from '@/lib/server-action';
import { readAccessToken } from '@/lib/session';
import type { ActionState } from '@/lib/action-state';
import type { DryRunResult } from '@/lib/ingestion';

/**
 * The integration log's three actions (`FR-CAP-5`, `FR-CAP-6`).
 *
 * `replay` and the dry run are deliberately two different things: the dry run changes nothing and
 * answers what *would* happen, and the replay finishes a payload that is already stored. The import
 * wizard paid for the distinction — a screen that ran a state transition to show a preview turned
 * the browser's reload button into a state machine.
 */
function refresh(): void {
  revalidatePath('/ingestion');
}

/**
 * Finishes a stored payload that never became a lead.
 *
 * One at a time, by id: a bulk replay of a thousand failures whose cause has not been fixed is a
 * thousand more failures, and the API refuses a payload that already became something.
 */
export async function replayPayload(_previous: ActionState, form: FormData): Promise<ActionState> {
  const id = text(form, 'id');
  if (!id) return { status: 'error', message: 'Which payload?' };
  const state = await callApi(
    `/ingestion/payloads/${id}/replay`,
    { method: 'POST' },
    'Replayed — it became a lead this time',
  );
  if (state.status === 'success') refresh();
  return state;
}

/**
 * The one click (`FR-CAP-5`'s "surfaced with a one-click create custom field").
 *
 * It calls `POST /custom-fields`, the same endpoint the field builder uses. There is deliberately
 * no second creation endpoint for this: a field is a field, however somebody noticed they needed
 * one — and a parallel path would be a second place for the key rules to drift.
 */
export async function createFieldFromUnmapped(
  _previous: ActionState,
  form: FormData,
): Promise<ActionState> {
  const key = text(form, 'key');
  const label = text(form, 'label');
  const type = text(form, 'type') ?? 'text';
  if (!key || !label) return { status: 'error', message: 'Which field?' };

  const state = await callApi(
    '/custom-fields',
    {
      method: 'POST',
      body: {
        entityType: 'lead',
        key,
        label,
        type,
        // Filterable and shown in the list: a field created because an integration keeps sending it
        // is one somebody wants to search by, and a field nobody can filter on is half a field.
        isFilterable: true,
        showInList: true,
        helpText: 'Created from a field an integration was already sending.',
      },
    },
    `“${label}” is now a field on every lead`,
  );
  if (state.status === 'success') {
    refresh();
    // The lead screens render the field set, so they are stale the moment this succeeds.
    revalidatePath('/leads');
  }
  return state;
}

/**
 * The self-serve test tool (`FR-CAP-6`).
 *
 * The result comes back through `ActionState.data` — as **pre-formatted strings**, built here
 * rather than in the browser — because it is the answer to a POST that persists nothing, so there
 * is no re-rendered server tree it could come from. Anything a screen can render from the database
 * belongs in that tree; this is the handful of cases that cannot.
 */
export async function testIngestion(_previous: ActionState, form: FormData): Promise<ActionState> {
  const token = await readAccessToken();
  if (!token) return { status: 'error', message: 'Please sign in again.' };

  const raw = text(form, 'payload');
  if (!raw) return { status: 'error', message: 'Paste the JSON your integration would send.' };

  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    // Said here rather than sent: a body that is not JSON would be refused by the schema with a
    // message about the field it looked for first, which explains nothing about the real problem.
    return {
      status: 'error',
      message: 'That is not valid JSON — check the quotes and commas.',
      values: { payload: raw },
    };
  }
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return {
      status: 'error',
      message: 'A payload is a JSON object, like { "name": "Rohit", "phone": "98450 12345" }.',
      values: { payload: raw },
    };
  }

  try {
    const response = await request<DryRunResult>('/ingestion/test', {
      method: 'POST',
      body: { payload },
      token,
    });
    const result = response.data;
    return {
      status: 'success',
      message: response.message ?? 'Nothing was saved — this is what would have happened',
      data: {
        // The verdict first, because it is the one thing somebody pressing this wants: would the
        // real endpoint take it? A tool that printed a normalised payload and left the answer to be
        // inferred from it would be a tool for the person who wrote the endpoint.
        verdict: result.wouldCreate ? 'create' : 'refuse',
        normalized: JSON.stringify(result.normalized, null, 2),
        unmapped: result.unmappedFields.join(', '),
        notes: result.notes.join('\n'),
      },
    };
  } catch (error) {
    return { status: 'error', message: describeError(error), values: { payload: raw } };
  }
}
