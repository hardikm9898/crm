import { Injectable } from '@nestjs/common';
import {
  isWithinBusinessHours,
  type AutomationFacts,
} from '@leados/shared';
import { DbService } from '../../infra/db/db.service.js';
import { SlaCalendarService } from '../sla/sla-calendar.service.js';

/**
 * The facts a run is evaluated and interpolated against.
 *
 * One builder, keyed by exactly the strings `CONDITION_FIELDS` declares, so "the field the editor
 * offered" and "the fact the engine reads" cannot drift — the `TASK_BUCKETS` arrangement applied
 * to a fact map. It also carries the friendlier names interpolation uses (`{{lead.fullName}}`),
 * because a note that reads "Call 7a3f-… back" is a note nobody wants.
 *
 * `time.withinWorkingHours` is here rather than in the pure runtime because answering it needs the
 * workspace's rows — the same reason `validateWorkflowDefinition` checks shape and the service
 * checks references.
 */
@Injectable()
export class AutomationFactsService {
  constructor(
    private readonly db: DbService,
    private readonly calendar: SlaCalendarService,
  ) {}

  async forLead(leadId: string, extra: Readonly<Record<string, unknown>> = {}): Promise<AutomationFacts> {
    const lead = await this.db.client.lead.findFirst({
      where: { id: leadId, deletedAt: null },
      include: {
        status: { select: { name: true } },
        stage: { select: { name: true } },
        source: { select: { name: true } },
        assignee: { select: { user: { select: { name: true } } } },
        tags: { include: { tag: { select: { name: true } } } },
      },
    });
    if (!lead) return { ...extra };

    const organization = await this.db.client.organization.findFirst({
      where: { id: lead.organizationId },
      select: { timezone: true },
    });
    const timeZone = organization?.timezone ?? 'Asia/Kolkata';
    const workingCalendar = await this.calendar.forBranch(timeZone, lead.branchId, new Date());

    return {
      // The condition vocabulary, one key per `CONDITION_FIELDS` entry.
      'lead.statusId': lead.statusId,
      'lead.stageId': lead.stageId,
      'lead.priority': lead.priority,
      // A **name**, because `score_bands` are rows a workspace names and the scoring rules already
      // compare them by name. The column holds the name, not an id.
      'lead.scoreBand': lead.scoreBand,
      'lead.score': lead.score,
      'lead.leadSourceId': lead.leadSourceId,
      'lead.city': lead.city,
      'lead.tags': lead.tags.map((entry) => entry.tag.name),
      'lead.assignedUserId': lead.assignedUserId,
      'lead.consentWhatsapp': lead.consentWhatsapp,
      'time.withinWorkingHours': isWithinBusinessHours(new Date(), workingCalendar),

      // And the names a message is written with. Ids are what conditions compare; nobody writes a
      // message that says a UUID.
      'lead.id': lead.id,
      'lead.fullName': lead.fullName,
      'lead.firstName': lead.firstName,
      'lead.lastName': lead.lastName,
      'lead.phone': lead.phoneE164,
      'lead.email': lead.email,
      'lead.status': lead.status?.name ?? null,
      'lead.stage': lead.stage?.name ?? null,
      'lead.source': lead.source?.name ?? null,
      'lead.owner': lead.assignee?.user.name ?? null,
      ...extra,
    };
  }
}
