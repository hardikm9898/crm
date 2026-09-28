import { Injectable } from '@nestjs/common';
import {
  ACTIVITY_TYPES,
  AppError,
  MATCHABLE_FIELDS,
  PERMISSIONS,
  newId,
  normalizePhone,
  PhoneNormalizationError,
  tenantContext,
  validateMatchOn,
  type CountryCode,
} from '@leados/shared';
import { DbService } from '../../infra/db/db.service.js';
import { AuditService } from '../../infra/audit/audit.service.js';
import { TimelineService } from '../../infra/timeline/timeline.service.js';
import { DataScopeService } from '../../infra/authz/data-scope.service.js';
import { fullPage } from '../organizations/organizations.service.js';
import { DuplicateDetectionService } from './duplicate-detection.service.js';
import type {
  CreateDuplicateRuleInput,
  ListDuplicatesQuery,
  TestDuplicateInput,
  UpdateDuplicateRuleInput,
} from './duplicates.dto.js';

/**
 * Duplicate rules, and the triage queue they fill.
 *
 * The rules are configuration; the queue is work. Keeping them in one service is deliberate — a
 * manager looking at a pile of false positives needs to get from "this pair is wrong" to "the rule
 * that produced it" without changing screens.
 */
@Injectable()
export class DuplicatesService {
  constructor(
    private readonly db: DbService,
    private readonly scopes: DataScopeService,
    private readonly detection: DuplicateDetectionService,
    private readonly audit: AuditService,
    private readonly timeline: TimelineService,
  ) {}

  // ── Rules ─────────────────────────────────────────────────────────────────

  /** The fields a rule may match on, so a rule builder does not hardcode them. */
  matchableFields() {
    return {
      items: MATCHABLE_FIELDS.map((field) => ({
        field: field.field,
        label: field.label,
        comparison: field.comparison,
        // What the UI needs to explain why a field cannot stand alone.
        sufficientAlone: field.sufficientAlone,
        strength: field.weight,
        // So the rule builder can say "this also matches the WhatsApp column" rather than leaving
        // someone to discover it from a match they did not expect.
        alsoMatches: field.aliasFields ?? [],
      })),
      pagination: fullPage(MATCHABLE_FIELDS.length),
    };
  }

  async listRules(includeInactive = false) {
    const rules = await this.db.client.duplicateRule.findMany({
      where: { deletedAt: null, ...(includeInactive ? {} : { isActive: true }) },
      orderBy: [{ priority: 'asc' }, { name: 'asc' }],
      include: { _count: { select: { detections: true } } },
    });
    const items = rules.map((rule) => ({
      id: rule.id,
      name: rule.name,
      matchOn: rule.matchOn,
      lookbackDays: rule.lookbackDays,
      action: rule.action,
      priority: rule.priority,
      isActive: rule.isActive,
      detectionCount: rule._count.detections,
    }));
    return { items, pagination: fullPage(items.length) };
  }

  async createRule(input: CreateDuplicateRuleInput) {
    const organizationId = tenantContext.organizationId('duplicates.createRule');
    this.assertMatchOnUsable(input.matchOn);

    const id = newId();
    await this.db.client.duplicateRule.create({
      data: {
        id,
        organizationId,
        name: input.name,
        matchOn: input.matchOn as never,
        lookbackDays: input.lookbackDays ?? 365,
        action: input.action ?? 'attach_to_existing',
        priority: input.priority ?? 0,
      },
    });
    await this.audit.record({
      action: 'duplicate_rule.created',
      resourceType: 'duplicate_rule',
      resourceId: id,
      after: {
        name: input.name,
        matchOn: input.matchOn,
        action: input.action ?? 'attach_to_existing',
      },
    });
    return { id, name: input.name };
  }

