import { Injectable } from '@nestjs/common';
import {
  AppError,
  FORM_CONTACT_KEYS,
  FORM_STANDARD_FIELDS,
  newId,
  newToken,
  tenantContext,
} from '@leados/shared';
import { DbService } from '../../infra/db/db.service.js';
import { AuditService } from '../../infra/audit/audit.service.js';
import { FieldRegistryService } from '../custom-fields/field-registry.service.js';
import type {
  CreateFormInput,
  ListFormsQuery,
  ListSubmissionsQuery,
  SetFormFieldsInput,
  UpdateFormInput,
} from './forms.dto.js';

/** How long a public key is. 24 random bytes, base64url — 32 characters in the URL. */
const PUBLIC_KEY_BYTES = 24;

/**
 * Capture forms, from the workspace's side (`FR-CAP-2`).
 *
 * The public side is `PublicFormsService`, and the split is deliberate: everything here runs with
 * a signed-in principal and `form:manage`, and everything there runs for a stranger with no
 * session at all. One service doing both would make it easy to write a method that reads the
 * tenant from the context in one path and from a public key in the other.
 *
 * Three decisions worth knowing:
 *
 *  * **A form is refused unless it can reach somebody.** A capture with no phone, email or name is
 *    not a lead, and the create path would refuse it with a field error nobody filling in a public
 *    form could act on — so the *builder* refuses to save it. Same lesson as the import's dry run:
 *    a check that needs information a schema does not have belongs where that information is.
 *  * **The field set is replaced whole.** A builder screen edits an ordered list; per-field writes
 *    would let "move this to step 2" half-apply, and a half-saved form captures the wrong things
 *    without saying so.
 *  * **Deleting is deactivating plus a soft delete.** Leads carry `form_id` with a `RESTRICT` FK
 *    because the attribution is read a year later, so a form with captures cannot be removed; and
 *    a deleted form's public URL must stop answering immediately, which is what `is_active` does.
 */
@Injectable()
export class FormsService {
  constructor(
    private readonly db: DbService,
    private readonly fields: FieldRegistryService,
    private readonly audit: AuditService,
  ) {}

  // ── Reading ───────────────────────────────────────────────────────────────

  async list(query: ListFormsQuery) {
    const where: Record<string, unknown> = {
      deletedAt: null,
      ...(query.active === undefined ? {} : { isActive: query.active }),
      ...(query.search ? { name: { contains: query.search, mode: 'insensitive' } } : {}),
    };

    const [total, rows] = await Promise.all([
      this.db.client.form.count({ where }),
      this.db.client.form.findMany({
        where,
        orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
        take: query.limit + 1,
        ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
        include: this.include(),
      }),
    ]);

    const page = rows.slice(0, query.limit);
    const hasMore = rows.length > query.limit;
    return {
      items: page.map((row) => this.present(row)),
      pagination: {
        limit: query.limit,
        nextCursor: hasMore ? (page.at(-1)?.id ?? null) : null,
        hasMore,
        total,
      },
    };
  }

  async findOne(id: string) {
    const row = await this.db.client.form.findFirst({
      where: { id, deletedAt: null },
      include: this.include(),
    });
    if (!row) throw AppError.notFound('Form');
    return this.present(row);
  }

  /**
   * What the builder needs to offer: the standard questions, and this workspace's own lead fields.
   *
   * Served from here rather than assembled by the client, because "which standard fields may a
   * public form ask for" is a security decision (`FORM_STANDARD_FIELDS`) and a client that built
   * its own list could offer a field the API will refuse — or, worse, one it will accept.
   */
  async builderOptions() {
    const definitions = await this.fields.definitionsFor('lead');
    return {
      standardFields: [...FORM_STANDARD_FIELDS_VIEW],
      customFields: definitions.map((definition) => ({
        id: definition.id,
        key: definition.key,
        label: definition.label,
        type: definition.type,
        isRequired: definition.isRequired,
        placeholder: definition.placeholder,
        helpText: definition.helpText,
        options: definition.options
          .filter((option) => option.isActive)
          .map((option) => ({ value: option.value, label: option.label })),
      })),
      contactKeys: [...FORM_CONTACT_KEYS],
    };
  }

