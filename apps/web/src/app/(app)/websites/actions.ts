'use server';

import { revalidatePath } from 'next/cache';
import { callApi, text } from '@/lib/server-action';
import type { ActionState } from '@/lib/action-state';

/**
 * The website actions (`FR-WEB-2`, `FR-WEB-5`).
 *
 * A page's blocks travel as **one** field — a JSON string the editor holds in React state — and not
 * as a field per block. `submittedValues` keeps one value per name, so a form whose fields repeat
 * comes back from a refusal having silently dropped every row but the last: the mapping editor paid
 * for that, and the workflow editor is built this way for the same reason. One field means a
 * refusal echoes the whole page, which is what lets somebody fix one block and press save again.
 */
function refresh(id?: string): void {
  revalidatePath('/websites');
  if (id !== undefined) revalidatePath(`/websites/${id}`);
}

export async function createWebsite(_previous: ActionState, form: FormData): Promise<ActionState> {
  const result = await callApi<{ id: string }>(
    '/websites',
    { method: 'POST', body: { name: text(form, 'name'), subdomain: text(form, 'subdomain') } },
    'Created as a draft.',
    form,
  );
  if (result.status === 'success') refresh();
  return result;
}

export async function saveTheme(_previous: ActionState, form: FormData): Promise<ActionState> {
  const id = text(form, 'websiteId') ?? '';
  const result = await callApi(
    `/websites/${id}`,
    {
      method: 'PATCH',
      body: {
        name: text(form, 'name'),
        theme: {
          // Only the keys the renderer reads. A theme is tenant-controlled JSON on its way into a
          // `style` attribute, and `themeStyle` allowlists them again on the way out — this is the
          // editor half of that, not a substitute for it.
          background: text(form, 'background') ?? '',
          text: text(form, 'textColour') ?? '',
          muted: text(form, 'muted') ?? '',
          accent: text(form, 'accent') ?? '',
          accentContrast: text(form, 'accentContrast') ?? '',
          font: text(form, 'font') ?? '',
        },
      },
    },
    'Saved. The live site is unchanged until you publish.',
    form,
  );
  if (result.status === 'success') refresh(id);
  return result;
}

export async function createPage(_previous: ActionState, form: FormData): Promise<ActionState> {
  const id = text(form, 'websiteId') ?? '';
  const result = await callApi(
    `/websites/${id}/pages`,
    { method: 'POST', body: { path: text(form, 'path'), title: text(form, 'title') } },
    'Page added as a draft.',
    form,
  );
  if (result.status === 'success') refresh(id);
  return result;
}

export async function savePage(_previous: ActionState, form: FormData): Promise<ActionState> {
  const id = text(form, 'websiteId') ?? '';
  const pageId = text(form, 'pageId') ?? '';
  const raw = text(form, 'blocks') ?? '[]';
  let blocks: unknown;
  try {
    blocks = JSON.parse(raw);
  } catch {
    // Not reachable from the editor, which serialises its own state. Answered rather than thrown,
    // because a 500 on a save is the one failure that makes somebody stop trusting the button.
    return { status: 'error', message: 'That page could not be read. Reload and try again.' };
  }
  const result = await callApi(
    `/websites/${id}/pages/${pageId}`,
    {
      method: 'PATCH',
      body: {
        title: text(form, 'title'),
        status: text(form, 'status'),
        blocks,
      },
    },
    'Saved. The live site is unchanged until you publish.',
    form,
  );
  if (result.status === 'success') refresh(id);
  return result;
}

export async function makeHome(_previous: ActionState, form: FormData): Promise<ActionState> {
  const id = text(form, 'websiteId') ?? '';
  const pageId = text(form, 'pageId') ?? '';
  const result = await callApi(
    `/websites/${id}/pages/${pageId}`,
    { method: 'PATCH', body: { isHome: true } },
    'That is the home page now.',
    form,
  );
  if (result.status === 'success') refresh(id);
  return result;
}

export async function deletePage(_previous: ActionState, form: FormData): Promise<ActionState> {
  const id = text(form, 'websiteId') ?? '';
  const pageId = text(form, 'pageId') ?? '';
  const result = await callApi(
    `/websites/${id}/pages/${pageId}`,
    { method: 'DELETE' },
    'Page removed. Every published version still has it.',
    form,
  );
  if (result.status === 'success') refresh(id);
  return result;
}

export async function publishSite(_previous: ActionState, form: FormData): Promise<ActionState> {
  const id = text(form, 'websiteId') ?? '';
  const result = await callApi(`/websites/${id}/publish`, { method: 'POST' }, 'Published.', form);
  if (result.status === 'success') refresh(id);
  return result;
}

export async function unpublishSite(_previous: ActionState, form: FormData): Promise<ActionState> {
  const id = text(form, 'websiteId') ?? '';
  const result = await callApi(
    `/websites/${id}/unpublish`,
    { method: 'POST' },
    'Taken offline. Your pages are kept.',
    form,
  );
  if (result.status === 'success') refresh(id);
  return result;
}

export async function rollbackSite(_previous: ActionState, form: FormData): Promise<ActionState> {
  const id = text(form, 'websiteId') ?? '';
  const result = await callApi(
    `/websites/${id}/rollback`,
    { method: 'POST', body: { versionId: text(form, 'versionId') } },
    'Rolled back. That version is live again as a new version.',
    form,
  );
  if (result.status === 'success') refresh(id);
  return result;
}
