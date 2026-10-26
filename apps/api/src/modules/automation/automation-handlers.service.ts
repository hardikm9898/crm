import { Injectable } from '@nestjs/common';
import {
  ACTIVITY_TYPES,
  AppError,
  addBusinessMinutes,
  interpolate,
  templateBlockedReason,
  type AutomationFacts,
} from '@leados/shared';
import { DbService } from '../../infra/db/db.service.js';
import { CrmConfigService } from '../crm-config/crm-config.service.js';
import { LeadsService } from '../leads/leads.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { SlaCalendarService } from '../sla/sla-calendar.service.js';
import { TasksService } from '../tasks/tasks.service.js';
import { TimelineService } from '../../infra/timeline/timeline.service.js';
// The same helper the WhatsApp ingestion uses, and for the same reason: the timeline deduplicates
// on a uuid, and a step's idempotency key is not one.
import { deterministicEventId } from '../whatsapp/whatsapp-ids.js';
import { WhatsAppSendService } from '../whatsapp/whatsapp-send.service.js';
import { WebhookDispatchService } from '../webhooks/webhook-dispatch.service.js';

/** What a handler was asked to do, and what it needs to do it. */
export interface StepContext {
  readonly organizationId: string;
  readonly runId: string;
  readonly workflowId: string;
  readonly leadId: string;
  readonly facts: AutomationFacts;
  readonly params: Readonly<Record<string, unknown>>;
  /**
   * Stable across retries of the same attempt, and handed to anything with an external effect.
   * `wf:{runId}:{stepId}:{attempt}` — the step log's own key, so "did this already send" is
   * answerable by the thing that sends.
   */
  readonly idempotencyKey: string;
}

/** What a handler answers. `skipped` is a real outcome, and its reason reaches the timeline. */
export type StepOutcome =
  | { readonly status: 'succeeded'; readonly output: Record<string, unknown>; readonly summary: string }
  | { readonly status: 'skipped'; readonly reason: string };

/**
 * The action handlers (`FR-AUT-4`).
 *
 * One method per registry key, and the registry's boot check in `automation.registry-check.ts`
 * reconciles the two — a declared action with no handler is a workflow somebody can publish and
 * watch do nothing, which is the same class of defect as a provider capability read off a
 * near-synonym. Adding an action is an entry in `WORKFLOW_ACTIONS` plus a method here, and that is
 * the whole of Phase 6's first exit criterion on the engine side.
 *
 * Every handler goes through the **service** that owns the write, never through Prisma directly:
 * a status change has to write its history row, start its SLA clock, emit its event and reach the
 * timeline, and a workflow that wrote `leads.status_id` itself would skip all four. The cost is
 * that an action inherits its service's refusals, which is the point — a workflow cannot send a
 * template WhatsApp has not approved, because the send path will not let it.
 *
 * A handler that **throws** is a failure the queue will retry. A handler that answers `skipped` is
 * a decision: "there was nobody to tell", "they asked not to be messaged". The difference is the
 * difference between a bug and a business rule, and the run log records them differently.
 */
@Injectable()
export class AutomationHandlersService {
  constructor(
    private readonly db: DbService,
    private readonly leads: LeadsService,
    private readonly tasks: TasksService,
    private readonly config: CrmConfigService,
    private readonly notifications: NotificationsService,
    private readonly whatsapp: WhatsAppSendService,
    private readonly webhooks: WebhookDispatchService,
    private readonly calendar: SlaCalendarService,
    private readonly timeline: TimelineService,
  ) {}

  /** The keys this service can execute, for the boot check that reconciles them with the registry. */
  handledActions(): string[] {
    return [
      'assign',
      'create_task',
      'send_whatsapp_template',
      'change_status',
      'change_stage',
      'add_tag',
      'add_note',
      'notify',
      'call_webhook',
    ];
  }

