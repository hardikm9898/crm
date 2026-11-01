'use server';

import { revalidatePath } from 'next/cache';
import { callApi, text } from '@/lib/server-action';
import type { ActionState } from '@/lib/action-state';

/**
 * Template mutations (`FR-WA-5`).
 *
 * The variable map is submitted as one field per variable (`variable-1`, `variable-2`), because a
 * repeating field cannot be echoed back through `submittedValues` — it keeps one value per name,
 * so a refusal would come back with the last row and silently drop the others.
 */
function refresh(): void {
  revalidatePath('/settings/whatsapp/templates');
  revalidatePath('/inbox');
}

function variableMapOf(form: FormData): Record<string, string> {
  const map: Record<string, string> = {};
  for (const [key, value] of form.entries()) {
    const match = /^variable-(\d+)$/.exec(key);
    if (match && typeof value === 'string' && value.trim() !== '') {
      map[match[1] as string] = value.trim();
    }
  }
  return map;
}

export async function createTemplate(_previous: ActionState, form: FormData): Promise<ActionState> {
  const body = text(form, 'body') ?? '';
  const result = await callApi(
    '/whatsapp/templates',
    {
      method: 'POST',
      body: {
        accountId: text(form, 'accountId'),
        name: text(form, 'name'),
        language: text(form, 'language') ?? 'en',
        category: text(form, 'category') ?? 'utility',
        components: {
          ...(text(form, 'header') ? { header: text(form, 'header') } : {}),
          body,
          ...(text(form, 'footer') ? { footer: text(form, 'footer') } : {}),
        },
        variableMap: variableMapOf(form),
      },
    },
    'Saved as a draft.',
    form,
  );
  if (result.status === 'success') refresh();
  return result;
}

/** Sends it to Meta for review. Nothing about it can be edited afterwards, which is Meta's rule. */
export async function submitTemplate(_previous: ActionState, form: FormData): Promise<ActionState> {
  const result = await callApi(
    `/whatsapp/templates/${String(form.get('templateId') ?? '')}/submit`,
    { method: 'POST', body: {} },
    'Sent to WhatsApp for review.',
  );
  if (result.status === 'success') refresh();
  return result;
}

export async function archiveTemplate(
  _previous: ActionState,
  form: FormData,
): Promise<ActionState> {
  const result = await callApi(
    `/whatsapp/templates/${String(form.get('templateId') ?? '')}`,
    { method: 'DELETE' },
    'Archived.',
  );
  if (result.status === 'success') refresh();
  return result;
}

/** Asks Meta what it thinks of them all now, which is the button for somebody who cannot wait. */
export async function syncTemplates(_previous: ActionState, form: FormData): Promise<ActionState> {
  const result = await callApi(
    '/whatsapp/templates/sync',
    { method: 'POST', body: { accountId: text(form, 'accountId') } },
    'Asked WhatsApp.',
  );
  if (result.status === 'success') refresh();
  return result;
}
