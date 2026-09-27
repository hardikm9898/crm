import { Injectable } from '@nestjs/common';
import {
  AppError,
  customFieldSpec,
  newId,
  tenantContext,
  validateFieldDefinition,
  type CustomFieldEntity,
} from '@leados/shared';
import { DbService } from '../../infra/db/db.service.js';
import { AuditService } from '../../infra/audit/audit.service.js';
import { fullPage } from '../organizations/organizations.service.js';
import { FieldRegistryService } from './field-registry.service.js';
import type {
  CreateFieldInput,
  CreateSectionInput,
  ListFieldsQuery,
  SetOptionsInput,
  UpdateFieldInput,
  UpdateSectionInput,
} from './custom-fields.dto.js';

/**
 * The field builder (ADR-0005).
 *
 * The product promise is that a business owner adds "Budget" or "Preferred locality" and it is
 * immediately usable — no migration, no deploy. What that costs is discipline in three places:
 *
 *  * **`key`, `entityType` and `type` are immutable.** They appear in stored JSONB, saved views,
 *    import mappings and expression index names. Renaming a key would orphan every value already
 *    written, and silently: the field would simply look empty on every existing record.
 *  * **Delete is soft, and values are kept.** A field removed today must not rewrite last quarter's
 *    leads. Values stay until the retention purge, so history and audit remain truthful.
 *  * **Every write invalidates the registry cache**, or a field created thirty seconds ago is
 *    rejected as unknown for five minutes.
 */
@Injectable()
export class CustomFieldsService {
  constructor(
    private readonly db: DbService,
    private readonly registry: FieldRegistryService,
    private readonly audit: AuditService,
  ) {}

  // ── Sections ──────────────────────────────────────────────────────────────

  async listSections(entityType?: CustomFieldEntity) {
    const sections = await this.db.client.customFieldSection.findMany({
      where: { deletedAt: null, ...(entityType ? { entityType } : {}) },
      orderBy: [{ entityType: 'asc' }, { sortOrder: 'asc' }, { name: 'asc' }],
    });
    const items = sections.map((section) => ({
      id: section.id,
      entityType: section.entityType,
      name: section.name,
      sortOrder: section.sortOrder,
      collapsedByDefault: section.collapsedByDefault,
    }));
    return { items, pagination: fullPage(items.length) };
  }

  async createSection(input: CreateSectionInput) {
    const organizationId = tenantContext.organizationId('customFields.createSection');
    const id = newId();
    await this.db.client.customFieldSection.create({
      data: {
        id,
        organizationId,
        entityType: input.entityType,
        name: input.name,
        sortOrder: input.sortOrder ?? 0,
        collapsedByDefault: input.collapsedByDefault ?? false,
      },
    });
    await this.audit.record({
      action: 'custom_field_section.created',
      resourceType: 'custom_field_section',
      resourceId: id,
      after: { name: input.name, entityType: input.entityType },
    });
    return { id, name: input.name, entityType: input.entityType };
  }

  async updateSection(id: string, input: UpdateSectionInput) {
    const result = await this.db.client.customFieldSection.updateMany({
      where: { id, deletedAt: null },
      data: input,
    });
    if (result.count === 0) throw AppError.notFound('Section');
    await this.audit.record({
      action: 'custom_field_section.updated',
      resourceType: 'custom_field_section',
      resourceId: id,
      after: input as Record<string, unknown>,
    });
    return { id };
  }

  async deleteSection(id: string) {
    // Fields keep working without a section, so the only thing to do is detach them — refusing the
    // delete would make a tidy-up impossible for no benefit.
    const section = await this.db.client.customFieldSection.findFirst({
      where: { id, deletedAt: null },
    });
    if (!section) throw AppError.notFound('Section');

    await this.db.client.$transaction(async (tx) => {
      await tx.customFieldDefinition.updateMany({
        where: { sectionId: id },
        data: { sectionId: null },
      });
      await tx.customFieldSection.update({ where: { id }, data: { deletedAt: new Date() } });
      await this.audit.recordInTransaction(tx, {
        action: 'custom_field_section.deleted',
        resourceType: 'custom_field_section',
        resourceId: id,
        before: { name: section.name },
      });
    });
    await this.registry.invalidate(section.entityType);
    return { id, deleted: true };
  }

