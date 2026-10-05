'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { describeError, request } from '@/lib/api';
import { callApi, fieldErrorsOf } from '@/lib/server-action';
import { readAccessToken } from '@/lib/session';
import type { ActionState } from '@/lib/action-state';

/**
 * The import wizard's mutations.
 *
 * Every step is a server action and every step's result is a **persisted job state**, so the wizard
 * survives a reload, a closed tab and a shared link. The alternative — holding a 12 000-row file
 * and a 40-column mapping in client state — loses all of somebody's work to one stray refresh.
 */

const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

export async function uploadImport(_previous: ActionState, form: FormData): Promise<ActionState> {
  const token = await readAccessToken();
  if (!token) return { status: 'error', message: 'Please sign in again.' };

  const file = form.get('file');
  if (!(file instanceof File) || file.size === 0) {
    return {
      status: 'error',
      message: 'Choose a CSV file to import.',
      fieldErrors: { file: 'No file was attached.' },
    };
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return {
      status: 'error',
      message: 'That file is too large to import in one go.',
      fieldErrors: {
        file: `Up to ${Math.floor(MAX_UPLOAD_BYTES / (1024 * 1024))} MB. Split it and import the parts.`,
      },
    };
  }

  // The file's bytes *are* the request body (`content-type: text/csv`); its name travels in the
  // query, where it is metadata about the upload rather than part of the data.
  const content = await file.text();
  let jobId: string;
  try {
    const response = await request<{ id: string }>(
      `/imports?fileName=${encodeURIComponent(file.name)}`,
      { method: 'POST', token, rawBody: { content, contentType: 'text/csv' } },
    );
    jobId = response.data.id;
  } catch (error) {
    return { status: 'error', message: describeError(error), ...fieldErrorsOf(error) };
  }

  // A redirect rather than a rendered result: the job id belongs in the URL, so the mapping screen
  // is linkable and a reload does not re-upload the file.
  redirect(`/leads/import?job=${jobId}`);
}

export async function saveMapping(_previous: ActionState, form: FormData): Promise<ActionState> {
  const jobId = String(form.get('jobId') ?? '');
  const mode = String(form.get('mode') ?? 'create_only');
  if (!jobId) return { status: 'error', message: 'That import could not be found.' };

  // One select per column, named `column:<header>`. Anything left as `-` is a column the person
  // chose to ignore, which is the absence of a mapping rather than a mapping to nothing.
  const mapping: Record<string, string> = {};
  for (const [key, value] of form.entries()) {
    if (!key.startsWith('column:') || typeof value !== 'string' || value === '' || value === '-') {
      continue;
    }
    mapping[key.slice('column:'.length)] = value;
  }

  const state = await callApi(
    `/imports/${jobId}/mapping`,
    { method: 'PUT', body: { mapping, mode } },
    'Mapping saved.',
  );
  revalidatePath('/leads/import');
  return state;
}

export async function checkImport(_previous: ActionState, form: FormData): Promise<ActionState> {
  const jobId = String(form.get('jobId') ?? '');
  const state = await callApi(
    `/imports/${jobId}/validate`,
    { method: 'POST' },
    'Checked. See what will happen below.',
  );
  revalidatePath('/leads/import');
  return state;
}

export async function startImport(_previous: ActionState, form: FormData): Promise<ActionState> {
  const jobId = String(form.get('jobId') ?? '');
  const state = await callApi(`/imports/${jobId}/start`, { method: 'POST' }, 'Import started.');
  revalidatePath('/leads/import');
  revalidatePath('/leads');
  return state;
}

export async function cancelImport(_previous: ActionState, form: FormData): Promise<ActionState> {
  const jobId = String(form.get('jobId') ?? '');
  const state = await callApi(
    `/imports/${jobId}/cancel`,
    { method: 'POST' },
    'Import stopped. The leads already imported are kept.',
  );
  revalidatePath('/leads/import');
  return state;
}

/**
 * Exports the list the person is looking at.
 *
 * The filter is carried as the same encoded `f=` string the list uses, decoded here into the API's
 * filter shape — so "export what I am looking at" is the same query the screen just ran, rather
 * than a second filter that happens to look similar.
 */
export async function createExport(_previous: ActionState, form: FormData): Promise<ActionState> {
  const token = await readAccessToken();
  if (!token) return { status: 'error', message: 'Please sign in again.' };

  const viewId = String(form.get('viewId') ?? '');
  const filter = String(form.get('filter') ?? '');
  const columns = form
    .getAll('columns')
    .filter((value): value is string => typeof value === 'string' && value !== '');

  const body: Record<string, unknown> = {
    ...(viewId ? { viewId } : { filter: filter ? JSON.parse(filter) : { conditions: [] } }),
    ...(columns.length > 0 ? { columns } : {}),
  };

  try {
    await request<{ id: string }>('/exports', { method: 'POST', body, token });
  } catch (error) {
    return { status: 'error', message: describeError(error), ...fieldErrorsOf(error) };
  }
  revalidatePath('/leads/exports');
  redirect('/leads/exports');
}
