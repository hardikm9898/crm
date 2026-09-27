import { newId } from '@leados/shared';
import type { DbTransactionClient } from '../client.js';

/**
 * The CRM vocabulary a new organization starts with (docs/database-design.md §17).
 *
 * Every row here is **editable the moment it exists** — that is the point. A business that sells
 * flats and one that runs a coaching centre describe their pipeline differently, and rule 4 says none
 * of it may be hardcoded. What a default buys is that the product works on first login: a lead can be
 * created because there is a default status and a default pipeline to put it in.
 *
 * Deliberately industry-neutral. Industry templates (`FR-ONB-2`) layer on top of this and arrive with
 * the onboarding work; they add fields and rename stages rather than replacing the mechanism.
 *
 * Shared between provisioning and the development seed for the same reason the platform catalogue is:
 * two definitions of "what a new organization looks like" would drift, and the drift would only show
 * up as a support ticket from a real tenant.
 */

interface StatusSeed {
  readonly name: string;
  readonly category: 'open' | 'won' | 'lost' | 'invalid';
  readonly colour: string;
  readonly isDefault?: boolean;
}

/** Ordered as a business would read them, which is the order they are shown in. */
const STATUS_SEEDS: readonly StatusSeed[] = [
  { name: 'New', category: 'open', colour: '#3b5bdb', isDefault: true },
  { name: 'Contacted', category: 'open', colour: '#1098ad' },
  { name: 'Qualified', category: 'open', colour: '#0ca678' },
  { name: 'Proposal sent', category: 'open', colour: '#f59f00' },
  { name: 'Negotiating', category: 'open', colour: '#e8590c' },
  { name: 'Won', category: 'won', colour: '#2f9e44' },
  { name: 'Lost', category: 'lost', colour: '#e03131' },
  { name: 'Invalid', category: 'invalid', colour: '#868e96' },
];

interface StageSeed {
  readonly name: string;
  readonly colour: string;
  readonly probability: number;
  readonly isWon?: boolean;
  readonly isLost?: boolean;
}

const STAGE_SEEDS: readonly StageSeed[] = [
  { name: 'New enquiry', colour: '#3b5bdb', probability: 10 },
  { name: 'Contacted', colour: '#1098ad', probability: 25 },
  { name: 'Qualified', colour: '#0ca678', probability: 45 },
  { name: 'Proposal', colour: '#f59f00', probability: 65 },
  { name: 'Negotiation', colour: '#e8590c', probability: 80 },
  { name: 'Won', colour: '#2f9e44', probability: 100, isWon: true },
  { name: 'Lost', colour: '#e03131', probability: 0, isLost: true },
];

/**
 * `type` groups sources for reporting; `costModel` says whether spend can be attributed to them,
 * which is what lets a cost-per-lead report exist at all without guessing.
 */
const SOURCE_SEEDS: readonly {
  readonly name: string;
  readonly type: string;
  readonly costModel: string;
}[] = [
  { name: 'Website', type: 'organic', costModel: 'none' },
  { name: 'Website form', type: 'organic', costModel: 'none' },
  { name: 'Facebook Ads', type: 'paid', costModel: 'per_click' },
  { name: 'Google Ads', type: 'paid', costModel: 'per_click' },
  { name: 'WhatsApp', type: 'direct', costModel: 'none' },
  { name: 'Referral', type: 'referral', costModel: 'none' },
  { name: 'Walk-in', type: 'offline', costModel: 'none' },
  { name: 'Phone call', type: 'direct', costModel: 'none' },
  { name: 'Manual entry', type: 'internal', costModel: 'none' },
  { name: 'API', type: 'internal', costModel: 'none' },
];

/** `requiresNote` on the vague ones is what stops "Other" becoming the most common reason. */
const LOST_REASON_SEEDS: readonly { readonly name: string; readonly requiresNote?: boolean }[] = [
  { name: 'Price too high' },
  { name: 'Bought from a competitor', requiresNote: true },
  { name: 'Not the right time' },
  { name: 'Not interested' },
  { name: 'No response after follow-ups' },
  { name: 'Wrong or unreachable number' },
  { name: 'Requirement changed' },
  { name: 'Other', requiresNote: true },
];

export interface CrmDefaultsResult {
  readonly defaultStatusId: string;
  readonly pipelineId: string;
  readonly firstStageId: string;
  readonly sourceIdsByName: ReadonlyMap<string, string>;
}

/**
 * Writes the defaults inside the caller's transaction.
 *
 * Idempotent by absence rather than by upsert: if the organization already has statuses, this does
 * nothing. Re-running the development seed must not duplicate a tenant's pipeline, and provisioning
 * must not be retryable into a second copy.
 */
export async function seedCrmDefaults(
  tx: DbTransactionClient,
  organizationId: string,
): Promise<CrmDefaultsResult | null> {
  const existing = await tx.leadStatus.findFirst({ where: { organizationId } });
  if (existing) return null;

  const statusIds = new Map<string, string>();
  for (const [index, seed] of STATUS_SEEDS.entries()) {
    const id = newId();
    statusIds.set(seed.name, id);
    await tx.leadStatus.create({
      data: {
        id,
        organizationId,
        name: seed.name,
        category: seed.category,
        colour: seed.colour,
        sortOrder: index,
        isDefault: seed.isDefault ?? false,
      },
    });
  }

  const pipelineId = newId();
  await tx.pipeline.create({
    data: {
      id: pipelineId,
      organizationId,
      name: 'Sales',
      entityType: 'lead',
      isDefault: true,
    },
  });

  const stageIds: string[] = [];
  for (const [index, seed] of STAGE_SEEDS.entries()) {
    const id = newId();
    stageIds.push(id);
    await tx.pipelineStage.create({
      data: {
        id,
        organizationId,
        pipelineId,
        name: seed.name,
        colour: seed.colour,
        sortOrder: index,
        probability: seed.probability,
        isWon: seed.isWon ?? false,
        isLost: seed.isLost ?? false,
      },
    });
  }

  const sourceIdsByName = new Map<string, string>();
  for (const [index, seed] of SOURCE_SEEDS.entries()) {
    const id = newId();
    sourceIdsByName.set(seed.name, id);
    await tx.leadSource.create({
      data: {
        id,
        organizationId,
        name: seed.name,
        type: seed.type,
        costModel: seed.costModel,
        sortOrder: index,
      },
    });
  }

  for (const [index, seed] of LOST_REASON_SEEDS.entries()) {
    await tx.lostReason.create({
      data: {
        id: newId(),
        organizationId,
        name: seed.name,
        sortOrder: index,
        requiresNote: seed.requiresNote ?? false,
      },
    });
  }

  const defaultStatusId = statusIds.get('New');
  const firstStageId = stageIds[0];
  /* c8 ignore next */
  if (!defaultStatusId || !firstStageId)
    throw new Error('CRM defaults are internally inconsistent');

  return { defaultStatusId, pipelineId, firstStageId, sourceIdsByName };
}

export const CRM_DEFAULT_SEEDS = {
  statuses: STATUS_SEEDS,
  stages: STAGE_SEEDS,
  sources: SOURCE_SEEDS,
  lostReasons: LOST_REASON_SEEDS,
} as const;
