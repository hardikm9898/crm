import { Injectable } from '@nestjs/common';
import { AppError, websiteBlock, withPlatformScope } from '@leados/shared';
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
  constructor(private readonly db: DbService) {}

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

    return {
      site: { name: site.name, subdomain: site.subdomain },
      version: version.version,
      versionId: version.id,
      publishedAt: version.publishedAt,
      snapshot: version.snapshot,
      // Resolved now, not snapshotted (`FR-WEB-6`). See `resolveForms`.
      forms: await this.resolveForms(site.organizationId, version.snapshot),
    };
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