  // ── Definitions ───────────────────────────────────────────────────────────

  async list(query: ListFieldsQuery) {
    const definitions = await this.db.client.customFieldDefinition.findMany({
      where: {
        deletedAt: null,
        ...(query.entityType ? { entityType: query.entityType } : {}),
        ...(query.includeInactive === true ? {} : { isActive: true }),
      },
      include: { options: { orderBy: [{ sortOrder: 'asc' }, { label: 'asc' }] } },
      orderBy: [{ entityType: 'asc' }, { sortOrder: 'asc' }, { label: 'asc' }],
    });

    const items = definitions.map((definition) => this.present(definition));
    return { items, pagination: fullPage(items.length) };
  }

  async create(input: CreateFieldInput) {
    const organizationId = tenantContext.organizationId('customFields.create');

    // The definition is checked before anything is written: a type that does not exist, a choice
    // field with no choices, a rule its type ignores.
    const problems = validateFieldDefinition({
      type: input.type,
      validation: input.validation ?? {},
      optionCount: input.options?.length ?? 0,
    });
    if (problems.length > 0) throw AppError.validation('Some details need correcting', problems);

    const existing = await this.db.client.customFieldDefinition.findFirst({
      where: { entityType: input.entityType, key: input.key },
    });
    if (existing) {
      throw AppError.conflict(
        existing.deletedAt === null
          ? `A field with the key “${input.key}” already exists on ${input.entityType}`
          : // A key is never reused, even after deletion: old values are still stored under it, and a
            // new field inheriting them would show one business's data under another's label.
            `The key “${input.key}” belonged to a deleted field and cannot be reused`,
      );
    }

    if (input.sectionId) {
      const section = await this.db.client.customFieldSection.findFirst({
        where: { id: input.sectionId, entityType: input.entityType, deletedAt: null },
      });
      if (!section) throw AppError.notFound('Section');
    }

    const id = newId();
    await this.db.client.$transaction(async (tx) => {
      await tx.customFieldDefinition.create({
        data: {
          id,
          organizationId,
          entityType: input.entityType,
          key: input.key,
          label: input.label,
          type: input.type,
          placeholder: input.placeholder ?? null,
          helpText: input.helpText ?? null,
          isRequired: input.isRequired ?? false,
          defaultValue: (input.defaultValue ?? null) as never,
          validation: (input.validation ?? {}) as never,
          sectionId: input.sectionId ?? null,
          sortOrder: input.sortOrder ?? 0,
          showInList: input.showInList ?? false,
          isSearchable: input.isSearchable ?? customFieldSpec(input.type)?.searchable ?? false,
          isFilterable: input.isFilterable ?? true,
          isIndexed: input.isIndexed ?? false,
          isPii: input.isPii ?? false,
        },
      });

      if (input.options && input.options.length > 0) {
        await tx.customFieldOption.createMany({
          data: input.options.map((option, index) => ({
            id: newId(),
            organizationId,
            definitionId: id,
            value: option.value,
            label: option.label,
            colour: option.colour ?? null,
            sortOrder: option.sortOrder ?? index,
            isActive: option.isActive ?? true,
          })),
        });
      }

      await this.audit.recordInTransaction(tx, {
        action: 'custom_field.created',
        resourceType: 'custom_field',
        resourceId: id,
        after: { key: input.key, type: input.type, entityType: input.entityType },
      });
    });

    await this.registry.invalidate(input.entityType);
    return { id, key: input.key, entityType: input.entityType, type: input.type };
  }

