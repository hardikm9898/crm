import type { Metadata } from 'next';
import { notFound, permanentRedirect, redirect } from 'next/navigation';
import {
  loadPublishedSiteOrNull,
  pageAt,
  pathFromSegments,
  themeStyle,
  type PublishedSite,
} from '@/lib/websites';
import {
  jsonLdScript,
  localBusinessJsonLd,
  pageMetadata,
  productJsonLd,
  resolveRedirect,
  absoluteSiteUrl,
} from '@/lib/website-seo';
import { Blocks } from './blocks';

/**
 * A published tenant website (`FR-WEB-5`).
 *
 * Outside the `(app)` route group, like the public form page and for the same reason: no
 * navigation, no session, no workspace switcher — nothing that would make sense to somebody who
 * has never heard of this product, on a page that is theirs as far as the visitor is concerned.
 *
 * **Static with tag revalidation, not a time window.** `revalidate: false` on the fetch plus a tag
 * the publish path invalidates: a published site does not change until somebody publishes it, so a
 * timer would either serve stale content for its length or re-fetch content that has not moved.
 *
 * **A draft is never served from here, and the reason is not this file.** The API answers 404 for
 * anything not published, so the renderer cannot serve a draft even if it asked wrongly — the
 * guarantee lives at the layer that reads the database, not at the layer that draws HTML.
 */

/** Nothing is known at build time: a tenant creates sites long after this app is deployed. */
export const dynamicParams = true;

export async function generateStaticParams(): Promise<{ siteSlug: string }[]> {
  return [];
}

/**
 * The site, or `null` when there is genuinely no published site at this address.
 *
 * **A failure to ask is not an answer, and step 2 had this wrong.** The original collapsed a 404
 * and an unreachable API into the same `null`, with a comment arguing that the renderer has no
 * content either way — which is true and is not the point. This page is cached with
 * `revalidate: false` and a tag, so a 404 rendered during an API blip is cached *indefinitely*:
 * a live site would answer "not found" to every visitor until somebody published it again, and
 * nothing anywhere would say why. Letting the error propagate gives Next's error boundary and a
 * 500, which is not cached as a successful response.
 */
async function load(siteSlug: string): Promise<PublishedSite | null> {
  return loadPublishedSiteOrNull(siteSlug);
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ siteSlug: string; path?: string[] }>;
}): Promise<Metadata> {
  const { siteSlug, path } = await params;
  const site = await load(siteSlug);
  // `robots: { index: false }` on a page that does not exist, because a 404 that a crawler was
  // allowed to index is a dead address in a search result.
  if (!site) return { title: 'Site not found', robots: { index: false } };

  const page = pageAt(site.snapshot, pathFromSegments(path));
  if (!page) return { title: site.site.name, robots: { index: false } };

  // Every tag — title, description, canonical, Open Graph, Twitter and robots — comes from one
  // function, which `website-seo.spec.ts` tests without a browser. A `<head>` assembled inline
  // here would be the part of the page nothing could assert.
  return pageMetadata(site, page);
}

export default async function PublishedSitePage({
  params,
}: {
  params: Promise<{ siteSlug: string; path?: string[] }>;
}) {
  const { siteSlug, path } = await params;
  const site = await load(siteSlug);
  if (!site) notFound();

  const requested = pathFromSegments(path);
  const page = pageAt(site.snapshot, requested);

  // A page wins over a redirect, always. That precedence is the single rule, declared here and
  // nowhere else: a real page at an address must serve, and a redirect whose source is a page is
  // one the API refuses to create and the redirect list marks as `shadowed` if a page appears
  // later. Looking for the redirect first would mean publishing a page could not take an address
  // back.
  if (!page) {
    const moved = resolveRedirect(site, requested);
    if (moved !== undefined) {
      // 308 and 307, not 301 and 302. Both preserve the method, which 301 and 302 historically did
      // not, and Google treats 308 exactly as it treats 301 for ranking purposes — so there is
      // nothing to gain from the older pair and a POST to a moved address to lose.
      const target = moved.toPath.startsWith('/')
        ? absoluteSiteUrl(site.site.baseUrl, moved.toPath)
        : moved.toPath;
      if (moved.kind === 'permanent') permanentRedirect(target);
      redirect(target);
    }
    // A site that exists with no page at this path is a 404 on that path, not a redirect to the
    // home page: a visitor following a stale link should be told, and a search engine should not
    // find two addresses serving one page.
    notFound();
  }

  const pageUrl = absoluteSiteUrl(site.site.baseUrl, page.path);
  const business = localBusinessJsonLd(site.business, site.site.baseUrl);
  const seoProductId = (page.seo as { productId?: unknown } | undefined)?.productId;
  const product = productJsonLd(
    typeof seoProductId === 'string' ? site.products[seoProductId] : undefined,
    pageUrl,
  );

  return (
    <div
      // The tenant's tokens, set on their own container. A tenant site must not inherit this
      // product's design tokens — a builder's site rendering in Lead OS blue is our brand on their
      // page — and `themeStyle` allowlists the keys it reads, because a theme is tenant-controlled
      // JSON on its way into a `style` attribute.
      style={themeStyle(site.snapshot.theme)}
      className="min-h-dvh bg-[color:var(--site-bg)] font-[family-name:var(--site-font)] text-[color:var(--site-text)]"
      data-site={site.site.subdomain}
      data-site-version={site.version}
    >
      {/*
        Structured data. `dangerouslySetInnerHTML` is the only way to put a `<script>` body in
        React, and `jsonLdScript` is why it is safe here: it escapes `<`, so a tenant who types
        `</script>` into a page description cannot end the element and have the rest parsed as
        markup. The business block is on every page by design — any page of a site may be the one
        that surfaces in a local search result.
      */}
      {business !== null ? (
        <script
          type="application/ld+json"
          data-structured-data="business"
          dangerouslySetInnerHTML={{ __html: jsonLdScript(business) }}
        />
      ) : null}
      {product !== null ? (
        <script
          type="application/ld+json"
          data-structured-data="product"
          dangerouslySetInnerHTML={{ __html: jsonLdScript(product) }}
        />
      ) : null}
      <main className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-10">
        <Blocks blocks={page.blocks} forms={site.forms ?? {}} />
      </main>
    </div>
  );
}
