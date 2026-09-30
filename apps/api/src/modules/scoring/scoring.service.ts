import { Injectable } from '@nestjs/common';
import {
  AppError,
  SCORING_TRIGGERS,
  evaluateScoringRules,
  newId,
  scoringTrigger,
  tenantContext,
  validateBands,
  validateDecay,
  type RuleCondition,
  type ScoreBandSpec,
} from '@leados/shared';
import { DbService } from '../../infra/db/db.service.js';
import { AuditService } from '../../infra/audit/audit.service.js';
import { fullPage } from '../organizations/organizations.service.js';
import { ScoringEngineService } from './scoring-engine.service.js';
import type {
  CreateScoringRuleInput,
  ListScoringRulesQuery,
  SetBandsInput,
  TestScoringInput,
  UpdateScoringRuleInput,
} from './scoring.dto.js';

/**
 * Scoring configuration: the rules, the bands, and the tester that explains both.
 *
 * The refusals in here are the substance. A scoring engine is easy to configure wrongly in ways
 * nothing complains about — a rule on an event nothing emits, a band set with a hole in it, a decay
 * rule with no decay — and every one of those failures is silent: the number simply stops meaning
 * what the business thinks it means. So each is refused at configuration time, where somebody is
 * looking at a form and can still see why.
 */
@Injectable()
export class ScoringService {
  constructor(
    private readonly db: DbService,
    private readonly engine: ScoringEngineService,
    private readonly audit: AuditService,
  ) {}

  /** The triggers a rule may use, including the ones that are not live yet, marked as such. */
  triggers() {
    const items = SCORING_TRIGGERS.map((spec) => ({
      event: spec.event,
      label: spec.label,
      live: spec.live,
      describe: spec.describe,
      arrivesIn: spec.arrivesIn ?? null,
    }));
    return { items, pagination: fullPage(items.length) };
  }