  async update(id: string, input: UpdateFieldInput) {
    const definition = await this.db.client.customFieldDefinition.findFirst({
      where: { id, deletedAt: null },
      include: { options: true },
    });
    if (!definition) throw AppError.notFound('Custom field');

    if (input.validation !== undefined) {
      const problems = validateFieldDefinition({
        type: definition.type,
        validation: input.validation,
        optionCount: definition.options.length,
      });
      if (problems.length > 0) throw AppError.validation('Some details need correcting', problems);
    }

    if (input.sectionId) {
      const section = await this.db.client.customFieldSection.findFirst({
        where: { id: input.sectionId, entityType: definition.entityType, deletedAt: null },
      });
      if (!section) throw AppError.notFound('Section');
    }

    // Turning a field required after the fact does not retroactively invalidate existing records —
    // it only applies to new writes. Saying so is better than a surprise on the next edit of an old
    // lead, which is why the response reports it.
    const nowRequired = input.isRequired === true && !definition.isRequired;

    await this.db.client.$transaction(async (tx) => {
      await tx.customFieldDefinition.update({
        where: { id },
        data: {
          ...(input.label !== undefined ? { label: input.label } : {}),
          ...(input.placeholder !== undefined ? { placeholder: input.placeholder } : {}),
          ...(input.helpText !== undefined ? { helpText: input.helpText } : {}),
          ...(input.isRequired !== undefined ? { isRequired: input.isRequired } : {}),
          ...(input.defaultValue !== undefined
            ? { defaultValue: input.defaultValue as never }
            : {}),
          ...(input.validation !== undefined ? { validation: input.validation as never } : {}),
          ...(input.sectionId !== undefined ? { sectionId: input.sectionId } : {}),
          ...(input.sortOrder !== undefined ? { sortOrder: input.sortOrder } : {}),
          ...(input.showInList !== undefined ? { showInList: input.showInList } : {}),
          ...(input.isSearchable !== undefined ? { isSearchable: input.isSearchable } : {}),
          ...(input.isFilterable !== undefined ? { isFilterable: input.isFilterable } : {}),
          ...(input.isIndexed !== undefined ? { isIndexed: input.isIndexed } : {}),
          ...(input.isPii !== undefined ? { isPii: input.isPii } : {}),
          ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
        },
      });
      await this.audit.recordInTransaction(tx, {
        action: 'custom_field.updated',
        resourceType: 'custom_field',
        resourceId: id,
        before: {
          label: definition.label,
          isRequired: definition.isRequired,
          isActive: definition.isActive,
        },
        after: input as Record<string, unknown>,
      });
    });

    await this.registry.invalidate(definition.entityType);
    return { id, appliesToNewWritesOnly: nowRequired };
  }

  /**
   * Replaces a choice field's options.
   *
   * `PUT`, not a per-option API, for the same reason role grants are: an options editor shows a
   * complete list and submits a complete list. Options **absent** from the submission are deactivated
   * rather than deleted — a lead recorded as "Referral" must keep saying so after "Referral" is
   * retired.
   */
  async setOptions(id: string, input: SetOptionsInput) {
    const organizationId = tenantContext.organizationId('customFields.setOptions');
    const definition = await this.db.client.customFieldDefinition.findFirst({
      where: { id, deletedAt: null },
      include: { options: true },
    });
    if (!definition) throw AppError.notFound('Custom field');

    const spec = customFieldSpec(definition.type);
    if (!spec?.requiresOptions) {
      throw AppError.businessRule(`A ${definition.type} field does not take options`);
    }
    if (input.options.length === 0) {
      throw AppError.businessRule('A choice field needs at least one option');
    }

    const duplicates = input.options
      .map((option) => option.value)
      .filter((value, index, all) => all.indexOf(value) !== index);
    if (duplicates.length > 0) {
      throw AppError.validation('Some details need correcting', [
        {
          field: 'options',
          code: 'DUPLICATE_VALUE',
          message: `Repeated option values: ${[...new Set(duplicates)].join(', ')}`,
        },
      ]);
    }

    const submitted = new Set(input.options.map((option) => option.value));
    const existingByValue = new Map(definition.options.map((option) => [option.value, option]));

    await this.db.client.$transaction(async (tx) => {
      for (const [index, option] of input.options.entries()) {
        const existing = existingByValue.get(option.value);
        if (existing) {
          await tx.customFieldOption.update({
            where: { id: existing.id },
            data: {
              label: option.label,
              colour: option.colour ?? null,
              sortOrder: option.sortOrder ?? index,
              isActive: option.isActive ?? true,
            },
          });
        } else {
          await tx.customFieldOption.create({
            data: {
              id: newId(),
              organizationId,
              definitionId: id,
              value: option.value,
              label: option.label,
              colour: option.colour ?? null,
              sortOrder: option.sortOrder ?? index,
              isActive: option.isActive ?? true,
            },
          });
        }
      }

      const retired = definition.options.filter((option) => !submitted.has(option.value));
      if (retired.length > 0) {
        await tx.customFieldOption.updateMany({
          where: { id: { in: retired.map((option) => option.id) } },
          data: { isActive: false },
        });
      }

      await this.audit.recordInTransaction(tx, {
        action: 'custom_field.options_set',
        resourceType: 'custom_field',
        resourceId: id,
        after: { values: [...submitted], retired: retired.map((option) => option.value) },
      });
    });

    await this.registry.invalidate(definition.entityType);
    return { id, options: input.options.length };
  }

