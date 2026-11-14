import { Injectable } from '@nestjs/common';
import {
  AppError,
  REFERENCE_KINDS,
  WEBSITE_BLOCKS,
  WEBSITE_HOME_PATH,
  checkPageSeo,
  checkSeoDefaults,
  newId,
  normalizePagePath,
  normalizeSubdomain,
  pagePathProblem,
  redirectTargetProblem,
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
  CreateRedirectInput,
  CreateWebsiteInput,
  ListWebsitesQuery,
  UpdatePageInput,
  UpdateRedirectInput,
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
    const seoDefaults =
      input.seoDefaults === undefined ? undefined : this.assertSeoDefaults(input.seoDefaults);

    await this.db.client.$transaction(async (tx) => {
      await tx.website.update({
        where: { id },
        data: {
          ...(input.name === undefined ? {} : { name: input.name }),
          ...(subdomain === undefined ? {} : { subdomain }),
          ...(input.theme === undefined ? {} : { theme: input.theme as object }),
          ...(seoDefaults === undefined ? {} : { seoDefaults }),
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
   * Refuses SEO settings the registry does not accept, and returns the value to store.
   *
   * Returns the normalised value rather than only validating, so the caller never normalises a
   * second time and a screen cannot end up storing what it typed while the API reports what it
   * meant. The `@ `, the handle extracted from a pasted profile URL and the trimming all happen
   * here, once — a screen that cleaned the value too would be a second answer to one question, and
   * the two would eventually disagree.
   */
  private assertSeoDefaults(input: unknown): object {
    const { problems, normalized } = checkSeoDefaults(input);
    if (problems.length > 0) {
      throw AppError.validation('Some of the SEO settings need correcting.', problems);
    }
    return normalized as object;
  }

  /**
   * Refuses a page's SEO overrides, checks the product it names, and returns the value to store.
   *
   * The shape is all the shared validator can see; whether the product exists, and whether it
   * belongs to this workspace, is a question only a query answers. It goes through the
   * **tenant-scoped** client, which makes "another workspace's product" and "no such product" the
   * same refusal — a distinguishable answer would turn a product id into an oracle, the same
   * reasoning `UuidParamPipe` answers 404 for.
   */
  private async assertPageSeo(input: unknown, prefix = 'seo'): Promise<object> {
    const { problems, normalized } = checkPageSeo(input, prefix);
    if (problems.length > 0) {
      throw AppError.validation('Some of the SEO settings need correcting.', problems);
    }
    if (normalized.productId !== undefined) {
      const product = await this.db.client.product.findFirst({
        where: { id: normalized.productId, deletedAt: null },
        select: { id: true },
      });
      if (!product) {
        throw AppError.validation('Some of the SEO settings need correcting.', [
          {
            field: `${prefix}.productId`,
            code: 'INVALID',
            message: 'That product no longer exists. Choose another.',
          },
        ]);
      }
    }
    return normalized as object;
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
    const seo = await this.assertPageSeo(input.seo ?? {});
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
          seo,
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
    const seo = input.seo === undefined ? undefined : await this.assertPageSeo(input.seo);

    await this.db.client.$transaction(async (tx) => {
      if (input.isHome === true && !existing.isHome) await this.clearHome(tx, websiteId);
      await tx.websitePage.update({
        where: { id: pageId },
        data: {
          ...(path === undefined ? {} : { path }),
          ...(input.title === undefined ? {} : { title: input.title }),
          ...(input.blocks === undefined ? {} : { blocks: input.blocks as object }),
          ...(seo === undefined ? {} : { seo }),
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

  // -------------------------------------------------------------------------
  // Redirects (`FR-WEB-3`)
  // -------------------------------------------------------------------------

  /**
   * A site's redirects, each marked with whether a page now shadows it.
   *
   * `shadowed` is computed rather than stored. The renderer looks for a page first — which is the
   * right precedence, because a real page at an address must win over a rule saying that address
   * has moved — so a page created at a `from_path` leaves the redirect in place and never firing.
   * Storing a flag would be a second answer to "is there a page here"; computing it means the
   * screen can say *why* a redirect is doing nothing, which is otherwise a mystery somebody opens
   * a support ticket about.
   */
  async redirects(websiteId: string) {
    await this.requireWebsite(websiteId);
    const [items, pages] = await Promise.all([
      this.db.client.websiteRedirect.findMany({
        where: { websiteId },
        orderBy: [{ fromPath: 'asc' }],
      }),
      this.db.client.websitePage.findMany({ where: { websiteId }, select: { path: true } }),
    ]);
    const pagePaths = new Set(pages.map((page) => page.path));
    return {
      items: items.map((row) => ({ ...row, shadowed: pagePaths.has(row.fromPath) })),
      pagination: { limit: items.length, hasMore: false },
    };
  }

  /** The `from_path` of a redirect, through the same normalisation a page path gets. */
  private resolveRedirectFrom(raw: string): string {
    const path = normalizePagePath(raw);
    const problem = pagePathProblem(path);
    if (problem !== null) {
      throw AppError.validation(problem, [
        { field: 'fromPath', code: 'INVALID', message: problem },
      ]);
    }
    return path;
  }

  private resolveRedirectTo(raw: string): string {
    const target = raw.trim();
    const problem = redirectTargetProblem(target);
    if (problem !== null) {
      throw AppError.validation(problem, [{ field: 'toPath', code: 'INVALID', message: problem }]);
    }
    return target;
  }

  /**
   * Works out what a new or edited redirect should actually store, and what else has to move.
   *
   * **The invariant it keeps: no `to_path` is ever another row's `from_path` on the same site.**
   * That is what makes resolving a redirect at request time a single lookup with no loop guard,
   * and it is kept by collapsing rather than by refusing. Renaming `/a` to `/b` and later `/b` to
   * `/c` is an ordinary sequence of events; a product that refused the second rename because of
   * the first would be unusable, and one that allowed the chain would serve two hops to a crawler
   * that counts them.
   *
   * So two things happen on every write:
   *
   * - the destination is **followed** — pointing a new redirect at an address that has itself
   *   moved stores the final address, not the intermediate one;
   * - everything pointing **at** this redirect's source is rewritten to the new destination.
   *
   * Either can produce a row whose source and destination are the same, which is a loop a browser
   * reports as `ERR_TOO_MANY_REDIRECTS`. That is refused with a sentence rather than written and
   * caught by `website_redirects_not_to_self`, because a constraint name is not an explanation.
   */
  private async planRedirect(
    websiteId: string,
    fromPath: string,
    toPath: string,
    excludeId: string | null,
  ): Promise<{ target: string; rewrites: { id: string; fromPath: string }[] }> {
    const siblings = await this.db.client.websiteRedirect.findMany({
      where: { websiteId, ...(excludeId === null ? {} : { id: { not: excludeId } }) },
      select: { id: true, fromPath: true, toPath: true },
    });

    // Follow the destination one hop. One is enough *because* of the invariant: if `/c` had itself
    // moved on, the row for `/c` would already be pointing at the final address.
    const target = siblings.find((row) => row.fromPath === toPath)?.toPath ?? toPath;

    if (target === fromPath) {
      // Two sentences, because they are two situations. Somebody who typed one address twice has
      // made an obvious slip; somebody who typed two different addresses has closed a circle they
      // cannot see, and telling them it "goes back to itself" reads as though they had not.
      const literal = toPath === fromPath;
      throw AppError.validation(
        literal
          ? 'That would send this address back to itself.'
          : 'That would close a circle of redirects.',
        [
          {
            field: 'toPath',
            code: 'INVALID',
            message: literal
              ? 'An address cannot redirect to itself.'
              : `${toPath} already redirects to ${target}, so this would be a loop.`,
          },
        ],
      );
    }

    const rewrites = siblings
      .filter((row) => row.toPath === fromPath)
      .map((row) => ({ id: row.id, fromPath: row.fromPath }));
    const looping = rewrites.find((row) => row.fromPath === target);
    if (looping !== undefined) {
      throw AppError.validation('That would send two addresses in a circle.', [
        {
          field: 'toPath',
          code: 'INVALID',
          message: `${looping.fromPath} already redirects to ${fromPath}, so sending ${fromPath} to ${target} would be a loop.`,
        },
      ]);
    }

    return { target, rewrites };
  }

  /** Refuses a redirect whose source is a page: the page wins, so the redirect could never fire. */
  private async assertNoPageAt(websiteId: string, fromPath: string): Promise<void> {
    const page = await this.db.client.websitePage.findFirst({
      where: { websiteId, path: fromPath },
      select: { title: true },
    });
    if (page) {
      throw AppError.validation('There is already a page at that address.', [
        {
          field: 'fromPath',
          code: 'INVALID',
          message: `“${page.title}” is at ${fromPath}, and a page always wins over a redirect — so this one would never do anything. Move or delete the page first.`,
        },
      ]);
    }
  }

  async createRedirect(websiteId: string, input: CreateRedirectInput) {
    const website = await this.requireWebsite(websiteId);
    const actorId = this.requireActor(tenantContext.require('websites.createRedirect').actorId);
    const fromPath = this.resolveRedirectFrom(input.fromPath);
    const toPath = this.resolveRedirectTo(input.toPath);
    await this.assertNoPageAt(websiteId, fromPath);

    const existing = await this.db.client.websiteRedirect.findFirst({
      where: { websiteId, fromPath },
      select: { id: true },
    });
    if (existing) {
      throw AppError.validation('That address already redirects somewhere.', [
        {
          field: 'fromPath',
          code: 'INVALID',
          message: `${fromPath} already has a redirect. Edit that one rather than adding a second, which would be two answers to one question.`,
        },
      ]);
    }

    const { target, rewrites } = await this.planRedirect(websiteId, fromPath, toPath, null);
    const id = newId();

    await this.db.client.$transaction(async (tx) => {
      await tx.websiteRedirect.create({
        data: {
          id,
          organizationId: website.organizationId,
          websiteId,
          fromPath,
          toPath: target,
          kind: input.kind ?? 'permanent',
          ...(input.note === undefined ? {} : { note: input.note }),
          createdById: actorId,
        },
      });
      await this.applyRedirectRewrites(tx, rewrites, target);
      await this.audit.recordInTransaction(tx, {
        action: 'website.redirect_created',
        resourceType: 'website',
        resourceId: websiteId,
        // The collapse is audited because it changed rows nobody asked about in this request.
        after: {
          fromPath,
          toPath: target,
          asked: toPath,
          collapsed: rewrites.map((r) => r.fromPath),
        },
      });
      await this.emitRedirectsChanged(tx, websiteId, website.subdomain);
    });

    return this.db.client.websiteRedirect.findFirstOrThrow({ where: { id } });
  }

  async updateRedirect(websiteId: string, redirectId: string, input: UpdateRedirectInput) {
    const website = await this.requireWebsite(websiteId);
    const existing = await this.db.client.websiteRedirect.findFirst({
      where: { id: redirectId, websiteId },
    });
    if (!existing) throw AppError.notFound('Redirect not found');

    const fromPath =
      input.fromPath === undefined ? existing.fromPath : this.resolveRedirectFrom(input.fromPath);
    const toPath =
      input.toPath === undefined ? existing.toPath : this.resolveRedirectTo(input.toPath);
    if (fromPath !== existing.fromPath) await this.assertNoPageAt(websiteId, fromPath);

    const { target, rewrites } = await this.planRedirect(websiteId, fromPath, toPath, redirectId);

    await this.db.client.$transaction(async (tx) => {
      await tx.websiteRedirect.update({
        where: { id: redirectId },
        data: {
          fromPath,
          toPath: target,
          ...(input.kind === undefined ? {} : { kind: input.kind }),
          ...(input.note === undefined ? {} : { note: input.note }),
        },
      });
      await this.applyRedirectRewrites(tx, rewrites, target);
      await this.audit.recordInTransaction(tx, {
        action: 'website.redirect_updated',
        resourceType: 'website',
        resourceId: websiteId,
        before: { fromPath: existing.fromPath, toPath: existing.toPath, kind: existing.kind },
        after: { fromPath, toPath: target, kind: input.kind ?? existing.kind },
      });
      await this.emitRedirectsChanged(tx, websiteId, website.subdomain);
    });

    return this.db.client.websiteRedirect.findFirstOrThrow({ where: { id: redirectId } });
  }

  async deleteRedirect(websiteId: string, redirectId: string) {
    const website = await this.requireWebsite(websiteId);
    const existing = await this.db.client.websiteRedirect.findFirst({
      where: { id: redirectId, websiteId },
    });
    if (!existing) throw AppError.notFound('Redirect not found');

    await this.db.client.$transaction(async (tx) => {
      await tx.websiteRedirect.delete({ where: { id: redirectId } });
      await this.audit.recordInTransaction(tx, {
        action: 'website.redirect_deleted',
        resourceType: 'website',
        resourceId: websiteId,
        before: { fromPath: existing.fromPath, toPath: existing.toPath },
      });
      await this.emitRedirectsChanged(tx, websiteId, website.subdomain);
    });
    return { deleted: true };
  }

  private async applyRedirectRewrites(
    tx: DbTransaction,
    rewrites: readonly { id: string }[],
    target: string,
  ): Promise<void> {
    for (const rewrite of rewrites) {
      await tx.websiteRedirect.update({ where: { id: rewrite.id }, data: { toPath: target } });
    }
  }

  /**
   * Rule 5: the event leaves through the outbox inside the transaction that changed the redirect.
   *
   * It carries the subdomain because the renderer's cache tag is keyed on it, and it has to be
   * emitted on a *delete* as much as on a create: a redirect somebody removed that went on
   * redirecting from cache would be a page nobody could reach back, with no screen admitting it.
   */
  private async emitRedirectsChanged(
    tx: DbTransaction,
    websiteId: string,
    subdomain: string,
  ): Promise<void> {
    await this.outbox.emit(tx, [
      {
        name: 'website.redirects_changed',
        aggregateType: 'website',
        aggregateId: websiteId,
        payload: { subdomain },
      },
    ]);
  }
}

/** The transaction client shape the methods above share. */
type DbTransaction = Parameters<Parameters<DbService['client']['$transaction']>[0]>[0];
