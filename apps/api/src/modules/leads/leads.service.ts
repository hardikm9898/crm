import { Injectable } from '@nestjs/common';
import {
  ACTIVITY_TYPES,
  AppError,
  PERMISSIONS,
  newId,
  normalizePhone,
  PhoneNormalizationError,
  searchTextFor,
  tenantContext,
  validateCustomValues,
  type CountryCode,
} from '@leados/shared';
import type { TouchpointChannel } from '@leados/db';
import { DbService } from '../../infra/db/db.service.js';
import { AuditService } from '../../infra/audit/audit.service.js';
import { OutboxService, type DomainEventInput } from '../../infra/outbox/outbox.service.js';
import { TimelineService } from '../../infra/timeline/timeline.service.js';
import { DataScopeService, applyScopeFilter } from '../../infra/authz/data-scope.service.js';
import { EntitlementService } from '../../infra/entitlements/entitlement.service.js';
import { FieldRegistryService } from '../custom-fields/field-registry.service.js';
import {
  DuplicateDetectionService,
  type DuplicateCandidate,
} from '../duplicates/duplicate-detection.service.js';
import { AssignmentEngineService } from '../assignment/assignment-engine.service.js';
import type {
  AddTouchpointInput,
  AssignLeadInput,
  ChangeStageInput,
  ChangeStatusInput,
  CreateLeadInput,
  ListLeadsQuery,
  SetTagsInput,
  UpdateLeadInput,
} from './leads.dto.js';

/**
 * Leads.
 *
 * Every mutation here does four things together, in one transaction: change the row, record the
 * structured history a manager queries, write the timeline entry a person reads (rule 6), and emit
 * the domain event later phases subscribe to (rule 5). Splitting any of them out would create a state
 * where a lead moved but nothing knows why.
 *
 * Three decisions shape the rest:
 *
 *  * **Transitions are not fields.** Status, stage and assignment have their own methods because each
 *    has its own history table, its own permission and its own preconditions. A general PATCH that
 *    happened to include `stageId` could not check the stage's required fields.
 *  * **Reads are scoped by grant, not by query.** `lead:read` at `own` returns the caller's leads even
 *    when they ask for everything, and `findOne` re-checks authority on the row: knowing an id is
 *    never sufficient.
 *  * **Deletion is soft and reversible.** A recycle bin is what makes "delete" safe to offer at all.
 */
@Injectable()
export class LeadsService {
  constructor(
    private readonly db: DbService,
    private readonly scopes: DataScopeService,
    private readonly fields: FieldRegistryService,
    private readonly duplicates: DuplicateDetectionService,
    private readonly assignment: AssignmentEngineService,
    private readonly entitlements: EntitlementService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly timeline: TimelineService,
  ) {}

  // ── Reading ───────────────────────────────────────────────────────────────

  async list(query: ListLeadsQuery) {
    const filter = this.scopes.filterFor(PERMISSIONS.LEAD_READ, {
      userColumn: 'assignedUserId',
      teamColumn: 'teamId',
      branchColumn: 'branchId',
    });

    const baseWhere: Record<string, unknown> = {
      deletedAt: query.deleted === true ? { not: null } : null,
      ...(query.statusId ? { statusId: query.statusId } : {}),
      ...(query.stageId ? { stageId: query.stageId } : {}),
      ...(query.pipelineId ? { pipelineId: query.pipelineId } : {}),
      ...(query.leadSourceId ? { leadSourceId: query.leadSourceId } : {}),
      ...(query.assignedUserId ? { assignedUserId: query.assignedUserId } : {}),
      ...(query.priority ? { priority: query.priority } : {}),
      ...(query.unassigned === true ? { assignedUserId: null } : {}),
      ...(query.noNextAction === true ? { nextActionAt: null } : {}),
      ...(query.tagId ? { tags: { some: { tagId: query.tagId } } } : {}),
    };

    const scopedWhere = applyScopeFilter(baseWhere, filter);
    if (scopedWhere === null) return this.emptyPage(query.limit);

    if (query.search) {
      const matched = await this.searchIds(query.search, query.limit * 4);
      if (matched.length === 0) return this.emptyPage(query.limit);
      scopedWhere['id'] = { in: matched };
    }

    const orderBy = this.orderFor(query);
    const [total, rows] = await Promise.all([
      this.db.client.lead.count({ where: scopedWhere }),
      this.db.client.lead.findMany({
        where: scopedWhere,
        orderBy,
        take: query.limit + 1,
        ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
        include: this.listInclude(),
      }),
    ]);

    const page = rows.slice(0, query.limit);
    const hasMore = rows.length > query.limit;
    return {
      items: page.map((lead) => this.presentSummary(lead)),
      pagination: {
        limit: query.limit,
        nextCursor: hasMore ? (page[page.length - 1]?.id ?? null) : null,
        hasMore,
        total,
      },
    };
  }

  async findOne(id: string) {
    const lead = await this.db.client.lead.findFirst({
      where: { id },
      include: {
        ...this.listInclude(),
        source: { select: { id: true, name: true } },
        lostReason: { select: { id: true, name: true } },
        pipeline: { select: { id: true, name: true } },
        touchpoints: { orderBy: { sequence: 'asc' } },
      },
    });
    if (!lead) throw AppError.notFound('Lead');

    // The list predicate is not enough on a single row: knowing an id must never be authority.
    this.assertCanSee(lead);

    const definitions = await this.fields.definitionsFor('lead');
    return {
      ...this.presentSummary(lead),
      jobTitle: lead.jobTitle,
      phoneRaw: lead.phoneRaw,
      state: lead.state,
      country: lead.country,
      postalCode: lead.postalCode,
      landingPageUrl: lead.landingPageUrl,
      utm: lead.utm,
      pipeline: lead.pipeline,
      lostReason: lead.lostReason,
      lostNote: lead.lostNote,
      convertedAt: lead.convertedAt,
      lostAt: lead.lostAt,
      firstContactedAt: lead.firstContactedAt,
      lastContactedAt: lead.lastContactedAt,
      consent: {
        whatsapp: lead.consentWhatsapp,
        email: lead.consentEmail,
        calls: lead.consentCalls,
      },
      createdVia: lead.createdVia,
      createdById: lead.createdById,
      deletedAt: lead.deletedAt,
      touchpoints: lead.touchpoints.map((touchpoint) => ({
        id: touchpoint.id,
        sequence: touchpoint.sequence,
        occurredAt: touchpoint.occurredAt,
        channel: touchpoint.channel,
        leadSourceId: touchpoint.leadSourceId,
        landingPageUrl: touchpoint.landingPageUrl,
        utm: touchpoint.utm,
        costAttributable: touchpoint.costAttributable,
      })),
      // The definitions travel with the record so a client can render values it has never seen
      // before without a second request.
      fieldDefinitions: definitions,
    };
  }

  // ── Creating ──────────────────────────────────────────────────────────────

