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

/**
 * A handful of tags, because every other piece of a tenant's vocabulary is seeded and this one was
 * not — which left tagging invisible on first login and in the demo workspace: the control existed,
 * the list behind it was empty, and nothing said why.
 *
 * Deliberately about *what a business notices*, not about temperature — the score bands already say
 * hot or cold, and a tag that duplicates them is two things to keep in sync.
 */
const TAG_SEEDS: readonly { readonly name: string; readonly colour: string }[] = [
  { name: 'Follow up', colour: '#3b5bdb' },
  { name: 'Budget confirmed', colour: '#0ca678' },
  { name: 'Price sensitive', colour: '#f59f00' },
  { name: 'Referral', colour: '#7048e8' },
  { name: 'Do not call', colour: '#e03131' },
];

export interface CrmDefaultsResult {
  readonly defaultStatusId: string;
  readonly pipelineId: string;
  readonly firstStageId: string;
  readonly sourceIdsByName: ReadonlyMap<string, string>;
  readonly duplicateRuleId: string;
}

/**
 * The starter tags, idempotent on their own.
 *
 * Separate from `seedCrmDefaults` because that function short-circuits on "this tenant already has
 * statuses" — so anything added to it later never reaches a workspace that already exists. Each
 * concern seeded after the first release needs its own absence check, or `pnpm db:seed` silently
 * stops being a way to top up.
 */
/**
 * The deal pipeline a workspace starts with (`FR-DEAL-1`).
 *
 * Separate from `seedCrmDefaults` and independently idempotent, for the reason step 4 found the hard
 * way: a seeder that only runs for a brand-new organization never reaches the workspaces that
 * already exist, and the configuration written in a later step silently never arrives.
 *
 * Deliberately shorter than the lead pipeline. A lead pipeline tracks interest; a deal pipeline
 * tracks a negotiation, and a business that wants more stages adds them — these are rows.
 */
const DEAL_STAGE_SEEDS = [
  { name: 'Qualified', probability: 20, colour: '#64748b' },
  { name: 'Proposal sent', probability: 40, colour: '#3b82f6' },
  { name: 'Negotiating', probability: 65, colour: '#f59e0b' },
  { name: 'Verbal agreement', probability: 85, colour: '#8b5cf6' },
  { name: 'Won', probability: 100, colour: '#16a34a', isWon: true },
  { name: 'Lost', probability: 0, colour: '#dc2626', isLost: true },
] as const;

export async function seedDealPipeline(
  tx: DbTransactionClient,
  organizationId: string,
): Promise<string | null> {
  const existing = await tx.pipeline.findFirst({
    where: { organizationId, entityType: 'deal' },
    select: { id: true },
  });
  if (existing) return null;

  const pipelineId = newId();
  await tx.pipeline.create({
    data: { id: pipelineId, organizationId, name: 'Deals', entityType: 'deal', isDefault: true },
  });
  for (const [index, seed] of DEAL_STAGE_SEEDS.entries()) {
    await tx.pipelineStage.create({
      data: {
        id: newId(),
        organizationId,
        pipelineId,
        name: seed.name,
        colour: seed.colour,
        sortOrder: index,
        probability: seed.probability,
        isWon: 'isWon' in seed ? seed.isWon : false,
        isLost: 'isLost' in seed ? seed.isLost : false,
      },
    });
  }
  return pipelineId;
}

export async function seedDefaultTags(
  tx: DbTransactionClient,
  organizationId: string,
): Promise<number> {
  const existing = await tx.tag.findFirst({ where: { organizationId } });
  if (existing) return 0;
  for (const seed of TAG_SEEDS) {
    await tx.tag.create({
      data: { id: newId(), organizationId, name: seed.name, colour: seed.colour },
    });
  }
  return TAG_SEEDS.length;
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

  await seedDefaultTags(tx, organizationId);

  // One duplicate rule, per docs/database-design.md §17: the same phone within a year is the same
  // person, and the capture attaches to the existing lead rather than creating a second record.
  // `attach_to_existing` is the default because it is the only action that cannot lose information:
  // `reject` discards the new touchpoint, and `create_and_link` leaves work for a human.
  const duplicateRuleId = newId();
  await tx.duplicateRule.create({
    data: {
      id: duplicateRuleId,
      organizationId,
      name: 'Same phone number',
      // One set, not two: the phone columns are aliases of each other in `MATCHABLE_FIELDS`, so
      // this set already matches a number that arrived in either column on either side.
      matchOn: [['phoneE164']],
      lookbackDays: 365,
      action: 'attach_to_existing',
      priority: 0,
    },
  });

  const defaultStatusId = statusIds.get('New');
  const firstStageId = stageIds[0];
  /* c8 ignore next */
  if (!defaultStatusId || !firstStageId)
    throw new Error('CRM defaults are internally inconsistent');

  return { defaultStatusId, pipelineId, firstStageId, sourceIdsByName, duplicateRuleId };
}

