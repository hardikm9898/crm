import { Injectable } from '@nestjs/common';
import {
  evaluateConditions,
  nextInRoundRobin,
  newId,
  strategySpec,
  tenantContext,
  zonedParts,
  type AssignmentSubject,
  type RuleCondition,
  type RuleEvaluation,
} from '@leados/shared';
import { DbService } from '../../infra/db/db.service.js';
import type { TransactionClient } from '../../infra/outbox/outbox.service.js';
import { EligibilityService, type MemberEligibility } from './eligibility.service.js';

/**
 * Deciding who a lead goes to (`FR-ASG-1`–`FR-ASG-4`).
 *
 * The engine answers one question — "who should have this lead" — and it answers it with its
 * working shown. That is not a nicety: the most common complaint about an assignment engine is
 * "why did this lead go to the wrong person", and an engine that cannot say is one nobody trusts
 * enough to leave switched on.
 *
 * So `decide()` returns a **decision** rather than a user id: the rule that matched, the members it
 * considered, why each ineligible one was skipped, and whether it fell back. `assignOnCreate()`
 * applies that decision inside the caller's transaction; the rule tester renders it without
 * applying anything. One code path, two consumers.
 *
 * **Round-robin fairness is durable.** The cursor lives in `round_robin_state`, updated inside the
 * assigning transaction, so the row lock serialises two simultaneous captures — they cannot both take
 * the same turn. A Redis counter would be faster and would drift the first time the cache was
 * flushed; fairness that resets on a deploy is not fairness.
 */

export interface RuleVerdict {
  readonly ruleId: string;
  readonly ruleName: string;
  readonly priority: number;
  readonly matched: boolean;
  readonly explanation: string;
}

export interface CandidateReport {
  readonly userId: string;
  readonly eligible: boolean;
  readonly reason?: string;
  readonly openLeads: number;
  readonly recentConversions: number;
  /** True for the one that was chosen. */
  readonly chosen: boolean;
}

export interface AssignmentDecision {
  readonly assignedUserId: string | null;
  readonly teamId: string | null;
  /** The rule that decided, or null when no rule matched at all. */
  readonly rule: { id: string; name: string; strategy: string } | null;
  /** True when the rule matched but nobody was eligible, so its fallback applied. */
  readonly usedFallback: boolean;
  /** Whether a manager should be told. Always true when a lead ends up unassigned by fallback. */
  readonly notifyManagers: boolean;
  readonly candidates: readonly CandidateReport[];
  /** Per-rule verdicts, in priority order — the tester's main output. */
  readonly ruleEvaluations: readonly RuleVerdict[];
  /** One sentence a person can read. */
  readonly explanation: string;
  /** Recorded on `lead_assignments.reason`. */
  readonly reason: string;
  /** Set by `decide` for the pool strategies, and applied by the caller in the same transaction. */
  readonly roundRobinAdvance: {
    ruleId: string;
    cursorIndex: number;
    weightConsumed: number;
  } | null;
}

@Injectable()
export class AssignmentEngineService {
  constructor(
    private readonly db: DbService,
    private readonly eligibility: EligibilityService,
  ) {}

