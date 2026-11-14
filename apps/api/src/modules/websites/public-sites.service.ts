import { Inject, Injectable } from '@nestjs/common';
import {
  AppError,
  checkPageSeo,
  siteBaseUrl,
  websiteBlock,
  withPlatformScope,
} from '@leados/shared';
import { APP_CONFIG } from '../../infra/config/config.module.js';
import type { AppConfig } from '../../infra/config/config.schema.js';
import { DbService } from '../../infra/db/db.service.js';

/**
 * What a visitor is served (`FR-WEB-5`).
 *
 * One endpoint, one read: the **published version's snapshot**, whole. A per-page endpoint would be
 * the wrong unit — a snapshot is what publishing produces, so splitting it would mean a page
 * assembled from two reads that can disagree about which publish they came from, and the renderer
 * would have to stitch a site back together from parts it cannot prove belong to each other.
 *
 * **The subdomain is the whole of the tenant resolution, and it is all the request carries.** That
 * is the same shape as a public form's key (ADR-0029) and as `whatsapp_numbers.phone_number_id`:
 * the read therefore runs under `withPlatformScope`, because a `@Public()` route has no principal
 * and the tenant-scoped client throws without one. A route that reached for `db.client` here would
 * answer 500 to **every** visitor, including the ones asking for a site that does not exist, and
 * the generic body would say nothing about why — the integration framework's inbound door paid for
 * exactly that.
 */