  async updateRule(id: string, input: UpdateDuplicateRuleInput) {
    const rule = await this.db.client.duplicateRule.findFirst({ where: { id, deletedAt: null } });
    if (!rule) throw AppError.notFound('Duplicate rule');
    if (input.matchOn) this.assertMatchOnUsable(input.matchOn);

    await this.db.client.duplicateRule.update({
      where: { id },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.matchOn !== undefined ? { matchOn: input.matchOn as never } : {}),
        ...(input.lookbackDays !== undefined ? { lookbackDays: input.lookbackDays } : {}),
        ...(input.action !== undefined ? { action: input.action } : {}),
        ...(input.priority !== undefined ? { priority: input.priority } : {}),
        ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
      },
    });
    await this.audit.record({
      action: 'duplicate_rule.updated',
      resourceType: 'duplicate_rule',
      resourceId: id,
      before: { matchOn: rule.matchOn, action: rule.action, isActive: rule.isActive },
      after: input as Record<string, unknown>,
    });
    return { id };
  }

  /**
   * Soft-deletes a rule. The detections it produced stay, with their `ruleId` intact — a manager
   * looking at an old pair still needs to know what flagged it, and the composite FK is `Restrict`
   * precisely so that history cannot be orphaned.
   */
  async deleteRule(id: string) {
    const rule = await this.db.client.duplicateRule.findFirst({ where: { id, deletedAt: null } });
    if (!rule) throw AppError.notFound('Duplicate rule');
    await this.db.client.duplicateRule.update({
      where: { id },
      data: { deletedAt: new Date(), isActive: false },
    });
    await this.audit.record({
      action: 'duplicate_rule.deleted',
      resourceType: 'duplicate_rule',
      resourceId: id,
      before: { name: rule.name },
    });
    return { id, deleted: true, detectionsRetained: true };
  }

  /**
   * Runs the live rules against a hypothetical capture, without creating anything.
   *
   * The same code path the write uses, so what this reports is what would happen — a tester that
   * reimplemented the matching would eventually disagree with reality, which is worse than no tester.
   */
  async testRules(input: TestDuplicateInput) {
    const organizationId = tenantContext.organizationId('duplicates.test');
    const organization = await this.db.client.organization.findUniqueOrThrow({
      where: { id: organizationId },
      select: { defaultPhoneCountry: true },
    });

    const toE164 = (value: string | undefined): string | null => {
      if (!value) return null;
      try {
        return normalizePhone(value, organization.defaultPhoneCountry as CountryCode).e164;
      } catch (error) {
        const reason = error instanceof PhoneNormalizationError ? error.reason : 'invalid';
        throw AppError.validation('Some details need correcting', [
          { field: 'phone', code: 'INVALID_PHONE', message: `Not a phone number (${reason}).` },
        ]);
      }
    };

    const subject = {
      phoneE164: toE164(input.phone),
      whatsappE164: toE164(input.whatsapp),
      email: input.email ?? null,
      firstName: input.firstName ?? null,
      lastName: input.lastName ?? null,
      fullName: [input.firstName, input.lastName].filter(Boolean).join(' ') || null,
      company: input.company ?? null,
      city: input.city ?? null,
      postalCode: input.postalCode ?? null,
    };

    const matches = await this.detection.detect(subject);
    const decision = matches[0];
    return {
      subject,
      wouldMatch: matches.length > 0,
      // The action the write path would take, stated in the terms the rule uses.
      action: decision?.action ?? 'create_new',
      decidedByRule: decision ? { id: decision.ruleId, name: decision.ruleName } : null,
      matches: matches.map((match) => ({
        leadId: match.leadId,
        fullName: match.fullName,
        phone: match.phoneE164,
        email: match.email,
        createdAt: match.createdAt,
        matchedFields: match.matchedFields,
        confidence: match.confidence,
      })),
      explanation: decision
        ? `“${decision.ruleName}” matched on ${decision.matchedFields.join(' + ')} against ${matches.length} existing lead${matches.length === 1 ? '' : 's'}; the capture would ${describeAction(decision.action)}.`
        : 'No active rule matched, so this would be created as a new lead.',
    };
  }

  // ── The triage queue ──────────────────────────────────────────────────────

  async listDuplicates(query: ListDuplicatesQuery) {
    const where: Record<string, unknown> = {
      ...(query.status ? { status: query.status } : { status: 'open' }),
      ...(query.minConfidence !== undefined ? { confidence: { gte: query.minConfidence } } : {}),
      ...(query.leadId
        ? { OR: [{ leadId: query.leadId }, { duplicateLeadId: query.leadId }] }
        : {}),
    };

    const [total, rows] = await Promise.all([
      this.db.client.leadDuplicate.count({ where }),
      this.db.client.leadDuplicate.findMany({
        where,
        orderBy: [{ confidence: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
        take: query.limit + 1,
        ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
        include: {
          lead: {
            select: {
              id: true,
              fullName: true,
              phoneE164: true,
              email: true,
              createdAt: true,
              assignedUserId: true,
            },
          },
          duplicateLead: {
            select: {
              id: true,
              fullName: true,
              phoneE164: true,
              email: true,
              createdAt: true,
              assignedUserId: true,
            },
          },
          rule: { select: { id: true, name: true } },
        },
      }),
    ]);

    const page = rows.slice(0, query.limit);
    const hasMore = rows.length > query.limit;
    return {
      items: page.map((row) => ({
        id: row.id,
        status: row.status,
        confidence: row.confidence,
        matchedFields: (row.matchFields as { fields?: string[] } | null)?.fields ?? [],
        rule: row.rule,
        existing: row.lead,
        candidate: row.duplicateLead,
        createdAt: row.createdAt,
        resolvedAt: row.resolvedAt,
      })),
      pagination: {
        limit: query.limit,
        nextCursor: hasMore ? (page[page.length - 1]?.id ?? null) : null,
        hasMore,
        total,
      },
    };
  }

  /**
   * "These are different people."
   *
   * Recorded rather than deleted, so re-detection does not reopen a decision somebody has already
   * made — and so a manager can see that a rule keeps producing dismissals, which is the signal that
   * the rule is wrong.
   */
  async dismiss(id: string) {
    const pair = await this.db.client.leadDuplicate.findFirst({ where: { id } });
    if (!pair) throw AppError.notFound('Duplicate');
    if (pair.status !== 'open') {
      throw AppError.conflict(`That pair is already ${pair.status}`);
    }

    const lead = await this.db.client.lead.findFirst({ where: { id: pair.leadId } });
    if (!lead) throw AppError.notFound('Lead');
    const allowed = this.scopes.canAct(PERMISSIONS.LEAD_MERGE, {
      userId: lead.assignedUserId,
      teamId: lead.teamId,
      branchId: lead.branchId,
    });
    if (!allowed) throw AppError.notFound('Duplicate');

    const now = new Date();
    await this.db.client.$transaction(async (tx) => {
      await tx.leadDuplicate.update({
        where: { id },
        data: {
          status: 'dismissed',
          resolvedById: tenantContext.get()?.actorId ?? null,
          resolvedAt: now,
        },
      });
      // Both leads get the entry: either one could be the record somebody opens later asking
      // "did anyone look at this?"
      await this.timeline.recordManyInTransaction(tx, [
        {
          type: ACTIVITY_TYPES.LEAD_DUPLICATE_DETECTED,
          leadId: pair.leadId,
          occurredAt: now,
          payload: { duplicateId: id, otherLeadId: pair.duplicateLeadId, decision: 'dismissed' },
        },
        {
          type: ACTIVITY_TYPES.LEAD_DUPLICATE_DETECTED,
          leadId: pair.duplicateLeadId,
          occurredAt: now,
          payload: { duplicateId: id, otherLeadId: pair.leadId, decision: 'dismissed' },
        },
      ]);
      await this.audit.recordInTransaction(tx, {
        action: 'lead_duplicate.dismissed',
        resourceType: 'lead_duplicate',
        resourceId: id,
        after: { leadId: pair.leadId, duplicateLeadId: pair.duplicateLeadId },
      });
    });

    // The link on the newer lead goes too: it is no longer a suspected duplicate of anything.
    await this.db.client.lead.updateMany({
      where: { id: pair.duplicateLeadId, isDuplicateOfId: pair.leadId },
      data: { isDuplicateOfId: null },
    });

    return { id, status: 'dismissed' };
  }

  private assertMatchOnUsable(matchOn: readonly (readonly string[])[]): void {
    const problems = validateMatchOn(matchOn);
    if (problems.length === 0) return;
    throw AppError.validation('Some details need correcting', [
      ...problems.map((problem) => ({
        field: problem.setIndex >= 0 ? `matchOn.${problem.setIndex}` : 'matchOn',
        code: problem.code,
        message: problem.message,
      })),
    ]);
  }
}

function describeAction(action: string): string {
  switch (action) {
    case 'attach_to_existing':
      return 'be attached to the existing lead as another touchpoint';
    case 'create_and_link':
      return 'be created and linked for review';
    case 'reject':
      return 'be refused';
    default:
      return 'be created as a new lead';
  }
}