  async listRules(query: ListScoringRulesQuery) {
    const rules = await this.db.client.scoringRule.findMany({
      where: {
        deletedAt: null,
        ...(query.includeInactive ? {} : { isActive: true }),
        ...(query.triggerEvent ? { triggerEvent: query.triggerEvent } : {}),
      },
      orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }],
    });

    const items = rules.map((rule) => {
      const trigger = scoringTrigger(rule.triggerEvent);
      return {
        id: rule.id,
        name: rule.name,
        triggerEvent: rule.triggerEvent,
        triggerLabel: trigger?.label ?? rule.triggerEvent,
        conditions: rule.conditions,
        points: rule.points,
        maxApplications: rule.maxApplications,
        decay: rule.decay,
        priority: rule.priority,
        isActive: rule.isActive,
        /** A rule stored before its trigger went live would never fire; say so rather than imply it works. */
        dormant: trigger !== undefined && !trigger.live,
      };
    });
    return { items, pagination: fullPage(items.length) };
  }

  async createRule(input: CreateScoringRuleInput) {
    this.assertTriggerUsable(input.triggerEvent);
    this.assertRuleCoherent(input.triggerEvent, input.decay, input.points ?? 0);

    const id = newId();
    const organizationId = tenantContext.organizationId('scoring.createRule');
    await this.db.client.scoringRule.create({
      data: {
        id,
        organizationId,
        name: input.name,
        triggerEvent: input.triggerEvent,
        conditions: (input.conditions ?? []) as never,
        points: input.points ?? 0,
        maxApplications: input.maxApplications ?? null,
        ...(input.decay ? { decay: input.decay as never } : {}),
        priority: input.priority ?? 0,
      },
    });
    await this.audit.record({
      action: 'scoring_rule.created',
      resourceType: 'scoring_rule',
      resourceId: id,
      after: input as Record<string, unknown>,
    });
    return { id };
  }

  async updateRule(id: string, input: UpdateScoringRuleInput) {
    const rule = await this.db.client.scoringRule.findFirst({ where: { id, deletedAt: null } });
    if (!rule) throw AppError.notFound('Scoring rule');

    const triggerEvent = input.triggerEvent ?? rule.triggerEvent;
    if (input.triggerEvent !== undefined) this.assertTriggerUsable(input.triggerEvent);
    const decay =
      input.decay === undefined ? (rule.decay as Record<string, number> | null) : input.decay;
    this.assertRuleCoherent(triggerEvent, decay ?? undefined, input.points ?? rule.points);

    await this.db.client.scoringRule.update({
      where: { id },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.triggerEvent !== undefined ? { triggerEvent: input.triggerEvent } : {}),
        ...(input.conditions !== undefined ? { conditions: input.conditions as never } : {}),
        ...(input.points !== undefined ? { points: input.points } : {}),
        ...(input.maxApplications !== undefined ? { maxApplications: input.maxApplications } : {}),
        ...(input.decay !== undefined ? { decay: (input.decay ?? null) as never } : {}),
        ...(input.priority !== undefined ? { priority: input.priority } : {}),
        ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
      },
    });
    await this.audit.record({
      action: 'scoring_rule.updated',
      resourceType: 'scoring_rule',
      resourceId: id,
      before: { name: rule.name, points: rule.points, isActive: rule.isActive },
      after: input as Record<string, unknown>,
    });
    return { id };
  }

  /**
   * Soft-deletes a rule.
   *
   * Its score events stay, and so does their `reason` text — which is why the reason is stored as a
   * sentence rather than assembled from the rule at read time. A breakdown that lost its labels
   * when a rule was deleted would be a breakdown nobody could audit.
   */
  async deleteRule(id: string) {
    const rule = await this.db.client.scoringRule.findFirst({ where: { id, deletedAt: null } });
    if (!rule) throw AppError.notFound('Scoring rule');
    const applied = await this.db.client.leadScoreEvent.count({ where: { ruleId: id } });

    await this.db.client.scoringRule.update({
      where: { id },
      data: { deletedAt: new Date(), isActive: false },
    });
    await this.audit.record({
      action: 'scoring_rule.deleted',
      resourceType: 'scoring_rule',
      resourceId: id,
      before: { name: rule.name, appliedTimes: applied },
    });
    return {
      id,
      appliedTimes: applied,
      note:
        applied > 0
          ? 'Points this rule already awarded stay on their leads. Recalculate a lead to review its score.'
          : undefined,
    };
  }

  async listBands() {
    const bands = await this.db.client.scoreBand.findMany({ orderBy: { minScore: 'asc' } });
    const items = bands.map((band) => ({
      id: band.id,
      name: band.name,
      minScore: band.minScore,
      maxScore: band.maxScore,
      colour: band.colour,
    }));
    return { items, pagination: fullPage(items.length) };
  }

  /**
   * Replaces the whole band set (`FR-SCR-3`).
   *
   * A complete set rather than one band at a time because the validity condition is a property of
   * the set — a partition of 0–1000 with no gap and no overlap — and no sequence of single-band
   * edits can move between two valid sets without passing through an invalid one.
   *
   * Every lead's band is recalculated in the same transaction. Leaving that to a background job
   * would mean a business renames "Hot" to "Priority" and their Hot Leads view is empty until the
   * job runs, which reads as data loss.
   */
  async setBands(input: SetBandsInput) {
    const problems = validateBands(input.bands as readonly ScoreBandSpec[]);
    if (problems.length > 0) {
      throw AppError.validation(
        'The bands do not cover the score range',
        problems.map((problem) => ({
          field: problem.index >= 0 ? `bands.${problem.index}` : 'bands',
          code: problem.code,
          message: problem.message,
        })),
      );
    }

    const organizationId = tenantContext.organizationId('scoring.setBands');
    const rebanded = await this.db.client.$transaction(async (tx) => {
      await tx.scoreBand.deleteMany({});
      for (const band of input.bands) {
        await tx.scoreBand.create({
          data: {
            id: newId(),
            organizationId,
            name: band.name,
            minScore: band.minScore,
            maxScore: band.maxScore,
            colour: band.colour ?? null,
          },
        });
      }
      // One UPDATE per band rather than one per lead: a tenant with 100k leads must not pay a round
      // trip each. Raw SQL because Prisma has no "set this column from a range join".
      let touched = 0;
      for (const band of input.bands) {
        const result = await tx.$executeRaw`
          UPDATE leads
             SET score_band = ${band.name}
           WHERE organization_id = ${organizationId}::uuid
             AND score BETWEEN ${band.minScore} AND ${band.maxScore}
             AND (score_band IS DISTINCT FROM ${band.name})
        `;
        touched += result;
      }
      return touched;
    });

    await this.audit.record({
      action: 'score_bands.replaced',
      resourceType: 'score_band',
      after: { bands: input.bands, leadsReassigned: rebanded },
    });
    return { bands: input.bands.length, leadsReassigned: rebanded };
  }

  /**
   * "What would this lead score?" (`FR-SCR-2`).
   *
   * Runs the real evaluator over the real rules and writes nothing. Without a `triggerEvent` it
   * reports every live trigger, which answers the question a business actually has — *how* would
   * this lead get its points, not just the total.
   */
  async test(input: TestScoringInput) {
    const subjectLead = await this.subjectFrom(input);
    const triggers = input.triggerEvent
      ? [input.triggerEvent]
      : SCORING_TRIGGERS.filter((spec) => spec.live && spec.event !== 'schedule.decay').map(
          (spec) => spec.event,
        );

    const appliedCounts = subjectLead.leadId
      ? await this.engine.appliedCounts(
          subjectLead.leadId,
          (await this.db.client.scoringRule.findMany({ select: { id: true } })).map((r) => r.id),
        )
      : {};

    const perTrigger = [];
    let wouldGain = 0;
    for (const trigger of triggers) {
      const rules = await this.engine.rulesFor(trigger);
      if (rules.length === 0) continue;
      const verdicts = evaluateScoringRules({
        rules,
        subject: {
          lead: subjectLead.lead,
          custom: subjectLead.custom,
          event: input.eventPayload ?? {},
        },
        appliedCounts,
      });
      const gained = verdicts
        .filter((verdict) => verdict.applies)
        .reduce((total, verdict) => total + verdict.delta, 0);
      wouldGain += gained;
      perTrigger.push({
        triggerEvent: trigger,
        triggerLabel: scoringTrigger(trigger)?.label ?? trigger,
        wouldGain: gained,
        rules: verdicts,
      });
    }

    const bands = await this.engine.bands();
    const currentScore = subjectLead.currentScore;
    const projected = Math.max(0, Math.min(1000, currentScore + wouldGain));
    return {
      leadId: subjectLead.leadId,
      currentScore,
      currentBand: bandName(currentScore, bands),
      wouldGain,
      projectedScore: projected,
      projectedBand: bandName(projected, bands),
      triggers: perTrigger,
      explanation:
        perTrigger.length === 0
          ? 'No scoring rules are configured, so every lead stays at its current score.'
          : `Across ${perTrigger.length} trigger(s), this lead would gain ${wouldGain} point(s).`,
    };
  }

  private async subjectFrom(input: TestScoringInput) {
    if (input.leadId) {
      const lead = await this.db.client.lead.findFirst({
        where: { id: input.leadId, deletedAt: null },
      });
      if (!lead) throw AppError.notFound('Lead');
      return {
        leadId: lead.id,
        lead: lead as unknown as Record<string, unknown>,
        custom: (lead.customValues as Record<string, unknown>) ?? {},
        currentScore: lead.score,
      };
    }
    return {
      leadId: null,
      lead: input.lead ?? {},
      custom: input.customValues ?? {},
      currentScore: 0,
    };
  }

  /**
   * Refuses a trigger nothing emits, naming the phase it arrives in.
   *
   * The alternative — storing the rule and letting it sit inert — is the failure this whole
   * registry exists to prevent: a business believing their scoring covers WhatsApp engagement when
   * no WhatsApp event exists yet.
   */
  private assertTriggerUsable(event: string): void {
    const trigger = scoringTrigger(event);
    if (!trigger) {
      throw AppError.validation('Some details need correcting', [
        {
          field: 'triggerEvent',
          code: 'UNKNOWN_TRIGGER',
          message: `“${event}” is not a scoring trigger. Available: ${SCORING_TRIGGERS.filter(
            (spec) => spec.live,
          )
            .map((spec) => spec.event)
            .join(', ')}.`,
        },
      ]);
    }
    if (!trigger.live) {
      throw AppError.validation('Some details need correcting', [
        {
          field: 'triggerEvent',
          code: 'TRIGGER_NOT_LIVE',
          message: `Nothing emits “${event}” yet — it arrives in ${trigger.arrivesIn}. A rule on it would never score anything, so it is refused rather than stored.`,
        },
      ]);
    }
  }

  /** A rule is additive or decaying. The database enforces this too; the message comes from here. */
  private assertRuleCoherent(
    triggerEvent: string,
    decay: Record<string, number> | undefined,
    points: number,
  ): void {
    const isDecayTrigger = triggerEvent === 'schedule.decay';
    if (isDecayTrigger && !decay) {
      throw AppError.validation('Some details need correcting', [
        {
          field: 'decay',
          code: 'REQUIRED',
          message: 'A rule on the nightly sweep needs a decay setting, or it would do nothing.',
        },
      ]);
    }
    if (!isDecayTrigger && decay) {
      throw AppError.validation('Some details need correcting', [
        {
          field: 'decay',
          code: 'UNEXPECTED',
          message:
            'Only a rule on the nightly sweep can decay. An event-triggered rule adds or removes points once.',
        },
      ]);
    }
    if (decay) {
      const problems = validateDecay(decay);
      if (problems.length > 0) {
        throw AppError.validation(
          'Some details need correcting',
          problems.map((problem) => ({
            field: problem.field,
            code: 'INVALID',
            message: problem.message,
          })),
        );
      }
      return;
    }
    if (points === 0) {
      throw AppError.validation('Some details need correcting', [
        {
          field: 'points',
          code: 'REQUIRED',
          message:
            'A rule worth zero points would never change a score. Give it points, or delete it.',
        },
      ]);
    }
  }
}

function bandName(score: number, bands: readonly ScoreBandSpec[]): string | null {
  return bands.find((band) => score >= band.minScore && score <= band.maxScore)?.name ?? null;
}

/** Conditions are stored as JSON; this names the shape the evaluator expects. */
export type StoredConditions = readonly RuleCondition[];
