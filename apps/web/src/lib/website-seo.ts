import type { Metadata } from 'next';
import {
  WEBSITE_HOME_PATH,
  type PublishedSite,
  type SiteBusiness,
  type SiteProduct,
  type SnapshotPage,
} from '@/lib/websites';

/**
 * What a published page tells a crawler (`FR-WEB-3`).
 *
 * Pure functions, deliberately: the sitemap's one hard guarantee — it lists published pages and
 * **only** published pages — is then assertable in Node without a browser or a running site, and
 * the HTTP test becomes a second, independent check rather than the only one. The same reasoning
 * put `themeStyle` and `pageAt` in `lib/websites.ts`.
 *
 * Hand-written here rather than imported from `@leados/shared` for the reason every `lib/*` module
 * in this app is: that package's entry point reaches `node:async_hooks`, and a client component
 * that transitively imports it fails `next build`. `website-seo.spec.ts` reconciles the key lists
 * against the real registry, because a spec runs in Node and may import both.
 */

/** Every key this renderer reads from a page's `seo`. Reconciled against the registry by a spec. */
export const PAGE_SEO_KEYS = [
  'title',
  'description',
  'canonicalUrl',
  'ogImageUrl',
  'noindex',
  'productId',
] as const;

/** Every key this renderer reads from a site's `seoDefaults`. */
export const SEO_DEFAULT_KEYS = [
  'description',
  'ogImageUrl',
  'twitterSite',
  'noindex',
  'business',
] as const;

/**
 * The kinds of business a site may declare itself as, for the picker.
 *
 * Hand-written for the same reason the key lists are, and reconciled against `BUSINESS_KINDS` in
 * `@leados/shared` by `website-seo.spec.ts`. A kind here that the API refuses is a dropdown option
 * that produces a refusal; a kind the API accepts and this list omits is one nobody can choose.
 */
export const BUSINESS_KINDS = [
  'LocalBusiness',
  'Store',
  'ProfessionalService',
  'RealEstateAgent',
  'HomeAndConstructionBusiness',
  'HealthAndBeautyBusiness',
  'AutomotiveBusiness',
  'FinancialService',
  'TravelAgency',
  'Restaurant',
] as const;

/** How long a derived description may be before it is cut at a word boundary. */
export const DERIVED_DESCRIPTION_MAX = 160;

export interface PageSeo {
  readonly title?: string;
  readonly description?: string;
  readonly canonicalUrl?: string;
  readonly ogImageUrl?: string;
  readonly noindex?: boolean;
  readonly productId?: string;
}

export interface SiteSeoDefaults {
  readonly description?: string;
  readonly ogImageUrl?: string;
  readonly twitterSite?: string;
  readonly noindex?: boolean;
}

/**
 * The absolute address of a page.
 *
 * The web app's copy of the API's `siteAbsoluteUrl`, and `website-seo.spec.ts` drives the same
 * inputs through both. The home page is the base itself rather than the base plus `/`: Next
 * redirects a trailing slash away, and a canonical that points at a redirect is one a crawler
 * discards.
 */
export function absoluteSiteUrl(baseUrl: string, path: string): string {
  if (path === WEBSITE_HOME_PATH || path === '') return baseUrl;
  return `${baseUrl}${path.startsWith('/') ? path : `/${path}`}`;
}

function readSeo(page: SnapshotPage): PageSeo {
  // An allowlist, like `themeStyle`'s: `seo` is tenant-authored JSON out of a snapshot that may
  // have been written by a newer release, and anything unrecognised is ignored rather than
  // reaching a `<meta>` tag. Writes refuse an unknown key; reads tolerate one. That asymmetry is
  // what lets a rollback to an older release keep rendering.
  const raw = page.seo ?? {};
  const out: Record<string, unknown> = {};
  for (const key of PAGE_SEO_KEYS) {
    const value = (raw as Record<string, unknown>)[key];
    if (value === undefined || value === null) continue;
    if (key === 'noindex') {
      if (typeof value === 'boolean') out[key] = value;
      continue;
    }
    if (typeof value === 'string' && value.trim() !== '') out[key] = value.trim();
  }
  return out as PageSeo;
}