  async create(input: CreateLeadInput) {
    const principal = tenantContext.require('leads.create');
    const organizationId = principal.organizationId;

    const organization = await this.db.client.organization.findUniqueOrThrow({
      where: { id: organizationId },
      select: { defaultPhoneCountry: true, defaultCurrency: true },
    });

    const contact = this.normalizeContact(input, organization.defaultPhoneCountry as CountryCode);
    const fullName = buildFullName(input.firstName, input.lastName, input.company, contact);
    if (!fullName) {
      throw AppError.validation('Some details need correcting', [
        {
          field: 'firstName',
          code: 'IDENTITY_REQUIRED',
          message: 'Give at least a name, a company, a phone number or an email address.',
        },
      ]);
    }

    const placement = await this.resolvePlacement(input);
    const custom = await this.resolveCustomValues(input.customValues ?? {}, 'create', organization);
    await this.assertWithinLeadLimit();

    if (input.assignedUserId) await this.assertAssignable(input.assignedUserId);
    if (input.tagIds && input.tagIds.length > 0) await this.assertTagsExist(input.tagIds);
    if (input.leadSourceId) await this.assertSourceExists(input.leadSourceId);

    // ── Is this somebody we already know? (`FR-DUP-1`–`FR-DUP-3`) ───────────
    // Before the insert, because the whole point of `attach_to_existing` is that no second record
    // is created. The action comes from the tenant's own rules, in their own priority order.
    const matches = await this.duplicates.detect({
      phoneE164: contact.phoneE164,
      whatsappE164: contact.whatsappE164,
      email: input.email ?? null,
      firstName: input.firstName ?? null,
      lastName: input.lastName ?? null,
      fullName,
      company: input.company ?? null,
      city: input.city ?? null,
      postalCode: input.postalCode ?? null,
    });
    const decidingMatch = matches[0];

    if (decidingMatch?.action === 'reject') {
      throw AppError.conflict(
        `That looks like ${decidingMatch.fullName}, captured ${describeAge(decidingMatch.createdAt)}. ` +
          `“${decidingMatch.ruleName}” is set to refuse repeat captures.`,
        'CONFLICT',
      );
    }

    if (decidingMatch?.action === 'attach_to_existing') {
      // Attribution is preserved as an additional touchpoint, never overwritten (`FR-DUP-3`): a
      // lead can be "Facebook-originated, later re-engaged via the website".
      return this.attachToExisting(decidingMatch, input, contact, custom);
    }

    const id = newId();
    const now = new Date();

    const assignmentSummary = await this.db.client.$transaction(async (tx) => {
      await tx.lead.create({
        data: {
          id,
          organizationId,
          firstName: input.firstName ?? null,
          lastName: input.lastName ?? null,
          fullName,
          company: input.company ?? null,
          jobTitle: input.jobTitle ?? null,
          phoneE164: contact.phoneE164,
          phoneRaw: contact.phoneRaw,
          whatsappE164: contact.whatsappE164,
          email: input.email ?? null,
          city: input.city ?? null,
          state: input.state ?? null,
          country: input.country ?? null,
          postalCode: input.postalCode ?? null,
          leadSourceId: input.leadSourceId ?? null,
          landingPageUrl: input.landingPageUrl ?? null,
          utm: (input.utm ?? {}) as never,
          createdVia: input.createdVia ?? 'manual',
          statusId: placement.statusId,
          pipelineId: placement.pipelineId,
          stageId: placement.stageId,
          priority: input.priority ?? 'medium',
          valueMinor: input.valueMinor ?? null,
          currency: input.currency ?? (input.valueMinor ? organization.defaultCurrency : null),
          customValues: custom.values as never,
          customSearchText: custom.searchText,
          assignedUserId: input.assignedUserId ?? null,
          branchId: input.branchId ?? null,
          teamId: input.teamId ?? null,
          consentWhatsapp: input.consent?.whatsapp ?? false,
          consentEmail: input.consent?.email ?? false,
          consentCalls: input.consent?.calls ?? false,
          createdById: principal.actorId ?? null,
          lastActivityAt: now,
        },
      });

      if (input.tagIds && input.tagIds.length > 0) {
        await tx.leadTag.createMany({
          data: input.tagIds.map((tagId) => ({ id: newId(), organizationId, leadId: id, tagId })),
          skipDuplicates: true,
        });
      }

      // The first touchpoint is written at creation rather than later, because attribution that
      // starts on the second contact has already lost the answer to "where did this lead come from".
      await tx.leadTouchpoint.create({
        data: {
          id: newId(),
          organizationId,
          leadId: id,
          sequence: 1,
          occurredAt: now,
          channel: touchpointChannelFor(input.createdVia ?? 'manual'),
          leadSourceId: input.leadSourceId ?? null,
          landingPageUrl: input.landingPageUrl ?? null,
          utm: (input.utm ?? {}) as never,
          costAttributable: isPaidChannel(input.createdVia ?? 'manual'),
        },
      });
      await tx.lead.update({ where: { id }, data: { touchCount: 1 } });

      await tx.leadStatusHistory.create({
        data: {
          id: newId(),
          organizationId,
          leadId: id,
          fromStatusId: null,
          toStatusId: placement.statusId,
          changedById: principal.actorId ?? null,
        },
      });
      await tx.leadStageHistory.create({
        data: {
          id: newId(),
          organizationId,
          leadId: id,
          fromStageId: null,
          toStageId: placement.stageId,
          changedById: principal.actorId ?? null,
        },
      });

      // ── Who gets it? (`FR-ASG-1`) ────────────────────────────────────────
      // Inside the transaction, so there is no window where the lead belongs to nobody, and so the
      // round-robin cursor advances under the same row lock that serialises two simultaneous
      // captures. An explicit `assignedUserId` wins: somebody said who.
      let assignedUserId = input.assignedUserId ?? null;
      let assignedTeamId = input.teamId ?? null;
      let assignmentReason = input.assignedUserId ? 'assigned on creation' : null;
      let assignmentDecision: Awaited<ReturnType<AssignmentEngineService['decide']>> | null = null;

      if (!input.assignedUserId) {
        assignmentDecision = await this.assignment.decide({
          lead: {
            ...input,
            fullName,
            phoneE164: contact.phoneE164,
            whatsappE164: contact.whatsappE164,
            statusId: placement.statusId,
            pipelineId: placement.pipelineId,
            stageId: placement.stageId,
            createdVia: input.createdVia ?? 'manual',
          },
          customValues: custom.values,
          at: now,
        });
        assignedUserId = assignmentDecision.assignedUserId;
        assignedTeamId = assignmentDecision.teamId ?? input.teamId ?? null;
        assignmentReason = assignmentDecision.reason;
        if (assignedUserId !== null || assignedTeamId !== null) {
          await tx.lead.update({
            where: { id },
            data: { assignedUserId, teamId: assignedTeamId },
          });
        }
        if (assignmentDecision.roundRobinAdvance) {
          await this.assignment.commitRoundRobin(tx, assignmentDecision.roundRobinAdvance);
          if (assignedUserId) {
            await tx.roundRobinState.updateMany({
              where: { ruleId: assignmentDecision.roundRobinAdvance.ruleId },
              data: { lastAssignedUserId: assignedUserId },
            });
          }
        }
      }

      if (assignedUserId || assignedTeamId) {
        await tx.leadAssignment.create({
          data: {
            id: newId(),
            organizationId,
            leadId: id,
            toUserId: assignedUserId,
            toTeamId: assignedTeamId,
            assignedById: principal.actorId ?? null,
            reason: assignmentReason ?? 'assigned on creation',
          },
        });
      }

      // ── A detected duplicate that was let through, linked for review ──────
      if (decidingMatch?.action === 'create_and_link') {
        await tx.lead.update({ where: { id }, data: { isDuplicateOfId: decidingMatch.leadId } });
        await this.duplicates.recordPairs(tx, id, matches);
      }

      await this.timeline.recordManyInTransaction(tx, [
        {
          // No `sourceEventId`: this entry is written inside the transaction that creates the lead,
          // so there is no retry to be idempotent against. That key is for entries a *processor*
          // writes from an event, and the rule is that exactly one of the two writes any given type.
          type: ACTIVITY_TYPES.LEAD_CREATED,
          leadId: id,
          occurredAt: now,
          payload: { fullName, createdVia: input.createdVia ?? 'manual' },
        },
        {
          type: ACTIVITY_TYPES.LEAD_SOURCE_CAPTURED,
          leadId: id,
          occurredAt: now,
          payload: {
            leadSourceId: input.leadSourceId ?? null,
            channel: touchpointChannelFor(input.createdVia ?? 'manual'),
            utm: input.utm ?? {},
          },
        },
        ...(assignedUserId
          ? [
              {
                type: ACTIVITY_TYPES.LEAD_ASSIGNED,
                leadId: id,
                occurredAt: now,
                payload: {
                  toUserId: assignedUserId,
                  reason: assignmentReason ?? 'assigned on creation',
                  ruleId: assignmentDecision?.rule?.id ?? null,
                  ruleName: assignmentDecision?.rule?.name ?? null,
                  usedFallback: assignmentDecision?.usedFallback ?? false,
                  explanation: assignmentDecision?.explanation ?? null,
                },
              } as const,
            ]
          : []),
        // A lead nobody picked up is the case that loses business, so it is on the timeline as its
        // own entry rather than being inferred from the absence of an assignment.
        ...(assignedUserId === null && assignmentDecision
          ? [
              {
                type: ACTIVITY_TYPES.LEAD_UNASSIGNED,
                leadId: id,
                occurredAt: now,
                payload: {
                  reason: assignmentDecision.reason,
                  ruleId: assignmentDecision.rule?.id ?? null,
                  explanation: assignmentDecision.explanation,
                },
              } as const,
            ]
          : []),
        ...(decidingMatch?.action === 'create_and_link'
          ? [
              {
                type: ACTIVITY_TYPES.LEAD_DUPLICATE_DETECTED,
                leadId: id,
                occurredAt: now,
                payload: {
                  otherLeadId: decidingMatch.leadId,
                  otherLeadName: decidingMatch.fullName,
                  matchedFields: decidingMatch.matchedFields,
                  confidence: decidingMatch.confidence,
                  ruleName: decidingMatch.ruleName,
                  decision: 'created and linked for review',
                },
              } as const,
            ]
          : []),
      ]);

      await this.audit.recordInTransaction(tx, {
        action: 'lead.created',
        resourceType: 'lead',
        resourceId: id,
        after: { fullName, phoneE164: contact.phoneE164, email: input.email ?? null },
      });

      const events: DomainEventInput[] = [
        {
          name: 'lead.created',
          aggregateType: 'lead',
          aggregateId: id,
          payload: {
            leadId: id,
            organizationId,
            createdVia: input.createdVia ?? 'manual',
            leadSourceId: input.leadSourceId ?? null,
            assignedUserId,
          },
        },
      ];
      if (assignedUserId === null && (assignmentDecision?.notifyManagers ?? false)) {
        events.push({
          name: 'lead.unassigned_pool',
          aggregateType: 'lead',
          aggregateId: id,
          payload: {
            leadId: id,
            fullName,
            ruleId: assignmentDecision?.rule?.id ?? null,
            ruleName: assignmentDecision?.rule?.name ?? null,
            explanation: assignmentDecision?.explanation ?? null,
          },
        });
      }
      await this.outbox.emit(tx, events);

      // Returned so the caller can tell a person who has the lead and why — an assignment engine
      // whose decision is only visible by re-reading the row is one nobody checks.
      return {
        assignedUserId,
        teamId: assignedTeamId,
        rule: assignmentDecision?.rule?.name ?? null,
        usedFallback: assignmentDecision?.usedFallback ?? false,
        explanation: assignmentDecision?.explanation ?? null,
      };
    });

    return {
      id,
      fullName,
      assignment: assignmentSummary,
      ...(decidingMatch?.action === 'create_and_link'
        ? {
            duplicate: {
              ofLeadId: decidingMatch.leadId,
              matchedFields: decidingMatch.matchedFields,
              confidence: decidingMatch.confidence,
              rule: decidingMatch.ruleName,
            },
          }
        : {}),
    };
  }

