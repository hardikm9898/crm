import { Injectable } from '@nestjs/common';
import {
  AppError,
  REFERENCE_KINDS,
  WEBSITE_BLOCKS,
  WEBSITE_HOME_PATH,
  newId,
  normalizePagePath,
  normalizeSubdomain,
  pagePathProblem,
  subdomainProblem,
  tenantContext,
  validateBlocks,
  websiteBlock,
  withPlatformScope,
} from '@leados/shared';
import { AuditService } from '../../infra/audit/audit.service.js';
import { DbService } from '../../infra/db/db.service.js';
import { OutboxService } from '../../infra/outbox/outbox.service.js';
import { REFERENCE_SOURCES } from '../automation/automation.catalogue.js';
import type {
  CreatePageInput,
  CreateWebsiteInput,
  ListWebsitesQuery,
  UpdatePageInput,
  UpdateWebsiteInput,
} from './websites.dto.js';

/**
 * The page content a version holds, in the order a renderer will read it.
 *
 * The order is part of the snapshot rather than something the renderer sorts, because two
 * snapshots are compared for equality by the rollback test and a set compared as a list is a test
 * that fails on the day the query planner changes its mind.
 */
interface SnapshotPage {
  readonly path: string;
  readonly title: string;
  readonly blocks: unknown;
  readonly seo: unknown;
  readonly isHome: boolean;
  readonly sortOrder: number;
}

interface Snapshot {
  readonly theme: unknown;
  readonly seoDefaults: unknown;
  readonly pages: readonly SnapshotPage[];
}