  async execute(action: string, ctx: StepContext): Promise<StepOutcome> {
    switch (action) {
      case 'assign':
        return this.assign(ctx);
      case 'create_task':
        return this.createTask(ctx);
      case 'send_whatsapp_template':
        return this.sendTemplate(ctx);
      case 'change_status':
        return this.changeStatus(ctx);
      case 'change_stage':
        return this.changeStage(ctx);
      case 'add_tag':
        return this.addTag(ctx);
      case 'add_note':
        return this.addNote(ctx);
      case 'notify':
        return this.notify(ctx);
      case 'call_webhook':
        return this.callWebhook(ctx);
      default:
        // Unreachable while the boot check passes, and a sentence rather than a crash if it ever is.
        throw AppError.businessRule(`This release cannot carry out “${action}”.`);
    }
  }

  // ── Ownership ──────────────────────────────────────────────────────────────

  private async assign(ctx: StepContext): Promise<StepOutcome> {
    const userId = text(ctx.params['userId']);
    const useRules = ctx.params['useRules'] === true;

    if (useRules || userId === null) {
      // `assignedUserId: null` through the real path, which is what runs the workspace's rules —
      // round-robin, load-balanced, on-shift — rather than reimplementing them here.
      const assigned = await this.leads.assign(ctx.leadId, {
        assignedUserId: null,
        reason: 'Assigned by a workflow',
      });
      const owner = (assigned as { assignedUserId?: string | null }).assignedUserId ?? null;
      return owner === null
        ? { status: 'skipped', reason: 'the assignment rules had nobody available to take it' }
        : { status: 'succeeded', output: { assignedUserId: owner }, summary: 'assigned it by the rules' };
    }

    await this.leads.assign(ctx.leadId, {
      assignedUserId: userId,
      reason: 'Assigned by a workflow',
    });
    return { status: 'succeeded', output: { assignedUserId: userId }, summary: 'assigned it' };
  }

  // ── Follow-up ──────────────────────────────────────────────────────────────

  private async createTask(ctx: StepContext): Promise<StepOutcome> {
    const title = interpolate(String(ctx.params['title'] ?? ''), ctx.facts);
    const dueInMinutes = Number(ctx.params['dueInMinutes'] ?? 0);
    const assigneeFrom = text(ctx.params['assigneeFrom']) ?? 'lead_owner';
    const explicit = text(ctx.params['userId']);

    const assignedUserId =
      assigneeFrom === 'specific'
        ? explicit
        : (text(ctx.facts['lead.assignedUserId']) ?? explicit);

    // "Due in two hours" from a workflow means two **working** hours, for the same reason an SLA
    // target does: a follow-up due at 2 am is one nobody will do, and the lead's own branch decides
    // whose hours those are.
    const dueAt = await this.businessInstant(ctx.leadId, dueInMinutes);

    const created = await this.tasks.create({
      leadId: ctx.leadId,
      title: title.slice(0, 200),
      ...(text(ctx.params['taskTypeId']) === null ? {} : { taskTypeId: text(ctx.params['taskTypeId'])! }),
      dueAt,
      priority: 'medium',
      ...(assignedUserId === null ? {} : { assignedUserId }),
    } as Parameters<TasksService['create']>[0]);

    return {
      status: 'succeeded',
      output: { taskId: (created as { id: string }).id, dueAt: dueAt.toISOString() },
      summary: `created the follow-up “${title.slice(0, 60)}”`,
    };
  }

  // ── Messaging ──────────────────────────────────────────────────────────────

  private async sendTemplate(ctx: StepContext): Promise<StepOutcome> {
    const templateId = text(ctx.params['templateId']);
    if (templateId === null) return { status: 'skipped', reason: 'no template was chosen' };

    const template = await this.db.client.whatsAppTemplate.findFirst({
      where: { id: templateId, deletedAt: null },
      select: { id: true, name: true, status: true },
    });
    if (!template) return { status: 'skipped', reason: 'that template no longer exists' };
    const blocked = templateBlockedReason(template.status);
    if (blocked !== null) return { status: 'skipped', reason: blocked };

    // The conversation this workspace already has with this lead. A workflow does not open one:
    // an outbound-only conversation has no `phone_number_id` to have arrived at, and inventing one
    // would put a thread in the inbox that nobody there can answer.
    const conversation = await this.db.client.conversation.findFirst({
      where: { leadId: ctx.leadId },
      orderBy: [{ lastMessageAt: 'desc' }],
      select: { id: true },
    });
    if (!conversation) {
      return {
        status: 'skipped',
        reason: 'there is no WhatsApp conversation with this lead yet, so there is nowhere to send it',
      };
    }

    const sent = await this.whatsapp.send(conversation.id, {
      kind: 'template',
      templateId: template.id,
      // The consent rules, the window and the variable check are the send path's, not ours.
    } as Parameters<WhatsAppSendService['send']>[1]);

    return {
      status: 'succeeded',
      output: { messageId: (sent as { id?: string }).id ?? null, templateId: template.id },
      summary: `sent the template “${template.name}”`,
    };
  }