  /**
   * The `attach_to_existing` outcome (`FR-DUP-3`), and the most important behaviour in this file.
   *
   * A person who filled in a website form last month and now messages on WhatsApp is **one lead with
   * two touchpoints**, not two leads. So no record is created: a touchpoint is appended, the timeline
   * gains an entry, and any detail the existing lead was missing is filled in — but nothing it
   * already had is overwritten. The first capture said the lead came from Facebook, and that stays
   * true however many times they come back.
   *
   * The response is deliberately explicit about what happened. A caller that asked to create a lead
   * and got back somebody else's id without being told would be a worse bug than the duplicate.
   */
  private async attachToExisting(
    match: DuplicateCandidate,
    input: CreateLeadInput,
    contact: { phoneE164: string | null; phoneRaw: string | null; whatsappE164: string | null },
    custom: { values: Record<string, unknown>; searchText: string },
  ) {
    const principal = tenantContext.require('leads.attachToExisting');
    const existing = await this.db.client.lead.findFirstOrThrow({ where: { id: match.leadId } });
    const now = new Date();

    // Only blanks are filled. "Enrich, never overwrite" is the rule that makes repeat capture safe:
    // a customer who mistypes their surname on a second form must not rename themselves.
    const enrichment: Record<string, unknown> = {};
    const filled: string[] = [];
    const fill = (field: string, value: unknown): void => {
      if (value === null || value === undefined || value === '') return;
      const current = (existing as Record<string, unknown>)[field];
      if (current !== null && current !== undefined && current !== '') return;
      enrichment[field] = value;
      filled.push(field);
    };
    fill('firstName', input.firstName);
    fill('lastName', input.lastName);
    fill('company', input.company);
    fill('jobTitle', input.jobTitle);
    fill('email', input.email);
    fill('phoneE164', contact.phoneE164);
    fill('phoneRaw', contact.phoneRaw);
    fill('whatsappE164', contact.whatsappE164);
    fill('city', input.city);
    fill('state', input.state);
    fill('country', input.country);
    fill('postalCode', input.postalCode);
    fill('landingPageUrl', input.landingPageUrl);

    // Consent is only ever widened here, never narrowed: somebody ticking the WhatsApp box on a
    // second form is granting consent; leaving it blank is not withdrawing it. Withdrawal is its own
    // act, through the consent surface.
    if (input.consent?.whatsapp === true && !existing.consentWhatsapp) {
      enrichment['consentWhatsapp'] = true;
      filled.push('consentWhatsapp');
    }
    if (input.consent?.email === true && !existing.consentEmail) {
      enrichment['consentEmail'] = true;
      filled.push('consentEmail');
    }
    if (input.consent?.calls === true && !existing.consentCalls) {
      enrichment['consentCalls'] = true;
      filled.push('consentCalls');
    }

    // Custom values follow the same rule: fill a blank, never replace an answer.
    const existingCustom = (existing.customValues ?? {}) as Record<string, unknown>;
    const mergedCustom = { ...existingCustom };
    for (const [key, value] of Object.entries(custom.values)) {
      const current = existingCustom[key];
      if (current === null || current === undefined || current === '') {
        mergedCustom[key] = value;
        filled.push(`customValues.${key}`);
      }
    }

    const definitions = await this.fields.definitionsFor('lead');
    const nextFullName =
      existing.fullName ||
      buildFullName(
        (enrichment['firstName'] as string | undefined) ?? existing.firstName,
        (enrichment['lastName'] as string | undefined) ?? existing.lastName,
        (enrichment['company'] as string | undefined) ?? existing.company,
        contact,
        (enrichment['email'] as string | undefined) ?? existing.email,
      );

    const sequence = await this.db.client.$transaction(async (tx) => {
      const last = await tx.leadTouchpoint.findFirst({
        where: { leadId: match.leadId },
        orderBy: { sequence: 'desc' },
        select: { sequence: true },
      });
      const next = (last?.sequence ?? 0) + 1;

      await tx.leadTouchpoint.create({
        data: {
          id: newId(),
          organizationId: existing.organizationId,
          leadId: match.leadId,
          sequence: next,
          occurredAt: now,
          channel: touchpointChannelFor(input.createdVia ?? 'manual'),
          leadSourceId: input.leadSourceId ?? null,
          landingPageUrl: input.landingPageUrl ?? null,
          utm: (input.utm ?? {}) as never,
          costAttributable: isPaidChannel(input.createdVia ?? 'manual'),
        },
      });

      await tx.lead.update({
        where: { id: match.leadId },
        data: {
          ...enrichment,
          ...(nextFullName && nextFullName !== existing.fullName ? { fullName: nextFullName } : {}),
          ...(Object.keys(mergedCustom).length > 0
            ? {
                customValues: mergedCustom as never,
                customSearchText: searchTextFor(definitions, mergedCustom),
              }
            : {}),
          touchCount: { increment: 1 },
          lastActivityAt: now,
        },
      });

      await this.timeline.recordManyInTransaction(tx, [
        {
          type: ACTIVITY_TYPES.LEAD_DUPLICATE_DETECTED,
          leadId: match.leadId,
          occurredAt: now,
          payload: {
            decision: 'attached to this lead',
            matchedFields: match.matchedFields,
            confidence: match.confidence,
            ruleName: match.ruleName,
            createdVia: input.createdVia ?? 'manual',
            fieldsFilled: filled,
          },
        },
        {
          type: ACTIVITY_TYPES.LEAD_SOURCE_CAPTURED,
          leadId: match.leadId,
          occurredAt: now,
          payload: {
            sequence: next,
            channel: touchpointChannelFor(input.createdVia ?? 'manual'),
            leadSourceId: input.leadSourceId ?? null,
            utm: input.utm ?? {},
            repeatCapture: true,
          },
        },
      ]);

      await this.audit.recordInTransaction(tx, {
        action: 'lead.repeat_capture_attached',
        resourceType: 'lead',
        resourceId: match.leadId,
        after: {
          matchedFields: match.matchedFields,
          ruleName: match.ruleName,
          fieldsFilled: filled,
          touchpoint: next,
        },
      });

      await this.outbox.emit(tx, [
        {
          name: 'lead.touchpoint_added',
          aggregateType: 'lead',
          aggregateId: match.leadId,
          payload: {
            leadId: match.leadId,
            sequence: next,
            channel: touchpointChannelFor(input.createdVia ?? 'manual'),
            attachedBy: principal.actorId ?? null,
          },
        },
      ]);

      return next;
    });

    return {
      id: match.leadId,
      fullName: nextFullName || existing.fullName,
      // The caller asked to create a lead and did not get a new one. Saying so is not optional.
      attachedToExisting: true,
      matchedFields: match.matchedFields,
      confidence: match.confidence,
      rule: match.ruleName,
      touchpointSequence: sequence,
      fieldsFilled: filled,
      assignment: {
        assignedUserId: existing.assignedUserId,
        teamId: existing.teamId,
        rule: null,
        usedFallback: false,
        // Reassignment is not triggered by a repeat capture: whoever is working the lead keeps it.
        explanation: 'Kept with whoever already holds the lead.',
      },
    };
  }