  async submissions(query: ListSubmissionsQuery) {
    const where: Record<string, unknown> = {
      ...(query.formId ? { formId: query.formId } : {}),
      ...(query.status ? { status: query.status } : {}),
    };
    const [total, rows] = await Promise.all([
      this.db.client.formSubmission.count({ where }),
      this.db.client.formSubmission.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: query.limit + 1,
        ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
        include: {
          form: { select: { id: true, name: true } },
          lead: { select: { id: true, fullName: true } },
        },
      }),
    ]);
    const page = rows.slice(0, query.limit);
    const hasMore = rows.length > query.limit;
    return {
      items: page.map((row) => ({
        id: row.id,
        form: row.form,
        lead: row.lead,
        status: row.status,
        error: row.error,
        answers: row.rawPayload,
        utm: row.utm,
        pageUrl: row.pageUrl,
        referrer: row.referrer,
        createdAt: row.createdAt,
      })),
      pagination: {
        limit: query.limit,
        nextCursor: hasMore ? (page.at(-1)?.id ?? null) : null,
        hasMore,
        total,
      },
    };
  }

  // ── Writing ───────────────────────────────────────────────────────────────

  async create(input: CreateFormInput) {
    const principal = tenantContext.require('forms.create');
    const organizationId = principal.organizationId;
    const slug = input.slug ?? (await this.slugFrom(input.name));
    await this.assertSlugFree(slug, null);
    await this.assertPlacementExists(input);

    const fields = input.fields ?? [];
    if (fields.length > 0) await this.assertFieldsUsable(fields);

    const id = newId();
    await this.db.client.$transaction(async (tx) => {
      await tx.form.create({
        data: {
          id,
          organizationId,
          name: input.name,
          slug,
          publicKey: newToken(PUBLIC_KEY_BYTES),
          type: (input.type ?? 'embed') as never,
          pipelineId: input.pipelineId ?? null,
          leadSourceId: input.leadSourceId ?? null,
          assignmentRuleId: input.assignmentRuleId ?? null,
          settings: (input.settings ?? {}) as never,
          isActive: input.isActive ?? true,
          createdById: principal.actorId ?? null,
        },
      });
      if (fields.length > 0) {
        await tx.formField.createMany({ data: this.fieldRows(organizationId, id, fields) });
      }
      await this.audit.recordInTransaction(tx, {
        action: 'form.created',
        resourceType: 'form',
        resourceId: id,
        after: { name: input.name, slug, fields: fields.length },
      });
    });

    return this.findOne(id);
  }

  async update(id: string, input: UpdateFormInput) {
    const existing = await this.db.client.form.findFirst({ where: { id, deletedAt: null } });
    if (!existing) throw AppError.notFound('Form');
    if (input.slug !== undefined) await this.assertSlugFree(input.slug, id);
    await this.assertPlacementExists(input);

    await this.db.client.$transaction(async (tx) => {
      await tx.form.update({
        where: { id },
        data: {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.slug !== undefined ? { slug: input.slug } : {}),
          ...(input.type !== undefined ? { type: input.type as never } : {}),
          ...(input.pipelineId !== undefined ? { pipelineId: input.pipelineId } : {}),
          ...(input.leadSourceId !== undefined ? { leadSourceId: input.leadSourceId } : {}),
          ...(input.assignmentRuleId !== undefined
            ? { assignmentRuleId: input.assignmentRuleId }
            : {}),
          ...(input.settings !== undefined ? { settings: input.settings as never } : {}),
          ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
        },
      });
      await this.audit.recordInTransaction(tx, {
        action: 'form.updated',
        resourceType: 'form',
        resourceId: id,
        before: { name: existing.name, slug: existing.slug, isActive: existing.isActive },
        after: input as Record<string, unknown>,
      });
    });
    return this.findOne(id);
  }

  /**
   * Replaces the whole field set.
   *
   * Delete-then-insert inside one transaction rather than a diff: the identity of a field row is
   * not something anybody refers to, and a diff would have to reconcile "the same question moved
   * and was relabelled" against a unique index it also has to respect mid-flight.
   */
  async setFields(id: string, input: SetFormFieldsInput) {
    const form = await this.db.client.form.findFirst({ where: { id, deletedAt: null } });
    if (!form) throw AppError.notFound('Form');
    await this.assertFieldsUsable(input.fields);

    const principal = tenantContext.require('forms.setFields');
    await this.db.client.$transaction(async (tx) => {
      await tx.formField.deleteMany({ where: { formId: id } });
      if (input.fields.length > 0) {
        await tx.formField.createMany({
          data: this.fieldRows(principal.organizationId, id, input.fields),
        });
      }
      // `updated_at` is what the list sorts by, and a field change is a change to the form.
      await tx.form.update({ where: { id }, data: { updatedAt: new Date() } });
      await this.audit.recordInTransaction(tx, {
        action: 'form.fields_set',
        resourceType: 'form',
        resourceId: id,
        after: { fields: input.fields.map((field) => field.label) },
      });
    });
    return this.findOne(id);
  }

  /**
   * A new public key, which is how a form whose URL is being abused is rescued.
   *
   * The old URL stops answering the moment this returns — which is the point, and why the screen
   * says so before anybody presses it.
   */
  async rotateKey(id: string) {
    const form = await this.db.client.form.findFirst({ where: { id, deletedAt: null } });
    if (!form) throw AppError.notFound('Form');
    const publicKey = newToken(PUBLIC_KEY_BYTES);
    await this.db.client.$transaction(async (tx) => {
      await tx.form.update({ where: { id }, data: { publicKey } });
      await this.audit.recordInTransaction(tx, {
        action: 'form.key_rotated',
        resourceType: 'form',
        resourceId: id,
        after: { publicKeyPrefix: publicKey.slice(0, 6) },
      });
    });
    return this.findOne(id);
  }

  async remove(id: string) {
    const form = await this.db.client.form.findFirst({ where: { id, deletedAt: null } });
    if (!form) throw AppError.notFound('Form');

    const captured = await this.db.client.lead.count({ where: { formId: id } });
    if (captured > 0) {
      // The FK would refuse this anyway, with a constraint name. A sentence is better, and the
      // honest alternative is the one the business actually wants.
      throw AppError.businessRule(
        `${captured} ${captured === 1 ? 'lead came' : 'leads came'} in through this form, so it is part of your reporting. Deactivate it instead — the public URL stops answering straight away.`,
      );
    }

    await this.db.client.$transaction(async (tx) => {
      await tx.form.update({
        where: { id },
        // Deactivated as well as deleted: the public endpoints read `is_active`, and a deleted
        // form whose URL still answered would be a capture nobody is watching.
        data: { deletedAt: new Date(), isActive: false },
      });
      await this.audit.recordInTransaction(tx, {
        action: 'form.deleted',
        resourceType: 'form',
        resourceId: id,
        before: { name: form.name, slug: form.slug },
      });
    });
    return { id, deleted: true };
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private include() {
    return {
      fields: { orderBy: [{ stepIndex: 'asc' }, { sortOrder: 'asc' }] as never },
      pipeline: { select: { id: true, name: true } },
      source: { select: { id: true, name: true } },
      assignmentRule: { select: { id: true, name: true } },
    };
  }

  private present(row: {
    id: string;
    name: string;
    slug: string;
    publicKey: string;
    type: string;
    settings: unknown;
    isActive: boolean;
    submissionCount: number;
    lastSubmissionAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
    pipeline: { id: string; name: string } | null;
    source: { id: string; name: string } | null;
    assignmentRule: { id: string; name: string } | null;
    fields: {
      id: string;
      standardFieldKey: string | null;
      customFieldDefinitionId: string | null;
      label: string;
      placeholder: string | null;
      helpText: string | null;
      isRequired: boolean;
      sortOrder: number;
      stepIndex: number;
      options: unknown;
    }[];
  }) {
    return {
      id: row.id,
      name: row.name,
      slug: row.slug,
      publicKey: row.publicKey,
      type: row.type,
      settings: row.settings,
      isActive: row.isActive,
      submissionCount: row.submissionCount,
      lastSubmissionAt: row.lastSubmissionAt,
      pipeline: row.pipeline,
      source: row.source,
      assignmentRule: row.assignmentRule,
      fields: row.fields.map((field) => ({
        id: field.id,
        standardFieldKey: field.standardFieldKey,
        customFieldDefinitionId: field.customFieldDefinitionId,
        label: field.label,
        placeholder: field.placeholder,
        helpText: field.helpText,
        isRequired: field.isRequired,
        sortOrder: field.sortOrder,
        stepIndex: field.stepIndex,
        options: field.options,
      })),
      stepCount: Math.max(1, ...row.fields.map((field) => field.stepIndex + 1)),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  private fieldRows(organizationId: string, formId: string, fields: SetFormFieldsInput['fields']) {
    return fields.map((field, index) => ({
      id: newId(),
      organizationId,
      formId,
      standardFieldKey: field.standardFieldKey ?? null,
      customFieldDefinitionId: field.customFieldDefinitionId ?? null,
      label: field.label,
      placeholder: field.placeholder ?? null,
      helpText: field.helpText ?? null,
      isRequired: field.isRequired ?? false,
      // The order the builder sent them in, which is the order they will be rendered in.
      sortOrder: index,
      stepIndex: field.stepIndex ?? 0,
      options: (field.options ?? null) as never,
    }));
  }

  /**
   * The checks a form has to pass before it is saved.
   *
   * All three would otherwise be found by a stranger: a custom field that does not exist in this
   * workspace, the same question asked twice, and a form with no way to reach anybody.
   */
  private async assertFieldsUsable(fields: SetFormFieldsInput['fields']): Promise<void> {
    const customIds = fields
      .map((field) => field.customFieldDefinitionId)
      .filter((id): id is string => typeof id === 'string');
    if (customIds.length > 0) {
      const found = await this.db.client.customFieldDefinition.findMany({
        where: { id: { in: customIds }, entityType: 'lead', isActive: true, deletedAt: null },
        select: { id: true },
      });
      const known = new Set(found.map((row) => row.id));
      const missing = customIds.filter((id) => !known.has(id));
      if (missing.length > 0) {
        throw AppError.validation('Some fields need correcting', [
          {
            field: 'fields',
            code: 'UNKNOWN_CUSTOM_FIELD',
            message: 'One of the custom fields no longer exists or has been deactivated.',
          },
        ]);
      }
    }

    const names = fields.map(
      (field) => field.standardFieldKey ?? `custom:${field.customFieldDefinitionId}`,
    );
    if (new Set(names).size !== names.length) {
      throw AppError.validation('Some fields need correcting', [
        {
          field: 'fields',
          code: 'DUPLICATE_FIELD',
          message: 'The same question is on the form twice.',
        },
      ]);
    }

    const reaches = fields.some(
      (field) =>
        field.standardFieldKey !== null &&
        field.standardFieldKey !== undefined &&
        (FORM_CONTACT_KEYS as readonly string[]).includes(field.standardFieldKey),
    );
    if (fields.length > 0 && !reaches) {
      throw AppError.validation('Some fields need correcting', [
        {
          field: 'fields',
          code: 'NO_WAY_TO_REACH_THEM',
          message:
            'Ask for at least a phone number, an email address or a name — a capture with none of those cannot become a lead.',
        },
      ]);
    }
  }

  private async assertSlugFree(slug: string, exceptId: string | null): Promise<void> {
    const clash = await this.db.client.form.findFirst({
      where: { slug, deletedAt: null, ...(exceptId ? { id: { not: exceptId } } : {}) },
      select: { id: true, name: true },
    });
    if (clash) {
      throw AppError.validation('Some details need correcting', [
        {
          field: 'slug',
          code: 'SLUG_TAKEN',
          message: `“${clash.name}” already uses that address.`,
        },
      ]);
    }
  }

  /** A form cannot point at a pipeline, source or rule that is not this workspace's. */
  private async assertPlacementExists(
    input: Pick<UpdateFormInput, 'pipelineId' | 'leadSourceId' | 'assignmentRuleId'>,
  ): Promise<void> {
    if (input.pipelineId) {
      const pipeline = await this.db.client.pipeline.findFirst({
        where: { id: input.pipelineId, entityType: 'lead', deletedAt: null },
        select: { id: true },
      });
      if (!pipeline) throw AppError.notFound('Pipeline');
    }
    if (input.leadSourceId) {
      const source = await this.db.client.leadSource.findFirst({
        where: { id: input.leadSourceId },
        select: { id: true },
      });
      if (!source) throw AppError.notFound('Lead source');
    }
    if (input.assignmentRuleId) {
      const rule = await this.db.client.assignmentRule.findFirst({
        where: { id: input.assignmentRuleId },
        select: { id: true },
      });
      if (!rule) throw AppError.notFound('Assignment rule');
    }
  }

  /** `Website enquiry` → `website-enquiry`, with a suffix if that is taken. */
  private async slugFrom(name: string): Promise<string> {
    const base =
      name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 50) || 'form';
    const taken = await this.db.client.form.findMany({
      where: { slug: { startsWith: base }, deletedAt: null },
      select: { slug: true },
    });
    if (!taken.some((row) => row.slug === base)) return base;
    for (let suffix = 2; suffix < 100; suffix += 1) {
      const candidate = `${base}-${suffix}`;
      if (!taken.some((row) => row.slug === candidate)) return candidate;
    }
    return `${base}-${newToken(3)
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '')}`;
  }
}

/** The standard list as the builder reads it: label and kind, without the mapping internals. */
const FORM_STANDARD_FIELDS_VIEW: readonly {
  key: string;
  label: string;
  kind: string;
  target: string;
  describe: string | null;
}[] = FORM_STANDARD_FIELDS.map((spec) => ({
  key: spec.key,
  label: spec.label,
  kind: spec.kind,
  target: spec.target,
  describe: spec.describe ?? null,
}));
