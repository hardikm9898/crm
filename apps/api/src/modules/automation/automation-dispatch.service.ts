import { Inject, Injectable } from '@nestjs/common';
import type { Logger } from 'pino';
import {
  ACTIVITY_TYPES,
  automationPrincipal,
  evaluateAutomationConditions,
  newId,
  tenantContext,
  withPlatformScope,
  type WorkflowDefinition,
} from '@leados/shared';
import { DbService } from '../../infra/db/db.service.js';
import { ENGINE_PERMISSIONS } from './automation-authority.js';
import { LOGGER } from '../../infra/observability/logger.module.js';
import { TimelineService } from '../../infra/timeline/timeline.service.js';
import { JOBS, QUEUES } from '../../infra/queue/queue.constants.js';
import { QueueService } from '../../infra/queue/queue.service.js';
import { AutomationFactsService } from './automation-facts.service.js';
import { AutomationGuardrailsService } from './automation-guardrails.service.js';

export interface TriggerRequest {
  readonly organizationId: string;
  /** The lead the event is about — every trigger's subject today. */
  readonly leadId: string;
  /** The outbox event's name, or `manual` for a person pressing a button and for `enroll`. */
  readonly eventName: string;
  /** The outbox event's id, which is what makes a re-delivery one run rather than two. */
  readonly eventId?: string | null;
  readonly payload?: Record<string, unknown>;
  readonly causationDepth?: number;
  /** Only this workflow, for `enroll` and for a manual start. */
  readonly workflowId?: string;
}

/**
 * One domain event, offered to the workflows that listen for it (`FR-AUT-6`).
 *
 * The dispatch read is a **single indexed query** — `workflow_triggers (organization_id, event)` —
 * joined to `workflows` for the status and the kill switch, which is why the projection carries
 * neither. Everything after that is guards, and every refusal is written to the lead's timeline as
 * `automation.skipped` with its reason: "why didn't this customer get the message?" has to be
 * answerable without a developer, and a dispatcher that silently declines is the one thing that
 * would make it unanswerable.
 *
 * Idempotency is the partial unique on `(organization_id, workflow_id, trigger_event_id)`. The
 * outbox dispatcher is at-least-once by design, so the second delivery of `lead.created` finds the
 * run rather than starting another — which is the Phase 5 exit criterion ("a retried delivery ⇒ one
 * message, one activity, **one automation trigger**") finally finishable.
 */
