'use server';

import { revalidatePath } from 'next/cache';
import { callApi, text } from '@/lib/server-action';
import type { ActionState } from '@/lib/action-state';

/**
 * Moving a lead between stages.
 *
 * The same endpoint the detail screen's stage control uses, so the API's validation of a stage's
 * required fields applies identically whether a lead was dragged or chosen from a list — a board
 * that could bypass a rule the detail screen enforces would be a way to corrupt data by preferring
 * one screen over another.
 */
export async function moveLeadToStage(
  _previous: ActionState,
  form: FormData,
): Promise<ActionState> {
  const leadId = text(form, 'leadId');
  const stageId = text(form, 'stageId');
  if (!leadId || !stageId) return { status: 'error', message: 'Which lead, and which stage?' };

  const state = await callApi(
    `/leads/${leadId}/stage`,
    { method: 'POST', body: { stageId } },
    'Moved',
  );
  revalidatePath('/pipeline');
  revalidatePath('/leads');
  revalidatePath(`/leads/${leadId}`);
  return state;
}