/**
 * The starting assignment rule (`FR-ASG-3`, docs/database-design.md §17).
 *
 * Separate from `seedCrmDefaults` because it needs the team and its members, which provisioning
 * creates in the same transaction but a bare CRM seed does not have. A round-robin over the default
 * team, respecting working hours, falling back to the unassigned pool with a notification — which is
 * the configuration that makes the fallback path exercised from day one rather than discovered in
 * production at 9pm.
 */
export async function seedDefaultAssignmentRule(
  tx: DbTransactionClient,
  organizationId: string,
  poolUserIds: readonly string[],
): Promise<string | null> {
  const existing = await tx.assignmentRule.findFirst({ where: { organizationId } });
  if (existing) return null;
  if (poolUserIds.length === 0) return null;

  const ruleId = newId();
  await tx.assignmentRule.create({
    data: {
      id: ruleId,
      organizationId,
      name: 'Round-robin to the sales team',
      priority: 0,
      strategy: 'round_robin',
      target: {},
      respectWorkingHours: true,
      capacityCap: null,
      fallback: { mode: 'unassigned_pool', notify: true },
    },
  });
  await tx.assignmentPoolMember.createMany({
    data: poolUserIds.map((userId) => ({
      id: newId(),
      organizationId,
      ruleId,
      userId,
      weight: 1,
      isActive: true,
    })),
  });
  // No conditions: a rule that matches every lead is the right catch-all, and a tenant adds
  // narrower rules at a lower priority above it.
  return ruleId;
}

export const CRM_DEFAULT_SEEDS = {
  statuses: STATUS_SEEDS,
  stages: STAGE_SEEDS,
  sources: SOURCE_SEEDS,
  lostReasons: LOST_REASON_SEEDS,
  tags: TAG_SEEDS,
} as const;

// ═══════════════════════════════════════════════════════════════════════════
// Scoring and saved views (Phase 2 step 3)
// ═══════════════════════════════════════════════════════════════════════════

interface BandSeed {
  readonly name: string;
  readonly minScore: number;
  readonly maxScore: number;
  readonly colour: string;
}

/**
 * Three bands, covering 0–1000 with no gap (`FR-SCR-3`).
 *
 * The names are the ones every sales team already uses, and the thresholds are deliberately low:
 * a lead that matched two positive rules should read as warm, because a business that never sees a
 * hot lead concludes scoring is broken and turns it off.
 */
const BAND_SEEDS: readonly BandSeed[] = [
  { name: 'Cold', minScore: 0, maxScore: 29, colour: '#868e96' },
  { name: 'Warm', minScore: 30, maxScore: 64, colour: '#f59f00' },
  { name: 'Hot', minScore: 65, maxScore: 1000, colour: '#e03131' },
];

interface ScoringRuleSeed {
  readonly name: string;
  readonly triggerEvent: string;
  readonly conditions: readonly Record<string, unknown>[];
  readonly points: number;
  readonly maxApplications: number | null;
  readonly decay?: Record<string, number>;
  readonly priority: number;
}

/**
 * Rules that work on a tenant's first day, using only signals that exist in Phase 2.
 *
 * Nothing here scores website behaviour or WhatsApp engagement, because those events are not
 * emitted yet and a rule on a dormant trigger is refused rather than stored inert. What is left is
 * still the strongest early signal a small business has: **the same person enquiring twice.**
 */
const SCORING_RULE_SEEDS: readonly ScoringRuleSeed[] = [
  {
    name: 'Came back again',
    triggerEvent: 'lead.touchpoint_added',
    conditions: [],
    points: 15,
    // Four repeats is where "interested" stops being news and a person should already have called.
    maxApplications: 4,
    priority: 0,
  },
  {
    name: 'Someone has taken it on',
    triggerEvent: 'lead.assigned',
    conditions: [],
    points: 5,
    maxApplications: 1,
    priority: 10,
  },
  {
    name: 'Real progress in the pipeline',
    triggerEvent: 'lead.stage_changed',
    conditions: [],
    points: 10,
    maxApplications: 3,
    priority: 20,
  },
  {
    name: 'Marked urgent',
    triggerEvent: 'lead.updated',
    conditions: [
      { fieldPath: 'priority', operator: 'in', value: ['high', 'urgent'], groupIndex: 0 },
    ],
    points: 10,
    maxApplications: 1,
    priority: 30,
  },
  {
    name: 'Gone quiet',
    triggerEvent: 'schedule.decay',
    conditions: [],
    points: 0,
    maxApplications: null,
    // A fortnight of silence, then five points a week, never below cold's ceiling — a stale lead
    // stops looking hot without being erased.
    decay: { afterDays: 14, points: 5, everyDays: 7, floor: 0 },
    priority: 100,
  },
];

interface ViewSeed {
  readonly name: string;
  readonly filters: Record<string, unknown>;
  readonly sort: Record<string, unknown>;
  readonly columns: readonly string[];
  readonly sortOrder: number;
}

