import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import {
  loadPublishedSite,
  pageAt,
  pathFromSegments,
  themeStyle,
  type PublishedSite,
} from '@/lib/websites';
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

async function load(siteSlug: string): Promise<PublishedSite | null> {
  try {
    return await loadPublishedSite(siteSlug);
  } catch {
    // A 404 from the API and an unreachable API are deliberately the same answer here: in both
    // cases this renderer has no content, and guessing which would mean rendering a page that
    // claims the site does not exist when the truth is that we could not ask.
    return null;
  }
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ siteSlug: string; path?: string[] }>;
}): Promise<Metadata> {
  const { siteSlug, path } = await params;
  const site = await load(siteSlug);
  if (!site) return { title: 'Site not found', robots: { index: false } };

  const page = pageAt(site.snapshot, pathFromSegments(path));
  // The business's name, not ours. Per-page title, description, canonical and Open Graph are step
  // 5's; what is here is the minimum that stops every page of every tenant site being called
  // "Lead OS", which is what the root layout's metadata would otherwise do.
  const title = page ? `${page.title} · ${site.site.name}` : site.site.name;
  return { title };
}

export default async function PublishedSitePage({
  params,
}: {
  params: Promise<{ siteSlug: string; path?: string[] }>;
}) {
  const { siteSlug, path } = await params;
  const site = await load(siteSlug);
  if (!site) notFound();

  const page = pageAt(site.snapshot, pathFromSegments(path));
  // A site that exists with no page at this path is a 404 on that path, not a redirect to the home
  // page: a visitor following a stale link should be told, and a search engine should not find two
  // addresses serving one page.
  if (!page) notFound();

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
      <main className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-10">
        <Blocks blocks={page.blocks} />
      </main>
    </div>
  );
}