@Injectable()
export class AutomationDispatchService {
  constructor(
    private readonly db: DbService,
    private readonly facts: AutomationFactsService,
    private readonly guardrails: AutomationGuardrailsService,
    private readonly timeline: TimelineService,
    private readonly queues: QueueService,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  async dispatch(request: TriggerRequest): Promise<{ started: number; skipped: number }> {
    const listeners = await withPlatformScope(
      'automation: find the workflows listening for this event',
      async () =>
        this.db.client.workflowTrigger.findMany({
          where: {
            organizationId: request.organizationId,
            ...(request.workflowId === undefined
              ? { event: request.eventName }
              : { workflowId: request.workflowId }),
          },
          include: {
            workflow: {
              select: {
                id: true,
                name: true,
                status: true,
                killSwitch: true,
                reentryPolicy: true,
                cooldownHours: true,
                maxRunsPerEntity: true,
                deletedAt: true,
              },
            },
            version: { select: { id: true, definition: true } },
          },
        }),
    );
    if (listeners.length === 0) return { started: 0, skipped: 0 };

    let started = 0;
    let skipped = 0;
    for (const listener of listeners) {
      const outcome = await this.offer(request, listener);
      if (outcome === 'started') started += 1;
      else if (outcome === 'skipped') skipped += 1;
    }
    return { started, skipped };
  }

  private async offer(
    request: TriggerRequest,
    listener: {
      workflowId: string;
      versionId: string;
      params: unknown;
      workflow: {
        id: string;
        name: string;
        status: string;
        killSwitch: boolean;
        reentryPolicy: string;
        cooldownHours: number | null;
        maxRunsPerEntity: number | null;
        deletedAt: Date | null;
      };
      version: { id: string; definition: unknown };
    },
  ): Promise<'started' | 'skipped' | 'silent'> {
    const causationDepth = request.causationDepth ?? 0;
    // A deleted workflow leaves no trigger row, so this is belt and braces — and silent, because a
    // workspace does not want a timeline entry about a workflow they threw away.
    if (listener.workflow.deletedAt !== null) return 'silent';

    return tenantContext.run(
      automationPrincipal(
        request.organizationId,
        newId(),
        { runId: 'pending', workflowId: listener.workflowId, causationDepth },
        ENGINE_PERMISSIONS,
      ),
      async () => {
        const guard = await this.guardrails.triggerRefusal({
          workflow: listener.workflow,
          leadId: request.leadId,
          causationDepth,
        });
        if (guard.refusal !== null) {
          // A workflow that is paused or stopped is a decision somebody made, and a timeline entry
          // per event about it would bury the lead's actual history. Everything else — the
          // re-entry policy, the cap, the loop ceiling — is a thing the business would want to see,
          // because it is the answer to "why didn't they get the message".
          const quiet =
            listener.workflow.killSwitch || listener.workflow.status !== 'active';
          if (!quiet) await this.recordSkip(request, listener, guard.refusal);
          return quiet ? 'silent' : 'skipped';
        }

        const definition = listener.version.definition as unknown as WorkflowDefinition;
        // The workflow's own entry conditions, evaluated before anything is written: an enrolment
        // row for a lead the conditions exclude would make the re-entry count wrong for ever.
        const facts = await this.facts.forLead(request.leadId, request.payload ?? {});
        const conditions = evaluateAutomationConditions(definition.conditions, facts);
        if (!conditions.passed) {
          await this.recordSkip(request, listener, conditions.reason);
          return 'skipped';
        }

        const runId = newId();
        try {
          await this.db.client.$transaction(async (tx) => {
            const enrollment = await tx.automationEnrollment.create({
              data: {
                id: newId(),
                organizationId: request.organizationId,
                workflowId: listener.workflowId,
                versionId: listener.versionId,
                leadId: request.leadId,
                cycle: guard.cycle,
              },
            });
            await tx.automationRun.create({
              data: {
                id: runId,
                organizationId: request.organizationId,
                workflowId: listener.workflowId,
                versionId: listener.versionId,
                enrollmentId: enrollment.id,
                leadId: request.leadId,
                triggerEventId: request.eventId ?? null,
                triggerType: definition.trigger.type,
                causationDepth,
                context: (request.payload ?? {}) as never,
              },
            });
          });
        } catch {
          // Either unique is a re-delivery of the same event, or two jobs racing the same cycle.
          // Both mean the run exists, which is the desired end state — the check passed twice and
          // the database kept its promise.
          this.logger.debug(
            { workflowId: listener.workflowId, leadId: request.leadId },
            'automation run already exists for this event',
          );
          return 'silent';
        }

        await this.timeline.record({
          type: ACTIVITY_TYPES.AUTOMATION_ENROLLED,
          leadId: request.leadId,
          occurredAt: new Date(),
          payload: {
            runId,
            workflowId: listener.workflowId,
            workflowName: listener.workflow.name,
            trigger: definition.trigger.type,
            cycle: guard.cycle,
          },
          visibility: 'internal',
          actorType: 'automation',
        });

        await this.queues.enqueue(
          QUEUES.AUTOMATION,
          JOBS.AUTOMATION_STEP,
          { organizationId: request.organizationId, aggregateId: runId },
          { jobId: `automation-step-${runId}-start` },
        );
        return 'started';
      },
    );
  }

  /**
   * "Skipped because", on the lead's own timeline (`FR-AUT-7`).
   *
   * This is the half of the requirement that is easy to leave out and expensive to be without: a
   * business owner asking "why didn't this customer get the message?" must get an answer from the
   * screen rather than from a developer with a query console.
   */
  private async recordSkip(
    request: TriggerRequest,
    listener: { workflowId: string; workflow: { name: string } },
    reason: string,
  ): Promise<void> {
    await this.timeline.record({
      type: ACTIVITY_TYPES.AUTOMATION_SKIPPED,
      leadId: request.leadId,
      occurredAt: new Date(),
      payload: {
        workflowId: listener.workflowId,
        workflowName: listener.workflow.name,
        trigger: request.eventName,
        reason,
      },
      visibility: 'internal',
      actorType: 'automation',
    });
  }
}
