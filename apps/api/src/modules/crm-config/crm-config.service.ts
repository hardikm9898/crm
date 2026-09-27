import { Injectable } from '@nestjs/common';
import { AppError, newId, tenantContext } from '@leados/shared';
import { DbService } from '../../infra/db/db.service.js';
import { AuditService } from '../../infra/audit/audit.service.js';
import { fullPage } from '../organizations/organizations.service.js';
import { FieldRegistryService } from '../custom-fields/field-registry.service.js';
import type {
  CreateLostReasonInput,
  CreatePipelineInput,
  CreateSourceInput,
  CreateStatusInput,
  CreateTagInput,
  SetStagesInput,
  StageInput,
  UpdateLostReasonInput,
  UpdatePipelineInput,
  UpdateSourceInput,
  UpdateStatusInput,
  UpdateTagInput,
} from './crm-config.dto.js';

/**
 * The vocabulary a tenant runs its business in: statuses, sources, lost reasons, pipelines, stages
 * and tags (rule 4).
 *
 * Two invariants are worth naming, because both are easy to break and expensive to discover late:
 *
 *  * **Configuration in use is never destroyed.** Deactivating hides a status from new writes;
 *    deleting one that leads still hold is refused. A business renaming "Site visit done" must not
 *    silently rewrite what happened last month.
 *  * **Defaults are single by construction.** Partial unique indexes enforce one default status and
 *    one default pipeline per organization, so the service sets the flag and lets the database be the
 *    arbiter rather than trusting a read-then-write.
 */