  /**
   * Evaluates the rules and picks someone, without writing anything.
   *
   * `at` is a parameter rather than `now()` so the tester can ask what would happen at 9pm on a
   * Sunday — which is exactly when leads go unanswered, and therefore exactly what a business wants
   * to check before trusting the engine.
   */
  async decide(input: {
    lead: Readonly<Record<string, unknown>>;
    customValues?: Readonly<Record<string, unknown>>;
    at?: Date;
  }): Promise<AssignmentDecision> {
    const organizationId = tenantContext.organizationId('assignment.decide');
    const at = input.at ?? new Date();

    const organization = await this.db.client.organization.findUniqueOrThrow({
      where: { id: organizationId },
      select: { timezone: true },
    });
    const parts = zonedParts(at, organization.timezone);
    const subject: AssignmentSubject = {
      lead: input.lead,
      custom: input.customValues ?? {},
      hour: parts.hour,
      dayOfWeek: new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay(),
    };

    const rules = await this.db.client.assignmentRule.findMany({
      where: { isActive: true, deletedAt: null },
      orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }],
      include: {
        conditions: { orderBy: { groupIndex: 'asc' } },
        poolMembers: { where: { isActive: true }, orderBy: { createdAt: 'asc' } },
        roundRobinState: true,
      },
    });

    const ruleEvaluations: RuleVerdict[] = [];
    for (const rule of rules) {
      const conditions: RuleCondition[] = rule.conditions.map((condition) => ({
        fieldPath: condition.fieldPath,
        operator: condition.operator,
        value: condition.value,
        groupIndex: condition.groupIndex,
      }));
      const evaluation: RuleEvaluation = evaluateConditions(conditions, subject);
      ruleEvaluations.push({
        ruleId: rule.id,
        ruleName: rule.name,
        priority: rule.priority,
        matched: evaluation.matched,
        explanation: evaluation.explanation,
      });
      if (!evaluation.matched) continue;

      // The first matching rule decides. A business that ordered its rules meant the order.
      const outcome = await this.applyStrategy(rule, at);
      return {
        ...outcome,
        rule: { id: rule.id, name: rule.name, strategy: rule.strategy },
        ruleEvaluations,
      };
    }

    // No rule matched. Not an error: an organization with no rules, or rules that all exclude this
    // lead, wants it in the pool where somebody will see it.
    return {
      assignedUserId: null,
      teamId: null,
      rule: null,
      usedFallback: false,
      notifyManagers: rules.length > 0,
      candidates: [],
      ruleEvaluations,
      explanation:
        rules.length === 0
          ? 'No assignment rules are configured, so the lead is left in the unassigned pool.'
          : 'No rule matched this lead, so it is left in the unassigned pool.',
      reason: rules.length === 0 ? 'no assignment rules' : 'no matching rule',
      roundRobinAdvance: null,
    };
  }

  private async applyStrategy(
    rule: {
      id: string;
      name: string;
      strategy: string;
      target: unknown;
      respectWorkingHours: boolean;
      capacityCap: number | null;
      fallback: unknown;
      poolMembers: { userId: string; weight: number }[];
      roundRobinState: { cursorIndex: number; weightConsumed: number } | null;
    },
    at: Date,
  ): Promise<Omit<AssignmentDecision, 'rule' | 'ruleEvaluations'>> {
    const target = (rule.target ?? {}) as { userId?: string; teamId?: string };
    const spec = strategySpec(rule.strategy);

    // Which people the strategy is choosing between.
    let userIds: string[] = [];
    let teamId: string | null = null;
    if (rule.strategy === 'specific_user') {
      userIds = target.userId ? [target.userId] : [];
    } else if (rule.strategy === 'team') {
      teamId = target.teamId ?? null;
      if (teamId) {
        const members = await this.db.client.teamMember.findMany({
          where: { teamId },
          select: { userId: true },
        });
        userIds = members.map((member) => member.userId);
      }
    } else {
      userIds = rule.poolMembers.map((member) => member.userId);
    }

    if (userIds.length === 0) {
      return this.fallbackFor(rule, at, [], `“${rule.name}” has nobody to assign to`);
    }

    const assessed = await this.eligibility.assess({
      userIds,
      at,
      respectWorkingHours: rule.respectWorkingHours,
      capacityCap: rule.capacityCap,
    });
    const eligible = assessed.filter((member) => member.eligible);

    if (eligible.length === 0) {
      return this.fallbackFor(
        rule,
        at,
        assessed,
        `Nobody on “${rule.name}” was available: ${summariseReasons(assessed)}`,
      );
    }

    const picked = this.pick(rule, eligible);
    if (!picked) {
      return this.fallbackFor(rule, at, assessed, `“${rule.name}” could not pick anyone`);
    }

    return {
      assignedUserId: picked.userId,
      teamId,
      usedFallback: false,
      notifyManagers: false,
      candidates: report(assessed, picked.userId),
      explanation: `${spec?.label ?? rule.strategy} under “${rule.name}” chose them${picked.because ? ` — ${picked.because}` : ''}.`,
      reason: `${rule.name} (${rule.strategy})`,
      roundRobinAdvance: picked.advance ? { ruleId: rule.id, ...picked.advance } : null,
    };
  }

  private pick(
    rule: {
      strategy: string;
      poolMembers: { userId: string; weight: number }[];
      roundRobinState: { cursorIndex: number; weightConsumed: number } | null;
    },
    eligible: readonly MemberEligibility[],
  ): {
    userId: string;
    because?: string;
    advance?: { cursorIndex: number; weightConsumed: number };
  } | null {
    switch (rule.strategy) {
      case 'specific_user':
        return eligible[0] ? { userId: eligible[0].userId } : null;

      case 'team':
      case 'least_open_leads': {
        // Ties broken by user id so the choice is deterministic and therefore explainable.
        const sorted = [...eligible].sort(
          (left, right) =>
            left.openLeads - right.openLeads || left.userId.localeCompare(right.userId),
        );
        const chosen = sorted[0];
        return chosen
          ? {
              userId: chosen.userId,
              because: `they hold the fewest open leads (${chosen.openLeads})`,
            }
          : null;
      }

      case 'top_performer': {
        const sorted = [...eligible].sort(
          (left, right) =>
            right.recentConversions - left.recentConversions ||
            left.openLeads - right.openLeads ||
            left.userId.localeCompare(right.userId),
        );
        const chosen = sorted[0];
        return chosen
          ? {
              userId: chosen.userId,
              because: `they converted the most in the last 90 days (${chosen.recentConversions})`,
            }
          : null;
      }

      case 'round_robin':
      case 'weighted_round_robin': {
        // The rotation runs over the pool **as configured**, not over the eligible subset: skipping
        // an absent member must not cost them their turn when they come back. So the cursor advances
        // through the full pool, and the first eligible member from that point takes the lead.
        const pool = rule.poolMembers.map((member) => ({
          userId: member.userId,
          weight: member.weight,
        }));
        const eligibleIds = new Set(eligible.map((member) => member.userId));
        let state = rule.roundRobinState ?? { cursorIndex: 0, weightConsumed: 0 };

        for (let attempt = 0; attempt < pool.length; attempt += 1) {
          const turn = nextInRoundRobin(pool, state, rule.strategy === 'weighted_round_robin');
          if (!turn) return null;
          if (eligibleIds.has(turn.userId)) {
            return {
              userId: turn.userId,
              because:
                attempt === 0
                  ? 'it was their turn'
                  : `it was their turn after ${attempt} unavailable`,
              advance: {
                cursorIndex: turn.nextCursorIndex,
                weightConsumed: turn.nextWeightConsumed,
              },
            };
          }
          // Skipped: move on, and do not let a partially-consumed weight stall the rotation.
          state = { cursorIndex: turn.nextCursorIndex, weightConsumed: 0 };
        }
        return null;
      }

      default:
        return null;
    }
  }

  private async fallbackFor(
    rule: { id: string; name: string; fallback: unknown },
    at: Date,
    assessed: readonly MemberEligibility[],
    why: string,
  ): Promise<Omit<AssignmentDecision, 'rule' | 'ruleEvaluations'>> {
    const fallback = (rule.fallback ?? {}) as {
      mode?: string;
      userId?: string;
      teamId?: string;
      notify?: boolean;
    };
    // Notification defaults to on. A lead that quietly went nowhere is the failure `FR-ASG-4`
    // exists to prevent.
    const notify = fallback.notify !== false;

    if (fallback.mode === 'specific_user' && fallback.userId) {
      const [member] = await this.eligibility.assess({
        userIds: [fallback.userId],
        at,
        // A fallback that respected working hours could fall back to nobody, which defeats the point.
        respectWorkingHours: false,
        capacityCap: null,
      });
      if (member) {
        return {
          assignedUserId: member.userId,
          teamId: null,
          usedFallback: true,
          notifyManagers: notify,
          candidates: report(assessed, null),
          explanation: `${why}. Fell back to the named person.`,
          reason: `${rule.name} fallback (named person)`,
          roundRobinAdvance: null,
        };
      }
    }

    if (fallback.mode === 'team' && fallback.teamId) {
      const members = await this.db.client.teamMember.findMany({
        where: { teamId: fallback.teamId },
        select: { userId: true },
      });
      const assessedFallback = await this.eligibility.assess({
        userIds: members.map((member) => member.userId),
        at,
        respectWorkingHours: false,
        capacityCap: null,
      });
      const chosen = [...assessedFallback]
        .filter((member) => member.eligible)
        .sort(
          (left, right) =>
            left.openLeads - right.openLeads || left.userId.localeCompare(right.userId),
        )[0];
      if (chosen) {
        return {
          assignedUserId: chosen.userId,
          teamId: fallback.teamId,
          usedFallback: true,
          notifyManagers: notify,
          candidates: report(assessed, null),
          explanation: `${why}. Fell back to the named team.`,
          reason: `${rule.name} fallback (team)`,
          roundRobinAdvance: null,
        };
      }
    }

    return {
      assignedUserId: null,
      teamId: null,
      usedFallback: true,
      // Always notify when a lead ends up unassigned: this is the case that loses business.
      notifyManagers: true,
      candidates: report(assessed, null),
      explanation: `${why}. Left in the unassigned pool.`,
      reason: `${rule.name} fallback (unassigned pool)`,
      roundRobinAdvance: null,
    };
  }

  /**
   * Persists the round-robin cursor. Called inside the assigning transaction, which is what makes
   * two simultaneous captures take different turns rather than the same one.
   */
  async commitRoundRobin(
    tx: TransactionClient,
    advance: { ruleId: string; cursorIndex: number; weightConsumed: number },
  ): Promise<void> {
    const organizationId = tenantContext.organizationId('assignment.commitRoundRobin');
    await tx.roundRobinState.upsert({
      where: { organizationId_ruleId: { organizationId, ruleId: advance.ruleId } },
      create: {
        id: newId(),
        organizationId,
        ruleId: advance.ruleId,
        cursorIndex: advance.cursorIndex,
        weightConsumed: advance.weightConsumed,
      },
      update: { cursorIndex: advance.cursorIndex, weightConsumed: advance.weightConsumed },
    });
  }
}

function report(
  assessed: readonly MemberEligibility[],
  chosenUserId: string | null,
): readonly CandidateReport[] {
  return assessed.map((member) => ({
    userId: member.userId,
    eligible: member.eligible,
    ...(member.reason ? { reason: member.reason } : {}),
    openLeads: member.openLeads,
    recentConversions: member.recentConversions,
    chosen: member.userId === chosenUserId,
  }));
}

/** The distinct reasons, so "nobody was available" becomes "all three were outside working hours". */
function summariseReasons(assessed: readonly MemberEligibility[]): string {
  const counts = new Map<string, number>();
  for (const member of assessed) {
    const reason = member.reason ?? 'not eligible';
    counts.set(reason, (counts.get(reason) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([reason, count]) => (count > 1 ? `${count} × ${reason}` : reason))
    .join('; ');
}