export function readSeoDefaults(snapshot: {
  seoDefaults?: Record<string, unknown>;
}): SiteSeoDefaults {
  const raw = snapshot.seoDefaults ?? {};
  const out: Record<string, unknown> = {};
  for (const key of SEO_DEFAULT_KEYS) {
    if (key === 'business') continue;
    const value = raw[key];
    if (value === undefined || value === null) continue;
    if (key === 'noindex') {
      if (typeof value === 'boolean') out[key] = value;
      continue;
    }
    if (typeof value === 'string' && value.trim() !== '') out[key] = value.trim();
  }
  return out as SiteSeoDefaults;
}

/**
 * A description taken from what the page actually says, for a page nobody wrote one for.
 *
 * Worth the thirty lines rather than leaving the tag off. Lighthouse fails a page with no meta
 * description, which is one audit of about ten and enough on its own to put a site under the
 * threshold this step has to meet — but the real argument is the search result: without a
 * description a search engine invents one from whatever text it finds first, and "Skip to content"
 * is a common answer. The first words of the page is what a person would have written anyway.
 *
 * It reads the blocks' own parameter keys, which `website-blocks.spec.ts` keeps in step with the
 * registry. A block type whose text lives under a key not listed here contributes nothing, which
 * is a missing fallback rather than a wrong one.
 */
export function derivedDescription(page: SnapshotPage): string | undefined {
  const sources = ['subheading', 'body', 'text'];
  for (const raw of page.blocks) {
    const block = (typeof raw === 'object' && raw !== null ? raw : {}) as {
      params?: Record<string, unknown>;
    };
    const params = block.params ?? {};
    for (const key of sources) {
      const value = params[key];
      if (typeof value !== 'string') continue;
      const flat = value.replace(/\s+/g, ' ').trim();
      if (flat.length < 20) continue;
      if (flat.length <= DERIVED_DESCRIPTION_MAX) return flat;
      // Cut at a word boundary. A description sliced mid-word reads as broken software, and the
      // ellipsis is what tells a reader the sentence continues on the page.
      const cut = flat.slice(0, DERIVED_DESCRIPTION_MAX);
      const lastSpace = cut.lastIndexOf(' ');
      return `${(lastSpace > 80 ? cut.slice(0, lastSpace) : cut).replace(/[,;:.\s]+$/, '')}…`;
    }
  }
  return undefined;
}

/**
 * The page's `<head>`, as Next's `Metadata`.
 *
 * **A page's own `seo.title` is used verbatim, with no site name appended.** Somebody who fills in
 * a title tag is controlling the sixty characters a search result shows, and a product that then
 * added ` · Acme Interiors` to it would be overriding the override. Without one, the page's
 * editor-facing title plus the site name is the sensible default — and it is a default, which is
 * why it is the branch that gets the suffix.
 */
export function pageMetadata(site: PublishedSite, page: SnapshotPage): Metadata {
  const seo = readSeo(page);
  const defaults = readSeoDefaults(site.snapshot);
  const canonical = seo.canonicalUrl ?? absoluteSiteUrl(site.site.baseUrl, page.path);
  const title = seo.title ?? `${page.title} · ${site.site.name}`;
  const description = seo.description ?? defaults.description ?? derivedDescription(page);
  const image = seo.ogImageUrl ?? defaults.ogImageUrl;
  const noindex = seo.noindex === true || defaults.noindex === true;

  return {
    title,
    ...(description === undefined ? {} : { description }),
    alternates: { canonical },
    // `index: false, follow: false`. A page the business has asked to keep out of search should
    // not be passing authority onward either, and `nofollow` without `noindex` is the combination
    // nobody wants.
    ...(noindex ? { robots: { index: false, follow: false } } : {}),
    openGraph: {
      type: 'website',
      url: canonical,
      siteName: site.site.name,
      title,
      ...(description === undefined ? {} : { description }),
      ...(image === undefined ? {} : { images: [{ url: image }] }),
    },
    twitter: {
      // `summary_large_image` only when there is an image: the large card with nothing in it
      // renders as a blank rectangle, which looks worse than the small card it replaced.
      card: image === undefined ? 'summary' : 'summary_large_image',
      ...(defaults.twitterSite === undefined ? {} : { site: defaults.twitterSite }),
      title,
      ...(description === undefined ? {} : { description }),
      ...(image === undefined ? {} : { images: [image] }),
    },
  };
}

