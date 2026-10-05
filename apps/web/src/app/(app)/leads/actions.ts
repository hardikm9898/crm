'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { describeError, request } from '@/lib/api';
import { callApi, fieldErrorsOf, submittedValues, text } from '@/lib/server-action';
import { readAccessToken } from '@/lib/session';
import type { ActionState } from '@/lib/action-state';

/**
 * Lead mutations.
 *
 * Server actions rather than browser fetches because the access token lives in an httpOnly cookie
 * and only the server can attach it. Each one revalidates the paths whose content it changed, so a
 * list re-reads from the API instead of this app keeping a second copy of the truth.
 */

function revalidateLead(id?: string): void {
  revalidatePath('/leads');
  revalidatePath('/pipeline');
  if (id) revalidatePath(`/leads/${id}`);
}

export async function createLead(_previous: ActionState, form: FormData): Promise<ActionState> {
  const token = await readAccessToken();
  if (!token) return { status: 'error', message: 'Please sign in again.' };

  const payload: Record<string, unknown> = {
    firstName: text(form, 'firstName'),
    lastName: text(form, 'lastName'),
    company: text(form, 'company'),
    phone: text(form, 'phone'),
    whatsapp: text(form, 'whatsapp'),
    email: text(form, 'email'),
    city: text(form, 'city'),
    priority: text(form, 'priority'),
    leadSourceId: text(form, 'leadSourceId'),
    createdVia: 'manual',
  };
  const value = text(form, 'value');
  if (value !== undefined) {
    // The form asks for a whole amount; money crosses the wire in minor units everywhere here.
    const amount = Number(value);
    if (!Number.isFinite(amount) || amount < 0) {
      return {
        status: 'error',
        message: 'Some details need correcting.',
        fieldErrors: { value: 'Enter an amount, or leave it blank.' },
        values: submittedValues(form),
      };
    }
    payload['valueMinor'] = Math.round(amount * 100);
    payload['currency'] = text(form, 'currency') ?? 'INR';
  }

  let created: { id: string; attachedToExisting?: boolean };
  try {
    const response = await request<{ id: string; attachedToExisting?: boolean }>('/leads', {
      method: 'POST',
      body: payload,
      token,
    });
    created = response.data;
  } catch (error) {
    // `callApi` cannot be used here: this action needs the created lead's id to redirect to it.
    // The submission is echoed back so the form can re-fill itself — see `ActionState.values`.
    return {
      status: 'error',
      message: describeError(error),
      ...fieldErrorsOf(error),
      values: submittedValues(form),
    };
  }

  revalidateLead(created.id);
  // Straight to the lead, whether it was created or attached to one that already existed: either
  // way the next thing a person wants is the record they just described.
  redirect(`/leads/${created.id}`);
}

export async function assignLeads(_previous: ActionState, form: FormData): Promise<ActionState> {
  const ids = form.getAll('leadIds').filter((value): value is string => typeof value === 'string');
  if (ids.length === 0) return { status: 'error', message: 'Select at least one lead.' };
  const assignedUserId = text(form, 'assignedUserId') ?? null;

  const state = await callApi(
    '/assignment/reassign',
    { method: 'POST', body: { leadIds: ids, assignedUserId } },
    assignedUserId
      ? `Assigned ${ids.length} lead(s)`
      : `Returned ${ids.length} lead(s) to the pool`,
  );
  revalidateLead();
  return state;
}

export async function tagLeads(_previous: ActionState, form: FormData): Promise<ActionState> {
  const ids = form.getAll('leadIds').filter((value): value is string => typeof value === 'string');
  const tagId = text(form, 'tagId');
  if (ids.length === 0 || !tagId) return { status: 'error', message: 'Choose leads and a tag.' };
  const token = await readAccessToken();
  if (!token) return { status: 'error', message: 'Please sign in again.' };

  // `PUT /leads/:id/tags` is the intended final set, so each lead's existing tags are read first —
  // a bulk "add tag" that silently removed the others would be a data-loss bug dressed as a feature.
  let applied = 0;
  const failures: string[] = [];
  for (const id of ids) {
    try {
      const current = await request<{ tags: { id: string }[] }>(`/leads/${id}`, { token });
      const tagIds = [...new Set([...current.data.tags.map((tag) => tag.id), tagId])];
      await request(`/leads/${id}/tags`, { method: 'PUT', body: { tagIds }, token });
      applied += 1;
    } catch {
      failures.push(id);
    }
  }
  revalidateLead();
  if (applied === 0) return { status: 'error', message: 'Could not tag those leads.' };
  return {
    status: 'success',
    message:
      failures.length === 0
        ? `Tagged ${applied} lead(s)`
        : `Tagged ${applied} lead(s); ${failures.length} could not be tagged`,
  };
}

export async function deleteLeads(_previous: ActionState, form: FormData): Promise<ActionState> {
  const ids = form.getAll('leadIds').filter((value): value is string => typeof value === 'string');
  if (ids.length === 0) return { status: 'error', message: 'Select at least one lead.' };
  const token = await readAccessToken();
  if (!token) return { status: 'error', message: 'Please sign in again.' };

  let deleted = 0;
  for (const id of ids) {
    try {
      await request(`/leads/${id}`, { method: 'DELETE', token });
      deleted += 1;
    } catch {
      // Keep going: one lead the caller cannot delete should not abandon the rest.
    }
  }
  revalidateLead();
  if (deleted === 0) return { status: 'error', message: 'Could not delete those leads.' };
  return {
    status: 'success',
    message: `Moved ${deleted} lead(s) to the recycle bin. Nothing is destroyed — restore them from Deleted.`,
  };
}

export async function restoreLead(_previous: ActionState, form: FormData): Promise<ActionState> {
  const id = text(form, 'leadId');
  if (!id) return { status: 'error', message: 'Which lead?' };
  const state = await callApi(`/leads/${id}/restore`, { method: 'POST' }, 'Lead restored');
  revalidateLead(id);
  return state;
}
