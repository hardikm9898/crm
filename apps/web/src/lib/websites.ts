import { ApiError, request } from '@/lib/api';
import { loadProductsOrThrow } from '@/lib/deals';

/**
 * The renderer's own copy of the website vocabulary (`FR-WEB-5`).
 *
 * Hand-written here rather than imported from `@leados/shared`, for the reason `lib/tasks.ts`,
 * `lib/sla.ts` and `lib/whatsapp.ts` each record: that package's entry point re-exports the tenant
 * context, which reaches `node:async_hooks`, and a client component that transitively imports it
 * fails `next build` with "the chunking context does not support external modules" — on whichever
 * page happens to render it, not on the file that imported it. `websites.spec.ts` reconciles the
 * two, because a spec runs in Node and may import both.
 */

export const WEBSITE_HOME_PATH = '/';

/** The business behind a site, assembled by the API from three places none of which copies
 * another: the organization profile, the site's SEO defaults, and `working_hours`. */
export interface SiteBusiness {
  readonly name: string;
  readonly legalName: string | null;
  readonly country: string;
  readonly logoUrl: string | null;
  readonly timezone: string;
  readonly kind: string;
  readonly streetAddress: string | null;
  readonly locality: string | null;
  readonly region: string | null;
  readonly postalCode: string | null;
  readonly phone: string | null;
  readonly priceRange: string | null;
  readonly openingHours: readonly {
    readonly dayOfWeek: number;
    readonly opens: string;
    readonly closes: string;
  }[];
}

/** A product a page names, read live from the catalogue so a published price cannot go stale. */
export interface SiteProduct {
  readonly name: string;
  readonly description: string | null;
  readonly sku: string | null;
  readonly priceMinor: number;
  readonly currency: string | null;
}

/** A page as the published snapshot carries it. */
export interface SnapshotPage {
  readonly path: string;
  readonly title: string;
  readonly blocks: readonly unknown[];
  readonly seo: Record<string, unknown>;
  readonly isHome: boolean;
  readonly sortOrder: number;
}

export interface SiteSnapshot {
  readonly theme: Record<string, unknown>;
  readonly seoDefaults: Record<string, unknown>;
  readonly pages: readonly SnapshotPage[];
}

export interface PublishedSite {
  readonly site: {
    readonly name: string;
    readonly subdomain: string;
    /**
     * Where this site lives, absolutely — the API's one answer to that question (`FR-WEB-3`).
     *
     * Not computed here, because step 6 adds a third possibility (a verified custom domain) that
     * is a row in the database rather than a variable in this app's environment. A canonical URL
     * and a sitemap entry that disagreed would tell a crawler the page it fetched is a duplicate
     * of something it cannot find, and the usual outcome is neither being indexed.
     */
    readonly baseUrl: string;
  };
  readonly version: number;
  readonly versionId: string;
  readonly publishedAt: string;
  readonly snapshot: SiteSnapshot;
  /**
   * The forms this site's pages place, keyed by form id (`FR-WEB-6`).
   *
   * Beside the snapshot rather than inside it: the API resolves these at read time so a rotated
   * key stops working and an edited form stays current, and the snapshot has to stay byte-stable
   * across reads or a version comparison would find differences the server invented.
   */
  readonly forms: Readonly<Record<string, { readonly key: string; readonly name: string }>>;
  /**
   * The site's redirects, beside the snapshot for the reason the forms are — and one more.
   *
   * A redirect exists because an address *changed*, and the links it serves were published by
   * other people. Snapshotting it would make a rollback of the **content** delete redirects added
   * since the restored version, 404ing inbound links that were never part of what was rolled back.
   */
  readonly redirects: readonly {
    readonly fromPath: string;
    readonly toPath: string;
    readonly kind: string;
  }[];
  /** The business behind the site, for `LocalBusiness` structured data. Null if it has gone. */
  readonly business: SiteBusiness | null;
  /** The products this site's pages name, keyed by id. A withdrawn product is simply absent. */
  readonly products: Readonly<Record<string, SiteProduct>>;
}

/**
 * The cache tag a site's snapshot is stored under.
 *
 * Keyed on the **subdomain** rather than the site's id, because the id is deliberately not in the
 * public response — a visitor has no business holding it — and because the subdomain is what the
 * request arrives with. The publish path knows both, so it can name this tag.
 */
export function siteCacheTag(subdomain: string): string {
  return `site:${subdomain.trim().toLowerCase()}`;
}

/**
 * Turns the catch-all route's segments into the path a snapshot stores.
 *
 * Deliberately **not** a second implementation of `normalizePagePath`: that function cleans what
 * somebody typed into an editor, which can contain capitals, spaces, a query string or a trailing
 * slash. This one reads what Next has already split and decoded, so its whole job is to join the
 * segments back and lowercase them. `websites.spec.ts` asserts the two agree on every shape a URL
 * can actually produce, because if they ever disagree a published page becomes unreachable at its
 * own address — and nothing else in the product would notice.
 */
