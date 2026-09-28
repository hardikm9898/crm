import { Injectable } from '@nestjs/common';
import { ACTIVITY_TYPES, AppError, PERMISSIONS, newId, tenantContext } from '@leados/shared';
import { DbService } from '../../infra/db/db.service.js';
import { AuditService } from '../../infra/audit/audit.service.js';
import { OutboxService } from '../../infra/outbox/outbox.service.js';
import { TimelineService } from '../../infra/timeline/timeline.service.js';
import { DataScopeService } from '../../infra/authz/data-scope.service.js';
import type { MergeLeadsInput } from './duplicates.dto.js';

/**
 * Merging two leads, reversibly (`FR-DUP-4`).
 *
 * The hard requirement is reversibility, and it is what shapes everything else:
 *
 *  * **The absorbed lead is soft-deleted, never destroyed.** Its row, its custom values and its own
 *    history stay exactly where they were. Undo therefore has something to restore *to*, without a
 *    second copy of the data.
 *  * **Children are moved, and the move is recorded.** Timeline entries, touchpoints, assignments,
 *    status and stage history, tags and duplicate pairs are re-pointed at the survivor. The snapshot
 *    lists which ids moved, so undo moves exactly those back — not "everything that now looks like it
 *    came from there", which would also drag in anything added since.
 *  * **The survivor's overwritten columns are snapshotted.** A merge that takes the absorbed lead's
 *    email has to be able to give the survivor its own back.
 *
 * What is deliberately *not* reversible is time: an undo restores records, not the fact that somebody
 * saw the merged view. Both the merge and the undo are audited and appear on the timeline.
 */

/** Columns a merge may take from either side. Everything else belongs to the survivor by definition. */
const MERGEABLE_FIELDS = [
  'firstName',
  'lastName',
  'company',
  'jobTitle',
  'phoneE164',
  'phoneRaw',
  'whatsappE164',
  'email',
  'city',
  'state',
  'country',
  'postalCode',
  'leadSourceId',
  'landingPageUrl',
  'valueMinor',
  'currency',
  'priority',
  'consentWhatsapp',
  'consentEmail',
  'consentCalls',
] as const;

interface MovedIds {
  activities: { id: string; occurredAt: string }[];
  touchpoints: string[];
  assignments: string[];
  statusHistory: string[];
  stageHistory: string[];
  tags: string[];
  duplicatesAsLead: string[];
  duplicatesAsCandidate: string[];
}

interface MergeSnapshot {
  /** The survivor's values for every column the merge changed, so undo can put them back. */
  readonly survivingBefore: Record<string, unknown>;
  /** The absorbed lead's own columns, in case its row is later needed for reference. */
  readonly mergedBefore: Record<string, unknown>;
  /** The ids that moved, per table. Undo moves exactly these back. */
  readonly moved: MovedIds;
  /** Touchpoint sequences were renumbered on the survivor; this maps id → original sequence. */
  readonly touchpointSequences: Record<string, number>;
}

@Injectable()
export class MergeService {
  constructor(
    private readonly db: DbService,
    private readonly scopes: DataScopeService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly timeline: TimelineService,
  ) {}

