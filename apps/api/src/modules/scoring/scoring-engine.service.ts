import { Inject, Injectable } from '@nestjs/common';
import {
  ACTIVITY_TYPES,
  bandFor,
  clampScore,
  decayDue,
  evaluateScoringRules,
  newId,
  tenantContext,
  type DecaySpec,
  type RuleCondition,
  type ScoreBandSpec,
  type ScoringRuleInput,
  type ScoringSubject,
  type ScoringVerdict,
} from '@leados/shared';
import type { Logger } from 'pino';
import { DbService } from '../../infra/db/db.service.js';
import { LOGGER } from '../../infra/observability/logger.module.js';
import { OutboxService, type TransactionClient } from '../../infra/outbox/outbox.service.js';
import { TimelineService } from '../../infra/timeline/timeline.service.js';

/**
 * Applying the score (`FR-SCR-1`, `FR-SCR-2`).
 *
 * **The score is the running total of its score events.** `leads.score` caches
 * `sum(lead_score_events.delta)`, clamped to 0–1000. Nothing here computes a score from scratch;
 * every change is a row with a delta, a reason and the resulting balance, which is why the
 * breakdown a manager reads always adds up to the number on the lead.
 *
 * Two consequences worth stating, because both are load-bearing:
 *
 *  * **Idempotency is a unique index**, not a check-then-write. `(lead, rule, source_event)` is
 *    unique where a source event exists, so an at-least-once redelivery of `lead.created` inserts
 *    nothing the second time. The service catches the violation and moves on rather than failing the
 *    job, because a duplicate delivery is a success.
 *  * **Only a band change reaches the timeline.** A timeline entry per +5 would bury the calls and
 *    the status changes a business actually reads (rule 6 is about what they want to see, not about
 *    everything that happened). Cold → Hot is news; 45 → 50 is arithmetic, and the breakdown has it.
 */

/** Postgres unique violation — a replayed event. */
const UNIQUE_VIOLATION = 'P2002';

export interface ScoreApplication {
  readonly leadId: string;
  readonly applied: readonly { ruleId: string | null; delta: number; reason: string }[];
  readonly skipped: readonly { ruleId: string; reason: string }[];
  readonly scoreBefore: number;
  readonly scoreAfter: number;
  readonly bandBefore: string | null;
  readonly bandAfter: string | null;
  /** True when nothing changed, which is the normal outcome of a replay. */
  readonly noop: boolean;
}

@Injectable()
export class ScoringEngineService {
  constructor(
    private readonly db: DbService,
    private readonly timeline: TimelineService,
    private readonly outbox: OutboxService,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  /** The bands, ordered, as the pure helpers want them. */
  async bands(): Promise<readonly ScoreBandSpec[]> {
    const rows = await this.db.client.scoreBand.findMany({ orderBy: { minScore: 'asc' } });
    return rows.map((row) => ({
      name: row.name,
      minScore: row.minScore,
      maxScore: row.maxScore,
      colour: row.colour,
    }));
  }

  /**
   * Runs the rules a domain event triggers and records whatever applied.
   *
   * `sourceEventId` is what makes this safe to call twice. It is the outbox event id, so the second
   * delivery of the same event finds the unique index already satisfied and changes nothing.
   */
  async applyForEvent(input: {
    readonly leadId: string;
    readonly triggerEvent: string;
    readonly sourceEventId: string | null;
    readonly eventPayload?: Record<string, unknown>;
  }): Promise<ScoreApplication | null> {
    const rules = await this.rulesFor(input.triggerEvent);
    if (rules.length === 0) return null;

    const lead = await this.db.client.lead.findFirst({
      where: { id: input.leadId, deletedAt: null },
    });
    if (!lead) return null;

    return this.commit({
      leadId: lead.id,
      subject: this.subjectFor(lead, input.eventPayload ?? {}),
      rules,
      sourceEventId: input.sourceEventId,
    });
  }

  /**
   * The nightly decay sweep (`FR-SCR-1`, `score.decay-sweep`).
   *
   * One lead at a time, because the deduction depends on how much this rule has already taken off
   * *this* lead — which is also what makes the sweep idempotent without recording when it last ran.
   * A missed night catches up rather than being lost.
   */
  async applyDecay(input: {
    readonly leadId: string;
    readonly at: Date;
  }): Promise<ScoreApplication | null> {
    const lead = await this.db.client.lead.findFirst({
      where: { id: input.leadId, deletedAt: null },
    });
    if (!lead) return null;

    const rules = await this.db.client.scoringRule.findMany({
      where: { triggerEvent: 'schedule.decay', isActive: true, deletedAt: null },
      orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }],
    });
    if (rules.length === 0) return null;

