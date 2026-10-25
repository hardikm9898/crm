import { Injectable } from '@nestjs/common';
import {
  AppError,
  newId,
  publishProblem,
  referencesIn,
  tenantContext,
  templateBlockedReason,
  validateWorkflowDefinition,
  workflowTrigger,
  type DefinitionProblem,
  type ReferenceKind,
  type ReentryPolicy,
  type WorkflowDefinition,
  type WorkflowStatus,
} from '@leados/shared';
import { AuditService } from '../../infra/audit/audit.service.js';
import { DbService } from '../../infra/db/db.service.js';
import { automationCatalogue } from './automation.catalogue.js';
import type {
  CreateWorkflowInput,
  ListWorkflowsQuery,
  SaveDefinitionInput,
  UpdateWorkflowInput,
} from './automation.dto.js';

/** The empty graph a new workflow starts from, so the editor always has something to render. */
const EMPTY_DEFINITION = { trigger: { type: '' }, steps: [] };

type WorkflowRow = {
  id: string;
  name: string;
  description: string | null;
  status: string;
  currentVersionId: string | null;
  killSwitch: boolean;
  maxRunsPerEntity: number | null;
  reentryPolicy: string;
  cooldownHours: number | null;
  createdById: string;
  createdAt: Date;
  updatedAt: Date;
};

type VersionRow = {
  id: string;
  version: number;
  definition: unknown;
  publishedAt: Date | null;
  publishedById: string | null;
  createdById: string;
  createdAt: Date;
  updatedAt: Date;
};

/**
 * Workflows, their versions, and the publish that makes one live (`FR-AUT-4`, `FR-AUT-5`,
 * `FR-AUT-8`).
 *
 * Four decisions worth stating, because each one is a thing that could have been built the other
 * way and been wrong:
 *
 *  * **A draft may be incomplete.** Saving is not publishing. An editor that refuses to save a
 *    half-built workflow is an editor somebody loses an afternoon's work in, so `saveDefinition`
 *    records whatever parses as an object and answers the problem list beside it; `publish` is
 *    where that list becomes a refusal.
 *  * **Editing a published workflow writes a new version.** That is the whole of "editing a live
 *    workflow does not alter in-flight runs": a run pins `version_id`, and the row it pins to is
 *    never written again. There is at most one unpublished version per workflow — the draft — and
 *    `saveDefinition` updates it in place rather than minting a version per keystroke.
 *  * **References are checked against the workspace, not against a schema.** The registry knows a
 *    parameter points at a status; only the workspace knows whether *that* status still exists.
 *    The import's dry run already paid for the version of this mistake where a schema was asked a
 *    question only the tenant's data could answer, so `problemsFor` does both halves.
 *  * **Nothing here touches a lead's timeline.** A workflow is configuration, and the timeline is
 *    about a lead; the entries rule 6 asks for are what step 2's *runs* write, where there is a
 *    lead to write them about. Configuration lands in the audit log instead.
 */
