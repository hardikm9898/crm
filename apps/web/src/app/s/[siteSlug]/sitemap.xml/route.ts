import { loadPublishedSiteOrNull } from '@/lib/websites';
import { sitemapXml } from '@/lib/website-seo';

/**
 * A site's `sitemap.xml` (`FR-WEB-3`).
 *
 * A literal segment for the same reason `robots.txt` is one, and with the same guarantee behind
 * it: a page path cannot contain a dot, so a tenant cannot shadow this.
 *
 * **It lists published pages and only published pages, and that holds structurally.** The document
 * is built from the published version's snapshot, which contains the pages that were `published`
 * at the moment of the publish — so a draft page is not filtered out here, it was never in the
 * input. That is step 2's draft-leak guarantee one layer out, and it is the reason this route
 * cannot leak a draft even if it asked wrongly.
 *
 * Not Next's `sitemap.ts` convention: that generates from `generateSitemaps` and a typed array,
 * which is a fine fit for a fixed set of routes and a poor one for a document whose content is a
 * tenant's snapshot and whose correctness is the thing being tested. A plain route handler is
 * assertable byte for byte.
 */
export const dynamicParams = true;

export async function generateStaticParams(): Promise<{ siteSlug: string }[]> {
  return [];
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ siteSlug: string }> },
): Promise<Response> {
  const { siteSlug } = await params;
  let site;
  try {
    site = await loadPublishedSiteOrNull(siteSlug);
  } catch {
    // 503, not the answer for a missing site. A crawler reads 503 as "ask again later" and
    // explicitly does not treat it as a change of permission, so an API blip cannot be cached as
    // an instruction to stop crawling a site that is live.
    return new Response('Temporarily unavailable', {
      status: 503,
      headers: { 'content-type': 'text/plain; charset=utf-8', 'retry-after': '120' },
    });
  }
  // 404 here, unlike `robots.txt`: a missing sitemap means "nothing to tell you", which is true,
  // while a missing `robots.txt` is read as "crawl everything", which would not be.
  if (site === null) return new Response('Not found', { status: 404 });

  return new Response(sitemapXml(site), {
    status: 200,
    headers: { 'content-type': 'application/xml; charset=utf-8' },
  });
}
