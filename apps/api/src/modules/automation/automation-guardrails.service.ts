import { Injectable } from '@nestjs/common';
import {
  DEFAULT_DAILY_ACTION_CAP,
  MAX_CAUSATION_DEPTH,
  dateKeyInZone,
  newId,
  reentryDecision,
  withPlatformScope,
  type ReentryDecision,
  type ReentryPolicy,
} from '@leados/shared';
import { DbService } from '../../infra/db/db.service.js';

/**
 * The limits (`FR-AUT-6`).
 *
 * `queue-event-architecture.md` §7 is blunt about why this file exists: "a single bad workflow must
 * never be able to message a tenant's entire customer base or get their WABA banned — this is the
 * highest-consequence subsystem in the product." Five guards, each refusing in a sentence a person
 * can read, because every refusal here ends up on a lead's timeline as "skipped because".
 *
 *  1. **The kill switch and the status**, read from `workflows` — one place, so "is this live" has
 *     one answer.
 *  2. **Re-entry**, decided by a pure function and *guaranteed* by the unique on
 *     `(organization_id, workflow_id, lead_id, cycle)`: two jobs can both pass the check, and only
 *     one can insert the row.
 *  3. **The per-lead run cap**, which is the same unique one layer up.
 *  4. **Loop depth.** Every event an automation step causes carries `causation_depth + 1`,
 *     defaulted from the principal, so a workflow that re-triggers itself climbs until this
 *     refuses. No cycle checker, and nothing to forget at a call site.
 *  5. **The daily action cap**, counted in one atomic statement. An absent setting is **not**
 *     unlimited: the workspace that never opened the automation settings is exactly the one a
 *     runaway workflow would happen to.
 */
@Injectable()
export class AutomationGuardrailsService {
  constructor(private readonly db: DbService) {}

  /** Why this event may not start this workflow, or null. */
  async triggerRefusal(input: {
    readonly workflow: {
      readonly id: string;
      readonly status: string;
      readonly killSwitch: boolean;
      readonly reentryPolicy: string;
      readonly cooldownHours: number | null;
      readonly maxRunsPerEntity: number | null;
    };
    readonly leadId: string;
    readonly causationDepth: number;
  }): Promise<{ refusal: string | null; cycle: number }> {
    const { workflow } = input;
    if (workflow.killSwitch) {
      return { refusal: 'this workflow is stopped', cycle: 0 };
    }
    if (workflow.status !== 'active') {
      return { refusal: `this workflow is ${workflow.status}, so it is not running`, cycle: 0 };
    }
    if (input.causationDepth >= MAX_CAUSATION_DEPTH) {
      // The loop guard. Deliberately phrased as what happened rather than as a code: somebody
      // reading this on a timeline needs to know their workflows are triggering each other.
      return {
        refusal: `this would be ${input.causationDepth + 1} automations deep, and ${MAX_CAUSATION_DEPTH} is the limit — something here is triggering itself`,
        cycle: 0,
      };
    }

    const decision = await this.reentry({
      workflowId: workflow.id,
      leadId: input.leadId,
      policy: workflow.reentryPolicy as ReentryPolicy,
      cooldownHours: workflow.cooldownHours,
      maxRunsPerEntity: workflow.maxRunsPerEntity,
    });
    return { refusal: decision.allowed ? null : decision.reason, cycle: decision.cycle };
  }

  async reentry(input: {
    readonly workflowId: string;
    readonly leadId: string;
    readonly policy: ReentryPolicy;
    readonly cooldownHours: number | null;
    readonly maxRunsPerEntity: number | null;
  }): Promise<ReentryDecision> {
    const [cycles, latest, live] = await Promise.all([
      this.db.client.automationEnrollment.count({
        where: { workflowId: input.workflowId, leadId: input.leadId },
      }),
      this.db.client.automationEnrollment.findFirst({
        where: { workflowId: input.workflowId, leadId: input.leadId },
        orderBy: [{ cycle: 'desc' }],
        select: { enrolledAt: true },
      }),
      this.db.client.automationRun.findFirst({
        where: {
          workflowId: input.workflowId,
          leadId: input.leadId,
          status: { in: ['running', 'waiting'] },
        },
        select: { id: true },
      }),
    ]);

    return reentryDecision({
      policy: input.policy,
      cooldownHours: input.cooldownHours,
      maxRunsPerEntity: input.maxRunsPerEntity,
      cycles,
      lastEnrolledAt: latest?.enrolledAt ?? null,
      hasLiveRun: live !== null,
      now: new Date(),
    });
  }

  /**
   * Counts one action against the workspace's daily cap, and answers whether it may happen.
   *
   * **Check and increment in one statement.** A read-then-write loses the race at queue
   * concurrency — the shape the scoring queue paid for with a row lock and the WhatsApp receipts
   * with a conditional `UPDATE` — and the cheapest correct form here is an upsert that returns the
   * new count. It over-counts an action that then fails, which is the safe direction for a safety
   * limit: a cap that errs towards refusing is a cap.
   *
   * The window is the workspace's **own** day. A cap a business reads as "per day" has to start
   * when their day does, or an Indian workspace's limit resets at half past five in the evening.
   */
  async countAction(input: {
    readonly organizationId: string;
    readonly timeZone: string;
    readonly scopeKey: string;
    readonly cap: number;
  }): Promise<{ allowed: boolean; used: number; refusal: string | null }> {
    const windowStart = `${dateKeyInZone(new Date(), input.timeZone)}T00:00:00.000Z`;
    const rows = await this.db.client.$queryRaw<{ count: number }[]>`
      INSERT INTO automation_guardrail_counters
        (id, organization_id, scope_key, window_start, count, created_at, updated_at)
      VALUES (
        ${newId()}::uuid, ${input.organizationId}::uuid, ${input.scopeKey},
        ${windowStart}::timestamptz::date, 1, now(), now()
      )
      ON CONFLICT (organization_id, scope_key, window_start)
        DO UPDATE SET count = automation_guardrail_counters.count + 1, updated_at = now()
      RETURNING count
    `;
    const used = Number(rows[0]?.count ?? 0);
    if (used > input.cap) {
      return {
        allowed: false,
        used,
        refusal: `this workspace's automations have already taken ${input.cap} actions today, which is the limit`,
      };
    }
    return { allowed: true, used, refusal: null };
  }

  /** What this workspace's cap is, and the timezone its day starts in. */
  async capFor(organizationId: string): Promise<{ cap: number; timeZone: string }> {
    const organization = await withPlatformScope(
      'automation: read the workspace’s own cap',
      async () =>
        this.db.client.organization.findUnique({
          where: { id: organizationId },
          select: { settings: true, timezone: true },
        }),
    );
    const settings = (organization?.settings ?? {}) as Record<string, unknown>;
    const configured = settings['automationDailyActionCap'];
    // A number, or the default. `Number('')` is 0 and a cap of 0 would stop every automation in
    // the workspace — which is the kind of coercion mistake this codebase has paid for twice.
    const cap =
      typeof configured === 'number' && Number.isFinite(configured) && configured > 0
        ? Math.floor(configured)
        : DEFAULT_DAILY_ACTION_CAP;
    return { cap, timeZone: organization?.timezone ?? 'Asia/Kolkata' };
  }
}