const SCHEMA_DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/**
 * `LocalBusiness` structured data for the site.
 *
 * Emitted on **every** page, which is what Google's own guidance asks for and what lets any page
 * of a site be the one that surfaces in a local result. The address, the phone and the hours come
 * from three different places in the product and none of them is a copy of another: see
 * `resolveBusiness` in the API.
 *
 * Returns `null` rather than a skeleton when there is nothing but a name. Structured data with no
 * address and no hours tells a search engine nothing it did not already have from the page, and
 * an incomplete `LocalBusiness` is reported as an error in Search Console — a warning a business
 * owner would have to act on, about a feature they never asked for.
 */
export function localBusinessJsonLd(
  business: SiteBusiness | null,
  baseUrl: string,
): Record<string, unknown> | null {
  if (business === null) return null;
  const hasAddress =
    business.streetAddress !== null || business.locality !== null || business.postalCode !== null;
  if (!hasAddress && business.phone === null && business.openingHours.length === 0) return null;

  const address =
    hasAddress || business.country !== ''
      ? {
          '@type': 'PostalAddress',
          ...(business.streetAddress === null ? {} : { streetAddress: business.streetAddress }),
          ...(business.locality === null ? {} : { addressLocality: business.locality }),
          ...(business.region === null ? {} : { addressRegion: business.region }),
          ...(business.postalCode === null ? {} : { postalCode: business.postalCode }),
          addressCountry: business.country,
        }
      : undefined;

  return {
    '@context': 'https://schema.org',
    '@type': business.kind,
    name: business.name,
    ...(business.legalName === null ? {} : { legalName: business.legalName }),
    url: baseUrl,
    ...(business.logoUrl === null ? {} : { logo: business.logoUrl, image: business.logoUrl }),
    ...(business.phone === null ? {} : { telephone: business.phone }),
    ...(business.priceRange === null ? {} : { priceRange: business.priceRange }),
    ...(address === undefined ? {} : { address }),
    ...(business.openingHours.length === 0
      ? {}
      : {
          openingHoursSpecification: business.openingHours.map((window) => ({
            '@type': 'OpeningHoursSpecification',
            dayOfWeek: `https://schema.org/${SCHEMA_DAYS[window.dayOfWeek] ?? 'Monday'}`,
            opens: window.opens,
            closes: window.closes,
          })),
        }),
  };
}

/**
 * `Product` structured data for a page that names a product.
 *
 * The price is read live from the catalogue, never from the snapshot, which is the point of the
 * reference: a price frozen into a published version would go stale the moment somebody edited the
 * catalogue, in the one place where a stale price is a penalty rather than a typo.
 *
 * `priceCurrency` is required by Google alongside `price`, so a product with no currency gets no
 * `offers` block at all rather than a price with nothing to measure it in.
 */
export function productJsonLd(
  product: SiteProduct | undefined,
  pageUrl: string,
): Record<string, unknown> | null {
  if (product === undefined) return null;
  return {
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: product.name,
    ...(product.description === null ? {} : { description: product.description }),
    ...(product.sku === null ? {} : { sku: product.sku }),
    ...(product.currency === null
      ? {}
      : {
          offers: {
            '@type': 'Offer',
            url: pageUrl,
            priceCurrency: product.currency,
            // Minor units back to the major unit the schema expects, as a string: `19.90` must not
            // become `19.9`, and a float would eventually produce `19.900000000000002`.
            price: (product.priceMinor / 100).toFixed(2),
            availability: 'https://schema.org/InStock',
          },
        }),
  };
}

/**
 * JSON for a `<script type="application/ld+json">` body.
 *
 * **`<` is escaped, and that is the whole reason this function exists.** A tenant can type
 * `</script>` into a page description, and the browser's HTML parser ends the script element at
 * those characters regardless of their being inside a JSON string — turning the rest of the
 * structured data into markup, which is a stored cross-site-scripting hole on every visitor's
 * page. The line terminators U+2028 and U+2029 are escaped for the older reason: both are legal in
 * a JSON string and illegal in a JavaScript one.
 */