  async merge(input: MergeLeadsInput) {
    if (input.survivingLeadId === input.mergedLeadId) {
      throw AppError.businessRule('A lead cannot be merged into itself');
    }

    const organizationId = tenantContext.organizationId('leads.merge');
    const [surviving, merged] = await Promise.all([
      this.loadForMerge(input.survivingLeadId),
      this.loadForMerge(input.mergedLeadId),
    ]);

    if (merged.mergedIntoId) {
      throw AppError.conflict('That lead has already been merged into another one');
    }
    if (surviving.mergedIntoId) {
      throw AppError.conflict(
        'The surviving lead has itself been merged into another one. Merge into that one instead',
      );
    }

    const choices = input.fieldChoices ?? {};
    const unknownFields = Object.keys(choices).filter(
      (field) => !(MERGEABLE_FIELDS as readonly string[]).includes(field),
    );
    if (unknownFields.length > 0) {
      throw AppError.validation('Some details need correcting', [
        {
          field: 'fieldChoices',
          code: 'NOT_MERGEABLE',
          message: `These fields cannot be chosen: ${unknownFields.join(', ')}. Available: ${MERGEABLE_FIELDS.join(', ')}`,
        },
      ]);
    }

    // What actually changes on the survivor: only the fields explicitly given to the absorbed lead,
    // plus any the survivor simply does not have. Filling a blank is not a conflict, and refusing to
    // do it would make a merge lose information for no reason.
    const survivingBefore: Record<string, unknown> = {};
    const updates: Record<string, unknown> = {};
    for (const field of MERGEABLE_FIELDS) {
      const theirs = (merged as Record<string, unknown>)[field];
      const ours = (surviving as Record<string, unknown>)[field];
      const takeTheirs =
        choices[field] === 'merged' ||
        (isBlank(ours) && !isBlank(theirs) && choices[field] !== 'surviving');
      if (!takeTheirs || theirs === ours) continue;
      survivingBefore[field] = ours;
      updates[field] = theirs;
    }

    const mergeId = newId();
    const now = new Date();

    const result = await this.db.client.$transaction(async (tx) => {
      const moved: MovedIds = {
        activities: [],
        touchpoints: [],
        assignments: [],
        statusHistory: [],
        stageHistory: [],
        tags: [],
        duplicatesAsLead: [],
        duplicatesAsCandidate: [],
      };
      const touchpointSequences: Record<string, number> = {};

      // ── Timeline: the union is the whole point of a merge ──────────────────
      const activities = await tx.activity.findMany({
        where: { leadId: input.mergedLeadId },
        select: { id: true, occurredAt: true },
      });
      for (const activity of activities) {
        // `updateMany` keyed on the full composite primary key: `activities` is partitioned, so an
        // id alone does not identify a row.
        await tx.activity.updateMany({
          where: { id: activity.id, occurredAt: activity.occurredAt },
          data: { leadId: input.survivingLeadId },
        });
        moved.activities.push({ id: activity.id, occurredAt: activity.occurredAt.toISOString() });
      }

      // ── Touchpoints: renumbered onto the end of the survivor's sequence ────
      const lastTouchpoint = await tx.leadTouchpoint.findFirst({
        where: { leadId: input.survivingLeadId },
        orderBy: { sequence: 'desc' },
        select: { sequence: true },
      });
      let sequence = lastTouchpoint?.sequence ?? 0;
      const touchpoints = await tx.leadTouchpoint.findMany({
        where: { leadId: input.mergedLeadId },
        orderBy: { sequence: 'asc' },
        select: { id: true, sequence: true },
      });
      for (const touchpoint of touchpoints) {
        sequence += 1;
        touchpointSequences[touchpoint.id] = touchpoint.sequence;
        await tx.leadTouchpoint.update({
          where: { id: touchpoint.id },
          data: { leadId: input.survivingLeadId, sequence },
        });
        moved.touchpoints.push(touchpoint.id);
      }

      // ── The remaining children ────────────────────────────────────────────
      // Written out per model rather than through a generic helper: Prisma's client is typed per
      // model, and the indexed-access version that would loop over them types as `any`, which is
      // exactly the safety this codebase relies on for tenant-scoped writes.
      const assignments = await tx.leadAssignment.findMany({
        where: { leadId: input.mergedLeadId },
        select: { id: true },
      });
      if (assignments.length > 0) {
        await tx.leadAssignment.updateMany({
          where: { leadId: input.mergedLeadId },
          data: { leadId: input.survivingLeadId },
        });
        moved.assignments = assignments.map((row) => row.id);
      }

      const statusHistory = await tx.leadStatusHistory.findMany({
        where: { leadId: input.mergedLeadId },
        select: { id: true },
      });
      if (statusHistory.length > 0) {
        await tx.leadStatusHistory.updateMany({
          where: { leadId: input.mergedLeadId },
          data: { leadId: input.survivingLeadId },
        });
        moved.statusHistory = statusHistory.map((row) => row.id);
      }

      const stageHistory = await tx.leadStageHistory.findMany({
        where: { leadId: input.mergedLeadId },
        select: { id: true },
      });
      if (stageHistory.length > 0) {
        await tx.leadStageHistory.updateMany({
          where: { leadId: input.mergedLeadId },
          data: { leadId: input.survivingLeadId },
        });
        moved.stageHistory = stageHistory.map((row) => row.id);
      }

      // Tags are a set: a tag the survivor already has is dropped rather than duplicated, which the
      // unique constraint would refuse anyway.
      const survivingTags = await tx.leadTag.findMany({
        where: { leadId: input.survivingLeadId },
        select: { tagId: true },
      });
      const held = new Set(survivingTags.map((row) => row.tagId));
      const mergedTags = await tx.leadTag.findMany({ where: { leadId: input.mergedLeadId } });
      for (const leadTag of mergedTags) {
        if (held.has(leadTag.tagId)) {
          await tx.leadTag.delete({ where: { id: leadTag.id } });
          continue;
        }
        await tx.leadTag.update({
          where: { id: leadTag.id },
          data: { leadId: input.survivingLeadId },
        });
        moved.tags.push(leadTag.id);
      }

      // ── Duplicate pairs ───────────────────────────────────────────────────
      // The pair that justified this merge becomes `merged`; other pairs follow the survivor so the
      // triage queue does not keep pointing at a record nobody can open.
      await tx.leadDuplicate.updateMany({
        where: {
          OR: [
            { leadId: input.survivingLeadId, duplicateLeadId: input.mergedLeadId },
            { leadId: input.mergedLeadId, duplicateLeadId: input.survivingLeadId },
          ],
        },
        data: {
          status: 'merged',
          resolvedById: tenantContext.get()?.actorId ?? null,
          resolvedAt: now,
        },
      });

      const otherPairs = await tx.leadDuplicate.findMany({
        where: {
          OR: [{ leadId: input.mergedLeadId }, { duplicateLeadId: input.mergedLeadId }],
          status: 'open',
        },
      });
      for (const pair of otherPairs) {
        const asLead = pair.leadId === input.mergedLeadId;
        const otherSide = asLead ? pair.duplicateLeadId : pair.leadId;
        // Re-pointing would make a pair of the survivor with itself; drop those instead.
        if (otherSide === input.survivingLeadId) {
          await tx.leadDuplicate.delete({ where: { id: pair.id } });
          continue;
        }
        // The survivor may already have an identical pair, in which case the unique constraint
        // would refuse the move. Dropping the redundant one is the honest resolution.
        const existing = await tx.leadDuplicate.findFirst({
          where: asLead
            ? { leadId: input.survivingLeadId, duplicateLeadId: otherSide }
            : { leadId: otherSide, duplicateLeadId: input.survivingLeadId },
        });
        if (existing) {
          await tx.leadDuplicate.delete({ where: { id: pair.id } });
          continue;
        }
        await tx.leadDuplicate.update({
          where: { id: pair.id },
          data: asLead
            ? { leadId: input.survivingLeadId }
            : { duplicateLeadId: input.survivingLeadId },
        });
        if (asLead) moved.duplicatesAsLead.push(pair.id);
        else moved.duplicatesAsCandidate.push(pair.id);
      }

      // ── The two leads themselves ──────────────────────────────────────────
      const touchCount = await tx.leadTouchpoint.count({
        where: { leadId: input.survivingLeadId },
      });
      await tx.lead.update({
        where: { id: input.survivingLeadId },
        data: { ...updates, touchCount, lastActivityAt: now },
      });
      await tx.lead.update({
        where: { id: input.mergedLeadId },
        data: {
          mergedIntoId: input.survivingLeadId,
          deletedAt: now,
          deletedById: tenantContext.get()?.actorId ?? null,
          touchCount: 0,
        },
      });

      const snapshot: MergeSnapshot = {
        survivingBefore,
        mergedBefore: pick(merged as Record<string, unknown>, MERGEABLE_FIELDS),
        moved,
        touchpointSequences,
      };

      await tx.leadMerge.create({
        data: {
          id: mergeId,
          organizationId,
          survivingLeadId: input.survivingLeadId,
          mergedLeadId: input.mergedLeadId,
          fieldChoices: choices as never,
          snapshot: snapshot as never,
          performedById: tenantContext.get()?.actorId ?? null,
        },
      });

      await this.timeline.recordInTransaction(tx, {
        type: ACTIVITY_TYPES.LEAD_MERGED,
        leadId: input.survivingLeadId,
        occurredAt: now,
        payload: {
          mergeId,
          mergedLeadId: input.mergedLeadId,
          mergedLeadName: merged.fullName,
          fieldsTaken: Object.keys(updates),
          movedActivities: moved.activities.length,
          movedTouchpoints: moved.touchpoints.length,
          reversible: true,
        },
      });

      await this.audit.recordInTransaction(tx, {
        action: 'lead.merged',
        resourceType: 'lead',
        resourceId: input.survivingLeadId,
        before: survivingBefore,
        after: { ...updates, mergedLeadId: input.mergedLeadId, mergeId },
      });

      await this.outbox.emit(tx, [
        {
          name: 'lead.merged',
          aggregateType: 'lead',
          aggregateId: input.survivingLeadId,
          payload: {
            mergeId,
            survivingLeadId: input.survivingLeadId,
            mergedLeadId: input.mergedLeadId,
          },
        },
      ]);

      return {
        movedActivities: moved.activities.length,
        movedTouchpoints: moved.touchpoints.length,
      };
    });

    return {
      mergeId,
      survivingLeadId: input.survivingLeadId,
      mergedLeadId: input.mergedLeadId,
      fieldsTaken: Object.keys(updates),
      ...result,
      reversible: true,
    };
  }