    // Decay has no originating event, so there is no source event id to be idempotent on. It does
    // not need one: what has already been taken off is derived from the rows themselves, under the
    // same row lock every other path uses.
    return this.commit({
      leadId: lead.id,
      subject: this.subjectFor(lead as unknown as Record<string, unknown>, {}),
      decay: {
        at: input.at,
        lastActivityAt: lead.lastActivityAt,
        rules: rules
          .filter((rule) => rule.decay !== null)
          .map((rule) => ({
            id: rule.id,
            name: rule.name,
            spec: rule.decay as unknown as DecaySpec,
          })),
      },
      sourceEventId: null,
    });
  }

  /**
   * Which leads the sweep should look at tonight.
   *
   * Only live leads with a score to lose and some activity recorded — a lead at zero cannot decay,
   * and one with no activity at all is new rather than stale. Backed by `leads_decay_candidates`.
   */
  async decayCandidates(limit: number): Promise<readonly string[]> {
    const rows = await this.db.client.lead.findMany({
      where: { deletedAt: null, score: { gt: 0 }, lastActivityAt: { not: null } },
      select: { id: true },
      orderBy: { lastActivityAt: 'asc' },
      take: limit,
    });
    return rows.map((row) => row.id);
  }

  /**
   * Re-sums a lead's score events and corrects the cached column (`FR-SCR-2`).
   *
   * This is the repair path, and it is a *re-sum* rather than a re-derivation: replaying the rules
   * would need the historical events, which are gone, and would invent a different number.
   *
   * It writes **no score event**. A repair is not a scoring event, and recording the drift as one
   * would break the invariant it exists to restore: the events would sum to the old wrong number
   * plus a correction, so the breakdown would stop adding up the moment it was fixed. The audit log
   * records that somebody recalculated; the score history records only scoring.
   */
  async recompute(leadId: string): Promise<ScoreApplication | null> {
    const lead = await this.db.client.lead.findFirst({
      where: { id: leadId, deletedAt: null },
      select: { id: true },
    });
    if (!lead) return null;
    // The sum is read under the lock, like everything else: reading it first and then writing would
    // be the very race this repair path exists to clean up after.
    return this.commit({
      leadId,
      subject: { lead: {}, custom: {}, event: {} },
      recompute: true,
      sourceEventId: null,
    });
  }

  /** The breakdown behind a lead's score (`FR-SCR-2`). */
  async breakdown(leadId: string) {
    const lead = await this.db.client.lead.findFirst({
      where: { id: leadId, deletedAt: null },
      select: { id: true, score: true, scoreBand: true },
    });
    if (!lead) return null;

    const events = await this.db.client.leadScoreEvent.findMany({
      where: { leadId },
      orderBy: { createdAt: 'asc' },
      include: { rule: { select: { id: true, name: true, isActive: true, deletedAt: true } } },
    });

    const perRule = new Map<
      string,
      { ruleId: string | null; label: string; total: number; times: number }
    >();
    for (const event of events) {
      const key = event.ruleId ?? `reason:${event.reason}`;
      const entry = perRule.get(key) ?? {
        ruleId: event.ruleId,
        label: event.rule?.name ?? event.reason,
        total: 0,
        times: 0,
      };
      entry.total += event.delta;
      entry.times += 1;
      perRule.set(key, entry);
    }

    const bands = await this.bands();
    const sum = events.reduce((total, event) => total + event.delta, 0);
    return {
      leadId: lead.id,
      score: lead.score,
      band: lead.scoreBand,
      bands,
      // If this is ever false, the cached column has drifted and `recompute` will fix it. Surfaced
      // rather than hidden, because a breakdown that does not add up is the one thing that would
      // destroy trust in the number.
      addsUp: clampScore(sum) === lead.score,
      contributions: [...perRule.values()].sort((left, right) => right.total - left.total),
      events: events.map((event) => ({
        id: event.id,
        at: event.createdAt,
        delta: event.delta,
        reason: event.reason,
        scoreAfter: event.scoreAfter,
        ruleId: event.ruleId,
        ruleName: event.rule?.name ?? null,
        ruleDeleted: event.rule?.deletedAt !== null && event.rule !== null ? true : false,
      })),
    };
  }

  /** Active rules for a trigger, in the order a business listed them. */
  async rulesFor(triggerEvent: string): Promise<readonly ScoringRuleInput[]> {
    const rules = await this.db.client.scoringRule.findMany({
      where: { triggerEvent, isActive: true, deletedAt: null },
      orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }],
    });
    return rules.map((rule) => ({
      id: rule.id,
      name: rule.name,
      triggerEvent: rule.triggerEvent,
      conditions: (rule.conditions as unknown as RuleCondition[]) ?? [],
      points: rule.points,
      maxApplications: rule.maxApplications,
    }));
  }

  /**
   * How many times each rule has already applied to this lead — the cap's only input.
   *
   * The public version is for the tester, which holds no lock and does not need one. The write path
   * uses `appliedCountsIn` inside its transaction, because a cap read before the lock can be passed
   * twice by two concurrent events.
   */
  async appliedCounts(leadId: string, ruleIds: readonly string[]): Promise<Record<string, number>> {
    return this.appliedCountsIn(this.db.client, leadId, ruleIds);
  }

  private async appliedCountsIn(
    client: Pick<TransactionClient, 'leadScoreEvent'>,
    leadId: string,
    ruleIds: readonly string[],
  ): Promise<Record<string, number>> {
    if (ruleIds.length === 0) return {};
    const grouped = await client.leadScoreEvent.groupBy({
      by: ['ruleId'],
      where: { leadId, ruleId: { in: [...ruleIds] } },
      _count: { _all: true },
    });
    const counts: Record<string, number> = {};
    for (const row of grouped) {
      if (row.ruleId) counts[row.ruleId] = row._count._all;
    }
    return counts;
  }

  subjectFor(lead: Record<string, unknown>, eventPayload: Record<string, unknown>): ScoringSubject {
    return {
      lead,
      custom: (lead['customValues'] as Record<string, unknown>) ?? {},
      event: eventPayload,
    };
  }

  private async decayAlreadyRemoved(
    client: Pick<TransactionClient, 'leadScoreEvent'>,
    leadId: string,
    ruleId: string,
  ): Promise<number> {
    const total = await client.leadScoreEvent.aggregate({
      where: { leadId, ruleId },
      _sum: { delta: true },
    });
    // Stored negative; `decayDue` thinks in positive points already removed.
    return Math.abs(total._sum.delta ?? 0);
  }

  /**
   * Evaluates and writes, with the lead's row locked for the duration.
   *
   * **The lock is the correctness of the whole feature.** Scoring runs at concurrency 10 off a
   * queue, and the same lead can have two events in flight — three captures of one person arrive
   * within milliseconds of each other. Without the lock, both jobs read `score = 0`, both write
   * `score = 15`, and the lead ends up with two score events worth 30 points and a cached score of
   * 15: a breakdown that does not add up, which is the one thing that would make the number
   * untrustworthy. The same race also lets two jobs both pass a `maxApplications` cap of 1, and
   * both write a "band changed to Warm" timeline entry.
   *
   * So everything that reads-then-writes happens after `SELECT … FOR UPDATE`: the score, the band,
   * the per-rule applied counts, and the decay already taken off. The lock is per lead, so two
   * different leads still score in parallel.
   */
  private async commit(input: {
    readonly leadId: string;
    readonly subject: ScoringSubject;
    readonly rules?: readonly ScoringRuleInput[];
    readonly decay?: {
      readonly at: Date;
      readonly lastActivityAt: Date | null;
      readonly rules: readonly { id: string; name: string; spec: DecaySpec }[];
    };
    readonly sourceEventId: string | null;
    /** Sets the cached score to the sum of the lead's score events, writing no event of its own. */
    readonly recompute?: boolean;
  }): Promise<ScoreApplication> {
    const organizationId = tenantContext.organizationId('scoring.commit');
    const bands = await this.bands();
    const now = new Date();

    return this.db.client.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<{ score: number; score_band: string | null }[]>`
        SELECT score, score_band
          FROM leads
         WHERE organization_id = ${organizationId}::uuid
           AND id = ${input.leadId}::uuid
           FOR UPDATE
      `;
      const current = locked[0];
      /* c8 ignore next */
      if (!current) {
        return {
          leadId: input.leadId,
          applied: [],
          skipped: [],
          scoreBefore: 0,
          scoreAfter: 0,
          bandBefore: null,
          bandAfter: null,
          noop: true,
        };
      }

      const scoreBefore = current.score;
      const bandBefore = current.score_band;
      let running = scoreBefore;

      // A repair is not a scoring event. Recording the drift as one would break the very invariant
      // it exists to restore: the events would then sum to the *old* wrong number plus a
      // correction, and `addsUp` would be false again the moment it was fixed. The cached column is
      // derived, so repairing it means setting it to the sum — and the audit log, not the score
      // history, is where "somebody recalculated this" belongs.
      if (input.recompute === true) {
        const total = await tx.leadScoreEvent.aggregate({
          where: { leadId: input.leadId },
          _sum: { delta: true },
        });
        running = clampScore(total._sum.delta ?? 0);
      }

      const verdicts =
        input.recompute === true ? [] : await this.verdictsUnderLock(tx, input, running);
      const applying = verdicts.filter((verdict) => verdict.applies && verdict.delta !== 0);
      const skipped = verdicts
        .filter((verdict) => !verdict.applies)
        .map((verdict) => ({ ruleId: verdict.ruleId, reason: verdict.reason }));

      const applied: { ruleId: string | null; delta: number; reason: string }[] = [];
      for (const verdict of applying) {
        const next = clampScore(running + verdict.delta);
        const effective = next - running;
        // A clamp that leaves nothing to apply is not written: a zero-delta row is refused by the
        // database, and a lead already at 1000 "gaining" 10 points would be a lie in the breakdown.
        if (effective === 0) continue;
        const written = await this.writeScoreEvent(tx, {
          organizationId,
          leadId: input.leadId,
          ruleId: verdict.ruleId === '' ? null : verdict.ruleId,
          delta: effective,
          reason: verdict.reason,
          scoreAfter: next,
          sourceEventId: input.sourceEventId,
        });
        if (!written) continue; // replayed event: already scored
        running = next;
        applied.push({ ruleId: verdict.ruleId || null, delta: effective, reason: verdict.reason });
      }

      // A band that no longer matches the score is corrected even when nothing applied: a band set
      // edited since the lead was last scored leaves exactly that state, and the "Hot leads" view
      // would be wrong until something else touched the lead.
      const bandAfter = bandFor(running, bands)?.name ?? null;
      if (running !== scoreBefore || bandAfter !== bandBefore) {
        await tx.lead.update({
          where: { id: input.leadId },
          data: { score: running, scoreBand: bandAfter },
        });
      }

      if (bandAfter !== bandBefore) {
        // The one scoring outcome a business reads on the lead itself (rule 6): the band moved.
        // Cold → Hot is news; 45 → 50 is arithmetic, and the breakdown has it.
        await this.timeline.recordInTransaction(tx, {
          type: ACTIVITY_TYPES.LEAD_SCORE_CHANGED,
          leadId: input.leadId,
          occurredAt: now,
          actorType: 'system',
          actorLabel: 'Scoring',
          payload: {
            score: running,
            previousScore: scoreBefore,
            band: bandAfter,
            previousBand: bandBefore,
            reasons: applied.map((entry) => entry.reason),
          },
          ...(input.sourceEventId ? { sourceEventId: input.sourceEventId } : {}),
        });
        await this.outbox.emit(tx, [
          {
            name: 'lead.score_changed',
            aggregateType: 'lead',
            aggregateId: input.leadId,
            payload: {
              score: running,
              previousScore: scoreBefore,
              band: bandAfter,
              previousBand: bandBefore,
            },
          },
        ]);
      }

      if (applied.length > 0) {
        this.logger.debug(
          { leadId: input.leadId, scoreBefore, scoreAfter: running, bandAfter },
          'lead score updated',
        );
      }
      return {
        leadId: input.leadId,
        applied,
        skipped,
        scoreBefore,
        scoreAfter: running,
        bandBefore,
        bandAfter,
        noop: applied.length === 0 && bandAfter === bandBefore,
      };
    });
  }

  /**
   * The verdicts, computed with the lead's row already locked.
   *
   * Three shapes of input converge here — an event's rules, the decay rules, and a bare adjustment
   * from `recompute` — because all three need the same thing: the counts and totals read *after*
   * the lock, so a cap or a decay floor cannot be passed twice by two concurrent jobs.
   */
  private async verdictsUnderLock(
    tx: TransactionClient,
    input: {
      readonly leadId: string;
      readonly subject: ScoringSubject;
      readonly rules?: readonly ScoringRuleInput[];
      readonly decay?: {
        readonly at: Date;
        readonly lastActivityAt: Date | null;
        readonly rules: readonly { id: string; name: string; spec: DecaySpec }[];
      };
    },
    currentScore: number,
  ): Promise<readonly ScoringVerdict[]> {
    if (input.decay) {
      const verdicts: ScoringVerdict[] = [];
      // One rule after another against a running score, so two decay rules cannot together take a
      // lead below the higher of their floors.
      let running = currentScore;
      for (const rule of input.decay.rules) {
        const alreadyRemoved = await this.decayAlreadyRemoved(tx, input.leadId, rule.id);
        const delta = decayDue({
          decay: rule.spec,
          lastActivityAt: input.decay.lastActivityAt,
          at: input.decay.at,
          currentScore: running,
          alreadyRemoved,
        });
        if (delta === 0) continue;
        running += delta;
        const idleDays = input.decay.lastActivityAt
          ? Math.floor(
              (input.decay.at.getTime() - input.decay.lastActivityAt.getTime()) / 86_400_000,
            )
          : 0;
        verdicts.push({
          ruleId: rule.id,
          ruleName: rule.name,
          applies: true,
          delta,
          reason: `${rule.name} — no activity for ${idleDays} days`,
        });
      }
      return verdicts;
    }

    const rules = input.rules ?? [];
    if (rules.length === 0) return [];
    const appliedCounts = await this.appliedCountsIn(
      tx,
      input.leadId,
      rules.map((rule) => rule.id),
    );
    return evaluateScoringRules({ rules, subject: input.subject, appliedCounts });
  }

  /**
   * Inserts one score event, returning false when the same event already scored this lead under
   * this rule. That collision is the idempotency guarantee doing its job, so it is swallowed here
   * rather than failing the job and retrying forever.
   */
  private async writeScoreEvent(
    tx: TransactionClient,
    row: {
      organizationId: string;
      leadId: string;
      ruleId: string | null;
      delta: number;
      reason: string;
      scoreAfter: number;
      sourceEventId: string | null;
    },
  ): Promise<boolean> {
    try {
      await tx.leadScoreEvent.create({
        data: {
          id: newId(),
          organizationId: row.organizationId,
          leadId: row.leadId,
          ruleId: row.ruleId,
          delta: row.delta,
          reason: row.reason,
          scoreAfter: row.scoreAfter,
          sourceEventId: row.sourceEventId,
        },
      });
      return true;
    } catch (error) {
      if ((error as { code?: string }).code === UNIQUE_VIOLATION) {
        this.logger.debug(
          { leadId: row.leadId, ruleId: row.ruleId, sourceEventId: row.sourceEventId },
          'score event already applied for this event',
        );
        return false;
      }
      throw error;
    }
  }
}