  private async notify(ctx: StepContext): Promise<StepOutcome> {
    const recipient = text(ctx.params['recipient']) ?? 'lead_owner';
    const explicit = text(ctx.params['userId']);
    const userId = recipient === 'specific' ? explicit : text(ctx.facts['lead.assignedUserId']);
    if (userId === null) {
      // The commonest honest skip: a workflow told to tell "whoever owns the lead" about a lead
      // nobody owns. Saying so on the timeline is the whole point of `FR-AUT-7`.
      return { status: 'skipped', reason: 'nobody owns this lead, so there was nobody to tell' };
    }

    const title = interpolate(String(ctx.params['title'] ?? ''), ctx.facts).slice(0, 200);
    const id = await this.notifications.create({
      organizationId: ctx.organizationId,
      userId,
      type: 'automation.notice',
      title,
      link: `/leads/${ctx.leadId}`,
      data: { runId: ctx.runId, workflowId: ctx.workflowId, leadId: ctx.leadId },
      // The step's own key: a re-delivered job must not produce a second copy.
      dedupeKey: ctx.idempotencyKey,
    });

    return id === null
      ? { status: 'skipped', reason: 'that person has this kind of notification switched off' }
      : { status: 'succeeded', output: { notificationId: id, userId }, summary: `told them: ${title}` };
  }

  private async callWebhook(ctx: StepContext): Promise<StepOutcome> {
    const endpointId = text(ctx.params['endpointId']);
    if (endpointId === null) return { status: 'skipped', reason: 'no endpoint was chosen' };
    const endpoint = await this.db.client.webhookEndpoint.findFirst({
      where: { id: endpointId },
      select: { id: true, isActive: true, url: true },
    });
    if (!endpoint) return { status: 'skipped', reason: 'that endpoint no longer exists' };
    if (!endpoint.isActive) return { status: 'skipped', reason: 'that endpoint is switched off' };

    // The same delivery row, signature, retry schedule and log as every other webhook — through
    // the named-endpoint path rather than the fan-out, because the step says which endpoint it
    // wants and the fan-out answers a different question ("who subscribed to this event").
    const delivered = await this.webhooks.deliverToEndpoint({
      organizationId: ctx.organizationId,
      endpointId: endpoint.id,
      eventId: ctx.idempotencyKey,
      eventName: 'automation.action_executed',
      payload: {
        aggregateId: ctx.leadId,
        leadId: ctx.leadId,
        runId: ctx.runId,
        workflowId: ctx.workflowId,
      },
    });
    if (delivered.created === 0) {
      return { status: 'skipped', reason: 'that delivery had already been queued' };
    }

    return {
      status: 'succeeded',
      output: { endpointId: endpoint.id },
      summary: 'called the webhook',
    };
  }

  // ── The record ─────────────────────────────────────────────────────────────

  private async changeStatus(ctx: StepContext): Promise<StepOutcome> {
    const statusId = text(ctx.params['statusId']);
    if (statusId === null) return { status: 'skipped', reason: 'no status was chosen' };
    if (text(ctx.facts['lead.statusId']) === statusId) {
      // Not a failure, and not silence either: a status change that changes nothing would still
      // emit `lead.status_changed`, and that is exactly how a workflow re-triggers itself.
      return { status: 'skipped', reason: 'the lead is already at that status' };
    }
    await this.leads.changeStatus(ctx.leadId, { statusId });
    return { status: 'succeeded', output: { statusId }, summary: 'changed the status' };
  }

