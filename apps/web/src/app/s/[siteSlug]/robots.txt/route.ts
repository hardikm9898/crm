import { loadPublishedSiteOrNull } from '@/lib/websites';
import { robotsTxt } from '@/lib/website-seo';

/**
 * A site's `robots.txt` (`FR-WEB-3`).
 *
 * **A literal route segment, which is what makes it reachable at all.** The sibling
 * `[[...path]]` catch-all would otherwise match `robots.txt` as a page path; Next gives a static
 * segment precedence over a dynamic one and a dynamic one over a catch-all, so this wins. It also
 * cannot collide with a tenant's own page, and that is not luck: `PAGE_SEGMENT_SHAPE` allows only
 * letters, digits and hyphens, so no page path can ever contain a dot. The guarantee was paid for
 * in step 1 and is worth stating here, because the obvious alternative — a reserved-path list —
 * would have been a second rule that could drift from the first.
 *
 * **Where a crawler actually looks.** `robots.txt` is defined per *host*, at the host's root. On a
 * deployment with `WEBSITE_BASE_DOMAIN` set, this file is served at `acme.leados.app/robots.txt`
 * through the same subdomain rewrite that serves the pages, which is exactly where a crawler asks.
 * Without that variable — the path-based deployment, which is what runs today — it lives at
 * `/s/acme/robots.txt`, which is correct, reachable, and **not** where any crawler will ask. That
 * is a property of the deployment rather than of this file, and it is stated rather than papered
 * over: step 6 is what makes the host real.
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
  if (site === null) {
    // A site that is not published gets a crawl-blocking file rather than a 404. A 404 on
    // `robots.txt` is read as "no restrictions", which is the opposite of the answer an unpublished
    // address should give, and the unpublished address is precisely the one nobody wants indexed.
    return new Response('User-agent: *\nDisallow: /\n', {
      status: 200,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  }
  return new Response(robotsTxt(site), {
    status: 200,
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  });
}