  /**
   * Undoes a merge.
   *
   * Only what the merge moved is moved back, from the recorded id list. Anything added to the
   * survivor *since* the merge stays with the survivor, which is the only defensible reading: a note
   * written on the merged view was written about the survivor.
   */
  async undo(mergeId: string) {
    const merge = await this.db.client.leadMerge.findFirst({ where: { id: mergeId } });
    if (!merge) throw AppError.notFound('Merge');
    if (merge.undoneAt) throw AppError.conflict('That merge has already been undone');

    // Authority is checked on the surviving lead, which is the record the caller is changing.
    const surviving = await this.loadForMerge(merge.survivingLeadId);
    void surviving;

    const snapshot = merge.snapshot as unknown as MergeSnapshot;
    const now = new Date();

    await this.db.client.$transaction(async (tx) => {
      for (const activity of snapshot.moved?.activities ?? []) {
        await tx.activity.updateMany({
          where: { id: activity.id, occurredAt: new Date(activity.occurredAt) },
          data: { leadId: merge.mergedLeadId },
        });
      }
      for (const touchpointId of snapshot.moved?.touchpoints ?? []) {
        await tx.leadTouchpoint.updateMany({
          where: { id: touchpointId },
          data: {
            leadId: merge.mergedLeadId,
            sequence: snapshot.touchpointSequences?.[touchpointId] ?? 1,
          },
        });
      }
      const backTo = { leadId: merge.mergedLeadId };
      const assignmentIds = snapshot.moved?.assignments ?? [];
      if (assignmentIds.length > 0) {
        await tx.leadAssignment.updateMany({ where: { id: { in: assignmentIds } }, data: backTo });
      }
      const statusIds = snapshot.moved?.statusHistory ?? [];
      if (statusIds.length > 0) {
        await tx.leadStatusHistory.updateMany({ where: { id: { in: statusIds } }, data: backTo });
      }
      const stageIds = snapshot.moved?.stageHistory ?? [];
      if (stageIds.length > 0) {
        await tx.leadStageHistory.updateMany({ where: { id: { in: stageIds } }, data: backTo });
      }
      const tagIds = snapshot.moved?.tags ?? [];
      if (tagIds.length > 0) {
        await tx.leadTag.updateMany({ where: { id: { in: tagIds } }, data: backTo });
      }

      for (const pairId of snapshot.moved?.duplicatesAsLead ?? []) {
        await tx.leadDuplicate.updateMany({
          where: { id: pairId },
          data: { leadId: merge.mergedLeadId },
        });
      }
      for (const pairId of snapshot.moved?.duplicatesAsCandidate ?? []) {
        await tx.leadDuplicate.updateMany({
          where: { id: pairId },
          data: { duplicateLeadId: merge.mergedLeadId },
        });
      }

      // The pair that justified the merge goes back to `open`: undoing the merge means the question
      // "are these the same person" is open again.
      await tx.leadDuplicate.updateMany({
        where: {
          OR: [
            { leadId: merge.survivingLeadId, duplicateLeadId: merge.mergedLeadId },
            { leadId: merge.mergedLeadId, duplicateLeadId: merge.survivingLeadId },
          ],
          status: 'merged',
        },
        data: { status: 'open', resolvedById: null, resolvedAt: null },
      });

      const restored = snapshot.survivingBefore ?? {};
      await tx.lead.update({
        where: { id: merge.survivingLeadId },
        data: {
          ...restored,
          touchCount: await tx.leadTouchpoint.count({ where: { leadId: merge.survivingLeadId } }),
          lastActivityAt: now,
        },
      });
      await tx.lead.update({
        where: { id: merge.mergedLeadId },
        data: {
          mergedIntoId: null,
          deletedAt: null,
          deletedById: null,
          touchCount: await tx.leadTouchpoint.count({ where: { leadId: merge.mergedLeadId } }),
        },
      });

      await tx.leadMerge.update({
        where: { id: mergeId },
        data: { undoneAt: now, undoneById: tenantContext.get()?.actorId ?? null },
      });

      await this.timeline.recordInTransaction(tx, {
        type: ACTIVITY_TYPES.LEAD_MERGED,
        leadId: merge.survivingLeadId,
        occurredAt: now,
        payload: { mergeId, undone: true, mergedLeadId: merge.mergedLeadId },
      });
      await this.audit.recordInTransaction(tx, {
        action: 'lead.merge_undone',
        resourceType: 'lead',
        resourceId: merge.survivingLeadId,
        after: { mergeId, mergedLeadId: merge.mergedLeadId },
      });
      await this.outbox.emit(tx, [
        {
          name: 'lead.merge_undone',
          aggregateType: 'lead',
          aggregateId: merge.survivingLeadId,
          payload: {
            mergeId,
            survivingLeadId: merge.survivingLeadId,
            mergedLeadId: merge.mergedLeadId,
          },
        },
      ]);
    });

    return { mergeId, undone: true, restoredLeadId: merge.mergedLeadId };
  }

