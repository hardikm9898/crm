import { Injectable } from '@nestjs/common';
import { AppError, activityModule, isKnownActivityType, withPlatformScope } from '@leados/shared';
import { DbService } from '../db/db.service.js';

/**
 * Reading a page of the timeline, however the caller decided which rows belong to it.
 *
 * Extracted when customers arrived, because a customer's history is the **union** of their lead's
 * entries and their own (`FR-DEAL-4`) and the alternative was a second copy of the presentation:
 * the actor-name resolution, the unknown-type reporting and — the part that actually bites — the
 * cursor that has to carry both halves of a partitioned table's key. Deals and conversations will
 * each want the same page, over a different `where`.
 *
 * What stays with the caller is **authority**: an activity has no assignee of its own, so its
 * visibility is its subject's, and only the module that owns the subject can check it. This service
 * never decides who may read a row — it is given the rows to read.
 */
export interface TimelinePageQuery {
  readonly limit: number;
  readonly cursor?: string | undefined;
  readonly type?: string | undefined;
  readonly module?: string | undefined;
  readonly includeInternal?: boolean | undefined;
}

export interface TimelinePageItem {
  readonly id: string;
  readonly type: string;
  readonly module: string;
  /** False for a row written by a newer release; the client renders the raw type. */
  readonly known: boolean;
  readonly occurredAt: Date;
  readonly visibility: string;
  readonly actor: { type: string; id: string | null; name: string };
  readonly payload: unknown;
  /** Which subject the row names, so a customer's screen can mark the handover from the lead. */
  readonly stage: 'lead' | 'customer' | 'deal';
}

@Injectable()
export class TimelineReadService {
  constructor(private readonly db: DbService) {}

  /**
   * @param subject A Prisma predicate naming the rows that belong to this timeline — one subject
   *                for a lead, an `OR` of two for a converted customer.
   */
  async page(subject: Record<string, unknown>, query: TimelinePageQuery) {
    const where: Record<string, unknown> = {
      ...subject,
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
      ...(query.cursor ? { cursor: decodeCursor(query.cursor), skip: 1 } : {}),
    });

    const page = rows.slice(0, query.limit);
    const hasMore = rows.length > query.limit;
    const actors = await this.resolveActors(page.map((row) => row.actorId));

    return {
      items: page.map((row): TimelinePageItem => ({
        id: row.id,
        type: row.type,
        module: activityModule(row.type),
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
        // Most specific subject first: a row written against a deal names the deal, even though its
        // payload also carries the lead or customer it is about.
        stage: row.dealId ? 'deal' : row.customerId ? 'customer' : 'lead',
      })),
      pagination: {
        limit: query.limit,
        nextCursor: hasMore ? encodeCursor(page[page.length - 1]) : null,
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
}

/**
 * The cursor carries both halves of the composite primary key.
 *
 * `activities` is partitioned, so its key is `(id, occurred_at)` — an id alone does not identify a
 * row, and Prisma's cursor needs the whole key.
 */
function encodeCursor(row: { id: string; occurredAt: Date } | undefined): string | null {
  if (!row) return null;
  return Buffer.from(`${row.id}|${row.occurredAt.toISOString()}`).toString('base64url');
}

function decodeCursor(cursor: string): { id_occurredAt: { id: string; occurredAt: Date } } {
  const [id, occurredAt] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
  if (!id || !occurredAt) throw AppError.validation('That page cursor is not valid');
  const parsed = new Date(occurredAt);
  if (Number.isNaN(parsed.getTime())) throw AppError.validation('That page cursor is not valid');
  return { id_occurredAt: { id, occurredAt: parsed } };
}