@Injectable()
export class PublicSitesService {
  constructor(
    private readonly db: DbService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /**
   * Resolves a subdomain to the snapshot being served, or 404.
   *
   * A site that exists and is not published is **indistinguishable** from one that never existed,
   * which is step 2's second exit criterion. The alternative — a distinct "not published yet"
   * response — would make the existence of a draft, its name and its owner's plans readable by
   * anybody who guessed the address, and a workspace's unreleased site is not public information.
   */
  async snapshotFor(subdomain: string) {
    const normalized = subdomain.trim().toLowerCase();

    const site = await withPlatformScope(
      'websites: a subdomain is the only thing a visitor request carries',
      async () =>
        this.db.client.website.findFirst({
          where: { subdomain: normalized, deletedAt: null, status: 'published' },
          select: {
            id: true,
            organizationId: true,
            name: true,
            subdomain: true,
            publishedVersionId: true,
          },
        }),
    );

    // `publishedVersionId` cannot be null on a published row — `websites_published_has_version`
    // makes that unrepresentable — but the type is nullable, and a `!` here would be a claim about
    // a constraint rather than a check. The branch costs nothing and cannot rot.
    if (!site || site.publishedVersionId === null) throw AppError.notFound('Site not found');

    const version = await withPlatformScope(
      'websites: the served version belongs to the site the subdomain resolved',
      async () =>
        this.db.client.websiteVersion.findFirst({
          where: { id: site.publishedVersionId as string, websiteId: site.id },
          select: { id: true, version: true, publishedAt: true, snapshot: true },
        }),
    );
    if (!version) throw AppError.notFound('Site not found');

    const [forms, redirects, business, products] = await Promise.all([
      // Everything in this list is resolved **now** rather than read out of the snapshot, and the
      // dividing line is the one `website-seo.ts` states: versioned is what somebody wrote, live
      // is what the business is. A form's key, where a retired address now points, the trading
      // hours and a product's price are all the second kind.
      this.resolveForms(site.organizationId, version.snapshot),
      this.resolveRedirects(site.id),
      this.resolveBusiness(site.organizationId, version.snapshot),
      this.resolveProducts(site.organizationId, version.snapshot),
    ]);

    return {
      site: {
        name: site.name,
        subdomain: site.subdomain,
        // The one place that answers "where does this site live", so a canonical URL and a sitemap
        // entry cannot disagree. Computed here rather than in the renderer because step 6's answer
        // — a verified custom domain — is a row in this database, not a variable in another app.
        baseUrl: siteBaseUrl(site.subdomain, {
          webOrigin: this.config.WEB_ORIGIN,
          baseDomain: this.config.WEBSITE_BASE_DOMAIN,
        }),
      },
      version: version.version,
      versionId: version.id,
      publishedAt: version.publishedAt,
      snapshot: version.snapshot,
      forms,
      redirects,
      business,
      products,
    };
  }

  /**
   * The site's redirects, in full.
   *
   * Sent whole rather than filtered against the snapshot's pages, because the renderer looks for a
   * page **first** and that precedence is the single rule: a page at an address wins over a rule
   * saying the address moved. Filtering here as well would be a second place that decides, and the
   * list is a handful of rows on any real site.
   */
  private async resolveRedirects(
    websiteId: string,
  ): Promise<{ fromPath: string; toPath: string; kind: string }[]> {
    return withPlatformScope('websites: a visitor request carries only the subdomain', async () =>
      this.db.client.websiteRedirect.findMany({
        where: { websiteId },
        select: { fromPath: true, toPath: true, kind: true },
        orderBy: { fromPath: 'asc' },
      }),
    );
  }

  /**
   * The business behind the site, for `LocalBusiness` structured data.
   *
   * **Assembled from three places on purpose, none of them a copy of another.** The name, the
   * country and the logo are the organization's profile; the street address and the kind of
   * business are the site's SEO defaults, because nothing else in the product knows them; and the
   * opening hours are the **workspace-wide `working_hours` rows** that `seedWorkingHours` writes
   * and `SlaCalendarService` already reads.
   *
   * Asking somebody to type their trading hours a second time into a website screen is the defect
   * `notification_preferences.quiet_hours` was corrected for — one copy per reader, each able to
   * disagree with the others — and it would be worse here, because the copy that went stale would
   * be the one customers read.
   *
   * `userId: null, branchId: null` is the workspace's own calendar. A branch's hours are
   * deliberately not used: a site is the business, and picking one branch's hours to publish as
   * the business's would be a guess with no basis.
   */
  private async resolveBusiness(organizationId: string, snapshot: unknown): Promise<unknown> {
    const defaults = (snapshot as { seoDefaults?: unknown } | null)?.seoDefaults;
    const declared = (typeof defaults === 'object' && defaults !== null ? defaults : {}) as Record<
      string,
      unknown
    >;
    const business = (
      typeof declared.business === 'object' && declared.business !== null ? declared.business : null
    ) as Record<string, unknown> | null;

    const [organization, hours] = await withPlatformScope(
      'websites: the business behind a public site is read without a principal',
      async () =>
        Promise.all([
          this.db.client.organization.findFirst({
            where: { id: organizationId },
            select: { name: true, legalName: true, country: true, logoUrl: true, timezone: true },
          }),
          this.db.client.workingHours.findMany({
            where: { organizationId, userId: null, branchId: null, isWorking: true },
            select: { dayOfWeek: true, startMinute: true, endMinute: true },
            orderBy: [{ dayOfWeek: 'asc' }, { startMinute: 'asc' }],
          }),
        ]),
    );
    if (organization === null) return null;

    return {
      name: organization.name,
      legalName: organization.legalName,
      country: organization.country,
      logoUrl: organization.logoUrl,
      timezone: organization.timezone,
      kind: typeof business?.kind === 'string' ? business.kind : 'LocalBusiness',
      streetAddress: typeof business?.streetAddress === 'string' ? business.streetAddress : null,
      locality: typeof business?.locality === 'string' ? business.locality : null,
      region: typeof business?.region === 'string' ? business.region : null,
      postalCode: typeof business?.postalCode === 'string' ? business.postalCode : null,
      phone: typeof business?.phone === 'string' ? business.phone : null,
      priceRange: typeof business?.priceRange === 'string' ? business.priceRange : null,
      // Minutes from midnight become `HH:MM` here rather than in the renderer: schema.org wants
      // that format, the conversion is arithmetic, and doing it once keeps it under one test.
      openingHours: hours.map((row) => ({
        dayOfWeek: row.dayOfWeek,
        opens: minutesAsClock(row.startMinute),
        closes: minutesAsClock(row.endMinute),
      })),
    };
  }

  /**
   * The products this site's pages name, keyed by product id, for `Product` structured data.
   *
   * Live rather than snapshotted, and that is the whole reason this is a reference and not six
   * typed-in fields. A price frozen into a published version goes stale the moment somebody edits
   * the catalogue — in structured data, where a price that disagrees with the page is a penalty
   * rather than a typo, and where nobody would ever notice. A deactivated or deleted product is
   * **absent** from the map, and the renderer then emits no `Product` for that page: structured
   * data claiming something is for sale when it has been withdrawn is worse than none.
   *
   * `priceMinor` is a `BigInt` in Prisma and must not reach JSON as one — `JSON.stringify` throws
   * on a BigInt, which would be a 500 on every page of a site that named a product.
   */
  private async resolveProducts(
    organizationId: string,
    snapshot: unknown,
  ): Promise<Record<string, unknown>> {
    const ids = new Set<string>();
    const pages = (snapshot as { pages?: unknown } | null)?.pages;
    if (!Array.isArray(pages)) return {};
    for (const page of pages) {
      const seo = (page as { seo?: unknown }).seo;
      // Read through the same validator a write goes through, so an unknown key in an older
      // snapshot is ignored rather than reaching for a field that is not there.
      const { normalized } = checkPageSeo(seo ?? {});
      if (normalized.productId !== undefined) ids.add(normalized.productId);
    }
    if (ids.size === 0) return {};

    const rows = await withPlatformScope(
      'websites: a published page names the products it describes',
      async () =>
        this.db.client.product.findMany({
          // Written out by hand because this read is platform-scoped: without it a page could name
          // another tenant's product and publish their price.
          where: { id: { in: [...ids] }, organizationId, isActive: true, deletedAt: null },
          select: {
            id: true,
            name: true,
            description: true,
            sku: true,
            priceMinor: true,
            currency: true,
          },
        }),
    );
    return Object.fromEntries(
      rows.map((row) => [
        row.id,
        {
          name: row.name,
          description: row.description,
          sku: row.sku,
          priceMinor: Number(row.priceMinor),
          currency: row.currency,
        },
      ]),
    );
  }

  /**
   * The public key of every form a page places, keyed by the form's id.
   *
   * **Resolved at read time rather than frozen into the snapshot**, which is the opposite of how
   * everything else on a published page works, and deliberately so. A page is versioned because
   * its *content* is a thing somebody publishes; a form is a live object whose questions change and
   * whose key can be rotated. Snapshotting the key would mean a rotated key kept working on the
   * live site — the one thing rotation exists to stop — and snapshotting the questions would mean
   * editing a form left every published page asking the old ones.
   *
   * Returned beside the snapshot instead of injected into it, because the snapshot is immutable and
   * a reader comparing two versions must not find a difference this function invented.
   *
   * A form that has been deactivated or deleted is **absent** from the map rather than reported.
   * The renderer draws nothing for that block, which matches what `/f/:key` does with a dead key:
   * a form switched off is not an error on somebody's homepage.
   */
  private async resolveForms(
    organizationId: string,
    snapshot: unknown,
  ): Promise<Record<string, { key: string; name: string }>> {
    const ids = new Set<string>();
    const pages = (snapshot as { pages?: unknown } | null)?.pages;
    if (!Array.isArray(pages)) return {};

    for (const page of pages) {
      const blocks = (page as { blocks?: unknown }).blocks;
      if (!Array.isArray(blocks)) continue;
      for (const raw of blocks) {
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
          if (typeof id === 'string' && id.length > 0) ids.add(id);
        }
      }
    }
    if (ids.size === 0) return {};

    const rows = await withPlatformScope(
      'websites: a published page names the forms it places',
      async () =>
        this.db.client.form.findMany({
          // `organizationId` is written out by hand because this read is platform-scoped: without
          // it a page could name another tenant's form id and be handed their key. The write path
          // already refuses that, and this is the half that does not trust it to have.
          where: { id: { in: [...ids] }, organizationId, isActive: true, deletedAt: null },
          select: { id: true, publicKey: true, name: true },
        }),
    );

    return Object.fromEntries(rows.map((row) => [row.id, { key: row.publicKey, name: row.name }]));
  }
}

/** Minutes from midnight as `HH:MM`, which is the only time format schema.org accepts. */
function minutesAsClock(minutes: number): string {
  const safe = Math.max(0, Math.min(24 * 60, Math.trunc(minutes)));
  const hour = Math.floor(safe / 60);
  const minute = safe % 60;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}