  // ── Updating ──────────────────────────────────────────────────────────────

  async update(id: string, input: UpdateLeadInput) {
    const lead = await this.loadForWrite(id, PERMISSIONS.LEAD_UPDATE);
    const organization = await this.db.client.organization.findUniqueOrThrow({
      where: { id: lead.organizationId },
      select: { defaultPhoneCountry: true, defaultCurrency: true },
    });

    const contact = this.normalizeContact(input, organization.defaultPhoneCountry as CountryCode);
    const custom =
      input.customValues === undefined
        ? null
        : await this.resolveCustomValues(
            input.customValues,
            'patch',
            organization,
            lead.customValues,
          );

    if (input.leadSourceId) await this.assertSourceExists(input.leadSourceId);

    const data: Record<string, unknown> = {};
    const changes: Record<string, { from: unknown; to: unknown }> = {};

    const track = (field: string, next: unknown, previous: unknown): void => {
      if (next === undefined) return;
      if (next === previous) return;
      data[field] = next;
      changes[field] = { from: previous, to: next };
    };

    track('firstName', input.firstName, lead.firstName);
    track('lastName', input.lastName, lead.lastName);
    track('company', input.company, lead.company);
    track('jobTitle', input.jobTitle, lead.jobTitle);
    track('email', input.email, lead.email);
    track('city', input.city, lead.city);
    track('state', input.state, lead.state);
    track('country', input.country, lead.country);
    track('postalCode', input.postalCode, lead.postalCode);
    track('priority', input.priority, lead.priority);
    track('leadSourceId', input.leadSourceId, lead.leadSourceId);
    track(
      'valueMinor',
      input.valueMinor,
      lead.valueMinor === null ? null : Number(lead.valueMinor),
    );
    track('currency', input.currency, lead.currency);
    if (input.phone !== undefined) {
      track('phoneE164', contact.phoneE164, lead.phoneE164);
      track('phoneRaw', contact.phoneRaw, lead.phoneRaw);
    }
    if (input.whatsapp !== undefined)
      track('whatsappE164', contact.whatsappE164, lead.whatsappE164);
    if (input.consent) {
      track('consentWhatsapp', input.consent.whatsapp, lead.consentWhatsapp);
      track('consentEmail', input.consent.email, lead.consentEmail);
      track('consentCalls', input.consent.calls, lead.consentCalls);
    }

    // A value without a currency is refused by the database; defaulting it here means a client that
    // only knows about amounts still works.
    if (
      data['valueMinor'] !== undefined &&
      data['valueMinor'] !== null &&
      !lead.currency &&
      !input.currency
    ) {
      data['currency'] = organization.defaultCurrency;
    }

    if (custom) {
      const merged = { ...(lead.customValues as Record<string, unknown>), ...custom.values };
      for (const key of custom.cleared) delete merged[key];
      const definitions = await this.fields.definitionsFor('lead');
      data['customValues'] = merged;
      data['customSearchText'] = searchTextFor(definitions, merged);
      for (const key of Object.keys(custom.values)) {
        changes[`customValues.${key}`] = {
          from: (lead.customValues as Record<string, unknown>)[key] ?? null,
          to: custom.values[key],
        };
      }
      for (const key of custom.cleared) {
        changes[`customValues.${key}`] = {
          from: (lead.customValues as Record<string, unknown>)[key] ?? null,
          to: null,
        };
      }
    }

    if (Object.keys(data).length === 0) return { id, changed: false };

    const nextFullName = buildFullName(
      (data['firstName'] as string | null | undefined) ?? lead.firstName,
      (data['lastName'] as string | null | undefined) ?? lead.lastName,
      (data['company'] as string | null | undefined) ?? lead.company,
      {
        phoneE164: (data['phoneE164'] as string | null | undefined) ?? lead.phoneE164,
        phoneRaw: null,
        whatsappE164: null,
      },
      (data['email'] as string | null | undefined) ?? lead.email,
    );
    if (nextFullName && nextFullName !== lead.fullName) data['fullName'] = nextFullName;

    const now = new Date();
    await this.db.client.$transaction(async (tx) => {
      await tx.lead.update({ where: { id }, data: { ...data, lastActivityAt: now } });

      // One timeline entry per edit, listing what changed — not one per field, which would bury the
      // interesting events under a wall of "city changed".
      await this.timeline.recordInTransaction(tx, {
        type: ACTIVITY_TYPES.LEAD_FIELD_UPDATED,
        leadId: id,
        occurredAt: now,
        payload: { changes },
      });
      await this.audit.recordInTransaction(tx, {
        action: 'lead.updated',
        resourceType: 'lead',
        resourceId: id,
        before: Object.fromEntries(
          Object.entries(changes).map(([key, value]) => [key, value.from]),
        ),
        after: Object.fromEntries(Object.entries(changes).map(([key, value]) => [key, value.to])),
      });
      await this.outbox.emit(tx, [
        {
          name: 'lead.updated',
          aggregateType: 'lead',
          aggregateId: id,
          payload: { leadId: id, changed: Object.keys(changes) },
        },
      ]);
    });

    return { id, changed: true, fields: Object.keys(changes) };
  }

