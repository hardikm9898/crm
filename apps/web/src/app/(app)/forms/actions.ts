'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { describeError, request } from '@/lib/api';
import { callApi, fieldErrorsOf, submittedValues, text } from '@/lib/server-action';
import { readAccessToken } from '@/lib/session';
import type { ActionState } from '@/lib/action-state';

/**
 * Form mutations (`FR-CAP-2`).
 *
 * The questions are saved as **one** call (`PUT /forms/:id/fields`), because that is what they are
 * to the person editing them: a list, reordered and relabelled as a whole. Per-field actions would
 * let "move this to step 2" half-apply, and a half-saved form captures the wrong things without
 * saying so.
 *
 * The field set is carried through `FormData` as a JSON string rather than as thirty indexed
 * inputs. That is unusual here and deliberate: the builder is a client component that already
 * holds the list as state, and flattening it into `fields[3][label]` only to parse it back would
 * be two formats to keep in step.
 */
function refresh(id?: string): void {
  revalidatePath('/forms');
  if (id) revalidatePath(`/forms/${id}`);
}

export async function createForm(_previous: ActionState, form: FormData): Promise<ActionState> {
  const token = await readAccessToken();
  if (!token) return { status: 'error', message: 'Please sign in again.' };

  const body = {
    name: text(form, 'name') ?? '',
    ...(text(form, 'slug') ? { slug: text(form, 'slug') } : {}),
    ...(text(form, 'type') ? { type: text(form, 'type') } : {}),
    settings: {
      ...(text(form, 'submitLabel') ? { submitLabel: text(form, 'submitLabel') } : {}),
      ...(text(form, 'thankYouMessage') ? { thankYouMessage: text(form, 'thankYouMessage') } : {}),
      ...(text(form, 'redirectUrl') ? { redirectUrl: text(form, 'redirectUrl') } : {}),
      ...(text(form, 'introText') ? { introText: text(form, 'introText') } : {}),
    },
    fields: parseFields(form),
  };

  try {
    const created = await request<{ id: string }>('/forms', { method: 'POST', body, token });
    refresh(created.data.id);
    // Straight to the form that was just made: the next thing anybody wants is its link.
    redirect(`/forms/${created.data.id}`);
  } catch (error) {
    // `redirect` throws by design, so it must not be swallowed as a failure.
    if (isRedirect(error)) throw error;
    return failure(error, form);
  }
}

export async function updateForm(_previous: ActionState, form: FormData): Promise<ActionState> {
  const id = text(form, 'id');
  if (!id) return { status: 'error', message: 'Which form?' };

  const state = await callApi(
    `/forms/${id}`,
    {
      method: 'PATCH',
      body: {
        ...(text(form, 'name') ? { name: text(form, 'name') } : {}),
        ...(text(form, 'slug') ? { slug: text(form, 'slug') } : {}),
        ...(text(form, 'type') ? { type: text(form, 'type') } : {}),
        ...(form.get('pipelineId') !== null
          ? { pipelineId: text(form, 'pipelineId') ?? null }
          : {}),
        ...(form.get('leadSourceId') !== null
          ? { leadSourceId: text(form, 'leadSourceId') ?? null }
          : {}),
        ...(form.get('assignmentRuleId') !== null
          ? { assignmentRuleId: text(form, 'assignmentRuleId') ?? null }
          : {}),
        ...(form.get('submitLabel') !== null || form.get('thankYouMessage') !== null
          ? {
              settings: {
                ...(text(form, 'submitLabel') ? { submitLabel: text(form, 'submitLabel') } : {}),
                ...(text(form, 'thankYouMessage')
                  ? { thankYouMessage: text(form, 'thankYouMessage') }
                  : {}),
                redirectUrl: text(form, 'redirectUrl') ?? null,
                introText: text(form, 'introText') ?? null,
              },
            }
          : {}),
      },
    },
    'Form updated',
    form,
  );
  if (state.status === 'success') refresh(id);
  return state;
}

/** Switching a form on or off. Off means the public URL stops answering, immediately. */
export async function setFormActive(_previous: ActionState, form: FormData): Promise<ActionState> {
  const id = text(form, 'id');
  if (!id) return { status: 'error', message: 'Which form?' };
  const isActive = text(form, 'isActive') === 'true';
  const state = await callApi(
    `/forms/${id}`,
    { method: 'PATCH', body: { isActive } },
    isActive ? 'Form switched on' : 'Form switched off',
  );
  if (state.status === 'success') refresh(id);
  return state;
}

export async function saveFormFields(_previous: ActionState, form: FormData): Promise<ActionState> {
  const id = text(form, 'id');
  if (!id) return { status: 'error', message: 'Which form?' };
  const fields = parseFields(form);
  const state = await callApi(
    `/forms/${id}/fields`,
    { method: 'PUT', body: { fields } },
    'Questions saved',
    form,
  );
  if (state.status === 'success') refresh(id);
  return state;
}

export async function rotateFormKey(_previous: ActionState, form: FormData): Promise<ActionState> {
  const id = text(form, 'id');
  if (!id) return { status: 'error', message: 'Which form?' };
  const state = await callApi(
    `/forms/${id}/rotate-key`,
    { method: 'POST' },
    'New link created — the old one no longer works',
  );
  if (state.status === 'success') refresh(id);
  return state;
}

export async function deleteForm(_previous: ActionState, form: FormData): Promise<ActionState> {
  const id = text(form, 'id');
  if (!id) return { status: 'error', message: 'Which form?' };
  const state = await callApi(`/forms/${id}`, { method: 'DELETE' }, 'Form deleted');
  if (state.status === 'success') {
    refresh(id);
    redirect('/forms');
  }
  return state;
}

/**
 * The question list, as the builder sent it.
 *
 * Anything malformed is dropped rather than guessed at: a question with no label is one nobody
 * could answer, and sending it would get a refusal naming a field the person never typed into.
 */
function parseFields(form: FormData): unknown[] {
  const raw = form.get('fields');
  if (typeof raw !== 'string' || raw.trim() === '') return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (field): field is Record<string, unknown> =>
          typeof field === 'object' &&
          field !== null &&
          typeof (field as { label?: unknown }).label === 'string',
      )
      .map((field) => ({
        ...(typeof field['standardFieldKey'] === 'string'
          ? { standardFieldKey: field['standardFieldKey'] }
          : {}),
        ...(typeof field['customFieldDefinitionId'] === 'string'
          ? { customFieldDefinitionId: field['customFieldDefinitionId'] }
          : {}),
        label: field['label'],
        ...(typeof field['placeholder'] === 'string' && field['placeholder'] !== ''
          ? { placeholder: field['placeholder'] }
          : {}),
        ...(typeof field['helpText'] === 'string' && field['helpText'] !== ''
          ? { helpText: field['helpText'] }
          : {}),
        isRequired: field['isRequired'] === true,
        stepIndex: typeof field['stepIndex'] === 'number' ? field['stepIndex'] : 0,
      }));
  } catch {
    return [];
  }
}

function isRedirect(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    typeof (error as { digest?: unknown }).digest === 'string' &&
    (error as { digest: string }).digest.startsWith('NEXT_REDIRECT')
  );
}

function failure(error: unknown, form: FormData): ActionState {
  return {
    status: 'error',
    message: describeError(error),
    ...fieldErrorsOf(error),
    values: submittedValues(form),
  };
}