export function pathFromSegments(segments: readonly string[] | undefined): string {
  if (!segments || segments.length === 0) return WEBSITE_HOME_PATH;
  const joined = segments
    .map((segment) => segment.trim().toLowerCase())
    .filter((segment) => segment.length > 0)
    .join('/');
  return joined.length === 0 ? WEBSITE_HOME_PATH : `/${joined}`;
}

/** The page at this path, or `undefined`. The home page answers for `/`. */
export function pageAt(snapshot: SiteSnapshot, path: string): SnapshotPage | undefined {
  const direct = snapshot.pages.find((page) => page.path === path);
  if (direct) return direct;
  // `/` falls back to whichever page is marked home, so a site whose home page lives at a real
  // path (`/welcome`) still answers at its root.
  if (path === WEBSITE_HOME_PATH) return snapshot.pages.find((page) => page.isHome);
  return undefined;
}

/**
 * Loads a published site, cached and tagged.
 *
 * `revalidate: false` with a tag, rather than a time window: a published site does not change until
 * somebody publishes it, so a timer would either serve stale content for its length or re-fetch
 * content that has not moved. The publish path invalidates the tag, which is the only event that
 * can change this answer (`FR-WEB-5`).
 *
 * This is the one caller in the app that may cache a response, and `RequestOptions.cache` says why.
 */
export async function loadPublishedSite(subdomain: string): Promise<PublishedSite> {
  return (
    await request<PublishedSite>(`/public/sites/${encodeURIComponent(subdomain)}`, {
      next: { tags: [siteCacheTag(subdomain)], revalidate: false },
    })
  ).data;
}

/**
 * The published site, `null` when there is no such site, and a **throw** when we could not ask.
 *
 * The three outcomes have to stay three, which the first draft of the crawler files got wrong.
 * `robots.txt` answers `Disallow: /` for a site that is not published — a 404 on that file is read
 * as "no restrictions", which is the opposite of what an unpublished address should say. But
 * collapsing an API outage into the same answer would serve `Disallow: /` for a **healthy** site
 * during a blip, and a crawler that caches it stops crawling a site that is live. So a transport
 * failure or a 5xx propagates, and the route turns it into a 503, which crawlers treat as "ask
 * again later" and explicitly do not read as a change of permission.
 *
 * This is the "a catch that renders an empty state hides a 400 forever" lesson with a worse blast
 * radius: the empty state here is an instruction to the whole internet.
 */
export async function loadPublishedSiteOrNull(subdomain: string): Promise<PublishedSite | null> {
  try {
    return await loadPublishedSite(subdomain);
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  }
}

/**
 * The CSS custom properties a tenant's theme sets, as a style object.
 *
 * A tenant site must **not** inherit this product's design tokens: a builder's site rendering in
 * Lead OS blue with Lead OS's type scale is our brand on their page. So the renderer sets the
 * tokens it uses on the site's own container, from the theme, and falls back to a neutral set that
 * is deliberately not the app's primary colour.
 *
 * Only known keys are read. A theme is tenant-controlled JSON that reaches a `style` attribute, so
 * spreading it would let a saved theme inject arbitrary CSS — including `background: url(...)`
 * pointing anywhere. The allowlist is the whole defence, and it is why this returns a built object
 * rather than a cast.
 */
export function themeStyle(theme: Record<string, unknown>): Record<string, string> {
  const style: Record<string, string> = {
    '--site-bg': '#ffffff',
    '--site-text': '#1a1a1a',
    '--site-muted': '#5a5a5a',
    '--site-accent': '#1f6feb',
    '--site-accent-contrast': '#ffffff',
    '--site-font': 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif',
  };
  const allowed: Record<string, string> = {
    background: '--site-bg',
    text: '--site-text',
    muted: '--site-muted',
    accent: '--site-accent',
    accentContrast: '--site-accent-contrast',
    font: '--site-font',
  };
  for (const [key, token] of Object.entries(allowed)) {
    const value = theme[key];
    // A colour or a font stack and nothing else: no semicolons, no braces, no `url(`, and short
    // enough that a stylesheet cannot be smuggled through a colour field.
    if (
      typeof value === 'string' &&
      value.length > 0 &&
      value.length <= 120 &&
      isSafeCssValue(value)
    ) {
      style[token] = value;
    }
  }
  return style;
}

const UNSAFE_CSS = /[;{}()<>\\]|url|expression|@import/i;

function isSafeCssValue(value: string): boolean {
  return !UNSAFE_CSS.test(value);
}

/**
 * The block types this release can draw (`FR-WEB-2`).
 *
 * Here rather than beside the renderers, because the list and the URL guard are **pure** and three
 * things need them: the renderer, the step-3 editor, and a unit spec. A spec cannot import the
 * renderers at all — they are `.tsx`, and this app's unit tests run in a node environment with
 * `jsx: preserve`, so importing one fails at parse time with a message about tsconfig rather than
 * about the test. Keeping the pure half here is what makes the guard testable.
 */