  // ── Transitions ───────────────────────────────────────────────────────────

  async changeStatus(id: string, input: ChangeStatusInput) {
    const lead = await this.loadForWrite(id, PERMISSIONS.LEAD_UPDATE);
    if (lead.statusId === input.statusId && !input.lostReasonId) {
      return { id, changed: false, statusId: lead.statusId };
    }

    const status = await this.db.client.leadStatus.findFirst({
      where: { id: input.statusId, deletedAt: null, isActive: true },
    });
    if (!status) throw AppError.notFound('Status');

    let lostReasonId: string | null = null;
    if (status.category === 'lost') {
      if (!input.lostReasonId) {
        throw AppError.validation('Some details need correcting', [
          {
            field: 'lostReasonId',
            code: 'REQUIRED',
            message: 'Say why the lead was lost — it is the only way loss reports mean anything.',
          },
        ]);
      }
      const reason = await this.db.client.lostReason.findFirst({
        where: { id: input.lostReasonId, deletedAt: null, isActive: true },
      });
      if (!reason) throw AppError.notFound('Lost reason');
      if (reason.requiresNote && !input.lostNote) {
        throw AppError.validation('Some details need correcting', [
          {
            field: 'lostNote',
            code: 'REQUIRED',
            message: `“${reason.name}” needs a note explaining what happened.`,
          },
        ]);
      }
      lostReasonId = reason.id;
    }

    const now = new Date();
    const previous = await this.previousStatusChangeAt(id, lead.createdAt);
    const durationSeconds = Math.max(0, Math.round((now.getTime() - previous.getTime()) / 1000));

    await this.db.client.$transaction(async (tx) => {
      await tx.lead.update({
        where: { id },
        data: {
          statusId: status.id,
          lastActivityAt: now,
          lostReasonId,
          lostNote: status.category === 'lost' ? (input.lostNote ?? null) : null,
          lostAt: status.category === 'lost' ? now : null,
          convertedAt: status.category === 'won' ? (lead.convertedAt ?? now) : null,
        },
      });
      await tx.leadStatusHistory.create({
        data: {
          id: newId(),
          organizationId: lead.organizationId,
          leadId: id,
          fromStatusId: lead.statusId,
          toStatusId: status.id,
          changedById: tenantContext.get()?.actorId ?? null,
          durationSeconds,
        },
      });

      const entries = [
        {
          type: ACTIVITY_TYPES.LEAD_STATUS_CHANGED,
          leadId: id,
          occurredAt: now,
          payload: {
            fromStatusId: lead.statusId,
            toStatusId: status.id,
            toStatusName: status.name,
            category: status.category,
            secondsInPrevious: durationSeconds,
          },
        } as const,
      ];
      if (status.category === 'lost') {
        entries.push({
          type: ACTIVITY_TYPES.LEAD_LOST,
          leadId: id,
          occurredAt: now,
          payload: { lostReasonId, lostNote: input.lostNote ?? null },
        } as never);
      }
      if (status.category === 'won') {
        entries.push({
          type: ACTIVITY_TYPES.LEAD_CONVERTED,
          leadId: id,
          occurredAt: now,
          payload: { statusId: status.id, statusName: status.name },
        } as never);
      }
      await this.timeline.recordManyInTransaction(tx, entries);

      await this.audit.recordInTransaction(tx, {
        action: 'lead.status_changed',
        resourceType: 'lead',
        resourceId: id,
        before: { statusId: lead.statusId },
        after: { statusId: status.id, category: status.category },
      });
      await this.outbox.emit(tx, [
        {
          name: 'lead.status_changed',
          aggregateType: 'lead',
          aggregateId: id,
          payload: {
            leadId: id,
            fromStatusId: lead.statusId,
            toStatusId: status.id,
            category: status.category,
          },
        },
      ]);
    });

    return { id, changed: true, statusId: status.id, category: status.category };
  }

  async changeStage(id: string, input: ChangeStageInput) {
    const lead = await this.loadForWrite(id, PERMISSIONS.LEAD_UPDATE);
    if (lead.stageId === input.stageId) return { id, changed: false, stageId: lead.stageId };

    const stage = await this.db.client.pipelineStage.findFirst({
      where: { id: input.stageId, deletedAt: null },
    });
    if (!stage) throw AppError.notFound('Stage');

    const targetPipelineId = input.pipelineId ?? lead.pipelineId;
    if (stage.pipelineId !== targetPipelineId) {
      // The database refuses this too; catching it here says *why* rather than surfacing a
      // constraint name.
      throw AppError.businessRule(
        'That stage belongs to a different pipeline. Move the lead to that pipeline explicitly if that is what you meant',
        { stagePipelineId: stage.pipelineId, leadPipelineId: lead.pipelineId },
      );
    }

    await this.assertStageRequirementsMet(stage, lead);

    const now = new Date();
    const previous = await this.previousStageChangeAt(id, lead.createdAt);
    const durationSeconds = Math.max(0, Math.round((now.getTime() - previous.getTime()) / 1000));

    await this.db.client.$transaction(async (tx) => {
      await tx.lead.update({
        where: { id },
        data: { stageId: stage.id, pipelineId: targetPipelineId, lastActivityAt: now },
      });
      await tx.leadStageHistory.create({
        data: {
          id: newId(),
          organizationId: lead.organizationId,
          leadId: id,
          fromStageId: lead.stageId,
          toStageId: stage.id,
          changedById: tenantContext.get()?.actorId ?? null,
          durationSeconds,
        },
      });
      await this.timeline.recordInTransaction(tx, {
        type: ACTIVITY_TYPES.LEAD_STAGE_CHANGED,
        leadId: id,
        occurredAt: now,
        payload: {
          fromStageId: lead.stageId,
          toStageId: stage.id,
          toStageName: stage.name,
          secondsInPrevious: durationSeconds,
          isWon: stage.isWon,
          isLost: stage.isLost,
        },
      });
      await this.audit.recordInTransaction(tx, {
        action: 'lead.stage_changed',
        resourceType: 'lead',
        resourceId: id,
        before: { stageId: lead.stageId },
        after: { stageId: stage.id },
      });
      await this.outbox.emit(tx, [
        {
          name: 'lead.stage_changed',
          aggregateType: 'lead',
          aggregateId: id,
          payload: { leadId: id, fromStageId: lead.stageId, toStageId: stage.id },
        },
      ]);
    });

    return { id, changed: true, stageId: stage.id };
  }