@Injectable()
export class WebsitesService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
  ) {}

  private requireActor(actorId: string | null | undefined): string {
    // `principal.actorId` is a person, including for an API key, because every person-reference in
    // this product is written from it.
    if (actorId === null || actorId === undefined)
      throw AppError.businessRule('A website needs a person to own it.');
    return actorId;
  }

  /**
   * Normalizes a subdomain, refuses it with a sentence if it is not an address, and refuses it with
   * a different sentence if another workspace already holds it.
   *
   * The collision read is `withPlatformScope` because `websites.subdomain` is globally unique with
   * no `organization_id` beside it: an inbound request for `acme.leados.app` carries nothing else,
   * so the column has to resolve one workspace across all of them — and that means the row which
   * would collide is invisible to the tenant-scoped client. Without this the insert comes back as a
   * raw unique violation, which is a 500 on a mistake that has a sentence somebody can act on.
   * `whatsapp_numbers.phone_number_id` paid for this once already.
   */
  private async resolveSubdomain(raw: string, websiteId: string | null): Promise<string> {
    const subdomain = normalizeSubdomain(raw);
    const problem = subdomainProblem(subdomain);
    if (problem !== null) {
      throw AppError.validation(problem, [
        { field: 'subdomain', code: 'INVALID', message: problem },
      ]);
    }

    const holder = await withPlatformScope(
      'websites: a subdomain can only resolve one workspace',
      async () =>
        this.db.client.website.findFirst({
          where: { subdomain },
          select: { id: true, organizationId: true },
        }),
    );
    if (holder && holder.id !== websiteId) {
      throw AppError.businessRule(`The address “${subdomain}” is already taken. Try another.`);
    }
    return subdomain;
  }

  private async requireWebsite(id: string) {
    const row = await this.db.client.website.findFirst({ where: { id, deletedAt: null } });
    // 404 rather than 403: a malformed id, another tenant's id and a deleted one must be
    // indistinguishable, or the shape of an id becomes an oracle.
    if (!row) throw AppError.notFound('Website not found');
    return row;
  }

  async list(query: ListWebsitesQuery) {
    const rows = await this.db.client.website.findMany({
      where: { deletedAt: null, ...(query.status ? { status: query.status } : {}) },
      orderBy: [{ updatedAt: 'desc' }],
      take: query.limit + 1,
    });
    // `hasMore` from `limit + 1` rows rather than inferred from a full page, which is wrong exactly
    // when the total is a multiple of the limit.
    const hasMore = rows.length > query.limit;
    const items = hasMore ? rows.slice(0, query.limit) : rows;
    return { items, pagination: { limit: query.limit, hasMore } };
  }

  async findOne(id: string) {
    const website = await this.requireWebsite(id);
    const pages = await this.db.client.websitePage.findMany({
      where: { websiteId: id },
      orderBy: [{ sortOrder: 'asc' }, { path: 'asc' }],
    });
    return { ...website, pages };
  }

  async create(input: CreateWebsiteInput) {
    const principal = tenantContext.require('websites.create');
    const actorId = this.requireActor(principal.actorId);
    const subdomain = await this.resolveSubdomain(input.subdomain, null);
    const id = newId();

    await this.db.client.$transaction(async (tx) => {
      await tx.website.create({
        data: {
          id,
          organizationId: principal.organizationId,
          name: input.name,
          subdomain,
          templateCode: input.templateCode ?? null,
          createdById: actorId,
        },
      });
      // A site with no pages is a site the editor opens on nothing, so the home page comes with it.
      // It is a draft: creating a website must not put anything in front of the public.
      await tx.websitePage.create({
        data: {
          id: newId(),
          organizationId: principal.organizationId,
          websiteId: id,
          path: WEBSITE_HOME_PATH,
          title: input.name,
          isHome: true,
          status: 'draft',
        },
      });
      await this.audit.recordInTransaction(tx, {
        action: 'website.created',
        resourceType: 'website',
        resourceId: id,
        after: { name: input.name, subdomain, templateCode: input.templateCode ?? null },
      });
    });

    return this.findOne(id);
  }

  async update(id: string, input: UpdateWebsiteInput) {
    const existing = await this.requireWebsite(id);
    const subdomain =
      input.subdomain === undefined ? undefined : await this.resolveSubdomain(input.subdomain, id);

    await this.db.client.$transaction(async (tx) => {
      await tx.website.update({
        where: { id },
        data: {
          ...(input.name === undefined ? {} : { name: input.name }),
          ...(subdomain === undefined ? {} : { subdomain }),
          ...(input.theme === undefined ? {} : { theme: input.theme as object }),
          ...(input.seoDefaults === undefined ? {} : { seoDefaults: input.seoDefaults as object }),
        },
      });
      await this.audit.recordInTransaction(tx, {
        action: 'website.updated',
        resourceType: 'website',
        resourceId: id,
        before: { name: existing.name, subdomain: existing.subdomain },
        after: { name: input.name ?? existing.name, subdomain: subdomain ?? existing.subdomain },
      });
    });

    // Editing the draft deliberately does not touch `publishedVersionId` or `status`: what a
    // visitor sees changes when somebody publishes, and not before. The test that proves it reads
    // the served snapshot after an edit.
    return this.findOne(id);
  }

  /** The registry an editor renders its controls from (`FR-WEB-2`). */
  catalogue() {
    // Served rather than bundled, for the reason the automation catalogue is: the editor renders
    // from this response, so adding a block type reaches a running editor without a frontend
    // release. The renderer is the half that does need one.
    //
    // The reference sources travel with it, in `meta`: a `reference` parameter names a kind, and a
    // picker with no endpoint behind it renders empty — which looks exactly like a workspace with
    // no forms. The envelope merges `meta` and would discard any other sibling key, which is why
    // this is not a third top-level field.
    return {
      items: WEBSITE_BLOCKS,
      pagination: { limit: WEBSITE_BLOCKS.length, hasMore: false },
      meta: {
        references: REFERENCE_KINDS.map((kind) => ({ kind, source: REFERENCE_SOURCES[kind] })),
      },
    };
  }

  /**
   * Refuses blocks the registry does not accept, with the problems addressed at the rows they
   * belong to.
   *
   * Step 1 stored `blocks` uninterpreted, which was right then — there was no registry to check
   * against. Now there is, and the asymmetry matters: this refuses an unknown type on **write**
   * while the renderer tolerates one on **read**, because a rollback to an older release's snapshot
   * must not blank a live site.
   */
  private async assertBlocks(blocks: unknown): Promise<void> {
    const problems = [...validateBlocks(blocks)];

    // Shape is all the shared validator can check. Whether a referenced row **exists in this
    // workspace** is a question only a query answers, and skipping it would let a page name
    // another tenant's form — the scoped client makes that row invisible, so "somebody else's
    // form" and "no such form" are the same refusal, which is the right pair.
    if (problems.length === 0 && Array.isArray(blocks)) {
      for (const [index, raw] of blocks.entries()) {
        const block = (typeof raw === 'object' && raw !== null ? raw : {}) as {
          type?: unknown;
          params?: unknown;
        };
        const spec = typeof block.type === 'string' ? websiteBlock(block.type) : undefined;
        if (spec === undefined) continue;
        const params = (
          typeof block.params === 'object' && block.params !== null ? block.params : {}
        ) as Record<string, unknown>;
        for (const field of spec.params) {
          if (field.reference !== 'form') continue;
          const id = params[field.key];
          if (typeof id !== 'string') continue;
          const form = await this.db.client.form.findFirst({
            where: { id, deletedAt: null },
            select: { id: true },
          });
          if (form === null) {
            problems.push({
              field: `blocks[${index}].params.${field.key}`,
              code: 'INVALID',
              message: 'That form no longer exists. Choose another one.',
            });
          }
        }
      }
    }

    if (problems.length === 0) return;
    throw AppError.validation(
      problems.length === 1
        ? problems[0]!.message
        : `${problems.length} things on this page need correcting.`,
      problems.map((problem) => ({
        field: problem.field,
        code: problem.code,
        message: problem.message,
      })),
    );
  }

  private resolvePagePath(raw: string): string {
    const path = normalizePagePath(raw);
    const problem = pagePathProblem(path);
    if (problem !== null) {
      throw AppError.validation(problem, [{ field: 'path', code: 'INVALID', message: problem }]);
    }
    return path;
  }

  async createPage(websiteId: string, input: CreatePageInput) {
    const website = await this.requireWebsite(websiteId);
    const path = this.resolvePagePath(input.path);
    if (input.blocks !== undefined) await this.assertBlocks(input.blocks);
    const id = newId();

    await this.db.client.$transaction(async (tx) => {
      if (input.isHome === true) await this.clearHome(tx, websiteId);
      await tx.websitePage.create({
        data: {
          id,
          organizationId: website.organizationId,
          websiteId,
          path,
          title: input.title,
          blocks: (input.blocks ?? []) as object,
          seo: (input.seo ?? {}) as object,
          isHome: input.isHome ?? false,
          sortOrder: input.sortOrder ?? 0,
          status: input.status ?? 'draft',
        },
      });
    });
    return this.db.client.websitePage.findFirstOrThrow({ where: { id } });
  }

  /**
   * Unsets whichever page is currently the home page.
   *
   * `website_pages_one_home` is a partial unique, so making a second page the home page has to
   * clear the first in the same transaction — otherwise the insert is refused by an index and the
   * caller is told about a constraint rather than about their site.
   */
  private async clearHome(tx: DbTransaction, websiteId: string): Promise<void> {
    await tx.websitePage.updateMany({
      where: { websiteId, isHome: true },
      data: { isHome: false },
    });
  }

  async updatePage(websiteId: string, pageId: string, input: UpdatePageInput) {
    await this.requireWebsite(websiteId);
    const existing = await this.db.client.websitePage.findFirst({
      where: { id: pageId, websiteId },
    });
    if (!existing) throw AppError.notFound('Page not found');
    const path = input.path === undefined ? undefined : this.resolvePagePath(input.path);
    if (input.blocks !== undefined) await this.assertBlocks(input.blocks);

    await this.db.client.$transaction(async (tx) => {
      if (input.isHome === true && !existing.isHome) await this.clearHome(tx, websiteId);
      await tx.websitePage.update({
        where: { id: pageId },
        data: {
          ...(path === undefined ? {} : { path }),
          ...(input.title === undefined ? {} : { title: input.title }),
          ...(input.blocks === undefined ? {} : { blocks: input.blocks as object }),
          ...(input.seo === undefined ? {} : { seo: input.seo as object }),
          ...(input.isHome === undefined ? {} : { isHome: input.isHome }),
          ...(input.sortOrder === undefined ? {} : { sortOrder: input.sortOrder }),
          ...(input.status === undefined ? {} : { status: input.status }),
        },
      });
    });
    return this.db.client.websitePage.findFirstOrThrow({ where: { id: pageId } });
  }

  async deletePage(websiteId: string, pageId: string) {
    await this.requireWebsite(websiteId);
    const existing = await this.db.client.websitePage.findFirst({
      where: { id: pageId, websiteId },
    });
    if (!existing) throw AppError.notFound('Page not found');
    if (existing.isHome) {
      throw AppError.businessRule(
        'A site needs a home page. Make another page the home page first, then delete this one.',
      );
    }
    await this.db.client.websitePage.delete({ where: { id: pageId } });
    // Deleting a draft page does not change what is being served: every version that contained it
    // still contains it. That is why there is no recycle bin here.
    return { deleted: true };
  }

  async pages(websiteId: string) {
    await this.requireWebsite(websiteId);
    const items = await this.db.client.websitePage.findMany({
      where: { websiteId },
      orderBy: [{ sortOrder: 'asc' }, { path: 'asc' }],
    });
    return { items, pagination: { limit: items.length, hasMore: false } };
  }

  /** The draft as a snapshot: theme, SEO defaults, and the pages that are `published`. */
  private async snapshotOf(websiteId: string): Promise<Snapshot> {
    const website = await this.db.client.website.findFirstOrThrow({ where: { id: websiteId } });
    const pages = await this.db.client.websitePage.findMany({
      where: { websiteId, status: 'published' },
      orderBy: [{ sortOrder: 'asc' }, { path: 'asc' }],
    });
    return {
      theme: website.theme,
      seoDefaults: website.seoDefaults,
      pages: pages.map((page) => ({
        path: page.path,
        title: page.title,
        blocks: page.blocks,
        seo: page.seo,
        isHome: page.isHome,
        sortOrder: page.sortOrder,
      })),
    };
  }

  async publish(id: string) {
    const existing = await this.requireWebsite(id);
    const principal = tenantContext.require('websites.publish');
    const actorId = this.requireActor(principal.actorId);
    const snapshot = await this.snapshotOf(id);

    if (snapshot.pages.length === 0) {
      // Publishing nothing would answer 404 from a URL the owner has just been given, which reads
      // as the product being broken rather than as the site being empty.
      throw AppError.businessRule(
        'This site has no published pages yet. Mark at least one page as published, then publish the site.',
      );
    }

    const versionId = newId();
    await this.db.client.$transaction(async (tx) => {
      const version = await this.nextVersionNumber(tx, id);
      await tx.websiteVersion.create({
        data: {
          id: versionId,
          organizationId: existing.organizationId,
          websiteId: id,
          version,
          snapshot: snapshot as unknown as object,
          publishedById: actorId,
        },
      });
      await tx.website.update({
        where: { id },
        data: { publishedVersionId: versionId, status: 'published' },
      });
      await this.audit.recordInTransaction(tx, {
        action: 'website.published',
        resourceType: 'website',
        resourceId: id,
        after: { version, versionId, pages: snapshot.pages.length },
      });
      // Rule 5: the event leaves through the outbox inside the transaction that published the
      // version, so a crash between the two is impossible. The subdomain travels in the payload
      // because the renderer's cache tag is keyed on it — the site's id is deliberately not in the
      // public response, so there is no id for a tag to use.
      await this.outbox.emit(tx, [
        {
          name: 'website.published',
          aggregateType: 'website',
          aggregateId: id,
          payload: { subdomain: existing.subdomain, version, versionId },
        },
      ]);
    });

    return this.findOne(id);
  }

  async unpublish(id: string) {
    const existing = await this.requireWebsite(id);
    if (existing.status !== 'published') {
      throw AppError.businessRule('This site is not published.');
    }
    await this.db.client.$transaction(async (tx) => {
      // `published_version_id` is deliberately left set. `websites_published_has_version` is
      // one-way for exactly this: republishing is then one write, and the history of what was
      // live stays readable.
      await tx.website.update({ where: { id }, data: { status: 'draft' } });
      await this.audit.recordInTransaction(tx, {
        action: 'website.unpublished',
        resourceType: 'website',
        resourceId: id,
        before: { status: 'published', versionId: existing.publishedVersionId },
      });
      // Taking a site offline changes what the public sees as much as publishing does, so it drops
      // the same tag. A revalidation only on publish would leave a withdrawn site being served
      // from cache — the failure nobody tests for because the screen says "offline".
      await this.outbox.emit(tx, [
        {
          name: 'website.unpublished',
          aggregateType: 'website',
          aggregateId: id,
          payload: { subdomain: existing.subdomain },
        },
      ]);
    });
    return this.findOne(id);
  }

  /**
   * Rolls back to a version by publishing a **new** one that carries its snapshot (`FR-WEB-5`).
   *
   * Moving `published_version_id` backwards would be fewer writes and would make the history a lie:
   * "what was live on Tuesday" would have two answers, and a site rolled back twice would look like
   * a site nobody had touched. `restored_from_version_id` names the source, so the version list
   * reads as what happened.
   */
  async rollback(id: string, versionId: string) {
    const existing = await this.requireWebsite(id);
    const principal = tenantContext.require('websites.rollback');
    const actorId = this.requireActor(principal.actorId);

    const source = await this.db.client.websiteVersion.findFirst({
      where: { id: versionId, websiteId: id },
    });
    if (!source) throw AppError.notFound('Version not found');
    if (existing.publishedVersionId === versionId) {
      throw AppError.businessRule('That version is already the one being served.');
    }

    const newVersionId = newId();
    await this.db.client.$transaction(async (tx) => {
      const version = await this.nextVersionNumber(tx, id);
      await tx.websiteVersion.create({
        data: {
          id: newVersionId,
          organizationId: existing.organizationId,
          websiteId: id,
          version,
          // The source snapshot, unchanged. Not re-derived from the draft: the draft has moved on,
          // which is the entire reason somebody is rolling back.
          snapshot: source.snapshot as object,
          publishedById: actorId,
          restoredFromVersionId: versionId,
        },
      });
      await tx.website.update({
        where: { id },
        data: { publishedVersionId: newVersionId, status: 'published' },
      });
      await this.audit.recordInTransaction(tx, {
        action: 'website.rolled_back',
        resourceType: 'website',
        resourceId: id,
        after: { version, restoredFrom: source.version, versionId: newVersionId },
      });
      await this.outbox.emit(tx, [
        {
          name: 'website.rolled_back',
          aggregateType: 'website',
          aggregateId: id,
          payload: { subdomain: existing.subdomain, version, versionId: newVersionId },
        },
      ]);
    });

    return this.findOne(id);
  }

  private async nextVersionNumber(tx: DbTransaction, websiteId: string): Promise<number> {
    // Read inside the transaction. Two publishes of one site racing would otherwise both compute
    // the same number and the second would lose to `website_version_number_key` — which is the
    // right outcome, and a refusal rather than a wrong version.
    const latest = await tx.websiteVersion.findFirst({
      where: { websiteId },
      orderBy: [{ version: 'desc' }],
      select: { version: true },
    });
    return (latest?.version ?? 0) + 1;
  }

  async versions(id: string) {
    await this.requireWebsite(id);
    const items = await this.db.client.websiteVersion.findMany({
      where: { websiteId: id },
      orderBy: [{ version: 'desc' }],
      take: 100,
      select: {
        id: true,
        version: true,
        publishedAt: true,
        publishedById: true,
        restoredFromVersionId: true,
      },
    });
    return { items, pagination: { limit: 100, hasMore: items.length === 100 } };
  }

  /** What a visitor would be served: the published version's snapshot, never the draft. */
  async servedSnapshot(id: string) {
    const website = await this.requireWebsite(id);
    if (website.status !== 'published' || website.publishedVersionId === null) {
      throw AppError.notFound('Website not found');
    }
    const version = await this.db.client.websiteVersion.findFirstOrThrow({
      where: { id: website.publishedVersionId },
    });
    return { version: version.version, versionId: version.id, snapshot: version.snapshot };
  }
}

/** The transaction client shape the methods above share. */
type DbTransaction = Parameters<Parameters<DbService['client']['$transaction']>[0]>[0];
