import { Injectable } from '@nestjs/common';
import {
  ACTIVITY_TYPES,
  AppError,
  PERMISSIONS,
  activityModule,
  isKnownActivityType,
  withPlatformScope,
} from '@leados/shared';
import { DbService } from '../../infra/db/db.service.js';
import { DataScopeService } from '../../infra/authz/data-scope.service.js';
import type { TimelineQuery } from './leads.dto.js';

/**
 * Reading a lead's timeline.
 *
 * The write side is `infra/timeline`; this is the product surface — the screen that answers "what has
 * happened with this person". Three things it does that a plain `findMany` would not:
 *
 *  * **Re-checks authority on the lead, not the activities.** An activity has no assignee of its own,
 *    so its visibility is the lead's. Filtering activities directly would let anyone who knows a lead
 *    id read its history.
 *  * **Resolves actor names at read time.** The row denormalizes a label only for non-people;
 *    a person's name comes from `users`, so a rename shows everywhere and a departure degrades to
 *    "Removed user" rather than a blank.
 *  * **Reports unknown types rather than hiding them.** A row written by a newer release renders as
 *    its raw type instead of vanishing — a timeline that silently omits entries is worse than one
 *    showing something it cannot pretty-print.
 */
@Injectable()
export class LeadTimelineService {
  constructor(
    private readonly db: DbService,
    private readonly scopes: DataScopeService,
  ) {}

  async forLead(leadId: string, query: TimelineQuery) {
    const lead = await this.db.client.lead.findFirst({
      where: { id: leadId },
      select: { id: true, assignedUserId: true, teamId: true, branchId: true },
    });
    if (!lead) throw AppError.notFound('Lead');

    const allowed = this.scopes.canAct(PERMISSIONS.LEAD_READ, {
      userId: lead.assignedUserId,
      teamId: lead.teamId,
      branchId: lead.branchId,
    });
    if (!allowed) throw AppError.notFound('Lead');

    const where: Record<string, unknown> = {
      leadId,
      ...(query.type ? { type: query.type } : {}),
      ...(query.module ? { type: { startsWith: `${query.module}.` } } : {}),
      ...(query.includeInternal === false ? { visibility: 'all' } : {}),
    };

    // Ordered by the partition key first, so the planner prunes partitions instead of scanning all
    // of them; `id` breaks ties so cursor pagination is stable.
    const rows = await this.db.client.activity.findMany({
      where,
      orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
      ...(query.cursor ? { cursor: this.decodeCursor(query.cursor), skip: 1 } : {}),
    });

    const page = rows.slice(0, query.limit);
    const hasMore = rows.length > query.limit;
    const actors = await this.resolveActors(page.map((row) => row.actorId));

    return {
      items: page.map((row) => ({
        id: row.id,
        type: row.type,
        module: activityModule(row.type),
        /** False for a row written by a newer release; the client renders the raw type. */
        known: isKnownActivityType(row.type),
        occurredAt: row.occurredAt,
        visibility: row.visibility,
        actor: {
          type: row.actorType,
          id: row.actorId,
          name:
            (row.actorId ? actors.get(row.actorId) : null) ??
            row.actorLabel ??
            (row.actorType === 'user' ? 'Removed user' : row.actorType),
        },
        payload: row.payload,
      })),
      pagination: {
        limit: query.limit,
        nextCursor: hasMore ? this.encodeCursor(page[page.length - 1]) : null,
        hasMore,
      },
    };
  }

  /**
   * Names for the people who acted on this page.
   *
   * Under `withPlatformScope` because `users` is the global identity table — a tenant row references
   * a person through `Membership`, but the person's *name* lives outside the tenant. The ids come
   * from this organization's own activities, so nothing widens.
   */
  private async resolveActors(actorIds: readonly (string | null)[]): Promise<Map<string, string>> {
    const ids = [...new Set(actorIds.filter((id): id is string => id !== null))];
    if (ids.length === 0) return new Map();
    const users = await withPlatformScope('timeline: name the actors', async () =>
      this.db.client.user.findMany({
        where: { id: { in: ids } },
        select: { id: true, name: true },
      }),
    );
    return new Map(users.map((user) => [user.id, user.name]));
  }

  /**
   * The cursor carries both halves of the composite primary key.
   *
   * `activities` is partitioned, so its key is `(id, occurred_at)` — an id alone does not identify a
   * row, and Prisma's cursor needs the whole key.
   */
  private encodeCursor(row: { id: string; occurredAt: Date } | undefined): string | null {
    if (!row) return null;
    return Buffer.from(`${row.id}|${row.occurredAt.toISOString()}`).toString('base64url');
  }

  private decodeCursor(cursor: string): { id_occurredAt: { id: string; occurredAt: Date } } {
    const [id, occurredAt] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
    if (!id || !occurredAt) throw AppError.validation('That page cursor is not valid');
    const parsed = new Date(occurredAt);
    if (Number.isNaN(parsed.getTime())) throw AppError.validation('That page cursor is not valid');
    return { id_occurredAt: { id, occurredAt: parsed } };
  }
}

/** Re-exported so tests can assert the exact set a lead's creation writes. */
export const LEAD_CREATION_ACTIVITY_TYPES = [
  ACTIVITY_TYPES.LEAD_CREATED,
  ACTIVITY_TYPES.LEAD_SOURCE_CAPTURED,
] as const;