/**
 * The five views from `docs/database-design.md` §17, as filters rather than as code.
 *
 * Every date condition uses a **named window**, not a timestamp. "Today's Follow-ups" saved with an
 * absolute date is a view that is wrong tomorrow and misleading forever, and it is the one view an
 * executive opens every morning.
 */
const VIEW_SEEDS: readonly ViewSeed[] = [
  {
    name: "Today's follow-ups",
    filters: {
      conditions: [{ field: 'nextActionAt', operator: 'lte', value: { window: 'today' } }],
    },
    sort: { field: 'nextActionAt', direction: 'asc' },
    columns: ['fullName', 'phoneE164', 'statusId', 'nextActionAt', 'assignedUserId'],
    sortOrder: 0,
  },
  {
    name: 'Overdue',
    filters: {
      conditions: [{ field: 'nextActionAt', operator: 'lte', value: { window: 'overdue' } }],
    },
    sort: { field: 'nextActionAt', direction: 'asc' },
    columns: ['fullName', 'phoneE164', 'statusId', 'nextActionAt', 'assignedUserId'],
    sortOrder: 1,
  },
  {
    name: 'New leads',
    filters: { conditions: [{ field: 'createdAt', operator: 'gte', value: { window: 'today' } }] },
    sort: { field: 'createdAt', direction: 'desc' },
    columns: ['fullName', 'phoneE164', 'leadSourceId', 'createdAt', 'assignedUserId'],
    sortOrder: 2,
  },
  {
    name: 'Hot leads',
    filters: { conditions: [{ field: 'scoreBand', operator: 'eq', value: 'Hot' }] },
    sort: { field: 'score', direction: 'desc' },
    columns: ['fullName', 'phoneE164', 'score', 'statusId', 'assignedUserId'],
    sortOrder: 3,
  },
  {
    name: 'No next action',
    filters: { conditions: [{ field: 'nextActionAt', operator: 'is_null' }] },
    sort: { field: 'lastActivityAt', direction: 'asc' },
    columns: ['fullName', 'phoneE164', 'statusId', 'lastActivityAt', 'assignedUserId'],
    sortOrder: 4,
  },
  {
    name: 'Unassigned',
    filters: { conditions: [{ field: 'assignedUserId', operator: 'is_null' }] },
    sort: { field: 'createdAt', direction: 'asc' },
    columns: ['fullName', 'phoneE164', 'leadSourceId', 'createdAt', 'score'],
    sortOrder: 5,
  },
];

export interface ScoringDefaultsResult {
  readonly bandIds: readonly string[];
  readonly ruleIds: readonly string[];
  readonly viewIds: readonly string[];
}

/**
 * Bands, scoring rules and saved views for a new organization.
 *
 * Idempotent per concern rather than all-or-nothing: a tenant that deleted every one of their views
 * should not have them reinstated because their bands are missing.
 */
export async function seedScoringAndViews(
  tx: DbTransactionClient,
  organizationId: string,
): Promise<ScoringDefaultsResult> {
  const bandIds: string[] = [];
  const existingBand = await tx.scoreBand.findFirst({ where: { organizationId } });
  if (!existingBand) {
    for (const band of BAND_SEEDS) {
      const id = newId();
      await tx.scoreBand.create({ data: { id, organizationId, ...band } });
      bandIds.push(id);
    }
  }

  const ruleIds: string[] = [];
  const existingRule = await tx.scoringRule.findFirst({ where: { organizationId } });
  if (!existingRule) {
    for (const rule of SCORING_RULE_SEEDS) {
      const id = newId();
      await tx.scoringRule.create({
        data: {
          id,
          organizationId,
          name: rule.name,
          triggerEvent: rule.triggerEvent,
          conditions: rule.conditions as never,
          points: rule.points,
          maxApplications: rule.maxApplications,
          ...(rule.decay ? { decay: rule.decay as never } : {}),
          priority: rule.priority,
        },
      });
      ruleIds.push(id);
    }
  }

  const viewIds: string[] = [];
  const existingView = await tx.savedView.findFirst({
    where: { organizationId, entityType: 'lead' },
  });
  if (!existingView) {
    for (const view of VIEW_SEEDS) {
      const id = newId();
      await tx.savedView.create({
        data: {
          id,
          organizationId,
          entityType: 'lead',
          name: view.name,
          filters: view.filters as never,
          columns: view.columns as never,
          sort: view.sort as never,
          // Provisioned views belong to the whole workspace: a view only the owner can see is not
          // a default, it is somebody's private list.
          visibility: 'organization',
          isSystem: true,
          sortOrder: view.sortOrder,
        },
      });
      viewIds.push(id);
    }
  }

  return { bandIds, ruleIds, viewIds };
}

export const SCORING_DEFAULT_SEEDS = {
  bands: BAND_SEEDS,
  rules: SCORING_RULE_SEEDS,
  views: VIEW_SEEDS,
} as const;
