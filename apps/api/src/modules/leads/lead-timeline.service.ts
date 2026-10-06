import { Injectable } from '@nestjs/common';
import { ACTIVITY_TYPES, AppError, PERMISSIONS } from '@leados/shared';
import { DbService } from '../../infra/db/db.service.js';
import { DataScopeService } from '../../infra/authz/data-scope.service.js';
import { TimelineReadService } from '../../infra/timeline/timeline-read.service.js';
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
    private readonly reader: TimelineReadService,
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

    return this.reader.page(
      { leadId },
      {
        limit: query.limit,
        ...(query.cursor ? { cursor: query.cursor } : {}),
        ...(query.type ? { type: query.type } : {}),
        ...(query.module ? { module: query.module } : {}),
        ...(query.includeInternal === false ? { includeInternal: false } : {}),
      },
    );
  }
}

/** Re-exported so tests can assert the exact set a lead's creation writes. */
export const LEAD_CREATION_ACTIVITY_TYPES = [
  ACTIVITY_TYPES.LEAD_CREATED,
  ACTIVITY_TYPES.LEAD_SOURCE_CAPTURED,
] as const;
