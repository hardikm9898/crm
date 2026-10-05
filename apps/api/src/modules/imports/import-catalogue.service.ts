import { Injectable } from '@nestjs/common';
import { newId, normalizeHeader, tenantContext } from '@leados/shared';
import { DbService } from '../../infra/db/db.service.js';
import {
  FieldRegistryService,
  type FieldDefinition,
} from '../custom-fields/field-registry.service.js';

/**
 * Everything an import run needs to turn a *name* into an id.
 *
 * A spreadsheet says "Site Visit Done" and "priya@…"; the database wants a status id and a user id.
 * Resolution is by name, case- and punctuation-insensitively (`normalizeHeader` is the same
 * normaliser the column matcher uses), and an unknown name is **reported, never invented** — a typo
 * in a status column must not quietly create a status, because statuses are workspace
 * configuration and a 5 000-row import would otherwise leave a mess nobody asked for.
 *
 * Tags are the single deliberate exception: a tag is a label, creating one is cheap and reversible,
 * and an import that refuses a whole row over a new tag would be infuriating. That asymmetry is
 * stated in the field catalogue the wizard shows, so it is a promise rather than a surprise.
 *
 * Loaded **once per run**, not once per row: a 50 000-row file resolving five references per row
 * would otherwise be a quarter of a million queries.
 */
export interface ImportCatalogue {
  readonly statuses: ReadonlyMap<string, string>;
  readonly stages: ReadonlyMap<string, { readonly id: string; readonly pipelineId: string }>;
  readonly sources: ReadonlyMap<string, string>;
  readonly owners: ReadonlyMap<string, string>;
  readonly tags: Map<string, string>;
  readonly customFields: readonly FieldDefinition[];
  readonly defaultPhoneCountry: string;
  readonly defaultCurrency: string;
  /** The names a person can choose from, for the error message when one does not match. */
  readonly statusNames: readonly string[];
  readonly stageNames: readonly string[];
  readonly sourceNames: readonly string[];
}

@Injectable()
export class ImportCatalogueService {
  constructor(
    private readonly db: DbService,
    private readonly fields: FieldRegistryService,
  ) {}

  async load(): Promise<ImportCatalogue> {
    const principal = tenantContext.require('imports.catalogue');
    const [organization, statuses, stages, sources, tags, memberships, customFields] =
      await Promise.all([
        this.db.client.organization.findUniqueOrThrow({
          where: { id: principal.organizationId },
          select: { defaultPhoneCountry: true, defaultCurrency: true },
        }),
        this.db.client.leadStatus.findMany({
          where: { deletedAt: null, isActive: true },
          select: { id: true, name: true },
        }),
        this.db.client.pipelineStage.findMany({
          where: { deletedAt: null },
          select: { id: true, name: true, pipelineId: true },
        }),
        this.db.client.leadSource.findMany({
          where: { deletedAt: null, isActive: true },
          select: { id: true, name: true },
        }),
        this.db.client.tag.findMany({
          where: { deletedAt: null },
          select: { id: true, name: true },
        }),
        // An owner is resolved through `Membership`, never through `User` directly: a person is only
        // assignable in a workspace they are a member of, which is the rule the whole data model is
        // built on.
        this.db.client.membership.findMany({
          where: { status: 'active', deletedAt: null },
          select: { userId: true, user: { select: { name: true, email: true } } },
        }),
        this.fields.definitionsFor('lead'),
      ]);

    const owners = new Map<string, string>();
    for (const membership of memberships) {
      // Email first, because it is unique; the display name is a convenience and the *first*
      // holder of an ambiguous name wins rather than the last, so a re-run resolves the same way.
      const email = normalizeHeader(membership.user.email);
      if (email !== '' && !owners.has(email)) owners.set(email, membership.userId);
      const name = normalizeHeader(membership.user.name);
      if (name !== '' && !owners.has(name)) owners.set(name, membership.userId);
    }

    return {
      statuses: byName(statuses),
      stages: new Map(
        stages.map((stage) => [
          normalizeHeader(stage.name),
          { id: stage.id, pipelineId: stage.pipelineId },
        ]),
      ),
      sources: byName(sources),
      owners,
      tags: new Map(tags.map((tag) => [normalizeHeader(tag.name), tag.id])),
      customFields,
      defaultPhoneCountry: organization.defaultPhoneCountry,
      defaultCurrency: organization.defaultCurrency,
      statusNames: statuses.map((status) => status.name),
      stageNames: stages.map((stage) => stage.name),
      sourceNames: sources.map((source) => source.name),
    };
  }

  /**
   * The id of a tag, creating it if this workspace has never seen the name.
   *
   * The catalogue's map is updated in place, so the second row mentioning "Walk-in" costs nothing
   * and cannot create a second tag. `upsert` on the `(organization_id, name)` unique key rather
   * than find-then-create: two import runs may be processing the same new tag at the same moment.
   */
  async tagIdFor(catalogue: ImportCatalogue, name: string): Promise<string> {
    const key = normalizeHeader(name);
    const known = catalogue.tags.get(key);
    if (known) return known;

    const principal = tenantContext.require('imports.tag');
    const created = await this.db.client.tag.upsert({
      where: { organizationId_name: { organizationId: principal.organizationId, name } },
      create: { id: newId(), organizationId: principal.organizationId, name },
      update: {},
      select: { id: true },
    });
    catalogue.tags.set(key, created.id);
    return created.id;
  }
}

function byName(rows: readonly { id: string; name: string }[]): ReadonlyMap<string, string> {
  const map = new Map<string, string>();
  for (const row of rows) {
    const key = normalizeHeader(row.name);
    if (key !== '' && !map.has(key)) map.set(key, row.id);
  }
  return map;
}