  async assign(id: string, input: AssignLeadInput) {
    const lead = await this.loadForWrite(id, PERMISSIONS.LEAD_ASSIGN);
    if (lead.assignedUserId === input.assignedUserId && input.teamId === undefined) {
      return { id, changed: false, assignedUserId: lead.assignedUserId };
    }
    if (input.assignedUserId) await this.assertAssignable(input.assignedUserId);
    if (input.teamId) await this.assertTeamExists(input.teamId);

    const now = new Date();
    const wasAssigned = lead.assignedUserId !== null;

    await this.db.client.$transaction(async (tx) => {
      await tx.lead.update({
        where: { id },
        data: {
          assignedUserId: input.assignedUserId,
          ...(input.teamId !== undefined ? { teamId: input.teamId } : {}),
          lastActivityAt: now,
        },
      });
      await tx.leadAssignment.create({
        data: {
          id: newId(),
          organizationId: lead.organizationId,
          leadId: id,
          fromUserId: lead.assignedUserId,
          toUserId: input.assignedUserId,
          toTeamId: input.teamId ?? null,
          assignedById: tenantContext.get()?.actorId ?? null,
          reason: input.reason ?? 'manual assignment',
        },
      });
      await this.timeline.recordInTransaction(tx, {
        type:
          input.assignedUserId === null
            ? ACTIVITY_TYPES.LEAD_UNASSIGNED
            : wasAssigned
              ? ACTIVITY_TYPES.LEAD_REASSIGNED
              : ACTIVITY_TYPES.LEAD_ASSIGNED,
        leadId: id,
        occurredAt: now,
        payload: {
          fromUserId: lead.assignedUserId,
          toUserId: input.assignedUserId,
          reason: input.reason ?? 'manual assignment',
        },
      });
      await this.audit.recordInTransaction(tx, {
        action: 'lead.assigned',
        resourceType: 'lead',
        resourceId: id,
        before: { assignedUserId: lead.assignedUserId },
        after: { assignedUserId: input.assignedUserId },
      });
      await this.outbox.emit(tx, [
        {
          name: 'lead.assigned',
          aggregateType: 'lead',
          aggregateId: id,
          payload: {
            leadId: id,
            fromUserId: lead.assignedUserId,
            toUserId: input.assignedUserId,
          },
        },
      ]);
    });

    return { id, changed: true, assignedUserId: input.assignedUserId };
  }

  async setTags(id: string, input: SetTagsInput) {
    const lead = await this.loadForWrite(id, PERMISSIONS.LEAD_UPDATE);
    if (input.tagIds.length > 0) await this.assertTagsExist(input.tagIds);

    const existing = await this.db.client.leadTag.findMany({ where: { leadId: id } });
    const existingIds = new Set(existing.map((row) => row.tagId));
    const wanted = new Set(input.tagIds);
    const added = input.tagIds.filter((tagId) => !existingIds.has(tagId));
    const removed = existing.filter((row) => !wanted.has(row.tagId));
    if (added.length === 0 && removed.length === 0) return { id, changed: false };

    const now = new Date();
    await this.db.client.$transaction(async (tx) => {
      if (removed.length > 0) {
        await tx.leadTag.deleteMany({ where: { id: { in: removed.map((row) => row.id) } } });
      }
      if (added.length > 0) {
        await tx.leadTag.createMany({
          data: added.map((tagId) => ({
            id: newId(),
            organizationId: lead.organizationId,
            leadId: id,
            tagId,
          })),
          skipDuplicates: true,
        });
      }
      await tx.lead.update({ where: { id }, data: { lastActivityAt: now } });
      await this.timeline.recordManyInTransaction(tx, [
        ...(added.length > 0
          ? [
              {
                type: ACTIVITY_TYPES.LEAD_TAGGED,
                leadId: id,
                occurredAt: now,
                payload: { tagIds: added },
              } as const,
            ]
          : []),
        ...(removed.length > 0
          ? [
              {
                type: ACTIVITY_TYPES.LEAD_UNTAGGED,
                leadId: id,
                occurredAt: now,
                payload: { tagIds: removed.map((row) => row.tagId) },
              } as const,
            ]
          : []),
      ]);
    });

    return { id, changed: true, added: added.length, removed: removed.length };
  }

  async addTouchpoint(id: string, input: AddTouchpointInput) {
    const lead = await this.loadForWrite(id, PERMISSIONS.LEAD_UPDATE);
    if (input.leadSourceId) await this.assertSourceExists(input.leadSourceId);

    const occurredAt = input.occurredAt ?? new Date();

    // The sequence is derived inside the transaction, and the unique constraint on
    // (organization, lead, sequence) is what makes two concurrent captures collide rather than
    // silently share a number.
    const result = await this.db.client.$transaction(async (tx) => {
      const last = await tx.leadTouchpoint.findFirst({
        where: { leadId: id },
        orderBy: { sequence: 'desc' },
        select: { sequence: true },
      });
      const sequence = (last?.sequence ?? 0) + 1;

      await tx.leadTouchpoint.create({
        data: {
          id: newId(),
          organizationId: lead.organizationId,
          leadId: id,
          sequence,
          occurredAt,
          channel: input.channel,
          leadSourceId: input.leadSourceId ?? null,
          landingPageUrl: input.landingPageUrl ?? null,
          utm: (input.utm ?? {}) as never,
          sessionId: input.sessionId ?? null,
          costAttributable: input.costAttributable ?? false,
          metadata: (input.metadata ?? {}) as never,
        },
      });
      await tx.lead.update({
        where: { id },
        data: { touchCount: { increment: 1 }, lastActivityAt: new Date() },
      });
      await this.timeline.recordInTransaction(tx, {
        type: ACTIVITY_TYPES.LEAD_SOURCE_CAPTURED,
        leadId: id,
        occurredAt,
        payload: {
          sequence,
          channel: input.channel,
          leadSourceId: input.leadSourceId ?? null,
          utm: input.utm ?? {},
        },
      });
      return sequence;
    });

    return { id, sequence: result };
  }

  // ── Deleting and restoring ────────────────────────────────────────────────

  async remove(id: string) {
    const lead = await this.loadForWrite(id, PERMISSIONS.LEAD_DELETE);
    if (lead.deletedAt) return { id, deleted: true, alreadyDeleted: true };

    const now = new Date();
    await this.db.client.$transaction(async (tx) => {
      await tx.lead.update({
        where: { id },
        data: { deletedAt: now, deletedById: tenantContext.get()?.actorId ?? null },
      });
      await this.timeline.recordInTransaction(tx, {
        type: ACTIVITY_TYPES.LEAD_DELETED,
        leadId: id,
        occurredAt: now,
        payload: { fullName: lead.fullName },
      });
      await this.audit.recordInTransaction(tx, {
        action: 'lead.deleted',
        resourceType: 'lead',
        resourceId: id,
        before: { fullName: lead.fullName },
      });
      await this.outbox.emit(tx, [
        {
          name: 'lead.deleted',
          aggregateType: 'lead',
          aggregateId: id,
          payload: { leadId: id },
        },
      ]);
    });

    return { id, deleted: true, recoverable: true };
  }

