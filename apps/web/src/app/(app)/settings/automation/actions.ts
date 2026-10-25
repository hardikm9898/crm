'use server';

import { revalidatePath } from 'next/cache';
import { callApi, text } from '@/lib/server-action';
import type { ActionState } from '@/lib/action-state';

/**
 * The workflow actions (`FR-AUT-4`, `FR-AUT-5`).
 *
 * The definition travels as **one** field — a JSON string the editor holds in React state — and
 * not as a field per step. A form whose fields repeat cannot echo its submission through
 * `submittedValues`: it keeps one value per name, so a mapping editor submitting `mapSource` once
 * per row came back from a refusal with the last row and silently dropped the others. One field
 * means a refusal echoes the whole graph, which is what lets somebody fix one step and press save
 * again.
 */
function refresh(id?: string): void {
  revalidatePath('/settings/automation');
  if (id !== undefined) revalidatePath(`/settings/automation/${id}`);
}

export async function createWorkflow(
  _previous: ActionState,
  form: FormData,
): Promise<ActionState> {
  const result = await callApi<{ id: string }>(
    '/automation/workflows',
    {
      method: 'POST',
      body: {
        name: text(form, 'name'),
        description: text(form, 'description') ?? null,
      },
    },
    'Created as a draft.',
    form,
  );
  if (result.status === 'success') refresh();
  return result;
}

export async function saveDefinition(
  _previous: ActionState,
  form: FormData,
): Promise<ActionState> {
  const id = text(form, 'workflowId');
  const raw = text(form, 'definition') ?? '{}';
  let definition: unknown;
  try {
    definition = JSON.parse(raw);
  } catch {
    // Only reachable if the hidden field was tampered with, and a sentence is still better than a
    // 400 about JSON.
    return { status: 'error', message: 'That workflow could not be read. Reload and try again.' };
  }
  const result = await callApi(
    `/automation/workflows/${id}/definition`,
    { method: 'PUT', body: { definition } },
    'Draft saved.',
    form,
  );
  if (result.status === 'success') refresh(id);
  return result;
}

export async function publishWorkflow(
  _previous: ActionState,
  form: FormData,
): Promise<ActionState> {
  const id = text(form, 'workflowId');
  const result = await callApi(
    `/automation/workflows/${id}/publish`,
    { method: 'POST' },
    'Published.',
    form,
  );
  if (result.status === 'success') refresh(id);
  return result;
}

/**
 * Status, the kill switch and the guardrails, through one action.
 *
 * One action because they are one `PATCH`, and because a kill switch that went through its own
 * route would be a second answer to "what changes a workflow". The button that sets it says what
 * it does; the audit row records `workflow.stopped` rather than `workflow.updated`.
 */
export async function updateWorkflow(
  _previous: ActionState,
  form: FormData,
): Promise<ActionState> {
  const id = text(form, 'workflowId');
  const status = text(form, 'status');
  const killSwitch = text(form, 'killSwitch');
  const reentryPolicy = text(form, 'reentryPolicy');
  const cooldownHours = text(form, 'cooldownHours');
  const maxRunsPerEntity = text(form, 'maxRunsPerEntity');

  const result = await callApi(
    `/automation/workflows/${id}`,
    {
      method: 'PATCH',
      body: {
        ...(text(form, 'name') === undefined ? {} : { name: text(form, 'name') }),
        ...(form.has('description') ? { description: text(form, 'description') ?? null } : {}),
        ...(status === undefined ? {} : { status }),
        ...(killSwitch === undefined ? {} : { killSwitch: killSwitch === 'true' }),
        ...(reentryPolicy === undefined ? {} : { reentryPolicy }),
        // An empty box is "no cap", which is `null` and not the 0 `Number('')` would hand over.
        ...(form.has('cooldownHours')
          ? { cooldownHours: cooldownHours === undefined ? null : Number(cooldownHours) }
          : {}),
        ...(form.has('maxRunsPerEntity')
          ? { maxRunsPerEntity: maxRunsPerEntity === undefined ? null : Number(maxRunsPerEntity) }
          : {}),
      },
    },
    killSwitch === 'true' ? 'Stopped.' : 'Saved.',
    form,
  );
  if (result.status === 'success') refresh(id);
  return result;
}

export async function deleteWorkflow(
  _previous: ActionState,
  form: FormData,
): Promise<ActionState> {
  const result = await callApi(
    `/automation/workflows/${text(form, 'workflowId')}`,
    { method: 'DELETE' },
    'Deleted.',
    form,
  );
  if (result.status === 'success') refresh();
  return result;
}
