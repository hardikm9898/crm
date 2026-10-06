'use server';

import { revalidatePath } from 'next/cache';
import { callApi, text } from '@/lib/server-action';
import type { ActionState } from '@/lib/action-state';
import { nextStepKey, ONBOARDING_STEPS, type OnboardingState } from '@/lib/onboarding';

/**
 * Settings mutations.
 *
 * None of these check permissions: the API does, and duplicating the rule here would mean two
 * places to keep in step. What they do is attach the caller's token, shape the request, and
 * invalidate the page's cache so the next render shows the truth rather than the optimistic guess.
 */
export async function updateOrganization(
  _previous: ActionState,
  form: FormData,
): Promise<ActionState> {
  // Only the fields actually present are sent: the API rejects an empty patch, and sending every
  // field would overwrite a value someone else changed in another tab.
  const body: Record<string, unknown> = {};
  for (const field of [
    'name',
    'legalName',
    'industry',
    'timezone',
    'defaultCurrency',
    'defaultPhoneCountry',
  ] as const) {
    const value = text(form, field);
    if (value !== undefined) body[field] = value;
  }
  if (Object.keys(body).length === 0) {
    return { status: 'error', message: 'Nothing to save.' };
  }

  const result = await callApi('/organization', { method: 'PATCH', body }, 'Settings saved');
  if (result.status === 'success') revalidatePath('/settings');
  return result;
}

export async function advanceOnboarding(
  _previous: ActionState,
  form: FormData,
): Promise<ActionState> {
  const current = text(form, 'step');
  const finishing = form.get('finish') === 'true';

  const body = finishing
    ? { completed: true }
    : { step: nextStepKey(current) ?? ONBOARDING_STEPS[ONBOARDING_STEPS.length - 1]?.key };

  const result = await callApi<{ onboarding: OnboardingState }>(
    '/organization/onboarding',
    { method: 'PATCH', body },
    finishing ? 'Setup complete' : 'Step saved',
  );
  if (result.status === 'success') {
    revalidatePath('/settings');
    revalidatePath('/dashboard');
  }
  return result;
}

/**
 * Applies an industry template, and advances the wizard past the industry step (`FR-ONB-2`).
 *
 * One action rather than two, because choosing an industry **is** that step: making somebody pick a
 * template and then separately tick a box is a form arguing with itself. The API refuses the whole
 * thing if the workspace already has records, and its refusal says what to do instead — which is
 * the sentence this returns.
 */
export async function applyIndustryTemplate(
  _previous: ActionState,
  form: FormData,
): Promise<ActionState> {
  const key = text(form, 'key');
  if (!key) return { status: 'error', message: 'Choose an industry first.' };

  const applied = await callApi<{ name: string }>(
    '/organization/industry-template',
    { method: 'POST', body: { key } },
    'Industry set up.',
  );
  if (applied.status !== 'success') return applied;

  // Only advance the wizard if the template actually landed: a step marked done over a failure is
  // how somebody ends up on "start working" with the generic vocabulary.
  await callApi('/organization/onboarding', { method: 'PATCH', body: { step: 'pipeline' } }, 'ok');

  revalidatePath('/settings');
  revalidatePath('/dashboard');
  revalidatePath('/leads');
  revalidatePath('/settings/fields');
  return applied;
}

// ── People ──────────────────────────────────────────────────────────────────

export async function inviteMember(_previous: ActionState, form: FormData): Promise<ActionState> {
  const email = text(form, 'email');
  const roleId = text(form, 'roleId');
  if (!email || !roleId) {
    return { status: 'error', message: 'An email address and a role are both required.' };
  }

  const result = await callApi(
    '/users/invitations',
    {
      method: 'POST',
      body: {
        email,
        roleId,
        ...(text(form, 'teamId') ? { teamId: text(form, 'teamId') } : {}),
        ...(text(form, 'branchId') ? { branchId: text(form, 'branchId') } : {}),
      },
    },
    'Invitation sent',
  );
  if (result.status === 'success') revalidatePath('/settings/members');
  return result;
}

export async function revokeInvitation(
  _previous: ActionState,
  form: FormData,
): Promise<ActionState> {
  const id = text(form, 'invitationId');
  if (!id) return { status: 'error', message: 'Nothing to revoke.' };

  const result = await callApi(
    `/users/invitations/${encodeURIComponent(id)}`,
    { method: 'DELETE' },
    'Invitation revoked',
  );
  if (result.status === 'success') revalidatePath('/settings/members');
  return result;
}

/**
 * Roles are replaced wholesale, not toggled: the screen submits the intended final set and the API
 * takes `PUT /users/:id/roles`, which is what makes a concurrent edit lose cleanly instead of
 * merging two half-intentions.
 */
export async function setMemberRoles(_previous: ActionState, form: FormData): Promise<ActionState> {
  const userId = text(form, 'userId');
  if (!userId) return { status: 'error', message: 'No person selected.' };

  const roleIds = form
    .getAll('roleIds')
    .filter((value): value is string => typeof value === 'string' && value !== '');
  if (roleIds.length === 0) {
    return { status: 'error', message: 'Choose at least one role.' };
  }

  const result = await callApi(
    `/users/${encodeURIComponent(userId)}/roles`,
    { method: 'PUT', body: { roleIds } },
    'Roles updated',
  );
  if (result.status === 'success') revalidatePath('/settings/members');
  return result;
}

export async function updateMemberStatus(
  _previous: ActionState,
  form: FormData,
): Promise<ActionState> {
  const userId = text(form, 'userId');
  const status = text(form, 'status');
  if (!userId || (status !== 'active' && status !== 'suspended')) {
    return { status: 'error', message: 'Choose active or suspended.' };
  }

  const result = await callApi(
    `/users/${encodeURIComponent(userId)}`,
    { method: 'PATCH', body: { status } },
    status === 'suspended' ? 'Access suspended' : 'Access restored',
  );
  if (result.status === 'success') revalidatePath('/settings/members');
  return result;
}