export const BLOCK_TYPES = [
  'heading',
  'text',
  'hero',
  'image',
  'list',
  'whatsapp_cta',
  'quote',
  'form',
] as const;
export type BlockType = (typeof BLOCK_TYPES)[number];

/** True when this release can draw the type. The step-3 editor reads the same answer. */
export function isKnownBlockType(type: unknown): type is BlockType {
  return typeof type === 'string' && (BLOCK_TYPES as readonly string[]).includes(type);
}

/**
 * Only `http:`, `https:`, `mailto:` and `tel:`, plus a same-site relative path.
 *
 * React will put `javascript:` in an `href` without complaint, so every tenant-authored URL goes
 * through here and anything else renders without a link rather than with a dangerous one. A
 * tenant's own editor is not a trust boundary we get to skip: the person who pastes a link is not
 * always the person who owns the workspace.
 */
export function safeUrl(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  if (trimmed.startsWith('/') && !trimmed.startsWith('//')) return trimmed;
  try {
    const url = new URL(trimmed);
    return ['http:', 'https:', 'mailto:', 'tel:'].includes(url.protocol) ? url.toString() : null;
  } catch {
    return null;
  }
}

/** A site as the list screen reads it. */
export interface WebsiteSummary {
  readonly id: string;
  readonly name: string;
  readonly subdomain: string;
  readonly status: 'draft' | 'published';
  readonly publishedVersionId: string | null;
  readonly updatedAt: string;
  readonly templateCode: string | null;
}

export interface WebsitePageRow {
  readonly id: string;
  readonly path: string;
  readonly title: string;
  readonly blocks: readonly unknown[];
  /** Per-page SEO overrides (`FR-WEB-3`). `{}` for a page nobody has filled any in for, which is
   * the common case: a page inherits the site's defaults and needs nothing typed. */
  readonly seo: Record<string, unknown>;
  readonly isHome: boolean;
  readonly sortOrder: number;
  readonly status: 'draft' | 'published';
}

export interface WebsiteDetail extends WebsiteSummary {
  readonly theme: Record<string, unknown>;
  readonly seoDefaults: Record<string, unknown>;
  readonly pages: readonly WebsitePageRow[];
}

export interface WebsiteVersionRow {
  readonly id: string;
  readonly version: number;
  readonly publishedAt: string;
  readonly restoredFromVersionId: string | null;
}

/**
 * Every authenticated loader takes the token, because the access token lives in an httpOnly cookie
 * and only the server can attach it. The first draft of these three omitted it and every screen
 * answered 500 — a 401 the loader turned into a thrown error, which is the right direction for it
 * to fail in and the wrong thing to ship.
 */
export async function loadWebsites(token: string | null): Promise<WebsiteSummary[]> {
  // `data` is the array: the envelope lifts `items` and puts `pagination` under `meta`.
  return (await request<WebsiteSummary[]>('/websites', { token })).data;
}

export async function loadWebsite(token: string | null, id: string): Promise<WebsiteDetail> {
  return (await request<WebsiteDetail>(`/websites/${id}`, { token })).data;
}

export async function loadVersions(token: string | null, id: string): Promise<WebsiteVersionRow[]> {
  return (await request<WebsiteVersionRow[]>(`/websites/${id}/versions`, { token })).data;
}

/** The address a published site is served at today. Host-based routing is step 6's. */
export function siteUrl(subdomain: string): string {
  return `/s/${subdomain}`;
}

/** A redirect as the editor lists it, with `shadowed` saying whether a page now outranks it. */
export interface RedirectRow {
  readonly id: string;
  readonly fromPath: string;
  readonly toPath: string;
  readonly kind: 'permanent' | 'temporary';
  readonly note: string | null;
  /**
   * True when a page now sits at `fromPath`, so this redirect never fires.
   *
   * Computed by the API rather than stored, and surfaced rather than hidden: a redirect doing
   * nothing with no explanation is a support ticket, and the explanation ("a page always wins") is
   * one sentence.
   */
  readonly shadowed: boolean;
}

export async function loadRedirects(token: string | null, id: string): Promise<RedirectRow[]> {
  return (await request<RedirectRow[]>(`/websites/${id}/redirects`, { token })).data;
}

/**
 * The products a page may link to, or a reason there are none to offer.
 *
 * `GET /products` is gated on `deal:read`, which somebody who edits websites need not hold — so
 * "the list is empty" and "you may not see the list" are two different answers and this returns
 * which. Collapsing them into `[]` would render an empty picker to a person whose workspace has a
 * full catalogue, which is the defect `loadProducts` exists to document: a loader whose failure is
 * indistinguishable from an empty result needs a twin on any screen where "none" is information.
 */
export async function loadSeoProductOptions(
  token: string | null,
): Promise<{ items: { id: string; name: string }[] } | { unavailable: true }> {
  try {
    const items = await loadProductsOrThrow(token, '?limit=200&active=true');
    return { items: items.map((item) => ({ id: item.id, name: item.name })) };
  } catch {
    return { unavailable: true };
  }
}
