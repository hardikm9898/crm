import {
  INDUSTRY_TEMPLATES,
  findIndustryTemplate,
  newId,
  type IndustryTemplate,
} from '@leados/shared';
import type { DbTransactionClient, UnscopedDbClient } from '../client.js';

/**
 * The industry template catalogue, as platform reference data (`FR-ONB-2`).
 *
 * Upserted from `INDUSTRY_TEMPLATES` in `@leados/shared` for the same reason the permission
 * catalogue is: one definition, read by the seeder and the API, so the ten industries cannot drift
 * between a code constant and a table. Called by `seedPlatformCatalogue`, so a fresh database and an
 * existing one both end up with the current ten.
 */
export async function seedIndustryTemplates(db: UnscopedDbClient): Promise<number> {
  for (const [index, template] of INDUSTRY_TEMPLATES.entries()) {
    await db.industryTemplate.upsert({
      where: { key: template.key },
      create: {
        key: template.key,
        name: template.name,
        description: template.description,
        sortOrder: index,
        definition: template as never,
      },
      // Updated, not skipped: a template improved in a later release has to reach the catalogue,
      // and nothing a tenant owns is touched by this — applying a template copies rows out of it.
      update: {
        name: template.name,
        description: template.description,
        sortOrder: index,
        definition: template as never,
      },
    });
  }
  return INDUSTRY_TEMPLATES.length;
}

export interface AppliedTemplate {
  readonly key: string;
  readonly name: string;
  readonly statuses: number;
  readonly stages: number;
  readonly sources: number;
  readonly lostReasons: number;
  readonly tags: number;
  readonly fields: number;
  readonly views: number;
}

/**
 * Installs a template's vocabulary into one workspace, **replacing** what is there.
 *
 * This is the one genuinely dangerous thing in the onboarding flow, and the design is about making
 * it safe rather than making it clever:
 *
 *  * **It replaces, it does not merge.** A workspace that picked "Real estate" and kept the generic
 *    statuses alongside it would have twelve statuses, two of which mean the same thing. Merging by
 *    name is worse: it produces a vocabulary that is neither the template's nor the tenant's.
 *  * **The caller must have established that the workspace is untouched.** Replacing a status a
 *    lead is sitting in is not possible (`leads.status_id` is `Restrict`), so the delete would fail
 *    at the database rather than corrupt anything — but failing halfway through a replacement is
 *    not an outcome worth having. `PlatformTemplateService` refuses when any lead, customer, deal
 *    or quotation exists, which is the honest window: onboarding.
 *  * **Everything it writes is an ordinary row.** No flag marks a row as the template's; a business
 *    renames, reorders, deactivates and deletes them like any other. Nothing in the product ever
 *    reads `industry_template_key` to decide anything.
 *
 * Returns what it installed, so the screen can say so.
 */
export async function applyIndustryTemplate(
  tx: DbTransactionClient,
  organizationId: string,
  key: string,
): Promise<AppliedTemplate> {
  const template = findIndustryTemplate(key);
  if (!template) throw new Error(`No industry template with key ${key}`);

  await replaceStatuses(tx, organizationId, template);
  const stages = await replaceLeadPipeline(tx, organizationId, template);
  await replaceSources(tx, organizationId, template);
  await replaceLostReasons(tx, organizationId, template);
  await replaceTags(tx, organizationId, template);
  await replaceCustomFields(tx, organizationId, template);
  const views = await replaceSavedViews(tx, organizationId, template);

  await tx.organization.update({
    where: { id: organizationId },
    data: { industryTemplateKey: template.key, industry: template.name },
  });

  return {
    key: template.key,
    name: template.name,
    statuses: template.statuses.length,
    stages,
    sources: template.sources.length,
    lostReasons: template.lostReasons.length,
    tags: template.tags.length,
    fields: template.fields.length,
    views,
  };
}

/**
 * The default status goes in **last**.
 *
 * `lead_statuses_one_default_per_org` is a partial unique index, so inserting the template's default
 * while the old default still exists would be refused. Clearing the flag on the way out is simpler
 * than ordering the inserts around it, and it also means a failed replacement leaves no default
 * rather than two.
 */
async function replaceStatuses(
  tx: DbTransactionClient,
  organizationId: string,
  template: IndustryTemplate,
): Promise<void> {
  await tx.leadStatus.updateMany({ where: { organizationId }, data: { isDefault: false } });
  await tx.leadStatus.deleteMany({ where: { organizationId } });
  for (const [index, status] of template.statuses.entries()) {
    await tx.leadStatus.create({
      data: {
        id: newId(),
        organizationId,
        name: status.name,
        category: status.category,
        colour: status.colour,
        sortOrder: index,
        isDefault: status.isDefault ?? false,
      },
    });
  }
}

/**
 * The lead pipeline's stages, on the workspace's existing default pipeline.
 *
 * The **pipeline** is kept and its stages replaced, rather than the pipeline being recreated:
 * `pipelines_one_default_per_org_entity` is partial-unique, the deal pipeline must not be touched,
 * and a workspace with no lead pipeline at all cannot create a lead.
 */
async function replaceLeadPipeline(
  tx: DbTransactionClient,
  organizationId: string,
  template: IndustryTemplate,
): Promise<number> {
  const pipeline = await tx.pipeline.findFirst({
    where: { organizationId, entityType: 'lead', deletedAt: null },
    orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
    select: { id: true },
  });
  if (!pipeline) return 0;

  await tx.pipelineStage.deleteMany({ where: { organizationId, pipelineId: pipeline.id } });
  for (const [index, stage] of template.stages.entries()) {
    await tx.pipelineStage.create({
      data: {
        id: newId(),
        organizationId,
        pipelineId: pipeline.id,
        name: stage.name,
        colour: stage.colour,
        sortOrder: index,
        probability: stage.probability,
        isWon: stage.isWon ?? false,
        isLost: stage.isLost ?? false,
      },
    });
  }
  return template.stages.length;
}