  private async changeStage(ctx: StepContext): Promise<StepOutcome> {
    const stageId = text(ctx.params['stageId']);
    if (stageId === null) return { status: 'skipped', reason: 'no stage was chosen' };
    if (text(ctx.facts['lead.stageId']) === stageId) {
      return { status: 'skipped', reason: 'the lead is already at that stage' };
    }
    await this.leads.changeStage(ctx.leadId, { stageId } as Parameters<LeadsService['changeStage']>[1]);
    return { status: 'succeeded', output: { stageId }, summary: 'moved it to the stage' };
  }

  private async addTag(ctx: StepContext): Promise<StepOutcome> {
    const name = interpolate(String(ctx.params['tag'] ?? ''), ctx.facts).trim();
    if (name === '') return { status: 'skipped', reason: 'no tag was given' };

    // `ensureTag` rather than a create: tagging is idempotent by design, and a workflow racing a
    // colleague who typed the same tag must not fail.
    const tag = (await this.config.ensureTag({ name } as Parameters<CrmConfigService['ensureTag']>[0])) as {
      id: string;
      name: string;
    };
    const existing = await this.db.client.leadTag.findMany({
      where: { leadId: ctx.leadId },
      select: { tagId: true },
    });
    if (existing.some((entry) => entry.tagId === tag.id)) {
      return { status: 'skipped', reason: `the lead already has the tag “${tag.name}”` };
    }
    await this.leads.setTags(ctx.leadId, {
      tagIds: [...existing.map((entry) => entry.tagId), tag.id],
    });
    return { status: 'succeeded', output: { tagId: tag.id, tag: tag.name }, summary: `tagged it “${tag.name}”` };
  }

  private async addNote(ctx: StepContext): Promise<StepOutcome> {
    const body = interpolate(String(ctx.params['body'] ?? ''), ctx.facts).trim();
    if (body === '') return { status: 'skipped', reason: 'the note was empty' };

    // A lead's note **is** a timeline entry in this product — the `notes` table §7 sketches has
    // never been built, and the import's own "add a note" writes `note.added` the same way. It has
    // no author on purpose: a workflow is not a person, and filling `actor_id` would be a claim
    // about a member who did not write it.
    await this.timeline.record({
      type: ACTIVITY_TYPES.NOTE_ADDED,
      leadId: ctx.leadId,
      occurredAt: new Date(),
      // The step's own key, so a retried job writes no second note.
      sourceEventId: deterministicEventId(ctx.idempotencyKey),
      payload: { note: body.slice(0, 2000), via: 'automation', runId: ctx.runId },
      actorType: 'automation',
    });
    return {
      status: 'succeeded',
      output: { body: body.slice(0, 200) },
      summary: 'added a note',
    };
  }

  // ── Plumbing ───────────────────────────────────────────────────────────────

  /** `minutes` from now, counted in the lead's branch's working hours. */
  private async businessInstant(leadId: string, minutes: number): Promise<Date> {
    const now = new Date();
    if (minutes <= 0) return now;
    const lead = await this.db.client.lead.findFirst({
      where: { id: leadId },
      select: { branchId: true, organizationId: true },
    });
    const organization = await this.db.client.organization.findFirst({
      where: { id: lead?.organizationId },
      select: { timezone: true },
    });
    const calendar = await this.calendar.forBranch(
      organization?.timezone ?? 'Asia/Kolkata',
      lead?.branchId ?? null,
      now,
    );
    // `addBusinessMinutes` answers null only for a negative duration, which the registry's
    // `min: 0` already refuses — but a due date that silently became "now" is worse than one that
    // says what happened, so the fallback is explicit rather than a `??` nobody reads.
    const due = addBusinessMinutes(now, minutes, calendar);
    if (due === null) throw AppError.businessRule('That follow-up has no sensible due date.');
    return due;
  }
}

/** A trimmed string, or null — never `''`, which is a value a branch reads as present. */
function text(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}