  async restore(id: string) {
    const lead = await this.loadForWrite(id, PERMISSIONS.LEAD_DELETE, { includeDeleted: true });
    if (!lead.deletedAt) return { id, restored: false, reason: 'not deleted' };

    const now = new Date();
    await this.db.client.$transaction(async (tx) => {
      await tx.lead.update({ where: { id }, data: { deletedAt: null, deletedById: null } });
      await this.timeline.recordInTransaction(tx, {
        type: ACTIVITY_TYPES.LEAD_RESTORED,
        leadId: id,
        occurredAt: now,
        payload: { fullName: lead.fullName },
      });
      await this.audit.recordInTransaction(tx, {
        action: 'lead.restored',
        resourceType: 'lead',
        resourceId: id,
        after: { fullName: lead.fullName },
      });
    });

    return { id, restored: true };
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  private listInclude() {
    return {
      status: { select: { id: true, name: true, colour: true, category: true } },
      stage: { select: { id: true, name: true, colour: true, isWon: true, isLost: true } },
      tags: { include: { tag: { select: { id: true, name: true, colour: true } } } },
    } as const;
  }

  private presentSummary(lead: {
    id: string;
    organizationId: string;
    fullName: string;
    firstName: string | null;
    lastName: string | null;
    company: string | null;
    phoneE164: string | null;
    whatsappE164: string | null;
    email: string | null;
    city: string | null;
    statusId: string;
    stageId: string;
    pipelineId: string;
    leadSourceId: string | null;
    priority: string;
    score: number;
    scoreBand: string | null;
    valueMinor: bigint | null;
    currency: string | null;
    customValues: unknown;
    assignedUserId: string | null;
    branchId: string | null;
    teamId: string | null;
    openTasksCount: number;
    touchCount: number;
    nextActionAt: Date | null;
    lastActivityAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
    status?: { id: string; name: string; colour: string | null; category: string };
    stage?: { id: string; name: string; colour: string | null; isWon: boolean; isLost: boolean };
    tags?: { tag: { id: string; name: string; colour: string | null } }[];
  }) {
    return {
      id: lead.id,
      fullName: lead.fullName,
      firstName: lead.firstName,
      lastName: lead.lastName,
      company: lead.company,
      phone: lead.phoneE164,
      whatsapp: lead.whatsappE164,
      email: lead.email,
      city: lead.city,
      status: lead.status ?? { id: lead.statusId },
      stage: lead.stage ?? { id: lead.stageId },
      pipelineId: lead.pipelineId,
      leadSourceId: lead.leadSourceId,
      priority: lead.priority,
      score: lead.score,
      scoreBand: lead.scoreBand,
      // BigInt does not survive JSON, so money crosses the wire as a number of minor units.
      valueMinor: lead.valueMinor === null ? null : Number(lead.valueMinor),
      currency: lead.currency,
      customValues: lead.customValues,
      assignedUserId: lead.assignedUserId,
      branchId: lead.branchId,
      teamId: lead.teamId,
      openTasksCount: lead.openTasksCount,
      touchCount: lead.touchCount,
      nextActionAt: lead.nextActionAt,
      lastActivityAt: lead.lastActivityAt,
      tags: (lead.tags ?? []).map((entry) => entry.tag),
      createdAt: lead.createdAt,
      updatedAt: lead.updatedAt,
    };
  }

  private emptyPage(limit: number) {
    return {
      items: [] as ReturnType<LeadsService['presentSummary']>[],
      pagination: { limit, nextCursor: null, hasMore: false, total: 0 },
    };
  }

  private orderFor(query: ListLeadsQuery) {
    const column = {
      created_at: 'createdAt',
      updated_at: 'updatedAt',
      last_activity_at: 'lastActivityAt',
      score: 'score',
    }[query.sort];
    // The id tiebreak is what makes cursor pagination stable when two rows share a timestamp.
    return [{ [column]: query.direction }, { id: 'desc' }] as never;
  }

  /**
   * Full-text search over the trigger-maintained vector, plus a trigram fallback for partial phone
   * numbers and misspelt names.
   *
   * Raw SQL because `search_vector` is a tsvector Prisma cannot express. The organization filter is
   * bound explicitly rather than relying on the scoped client, since the scoping extension cannot see
   * inside a raw query — the one place in this codebase where tenant scoping is written by hand, and
   * therefore the one worth reading twice.
   */
  private async searchIds(term: string, limit: number): Promise<string[]> {
    const organizationId = tenantContext.organizationId('leads.search');
    const digits = term.replace(/\D/g, '');
    const rows = await this.db.client.$queryRaw<{ id: string }[]>`
      SELECT id
      FROM leads
      WHERE organization_id = ${organizationId}::uuid
        AND deleted_at IS NULL
        AND (
          search_vector @@ plainto_tsquery('simple', ${term})
          OR full_name ILIKE ${'%' + term + '%'}
          OR email ILIKE ${'%' + term + '%'}
          OR (${digits} <> '' AND phone_e164 LIKE ${'%' + digits})
        )
      ORDER BY ts_rank(search_vector, plainto_tsquery('simple', ${term})) DESC, created_at DESC
      LIMIT ${limit}
    `;
    return rows.map((row) => row.id);
  }

  private assertCanSee(lead: {
    assignedUserId: string | null;
    teamId: string | null;
    branchId: string | null;
  }): void {
    const allowed = this.scopes.canAct(PERMISSIONS.LEAD_READ, {
      userId: lead.assignedUserId,
      teamId: lead.teamId,
      branchId: lead.branchId,
    });
    // 404, not 403: confirming the lead exists would tell an unauthorized caller something.
    if (!allowed) throw AppError.notFound('Lead');
  }

  private async loadForWrite(
    id: string,
    permission: string,
    options: { includeDeleted?: boolean } = {},
  ) {
    const lead = await this.db.client.lead.findFirst({
      where: { id, ...(options.includeDeleted === true ? {} : { deletedAt: null }) },
    });
    if (!lead) throw AppError.notFound('Lead');

    const allowed = this.scopes.canAct(permission, {
      userId: lead.assignedUserId,
      teamId: lead.teamId,
      branchId: lead.branchId,
    });
    if (!allowed) throw AppError.notFound('Lead');
    return lead;
  }

  /** Where a new lead lands when the caller does not say: the tenant's own defaults. */
  private async resolvePlacement(input: {
    statusId?: string;
    pipelineId?: string;
    stageId?: string;
  }): Promise<{ statusId: string; pipelineId: string; stageId: string }> {
    const status = input.statusId
      ? await this.db.client.leadStatus.findFirst({
          where: { id: input.statusId, deletedAt: null, isActive: true },
        })
      : await this.db.client.leadStatus.findFirst({
          where: { isDefault: true, deletedAt: null, isActive: true },
        });
    if (!status) {
      throw input.statusId
        ? AppError.notFound('Status')
        : AppError.businessRule(
            'This workspace has no default lead status. An administrator needs to set one before leads can be created',
          );
    }

    const pipeline = input.pipelineId
      ? await this.db.client.pipeline.findFirst({
          where: { id: input.pipelineId, deletedAt: null, isActive: true, entityType: 'lead' },
        })
      : await this.db.client.pipeline.findFirst({
          where: { isDefault: true, deletedAt: null, isActive: true, entityType: 'lead' },
        });
    if (!pipeline) {
      throw input.pipelineId
        ? AppError.notFound('Pipeline')
        : AppError.businessRule(
            'This workspace has no default pipeline. An administrator needs to set one before leads can be created',
          );
    }

    const stage = input.stageId
      ? await this.db.client.pipelineStage.findFirst({
          where: { id: input.stageId, pipelineId: pipeline.id, deletedAt: null },
        })
      : await this.db.client.pipelineStage.findFirst({
          where: { pipelineId: pipeline.id, deletedAt: null },
          orderBy: { sortOrder: 'asc' },
        });
    if (!stage) {
      throw input.stageId
        ? AppError.notFound('Stage')
        : AppError.businessRule(`The pipeline “${pipeline.name}” has no stages`);
    }

    return { statusId: status.id, pipelineId: pipeline.id, stageId: stage.id };
  }

  private async resolveCustomValues(
    input: Record<string, unknown>,
    mode: 'create' | 'patch',
    organization: { defaultPhoneCountry: string; defaultCurrency: string },
    existing?: unknown,
  ) {
    const definitions = await this.fields.definitionsFor('lead');
    const result = validateCustomValues(definitions, input, {
      mode,
      defaultPhoneCountry: organization.defaultPhoneCountry as CountryCode,
      defaultCurrency: organization.defaultCurrency,
    });
    if (mode === 'create') return result;

    const merged = { ...((existing ?? {}) as Record<string, unknown>), ...result.values };
    for (const key of result.cleared) delete merged[key];
    return { ...result, searchText: searchTextFor(definitions, merged) };
  }

  /**
   * A stage can demand that certain fields are filled before a lead enters it — the mechanism that
   * stops a pipeline becoming a row of empty buckets. Both lead columns and custom-field keys are
   * accepted, because "budget" is a custom field in one business and "value" is a column in another.
   */
  private async assertStageRequirementsMet(
    stage: { name: string; requiredFields: unknown },
    lead: Record<string, unknown>,
  ): Promise<void> {
    const required = Array.isArray(stage.requiredFields)
      ? stage.requiredFields.filter((entry): entry is string => typeof entry === 'string')
      : [];
    if (required.length === 0) return;

    const definitions = await this.fields.definitionsFor('lead');
    const byKey = new Map(definitions.map((definition) => [definition.key, definition]));
    const customValues = (lead['customValues'] ?? {}) as Record<string, unknown>;
    const columnAliases: Record<string, string> = {
      phone: 'phoneE164',
      whatsapp: 'whatsappE164',
      value: 'valueMinor',
      source: 'leadSourceId',
      owner: 'assignedUserId',
      assigned_to: 'assignedUserId',
    };

    const missing: string[] = [];
    for (const key of required) {
      const definition = byKey.get(key);
      if (definition) {
        const value = customValues[key];
        if (value === undefined || value === null || value === '') missing.push(definition.label);
        continue;
      }
      const column = columnAliases[key] ?? toCamel(key);
      const value = lead[column];
      if (value === undefined || value === null || value === '') missing.push(key);
    }

    if (missing.length > 0) {
      throw AppError.businessRule(
        `“${stage.name}” needs these filled in first: ${missing.join(', ')}`,
        { missing },
      );
    }
  }

  private normalizeContact(
    input: { phone?: string | null; whatsapp?: string | null },
    defaultCountry: CountryCode,
  ): { phoneE164: string | null; phoneRaw: string | null; whatsappE164: string | null } {
    const errors: { field: string; code: string; message: string }[] = [];

    const toE164 = (value: string | null | undefined, field: string): string | null => {
      if (value === null || value === undefined || value.trim() === '') return null;
      try {
        return normalizePhone(value, defaultCountry).e164;
      } catch (error) {
        const reason = error instanceof PhoneNormalizationError ? error.reason : 'invalid';
        errors.push({
          field,
          code: 'INVALID_PHONE',
          message: `That does not look like a phone number (${reason}).`,
        });
        return null;
      }
    };

    const phoneE164 = toE164(input.phone, 'phone');
    const whatsappE164 = toE164(input.whatsapp, 'whatsapp');
    if (errors.length > 0) throw AppError.validation('Some details need correcting', errors);

    return {
      phoneE164,
      // The raw form is kept for support conversations: "the number I was given was 98765 43210".
      phoneRaw: input.phone?.trim() ?? null,
      whatsappE164,
    };
  }

  private async assertWithinLeadLimit(): Promise<void> {
    const used = await this.db.client.lead.count({ where: { deletedAt: null } });
    await this.entitlements.assertWithinLimit('leads', used);
  }

  private async assertAssignable(userId: string): Promise<void> {
    const membership = await this.db.client.membership.findFirst({
      where: { userId, status: 'active', deletedAt: null },
    });
    // Tenant scoping means a user id from another organization simply is not found — which is the
    // point of assigning through Membership rather than User.
    if (!membership) throw AppError.notFound('Member');
  }

  private async assertTeamExists(teamId: string): Promise<void> {
    const team = await this.db.client.team.findFirst({ where: { id: teamId, deletedAt: null } });
    if (!team) throw AppError.notFound('Team');
  }

  private async assertSourceExists(sourceId: string): Promise<void> {
    const source = await this.db.client.leadSource.findFirst({
      where: { id: sourceId, deletedAt: null },
    });
    if (!source) throw AppError.notFound('Source');
  }

  private async assertTagsExist(tagIds: readonly string[]): Promise<void> {
    const found = await this.db.client.tag.findMany({
      where: { id: { in: [...tagIds] }, deletedAt: null },
      select: { id: true },
    });
    if (found.length !== new Set(tagIds).size) throw AppError.notFound('Tag');
  }

  private async previousStatusChangeAt(leadId: string, fallback: Date): Promise<Date> {
    const last = await this.db.client.leadStatusHistory.findFirst({
      where: { leadId },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    });
    return last?.createdAt ?? fallback;
  }

  private async previousStageChangeAt(leadId: string, fallback: Date): Promise<Date> {
    const last = await this.db.client.leadStageHistory.findFirst({
      where: { leadId },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    });
    return last?.createdAt ?? fallback;
  }
}

/**
 * A lead needs something to be called. In order of usefulness to a person scanning a list: their
 * name, the company, then whatever contact detail we do have — an unnamed enquiry from a phone number
 * is still a lead, and "Unknown" in a list helps nobody.
 */
function buildFullName(
  firstName: string | null | undefined,
  lastName: string | null | undefined,
  company: string | null | undefined,
  contact: { phoneE164: string | null; phoneRaw: string | null; whatsappE164: string | null },
  email?: string | null,
): string {
  const name = [firstName, lastName]
    .map((part) => part?.trim())
    .filter((part): part is string => Boolean(part))
    .join(' ');
  if (name) return name;
  if (company?.trim()) return company.trim();
  if (email?.trim()) return email.trim();
  if (contact.phoneE164) return contact.phoneE164;
  if (contact.whatsappE164) return contact.whatsappE164;
  return '';
}

function touchpointChannelFor(createdVia: string): TouchpointChannel {
  const map: Record<string, TouchpointChannel> = {
    manual: 'manual',
    form: 'form',
    api: 'api',
    webhook: 'api',
    import: 'import',
    whatsapp: 'whatsapp',
    meta_ads: 'meta_ads',
    google_ads: 'google_ads',
    website: 'website',
  };
  return map[createdVia] ?? 'other';
}

/** Only paid channels count against ad spend; a manual entry must not inflate cost per lead. */
function isPaidChannel(createdVia: string): boolean {
  return createdVia === 'meta_ads' || createdVia === 'google_ads';
}

function toCamel(value: string): string {
  return value.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
}

/**
 * How long ago, in words.
 *
 * Used in the message a `reject` rule produces. "That looks like Anita Sharma, captured 3 days ago"
 * is actionable; "duplicate detected" is not.
 */
function describeAge(when: Date): string {
  const days = Math.floor((Date.now() - when.getTime()) / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days} days ago`;
  const months = Math.floor(days / 30);
  return months === 1 ? 'about a month ago' : `about ${months} months ago`;
}