export function jsonLdScript(value: unknown): string {
  return (
    JSON.stringify(value)
      .replace(/</g, '\\u003c')
      .replace(/>/g, '\\u003e')
      .replace(/&/g, '\\u0026')
      // Written as escapes in a character class rather than as literal characters: a raw U+2028 in
      // this file is invisible in every editor and in `git diff`, and the first draft of this line
      // was corrupted into a literal one by the tool that wrote the file.
      .replace(/[\u2028\u2029]/g, (ch) => (ch === '\u2028' ? '\\u2028' : '\\u2029'))
  );
}

function xmlText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * The site's `sitemap.xml`.
 *
 * **It lists published pages and only published pages, and that is structural rather than
 * filtered.** The snapshot a published version carries is built from the pages that were
 * `published` at the moment of the publish, so a draft page is not absent because this function
 * removed it — it was never in the document this function reads. A filter here would be a second
 * place that decides, and the one that was wrong would be the one nothing ran.
 *
 * A `noindex` page **is** removed, and that is a filter: a sitemap entry for a page the site has
 * asked search engines not to list is a contradiction Search Console reports as an error, and the
 * two settings are written in different screens by people who may not know about each other.
 *
 * `lastmod` is the publish instant, the same for every page, which is the honest answer: a
 * published version is a single act, and the per-page `updated_at` of a draft is a date the public
 * has never seen.
 */
export function sitemapXml(site: PublishedSite): string {
  const defaults = readSeoDefaults(site.snapshot);
  const lastmod = new Date(site.publishedAt).toISOString();
  const urls = site.snapshot.pages
    .filter((page) => {
      if (defaults.noindex === true) return false;
      return readSeo(page).noindex !== true;
    })
    .map((page) => {
      const loc = xmlText(absoluteSiteUrl(site.site.baseUrl, page.path));
      // The home page is what a visitor lands on; the rest are equal. Priority and changefreq are
      // both widely documented as ignored by Google, so only `priority` is set and only to make
      // the home page's primacy explicit for the crawlers that do read it.
      const priority = page.isHome ? '1.0' : '0.8';
      return `  <url>\n    <loc>${loc}</loc>\n    <lastmod>${lastmod}</lastmod>\n    <priority>${priority}</priority>\n  </url>`;
    });

  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}${urls.length === 0 ? '' : '\n'}</urlset>\n`;
}

/**
 * The site's `robots.txt`.
 *
 * **Crawling is allowed even when the site asks not to be listed, and that is deliberate.** The
 * instinct is to answer `Disallow: /` for a `noindex` site, and it is exactly wrong: `Disallow`
 * stops a crawler fetching the page, which stops it ever seeing the `noindex` meta tag, so a site
 * that was already indexed stays indexed — permanently, with no way to ask again. Allowing the
 * crawl and serving `noindex` is the only combination that actually removes a site from a search
 * engine. What `noindex` does change here is the `Sitemap:` line: advertising a list of pages a
 * business has asked you not to list is incoherent.
 */
export function robotsTxt(site: PublishedSite): string {
  const defaults = readSeoDefaults(site.snapshot);
  const lines = ['User-agent: *', 'Allow: /'];
  if (defaults.noindex !== true) {
    lines.push('', `Sitemap: ${site.site.baseUrl}/sitemap.xml`);
  }
  return `${lines.join('\n')}\n`;
}

/**
 * Where a request for a path nobody has a page for should be sent, if anywhere.
 *
 * One lookup and no loop guard, because the invariant the API keeps makes a loop unrepresentable:
 * no redirect's destination is another redirect's source on the same site, so following one hop is
 * following all of them. A renderer that walked a chain would be code written against a state the
 * writer refuses to create.
 */
export function resolveRedirect(
  site: PublishedSite,
  path: string,
): { toPath: string; kind: string } | undefined {
  return site.redirects.find((row) => row.fromPath === path);
}