@Injectable()
export class AutomationService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
  ) {}

  catalogue() {
    return automationCatalogue();
  }

  async list(query: ListWorkflowsQuery) {
    const workflowIds = await this.idsForTrigger(query.trigger);
    if (workflowIds !== undefined && workflowIds.length === 0) {
      return { items: [], pagination: { limit: query.limit, nextCursor: null, hasMore: false, total: 0 } };
    }

    // The filters without the cursor. The count has to read the same predicate as the list: a
    // figure on a filtered screen that is not itself filtered is the recurring bug in this
    // codebase, and a total counting every workflow beside a filtered page is that bug.
    const filters = {
      deletedAt: null,
      ...(query.status !== undefined ? { status: query.status } : {}),
      ...(query.killSwitch !== undefined ? { killSwitch: query.killSwitch } : {}),
      ...(workflowIds !== undefined ? { id: { in: workflowIds } } : {}),
    };

    const [rows, total] = await Promise.all([
      this.db.client.workflow.findMany({
        where: { ...filters, ...keysetFrom(query.cursor) },
        orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
        // One more than asked for. `hasMore` inferred from a full page is wrong exactly when the
        // total is a multiple of the limit, which is how `GET /conversations` told a workspace of
        // 4 000 that it had 50.
        take: query.limit + 1,
        include: { trigger: true },
      }),
      this.db.client.workflow.count({ where: filters }),
    ]);

    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    return {
      items: page.map((row) => ({
        ...this.presentSummary(row),
        trigger: row.trigger
          ? { type: row.trigger.triggerType, event: row.trigger.event }
          : null,
      })),
      pagination: {
        limit: query.limit,
        // Both halves of the sort key: `updated_at` ties, and an instant alone skips whatever
        // shares it.
        nextCursor:
          rows.length > query.limit && last ? `${last.updatedAt.toISOString()}_${last.id}` : null,
        hasMore: rows.length > query.limit,
        total,
      },
    };
  }

  async findOne(id: string) {
    const row = await this.db.client.workflow.findFirst({
      where: { id, deletedAt: null },
      include: {
        trigger: true,
        versions: { orderBy: [{ version: 'desc' }], take: 20 },
      },
    });
    if (!row) throw AppError.notFound('Workflow');

    const draft = row.versions.find((version) => version.publishedAt === null) ?? null;
    const current =
      row.versions.find((version) => version.id === row.currentVersionId) ?? null;
    const editable = draft ?? current;
    const problems =
      editable === null ? [] : await this.problemsFor(editable.definition, row.id);

    return {
      ...this.presentSummary(row),
      trigger: row.trigger ? { type: row.trigger.triggerType, event: row.trigger.event } : null,
      /** What the editor opens: the draft if there is one, otherwise the live version. */
      draft: editable === null ? null : this.presentVersion(editable),
      current: current === null ? null : this.presentVersion(current),
      /** What stands between this workflow and being published, in sentences for the editor. */
      problems,
      /** Why it cannot be published, or null — the same answer the publish route gives. */
      publishBlockedReason: publishProblem({ status: row.status as WorkflowStatus, problems }),
      versions: row.versions.map((version) => this.presentVersionSummary(version)),
    };
  }

  async create(input: CreateWorkflowInput) {
    const principal = tenantContext.require('automation.create');
    const actorId = this.requireActor(principal.actorId);
    const id = newId();
    const versionId = newId();

    await this.db.client.$transaction(async (tx) => {
      await tx.workflow.create({
        data: {
          id,
          organizationId: principal.organizationId,
          name: input.name,
          description: input.description ?? null,
          maxRunsPerEntity: input.maxRunsPerEntity ?? null,
          reentryPolicy: input.reentryPolicy ?? 'once',
          // The CHECK pairs these two: a cooldown policy needs hours, anything else needs none.
          cooldownHours: (input.reentryPolicy ?? 'once') === 'cooldown' ? (input.cooldownHours ?? 24) : null,
          createdById: actorId,
        },
      });
      await tx.workflowVersion.create({
        data: {
          id: versionId,
          organizationId: principal.organizationId,
          workflowId: id,
          version: 1,
          definition: (input.definition ?? EMPTY_DEFINITION) as object,
          createdById: actorId,
        },
      });
      await this.audit.recordInTransaction(tx, {
        action: 'workflow.created',
        resourceType: 'workflow',
        resourceId: id,
        after: { name: input.name, reentryPolicy: input.reentryPolicy ?? 'once' },
      });
    });

    return this.findOne(id);
  }

  async update(id: string, input: UpdateWorkflowInput) {
    const existing = await this.requireWorkflow(id);

    if (input.status !== undefined) await this.assertStatusReachable(existing, input.status);

    const reentryPolicy = input.reentryPolicy ?? (existing.reentryPolicy as ReentryPolicy);
    const cooldownHours =
      input.cooldownHours !== undefined ? input.cooldownHours : existing.cooldownHours;
    if (reentryPolicy === 'cooldown' && (cooldownHours === null || cooldownHours === undefined)) {
      throw AppError.validation('Say how long to wait before a lead can enter again.', [
        { field: 'cooldownHours', code: 'COOLDOWN_REQUIRED', message: 'How many hours?' },
      ]);
    }

    await this.db.client.$transaction(async (tx) => {
      await tx.workflow.update({
        where: { id },
        data: {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.description !== undefined ? { description: input.description } : {}),
          ...(input.status !== undefined ? { status: input.status } : {}),
          ...(input.killSwitch !== undefined ? { killSwitch: input.killSwitch } : {}),
          ...(input.maxRunsPerEntity !== undefined
            ? { maxRunsPerEntity: input.maxRunsPerEntity }
            : {}),
          ...(input.reentryPolicy !== undefined ? { reentryPolicy: input.reentryPolicy } : {}),
          // Written whenever the policy moves, because the CHECK refuses the halves separately:
          // `always` with hours is a number nothing reads.
          cooldownHours: reentryPolicy === 'cooldown' ? (cooldownHours ?? 24) : null,
        },
      });
      await this.audit.recordInTransaction(tx, {
        action: input.killSwitch === true ? 'workflow.stopped' : 'workflow.updated',
        resourceType: 'workflow',
        resourceId: id,
        before: {
          name: existing.name,
          status: existing.status,
          killSwitch: existing.killSwitch,
          reentryPolicy: existing.reentryPolicy,
        },
        after: { ...input },
      });
      // Archiving or stopping leaves nothing for dispatch to find: the index row is the only
      // thing an event looks at, so it goes with the same write rather than a sweep later.
      if (input.status === 'archived') {
        await tx.workflowTrigger.deleteMany({ where: { workflowId: id } });
      }
    });

    return this.findOne(id);
  }

  async remove(id: string) {
    const existing = await this.requireWorkflow(id);
    await this.db.client.$transaction(async (tx) => {
      await tx.workflow.update({
        where: { id },
        data: { deletedAt: new Date(), status: 'archived', currentVersionId: null },
      });
      await tx.workflowTrigger.deleteMany({ where: { workflowId: id } });
      await this.audit.recordInTransaction(tx, {
        action: 'workflow.deleted',
        resourceType: 'workflow',
        resourceId: id,
        before: { name: existing.name, status: existing.status },
      });
    });
    return { id, deleted: true as const };
  }

  /**
   * Saves the draft.
   *
   * Updates the unpublished version in place when there is one, and mints the next version number
   * when the latest is published — which is what keeps a published version immutable without
   * making every save a new row.
   */
  async saveDefinition(id: string, input: SaveDefinitionInput) {
    const existing = await this.requireWorkflow(id);
    if (existing.status === 'archived') {
      throw AppError.businessRule('That workflow is archived. Copy it if you want to change it.');
    }
    const principal = tenantContext.require('automation.saveDefinition');
    const actorId = this.requireActor(principal.actorId);

    const draft = await this.db.client.workflowVersion.findFirst({
      where: { workflowId: id, publishedAt: null },
      orderBy: [{ version: 'desc' }],
    });

    if (draft) {
      await this.db.client.workflowVersion.update({
        where: { id: draft.id },
        data: { definition: input.definition as object, createdById: actorId },
      });
    } else {
      const latest = await this.db.client.workflowVersion.findFirst({
        where: { workflowId: id },
        orderBy: [{ version: 'desc' }],
      });
      await this.db.client.workflowVersion.create({
        data: {
          id: newId(),
          organizationId: existing.organizationId,
          workflowId: id,
          version: (latest?.version ?? 0) + 1,
          definition: input.definition as object,
          createdById: actorId,
        },
      });
    }

    // Deliberately not audited: a draft save is a keystroke, and an audit log full of them is one
    // nobody can read. Publishing is the event that matters, and it is audited.
    return this.findOne(id);
  }

  /**
   * Publishes the draft (`FR-AUT-5`).
   *
   * The whole transition in one transaction: the version is stamped, the workflow points at it,
   * and the dispatch index is rewritten from the definition that was just published. A trigger row
   * left over from the previous version would send the next event to a version nobody published.
   */
  async publish(id: string) {
    const existing = await this.requireWorkflow(id);
    const principal = tenantContext.require('automation.publish');
    const actorId = this.requireActor(principal.actorId);

    const draft = await this.db.client.workflowVersion.findFirst({
      where: { workflowId: id, publishedAt: null },
      orderBy: [{ version: 'desc' }],
    });
    if (!draft) {
      throw AppError.businessRule(
        'There is nothing to publish — this workflow has no unpublished changes.',
      );
    }

    const problems = await this.problemsFor(draft.definition, id);
    const blocked = publishProblem({ status: existing.status as WorkflowStatus, problems });
    if (blocked !== null) throw AppError.validation(blocked, problems);

    const definition = draft.definition as unknown as WorkflowDefinition;
    const spec = workflowTrigger(definition.trigger.type);
    const publishedAt = new Date();

    await this.db.client.$transaction(async (tx) => {
      await tx.workflowVersion.update({
        where: { id: draft.id },
        data: { publishedAt, publishedById: actorId },
      });
      await tx.workflow.update({
        where: { id },
        data: {
          currentVersionId: draft.id,
          // A draft published for the first time starts running. A paused workflow stays paused —
          // publishing is not a way to restart something somebody deliberately stopped.
          ...(existing.status === 'draft' ? { status: 'active' } : {}),
        },
      });
      await tx.workflowTrigger.deleteMany({ where: { workflowId: id } });
      await tx.workflowTrigger.create({
        data: {
          id: newId(),
          organizationId: existing.organizationId,
          workflowId: id,
          versionId: draft.id,
          triggerType: definition.trigger.type,
          // Copied from the registry rather than from the definition: the event is ours to know,
          // and a definition carrying its own event name would be a second answer to it.
          event: spec?.event ?? null,
          params: (definition.trigger.params ?? {}) as object,
        },
      });
      await this.audit.recordInTransaction(tx, {
        action: 'workflow.published',
        resourceType: 'workflow',
        resourceId: id,
        after: { version: draft.version, trigger: definition.trigger.type },
      });
    });

    return this.findOne(id);
  }

  async versions(id: string) {
    await this.requireWorkflow(id);
    const rows = await this.db.client.workflowVersion.findMany({
      where: { workflowId: id },
      orderBy: [{ version: 'desc' }],
      take: 100,
    });
    return {
      items: rows.map((row) => this.presentVersionSummary(row)),
      pagination: { limit: 100, nextCursor: null, hasMore: false, total: rows.length },
    };
  }

  /** One version in full — what a run pinned to, readable after the workflow has moved on. */
  async version(id: string, versionId: string) {
    await this.requireWorkflow(id);
    const row = await this.db.client.workflowVersion.findFirst({
      where: { id: versionId, workflowId: id },
    });
    if (!row) throw AppError.notFound('Version');
    return this.presentVersion(row);
  }

  // ── Checking a definition ───────────────────────────────────────────────────

  /**
   * Shape first, then this workspace's rows.
   *
   * `validateWorkflowDefinition` is pure and in `@leados/shared` so the editor's preview and the
   * write path cannot disagree. What it cannot do is answer "does that status still exist", which
   * is the half a schema has no information for — so the references come second, here, where the
   * workspace's rows are.
   */
  async problemsFor(definition: unknown, workflowId: string): Promise<DefinitionProblem[]> {
    const problems = [...validateWorkflowDefinition(definition)];
    if (problems.length > 0) return problems;

    for (const reference of referencesIn(definition as WorkflowDefinition)) {
      const problem = await this.checkReference(reference, workflowId);
      if (problem) problems.push(problem);
    }
    return problems;
  }

  private async checkReference(
    reference: { kind: ReferenceKind; id: string; field: string },
    workflowId: string,
  ): Promise<DefinitionProblem | null> {
    const missing = (what: string): DefinitionProblem => ({
      field: reference.field,
      code: 'REFERENCE_MISSING',
      message: `That ${what} no longer exists. Choose another one.`,
    });

    switch (reference.kind) {
      case 'user': {
        const row = await this.db.client.membership.findFirst({
          where: { userId: reference.id, status: 'active' },
        });
        return row ? null : missing('team member');
      }
      case 'team': {
        const row = await this.db.client.team.findFirst({ where: { id: reference.id } });
        return row ? null : missing('team');
      }
      case 'lead_status': {
        const row = await this.db.client.leadStatus.findFirst({ where: { id: reference.id } });
        return row ? null : missing('status');
      }
      case 'pipeline': {
        const row = await this.db.client.pipeline.findFirst({ where: { id: reference.id } });
        return row ? null : missing('pipeline');
      }
      case 'pipeline_stage': {
        const row = await this.db.client.pipelineStage.findFirst({ where: { id: reference.id } });
        return row ? null : missing('stage');
      }
      case 'task_type': {
        const row = await this.db.client.taskType.findFirst({ where: { id: reference.id } });
        return row ? null : missing('task type');
      }
      case 'lead_source': {
        const row = await this.db.client.leadSource.findFirst({ where: { id: reference.id } });
        return row ? null : missing('source');
      }
      case 'whatsapp_template': {
        const row = await this.db.client.whatsAppTemplate.findFirst({
          where: { id: reference.id, deletedAt: null },
        });
        if (!row) return missing('template');
        // Existence is not enough. A workflow published with a template WhatsApp has not approved
        // is one that fails at three in the morning, which is the dry-run lesson: check what the
        // step will actually need, not what the schema can see.
        const blocked = templateBlockedReason(row.status);
        return blocked === null
          ? null
          : { field: reference.field, code: 'TEMPLATE_NOT_SENDABLE', message: blocked };
      }
      case 'workflow': {
        if (reference.id === workflowId) {
          return {
            field: reference.field,
            code: 'WORKFLOW_SELF_ENROL',
            message: 'A workflow cannot start itself — that is a loop with no way out.',
          };
        }
        const row = await this.db.client.workflow.findFirst({
          where: { id: reference.id, deletedAt: null },
        });
        return row ? null : missing('workflow');
      }
      case 'webhook_endpoint': {
        const row = await this.db.client.webhookEndpoint.findFirst({ where: { id: reference.id } });
        return row ? null : missing('endpoint');
      }
    }
  }

  // ── Plumbing ───────────────────────────────────────────────────────────────

  private async idsForTrigger(trigger: string | undefined): Promise<string[] | undefined> {
    if (trigger === undefined) return undefined;
    const rows = await this.db.client.workflowTrigger.findMany({
      where: { triggerType: trigger },
      select: { workflowId: true },
    });
    return rows.map((row) => row.workflowId);
  }

  private async requireWorkflow(id: string) {
    const row = await this.db.client.workflow.findFirst({ where: { id, deletedAt: null } });
    if (!row) throw AppError.notFound('Workflow');
    return row;
  }

  /**
   * An API key acts as the member who created it, and `created_by_id` carries a composite FK into
   * `Membership` — so a principal with no person behind it has nobody to record, and saying so is
   * better than writing a row that claims a member who does not exist.
   */
  private requireActor(actorId: string | null | undefined): string {
    if (!actorId) {
      throw AppError.businessRule('A workflow has to be created by a person.');
    }
    return actorId;
  }

  private async assertStatusReachable(existing: WorkflowRow, next: string) {
    if (next === existing.status) return;
    if (next === 'draft') {
      throw AppError.businessRule(
        'A published workflow cannot go back to being a draft. Pause it instead.',
      );
    }
    if (next === 'active' && existing.currentVersionId === null) {
      // Which the CHECK also refuses — but a 500 from a constraint name is not a sentence anybody
      // can act on, and this one has an obvious next step.
      throw AppError.businessRule('Publish this workflow before switching it on.');
    }
  }

  private presentSummary(row: WorkflowRow) {
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      status: row.status,
      killSwitch: row.killSwitch,
      currentVersionId: row.currentVersionId,
      maxRunsPerEntity: row.maxRunsPerEntity,
      reentryPolicy: row.reentryPolicy,
      cooldownHours: row.cooldownHours,
      createdById: row.createdById,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  private presentVersion(row: VersionRow) {
    return { ...this.presentVersionSummary(row), definition: row.definition };
  }

  private presentVersionSummary(row: VersionRow) {
    return {
      id: row.id,
      version: row.version,
      isDraft: row.publishedAt === null,
      publishedAt: row.publishedAt?.toISOString() ?? null,
      publishedById: row.publishedById,
      createdById: row.createdById,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}

/** The keyset, carrying both halves of the sort key. */
function keysetFrom(cursor: string | undefined): Record<string, unknown> {
  if (cursor === undefined) return {};
  const split = cursor.lastIndexOf('_');
  if (split <= 0) return {};
  const at = new Date(cursor.slice(0, split));
  const id = cursor.slice(split + 1);
  if (Number.isNaN(at.getTime())) return {};
  return { OR: [{ updatedAt: { lt: at } }, { updatedAt: at, id: { lt: id } }] };
}