  /**
   * Soft-deletes a field.
   *
   * Values are **not** removed. A field deleted today must not rewrite last quarter's records, and
   * the retention purge is the only thing that removes data.
   */
  async remove(id: string) {
    const definition = await this.db.client.customFieldDefinition.findFirst({
      where: { id, deletedAt: null },
    });
    if (!definition) throw AppError.notFound('Custom field');

    await this.db.client.$transaction(async (tx) => {
      await tx.customFieldDefinition.update({
        where: { id },
        data: { deletedAt: new Date(), isActive: false },
      });
      await this.audit.recordInTransaction(tx, {
        action: 'custom_field.deleted',
        resourceType: 'custom_field',
        resourceId: id,
        before: { key: definition.key, label: definition.label, type: definition.type },
      });
    });

    await this.registry.invalidate(definition.entityType);
    return { id, deleted: true, valuesRetained: true };
  }

  private present(definition: {
    id: string;
    entityType: string;
    key: string;
    label: string;
    type: string;
    placeholder: string | null;
    helpText: string | null;
    isRequired: boolean;
    defaultValue: unknown;
    validation: unknown;
    sectionId: string | null;
    sortOrder: number;
    showInList: boolean;
    isSearchable: boolean;
    isFilterable: boolean;
    isIndexed: boolean;
    isPii: boolean;
    isActive: boolean;
    options: {
      id: string;
      value: string;
      label: string;
      colour: string | null;
      sortOrder: number;
      isActive: boolean;
    }[];
  }) {
    const spec = customFieldSpec(definition.type);
    return {
      id: definition.id,
      entityType: definition.entityType,
      key: definition.key,
      label: definition.label,
      type: definition.type,
      placeholder: definition.placeholder,
      helpText: definition.helpText,
      isRequired: definition.isRequired,
      defaultValue: definition.defaultValue,
      validation: definition.validation,
      sectionId: definition.sectionId,
      sortOrder: definition.sortOrder,
      showInList: definition.showInList,
      isSearchable: definition.isSearchable,
      isFilterable: definition.isFilterable,
      isIndexed: definition.isIndexed,
      isPii: definition.isPii,
      isActive: definition.isActive,
      options: definition.options,
      // The registry travels with the definition so a client can render and filter the field without
      // hardcoding what each type means — the same list the API validates against.
      capabilities: spec
        ? {
            storage: spec.storage,
            multiValue: spec.multiValue,
            requiresOptions: spec.requiresOptions,
            operators: spec.operators,
            supportedValidation: spec.validation,
            describe: spec.describe,
          }
        : null,
    };
  }
}