@Injectable()
export class CrmConfigService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly fields: FieldRegistryService,
  ) {}

  /**
   * Everything needed to render a lead form or board, in one request.
   *
   * Deliberately one endpoint: a client that had to fetch statuses, sources, reasons, pipelines,
   * stages, tags and field definitions separately would make seven round-trips before showing
   * anything, and every screen would need to know the order.
   */
  async bundle() {
    const [statuses, sources, lostReasons, pipelines, tags, fieldDefinitions] = await Promise.all([
      this.db.client.leadStatus.findMany({
        where: { deletedAt: null, isActive: true },
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      }),
      this.db.client.leadSource.findMany({
        where: { deletedAt: null, isActive: true },
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      }),
      this.db.client.lostReason.findMany({
        where: { deletedAt: null, isActive: true },
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      }),
      this.db.client.pipeline.findMany({
        where: { deletedAt: null, isActive: true, entityType: 'lead' },
        include: {
          stages: { where: { deletedAt: null }, orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] },
        },
        orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
      }),
      this.db.client.tag.findMany({ where: { deletedAt: null }, orderBy: { name: 'asc' } }),
      this.fields.definitionsFor('lead'),
    ]);

    return {
      statuses: statuses.map((status) => ({
        id: status.id,
        name: status.name,
        colour: status.colour,
        category: status.category,
        sortOrder: status.sortOrder,
        isDefault: status.isDefault,
      })),
      sources: sources.map((source) => ({
        id: source.id,
        name: source.name,
        type: source.type,
        costModel: source.costModel,
        sortOrder: source.sortOrder,
      })),
      lostReasons: lostReasons.map((reason) => ({
        id: reason.id,
        name: reason.name,
        sortOrder: reason.sortOrder,
        requiresNote: reason.requiresNote,
      })),
      pipelines: pipelines.map((pipeline) => ({
        id: pipeline.id,
        name: pipeline.name,
        isDefault: pipeline.isDefault,
        stages: pipeline.stages.map((stage) => ({
          id: stage.id,
          name: stage.name,
          colour: stage.colour,
          sortOrder: stage.sortOrder,
          probability: stage.probability,
          isWon: stage.isWon,
          isLost: stage.isLost,
          requiredFields: stage.requiredFields,
          targetDurationHours: stage.targetDurationHours,
        })),
      })),
      tags: tags.map((tag) => ({ id: tag.id, name: tag.name, colour: tag.colour })),
      fields: fieldDefinitions,
    };
  }

  // ── Statuses ──────────────────────────────────────────────────────────────

  async listStatuses(includeInactive = false) {
    const statuses = await this.db.client.leadStatus.findMany({
      where: { deletedAt: null, ...(includeInactive ? {} : { isActive: true }) },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    });
    const leadCounts = await this.db.client.lead.groupBy({
      by: ['statusId'],
      where: { deletedAt: null },
      _count: { _all: true },
    });
    const byStatus = new Map(leadCounts.map((row) => [row.statusId, row._count._all]));
    const items = statuses.map((status) => ({
      id: status.id,
      name: status.name,
      colour: status.colour,
      category: status.category,
      sortOrder: status.sortOrder,
      isDefault: status.isDefault,
      isActive: status.isActive,
      leadCount: byStatus.get(status.id) ?? 0,
    }));
    return { items, pagination: fullPage(items.length) };
  }

  async createStatus(input: CreateStatusInput) {
    const organizationId = tenantContext.organizationId('crmConfig.createStatus');
    const id = newId();
    await this.db.client.$transaction(async (tx) => {
      if (input.isDefault === true) await this.clearDefaultStatus(tx);
      await tx.leadStatus.create({
        data: {
          id,
          organizationId,
          name: input.name,
          colour: input.colour ?? null,
          category: input.category,
          sortOrder: input.sortOrder ?? 0,
          isDefault: input.isDefault ?? false,
        },
      });
      await this.audit.recordInTransaction(tx, {
        action: 'lead_status.created',
        resourceType: 'lead_status',
        resourceId: id,
        after: { name: input.name, category: input.category },
      });
    });
    return { id, name: input.name, category: input.category };
  }

  async updateStatus(id: string, input: UpdateStatusInput) {
    const status = await this.db.client.leadStatus.findFirst({ where: { id, deletedAt: null } });
    if (!status) throw AppError.notFound('Status');

    // The default is what new leads get. Removing it without naming a replacement would make lead
    // creation fail for everyone, so it is refused rather than allowed and regretted.
    if (input.isDefault === false && status.isDefault) {
      throw AppError.businessRule('Make another status the default instead of clearing this one');
    }
    if (input.isActive === false && status.isDefault) {
      throw AppError.businessRule(
        'The default status cannot be deactivated. Choose another default first',
      );
    }

    await this.db.client.$transaction(async (tx) => {
      if (input.isDefault === true && !status.isDefault) await this.clearDefaultStatus(tx);
      await tx.leadStatus.update({
        where: { id },
        data: {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.colour !== undefined ? { colour: input.colour } : {}),
          ...(input.category !== undefined ? { category: input.category } : {}),
          ...(input.sortOrder !== undefined ? { sortOrder: input.sortOrder } : {}),
          ...(input.isDefault !== undefined ? { isDefault: input.isDefault } : {}),
          ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
        },
      });
      await this.audit.recordInTransaction(tx, {
        action: 'lead_status.updated',
        resourceType: 'lead_status',
        resourceId: id,
        before: { name: status.name, category: status.category, isDefault: status.isDefault },
        after: input as Record<string, unknown>,
      });
    });
    return { id };
  }

  async deleteStatus(id: string) {
    const status = await this.db.client.leadStatus.findFirst({ where: { id, deletedAt: null } });
    if (!status) throw AppError.notFound('Status');
    if (status.isDefault) {
      throw AppError.businessRule(
        'The default status cannot be deleted. Choose another default first',
      );
    }

    const inUse = await this.db.client.lead.count({ where: { statusId: id, deletedAt: null } });
    if (inUse > 0) {
      // Deleting it would either orphan those leads or silently move them. Neither is something a
      // manager asked for, so the count is reported and the decision left with them.
      throw AppError.businessRule(
        `${inUse === 1 ? '1 lead still uses' : `${inUse} leads still use`} this status. Move them first, or deactivate the status to hide it from new leads`,
        { leads: inUse },
      );
    }

    await this.db.client.leadStatus.update({
      where: { id },
      data: { deletedAt: new Date(), isActive: false },
    });
    await this.audit.record({
      action: 'lead_status.deleted',
      resourceType: 'lead_status',
      resourceId: id,
      before: { name: status.name },
    });
    return { id, deleted: true };
  }

  // ── Sources ───────────────────────────────────────────────────────────────

  async listSources(includeInactive = false) {
    const sources = await this.db.client.leadSource.findMany({
      where: { deletedAt: null, ...(includeInactive ? {} : { isActive: true }) },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    });
    const counts = await this.db.client.lead.groupBy({
      by: ['leadSourceId'],
      where: { deletedAt: null },
      _count: { _all: true },
    });
    const bySource = new Map(counts.map((row) => [row.leadSourceId, row._count._all]));
    const items = sources.map((source) => ({
      id: source.id,
      name: source.name,
      type: source.type,
      costModel: source.costModel,
      sortOrder: source.sortOrder,
      isActive: source.isActive,
      leadCount: bySource.get(source.id) ?? 0,
    }));
    return { items, pagination: fullPage(items.length) };
  }

  async createSource(input: CreateSourceInput) {
    const organizationId = tenantContext.organizationId('crmConfig.createSource');
    const id = newId();
    await this.db.client.leadSource.create({
      data: {
        id,
        organizationId,
        name: input.name,
        type: input.type ?? null,
        costModel: input.costModel ?? null,
        sortOrder: input.sortOrder ?? 0,
      },
    });
    await this.audit.record({
      action: 'lead_source.created',
      resourceType: 'lead_source',
      resourceId: id,
      after: { name: input.name },
    });
    return { id, name: input.name };
  }

  async updateSource(id: string, input: UpdateSourceInput) {
    const result = await this.db.client.leadSource.updateMany({
      where: { id, deletedAt: null },
      data: input,
    });
    if (result.count === 0) throw AppError.notFound('Source');
    await this.audit.record({
      action: 'lead_source.updated',
      resourceType: 'lead_source',
      resourceId: id,
      after: input as Record<string, unknown>,
    });
    return { id };
  }

  async deleteSource(id: string) {
    const source = await this.db.client.leadSource.findFirst({ where: { id, deletedAt: null } });
    if (!source) throw AppError.notFound('Source');

    const inUse = await this.db.client.lead.count({ where: { leadSourceId: id, deletedAt: null } });
    if (inUse > 0) {
      throw AppError.businessRule(
        `${inUse === 1 ? '1 lead came' : `${inUse} leads came`} from this source. Deactivate it instead — attribution reports read historical sources`,
        { leads: inUse },
      );
    }
    await this.db.client.leadSource.update({
      where: { id },
      data: { deletedAt: new Date(), isActive: false },
    });
    await this.audit.record({
      action: 'lead_source.deleted',
      resourceType: 'lead_source',
      resourceId: id,
      before: { name: source.name },
    });
    return { id, deleted: true };
  }

  // ── Lost reasons ──────────────────────────────────────────────────────────

  async listLostReasons(includeInactive = false) {
    const reasons = await this.db.client.lostReason.findMany({
      where: { deletedAt: null, ...(includeInactive ? {} : { isActive: true }) },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    });
    const items = reasons.map((reason) => ({
      id: reason.id,
      name: reason.name,
      sortOrder: reason.sortOrder,
      requiresNote: reason.requiresNote,
      isActive: reason.isActive,
    }));
    return { items, pagination: fullPage(items.length) };
  }

  async createLostReason(input: CreateLostReasonInput) {
    const organizationId = tenantContext.organizationId('crmConfig.createLostReason');
    const id = newId();
    await this.db.client.lostReason.create({
      data: {
        id,
        organizationId,
        name: input.name,
        sortOrder: input.sortOrder ?? 0,
        requiresNote: input.requiresNote ?? false,
      },
    });
    await this.audit.record({
      action: 'lost_reason.created',
      resourceType: 'lost_reason',
      resourceId: id,
      after: { name: input.name },
    });
    return { id, name: input.name };
  }

  async updateLostReason(id: string, input: UpdateLostReasonInput) {
    const result = await this.db.client.lostReason.updateMany({
      where: { id, deletedAt: null },
      data: input,
    });
    if (result.count === 0) throw AppError.notFound('Lost reason');
    await this.audit.record({
      action: 'lost_reason.updated',
      resourceType: 'lost_reason',
      resourceId: id,
      after: input as Record<string, unknown>,
    });
    return { id };
  }

  async deleteLostReason(id: string) {
    const reason = await this.db.client.lostReason.findFirst({ where: { id, deletedAt: null } });
    if (!reason) throw AppError.notFound('Lost reason');
    const inUse = await this.db.client.lead.count({ where: { lostReasonId: id } });
    if (inUse > 0) {
      throw AppError.businessRule(
        `${inUse === 1 ? '1 lead was' : `${inUse} leads were`} lost for this reason. Deactivate it instead — loss reports read history`,
        { leads: inUse },
      );
    }
    await this.db.client.lostReason.update({
      where: { id },
      data: { deletedAt: new Date(), isActive: false },
    });
    await this.audit.record({
      action: 'lost_reason.deleted',
      resourceType: 'lost_reason',
      resourceId: id,
      before: { name: reason.name },
    });
    return { id, deleted: true };
  }

  // ── Tags ──────────────────────────────────────────────────────────────────

  async listTags() {
    const tags = await this.db.client.tag.findMany({
      where: { deletedAt: null },
      orderBy: { name: 'asc' },
      include: { _count: { select: { leadTags: true } } },
    });
    const items = tags.map((tag) => ({
      id: tag.id,
      name: tag.name,
      colour: tag.colour,
      leadCount: tag._count.leadTags,
    }));
    return { items, pagination: fullPage(items.length) };
  }

  /**
   * Creates a tag if it does not exist, and returns the existing one if it does.
   *
   * Idempotent on purpose: tagging is a per-lead act that a sales executive performs mid-conversation,
   * and a 409 on "Investor" because a colleague typed it first is a pointless obstacle.
   */
  async ensureTag(input: CreateTagInput) {
    const organizationId = tenantContext.organizationId('crmConfig.ensureTag');
    const existing = await this.db.client.tag.findFirst({
      where: { name: input.name, deletedAt: null },
    });
    if (existing) return { id: existing.id, name: existing.name, created: false };

    const id = newId();
    await this.db.client.tag.create({
      data: { id, organizationId, name: input.name, colour: input.colour ?? null },
    });
    await this.audit.record({
      action: 'tag.created',
      resourceType: 'tag',
      resourceId: id,
      after: { name: input.name },
    });
    return { id, name: input.name, created: true };
  }

  async updateTag(id: string, input: UpdateTagInput) {
    const result = await this.db.client.tag.updateMany({
      where: { id, deletedAt: null },
      data: input,
    });
    if (result.count === 0) throw AppError.notFound('Tag');
    await this.audit.record({
      action: 'tag.updated',
      resourceType: 'tag',
      resourceId: id,
      after: input as Record<string, unknown>,
    });
    return { id };
  }

  /** Deleting a tag removes it from the leads that carry it — a tag is a label, not a record. */
  async deleteTag(id: string) {
    const tag = await this.db.client.tag.findFirst({ where: { id, deletedAt: null } });
    if (!tag) throw AppError.notFound('Tag');

    const removed = await this.db.client.$transaction(async (tx) => {
      const { count } = await tx.leadTag.deleteMany({ where: { tagId: id } });
      await tx.tag.update({ where: { id }, data: { deletedAt: new Date() } });
      await this.audit.recordInTransaction(tx, {
        action: 'tag.deleted',
        resourceType: 'tag',
        resourceId: id,
        before: { name: tag.name, leads: count },
      });
      return count;
    });
    return { id, deleted: true, removedFromLeads: removed };
  }

  // ── Pipelines and stages ──────────────────────────────────────────────────

  async listPipelines(includeInactive = false) {
    const pipelines = await this.db.client.pipeline.findMany({
      where: {
        deletedAt: null,
        entityType: 'lead',
        ...(includeInactive ? {} : { isActive: true }),
      },
      include: {
        stages: { where: { deletedAt: null }, orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] },
        _count: { select: { leads: true } },
      },
      orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
    });
    const items = pipelines.map((pipeline) => ({
      id: pipeline.id,
      name: pipeline.name,
      isDefault: pipeline.isDefault,
      isActive: pipeline.isActive,
      leadCount: pipeline._count.leads,
      stages: pipeline.stages.map((stage) => ({
        id: stage.id,
        name: stage.name,
        colour: stage.colour,
        sortOrder: stage.sortOrder,
        probability: stage.probability,
        isWon: stage.isWon,
        isLost: stage.isLost,
        requiredFields: stage.requiredFields,
        targetDurationHours: stage.targetDurationHours,
      })),
    }));
    return { items, pagination: fullPage(items.length) };
  }

  async createPipeline(input: CreatePipelineInput) {
    const organizationId = tenantContext.organizationId('crmConfig.createPipeline');
    this.assertStagesCoherent(input.stages);

    const id = newId();
    await this.db.client.$transaction(async (tx) => {
      if (input.isDefault === true) await this.clearDefaultPipeline(tx);
      await tx.pipeline.create({
        data: {
          id,
          organizationId,
          name: input.name,
          entityType: 'lead',
          isDefault: input.isDefault ?? false,
        },
      });
      await tx.pipelineStage.createMany({
        data: input.stages.map((stage, index) => ({
          id: newId(),
          organizationId,
          pipelineId: id,
          name: stage.name,
          colour: stage.colour ?? null,
          sortOrder: index,
          probability: stage.probability ?? null,
          isWon: stage.isWon ?? false,
          isLost: stage.isLost ?? false,
          requiredFields: (stage.requiredFields ?? []) as never,
          targetDurationHours: stage.targetDurationHours ?? null,
        })),
      });
      await this.audit.recordInTransaction(tx, {
        action: 'pipeline.created',
        resourceType: 'pipeline',
        resourceId: id,
        after: { name: input.name, stages: input.stages.length },
      });
    });
    return { id, name: input.name, stages: input.stages.length };
  }

  async updatePipeline(id: string, input: UpdatePipelineInput) {
    const pipeline = await this.db.client.pipeline.findFirst({ where: { id, deletedAt: null } });
    if (!pipeline) throw AppError.notFound('Pipeline');

    if (input.isDefault === false && pipeline.isDefault) {
      throw AppError.businessRule('Make another pipeline the default instead of clearing this one');
    }
    if (input.isActive === false && pipeline.isDefault) {
      throw AppError.businessRule(
        'The default pipeline cannot be deactivated. Choose another default first',
      );
    }

    await this.db.client.$transaction(async (tx) => {
      if (input.isDefault === true && !pipeline.isDefault) await this.clearDefaultPipeline(tx);
      await tx.pipeline.update({ where: { id }, data: input });
      await this.audit.recordInTransaction(tx, {
        action: 'pipeline.updated',
        resourceType: 'pipeline',
        resourceId: id,
        before: { name: pipeline.name, isDefault: pipeline.isDefault },
        after: input as Record<string, unknown>,
      });
    });
    return { id };
  }

  /**
   * Replaces a pipeline's stages.
   *
   * Stages carrying leads cannot be dropped: a lead has to be *somewhere* on the board, and silently
   * moving it would corrupt stage-duration history. Submitting the stage's `id` keeps it; omitting an
   * empty stage removes it; omitting a populated one is refused with the count.
   */
  async setStages(pipelineId: string, input: SetStagesInput) {
    const organizationId = tenantContext.organizationId('crmConfig.setStages');
    const pipeline = await this.db.client.pipeline.findFirst({
      where: { id: pipelineId, deletedAt: null },
      include: { stages: { where: { deletedAt: null } } },
    });
    if (!pipeline) throw AppError.notFound('Pipeline');
    this.assertStagesCoherent(input.stages);

    const submittedIds = new Set(
      input.stages.map((stage) => stage.id).filter((value): value is string => value !== undefined),
    );
    const unknown = [...submittedIds].filter(
      (id) => !pipeline.stages.some((stage) => stage.id === id),
    );
    if (unknown.length > 0) throw AppError.notFound('Stage');

    const dropped = pipeline.stages.filter((stage) => !submittedIds.has(stage.id));
    if (dropped.length > 0) {
      const counts = await this.db.client.lead.groupBy({
        by: ['stageId'],
        where: { stageId: { in: dropped.map((stage) => stage.id) }, deletedAt: null },
        _count: { _all: true },
      });
      const occupied = counts.filter((row) => row._count._all > 0);
      if (occupied.length > 0) {
        const names = occupied
          .map((row) => {
            const stage = dropped.find((candidate) => candidate.id === row.stageId);
            return `${stage?.name ?? 'stage'} (${row._count._all})`;
          })
          .join(', ');
        throw AppError.businessRule(
          `These stages still hold leads and cannot be removed: ${names}. Move the leads first`,
          { stages: occupied.map((row) => row.stageId) },
        );
      }
    }

    await this.db.client.$transaction(async (tx) => {
      for (const [index, stage] of input.stages.entries()) {
        const data = {
          name: stage.name,
          colour: stage.colour ?? null,
          sortOrder: index,
          probability: stage.probability ?? null,
          isWon: stage.isWon ?? false,
          isLost: stage.isLost ?? false,
          requiredFields: (stage.requiredFields ?? []) as never,
          targetDurationHours: stage.targetDurationHours ?? null,
        };
        if (stage.id) {
          await tx.pipelineStage.update({ where: { id: stage.id }, data });
        } else {
          await tx.pipelineStage.create({
            data: { id: newId(), organizationId, pipelineId, ...data },
          });
        }
      }
      if (dropped.length > 0) {
        await tx.pipelineStage.updateMany({
          where: { id: { in: dropped.map((stage) => stage.id) } },
          data: { deletedAt: new Date() },
        });
      }
      await this.audit.recordInTransaction(tx, {
        action: 'pipeline.stages_set',
        resourceType: 'pipeline',
        resourceId: pipelineId,
        after: { stages: input.stages.map((stage) => stage.name), removed: dropped.length },
      });
    });
    return { id: pipelineId, stages: input.stages.length, removed: dropped.length };
  }

  async deletePipeline(id: string) {
    const pipeline = await this.db.client.pipeline.findFirst({ where: { id, deletedAt: null } });
    if (!pipeline) throw AppError.notFound('Pipeline');
    if (pipeline.isDefault) {
      throw AppError.businessRule(
        'The default pipeline cannot be deleted. Choose another default first',
      );
    }
    const inUse = await this.db.client.lead.count({ where: { pipelineId: id, deletedAt: null } });
    if (inUse > 0) {
      throw AppError.businessRule(
        `${inUse === 1 ? '1 lead is' : `${inUse} leads are`} on this pipeline. Move them to another one first`,
        { leads: inUse },
      );
    }

    await this.db.client.$transaction(async (tx) => {
      await tx.pipelineStage.updateMany({
        where: { pipelineId: id },
        data: { deletedAt: new Date() },
      });
      await tx.pipeline.update({ where: { id }, data: { deletedAt: new Date(), isActive: false } });
      await this.audit.recordInTransaction(tx, {
        action: 'pipeline.deleted',
        resourceType: 'pipeline',
        resourceId: id,
        before: { name: pipeline.name },
      });
    });
    return { id, deleted: true };
  }

  /**
   * Board-level coherence the database cannot express: at most one won stage and one lost stage, and
   * no duplicate names. A board with two "Won" columns is a reporting bug that surfaces as revenue
   * counted twice.
   */
  private assertStagesCoherent(stages: readonly StageInput[]): void {
    const names = stages.map((stage) => stage.name.toLowerCase());
    const duplicate = names.find((name, index) => names.indexOf(name) !== index);
    if (duplicate) {
      throw AppError.validation('Some details need correcting', [
        {
          field: 'stages',
          code: 'DUPLICATE_NAME',
          message: `Two stages are called “${duplicate}”`,
        },
      ]);
    }
    if (stages.filter((stage) => stage.isWon === true).length > 1) {
      throw AppError.businessRule('A pipeline can have only one won stage');
    }
    if (stages.filter((stage) => stage.isLost === true).length > 1) {
      throw AppError.businessRule('A pipeline can have only one lost stage');
    }
    for (const stage of stages) {
      if (stage.isWon === true && stage.isLost === true) {
        throw AppError.businessRule(`“${stage.name}” cannot be both the won and the lost stage`);
      }
    }
  }

  private async clearDefaultStatus(
    tx: Parameters<Parameters<DbService['client']['$transaction']>[0]>[0],
  ): Promise<void> {
    await tx.leadStatus.updateMany({ where: { isDefault: true }, data: { isDefault: false } });
  }

  private async clearDefaultPipeline(
    tx: Parameters<Parameters<DbService['client']['$transaction']>[0]>[0],
  ): Promise<void> {
    await tx.pipeline.updateMany({
      where: { isDefault: true, entityType: 'lead' },
      data: { isDefault: false },
    });
  }
}