  async listMerges(leadId: string) {
    await this.loadForMerge(leadId);
    const merges = await this.db.client.leadMerge.findMany({
      where: { OR: [{ survivingLeadId: leadId }, { mergedLeadId: leadId }] },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    const items = merges.map((merge) => ({
      id: merge.id,
      survivingLeadId: merge.survivingLeadId,
      mergedLeadId: merge.mergedLeadId,
      fieldChoices: merge.fieldChoices,
      performedById: merge.performedById,
      undoneAt: merge.undoneAt,
      createdAt: merge.createdAt,
      canUndo: merge.undoneAt === null,
    }));
    return {
      items,
      pagination: { limit: items.length, nextCursor: null, hasMore: false, total: items.length },
    };
  }

  /** The fields a merge may choose between, so a merge UI does not hardcode the list. */
  mergeableFields(): readonly string[] {
    return MERGEABLE_FIELDS;
  }

  private async loadForMerge(leadId: string) {
    const lead = await this.db.client.lead.findFirst({ where: { id: leadId } });
    if (!lead) throw AppError.notFound('Lead');
    const allowed = this.scopes.canAct(PERMISSIONS.LEAD_MERGE, {
      userId: lead.assignedUserId,
      teamId: lead.teamId,
      branchId: lead.branchId,
    });
    if (!allowed) throw AppError.notFound('Lead');
    return lead;
  }
}

function isBlank(value: unknown): boolean {
  return value === null || value === undefined || value === '';
}

function pick(source: Record<string, unknown>, fields: readonly string[]): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const field of fields) {
    const value = source[field];
    // BigInt does not survive JSON, and the snapshot is JSONB.
    result[field] = typeof value === 'bigint' ? Number(value) : value;
  }
  return result;
}