/**
 * Sources are replaced, except the two the product itself writes through.
 *
 * `Manual entry` and `API` are not a tenant's marketing channels — they are how a lead got into the
 * system when nobody chose a channel, and the capture paths look them up by name. A template that
 * deleted them would break lead creation for a workspace that had just finished onboarding.
 */
const RESERVED_SOURCE_NAMES = ['Manual entry', 'API'] as const;

async function replaceSources(
  tx: DbTransactionClient,
  organizationId: string,
  template: IndustryTemplate,
): Promise<void> {
  await tx.leadSource.deleteMany({
    where: { organizationId, name: { notIn: [...RESERVED_SOURCE_NAMES] } },
  });
  const kept = await tx.leadSource.findMany({ where: { organizationId }, select: { name: true } });
  const keptNames = new Set(kept.map((row) => row.name));

  let order = 0;
  for (const source of template.sources) {
    if (keptNames.has(source.name)) continue;
    await tx.leadSource.create({
      data: {
        id: newId(),
        organizationId,
        name: source.name,
        type: source.type,
        costModel: source.costModel,
        sortOrder: order,
      },
    });
    order += 1;
  }
  // The reserved two sort last, where a person expects them: they are not a channel anybody picks.
  for (const name of RESERVED_SOURCE_NAMES) {
    await tx.leadSource.updateMany({
      where: { organizationId, name },
      data: { sortOrder: order },
    });
    order += 1;
  }
}

async function replaceLostReasons(
  tx: DbTransactionClient,
  organizationId: string,
  template: IndustryTemplate,
): Promise<void> {
  await tx.lostReason.deleteMany({ where: { organizationId } });
  for (const [index, reason] of template.lostReasons.entries()) {
    await tx.lostReason.create({
      data: {
        id: newId(),
        organizationId,
        name: reason.name,
        sortOrder: index,
        requiresNote: reason.requiresNote ?? false,
      },
    });
  }
}

async function replaceTags(
  tx: DbTransactionClient,
  organizationId: string,
  template: IndustryTemplate,
): Promise<void> {
  await tx.tag.deleteMany({ where: { organizationId } });
  for (const tag of template.tags) {
    await tx.tag.create({
      data: { id: newId(), organizationId, name: tag.name, colour: tag.colour },
    });
  }
}

/**
 * Custom fields, with their options.
 *
 * Existing definitions are deleted rather than kept: a field a template does not define is one the
 * business did not ask for, and leaving it would mean the lead form shows a mix of two industries'
 * questions. The `custom_values` JSONB on any existing record is **not** touched — there are no
 * records yet, and a value whose definition is gone is simply not rendered, which is the registry's
 * designed behaviour rather than data loss.
 */
async function replaceCustomFields(
  tx: DbTransactionClient,
  organizationId: string,
  template: IndustryTemplate,
): Promise<void> {
  await tx.customFieldDefinition.deleteMany({ where: { organizationId } });
  for (const [index, field] of template.fields.entries()) {
    const definitionId = newId();
    await tx.customFieldDefinition.create({
      data: {
        id: definitionId,
        organizationId,
        entityType: field.entityType,
        key: field.key,
        label: field.label,
        type: field.type,
        ...(field.helpText ? { helpText: field.helpText } : {}),
        isRequired: field.isRequired ?? false,
        sortOrder: index,
        showInList: field.showInList ?? false,
        isSearchable: field.type === 'text' || field.type === 'textarea',
        isFilterable: true,
      },
    });
    for (const [optionIndex, option] of (field.options ?? []).entries()) {
      await tx.customFieldOption.create({
        data: {
          id: newId(),
          organizationId,
          definitionId,
          // The stored value is a stable slug and the label is what a person reads, so renaming an
          // option later does not rewrite every record that holds it.
          value: option
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '_')
            .replace(/^_|_$/g, ''),
          label: option,
          sortOrder: optionIndex,
        },
      });
    }
  }
}

/**
 * The template's saved views, added after the provisioned ones.
 *
 * The provisioned views are kept: "Unassigned", "My open leads" and the rest are about the mechanism
 * rather than the industry, and a workspace wants both. Only a view whose name the template reuses
 * is replaced.
 */
async function replaceSavedViews(
  tx: DbTransactionClient,
  organizationId: string,
  template: IndustryTemplate,
): Promise<number> {
  const names = template.views.map((view) => view.name);
  if (names.length > 0) {
    await tx.savedView.deleteMany({
      where: { organizationId, entityType: 'lead', name: { in: names } },
    });
  }
  const highest = await tx.savedView.aggregate({
    where: { organizationId, entityType: 'lead' },
    _max: { sortOrder: true },
  });
  let order = (highest._max.sortOrder ?? -1) + 1;

  for (const view of template.views) {
    await tx.savedView.create({
      data: {
        id: newId(),
        organizationId,
        entityType: 'lead',
        name: view.name,
        filters: view.filters as never,
        columns: ['fullName', 'phoneE164', 'status', 'source', 'owner', 'score'] as never,
        sort: { field: 'createdAt', direction: 'desc' } as never,
        visibility: 'organization',
        isSystem: false,
        sortOrder: order,
      },
    });
    order += 1;
  }
  return template.views.length;
}
