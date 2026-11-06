/**
 * Websites: the vocabulary both halves of the product read (`FR-WEB-1`…`FR-WEB-6`).
 *
 * A website in this product is three things that must not be confused with each other:
 *
 *  * the **draft** — `websites` plus its `website_pages`, which is what the editor changes;
 *  * the **version** — an immutable snapshot of that draft, written when somebody publishes;
 *  * what is **served** — always a version, never the draft.
 *
 * Keeping those three apart is the whole of `FR-WEB-5`. A renderer that read the draft would make
 * "rollback restores the previous version exactly" unachievable, because there would be nothing to
 * restore *to*: the only record of what the public saw would be the rows somebody has since edited.
 * So a publish copies, a rollback copies back, and the draft is never what a visitor reads.
 *
 * **A subdomain is globally unique, like `whatsapp_numbers.phone_number_id`.** It has no
 * `organization_id` beside it in its unique index because an inbound request for
 * `acme.leados.app` carries nothing else: the subdomain is the only thing that can resolve a
 * workspace, so it must identify one across all of them. The cost is the one that column already
 * taught this codebase — a collision check has to run under `withPlatformScope`, because the
 * tenant-scoped client cannot see the row that would collide, and the refusal has to be a sentence
 * rather than a unique-violation 500.
 */

/** `websites.status`. Only `published` is served; a `draft` site answers 404 to the public. */
export const WEBSITE_STATUSES = ['draft', 'published'] as const;
export type WebsiteStatus = (typeof WEBSITE_STATUSES)[number];

/**
 * `website_pages.status`. Per-page rather than per-site because a site that is live and a page that
 * is not yet finished is the ordinary case, not an edge one: somebody drafting a Pricing page does
 * not want their homepage taken down while they write it. Publishing snapshots the pages that are
 * `published`, which is also what makes step 5's "the sitemap lists published pages and only
 * published pages" a question with one answer.
 */
export const WEBSITE_PAGE_STATUSES = ['draft', 'published'] as const;
export type WebsitePageStatus = (typeof WEBSITE_PAGE_STATUSES)[number];

/** The home page's path. Stored, not implied, so `website_pages.path` is always a real path. */
export const WEBSITE_HOME_PATH = '/';

export const SUBDOMAIN_MIN_LENGTH = 3;
export const SUBDOMAIN_MAX_LENGTH = 63;

/**
 * Subdomains a workspace may not take, because the platform needs them or because owning one would
 * let a tenant impersonate the platform to their own visitors.
 *
 * `www` is here for a different reason from the rest: it is not ours to serve, it is the name every
 * visitor tries first, and a tenant holding it would shadow their own custom domain's `www` once
 * step 6 lands. Better refused now with a sentence than discovered then as a conflict.
 */
export const RESERVED_SUBDOMAINS: readonly string[] = [
  'admin',
  'api',
  'app',
  'assets',
  'auth',
  'billing',
  'cdn',
  'dashboard',
  'docs',
  'files',
  'help',
  'login',
  'mail',
  'media',
  'platform',
  'static',
  'status',
  'support',
  'www',
];

const SUBDOMAIN_SHAPE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

/**
 * Lowercases and trims what somebody typed. It does **not** validate: `subdomainProblem` does that,
 * and the two are separate so a caller can show the normalized value back beside the reason it was
 * refused — "you typed `Acme Realty`, we would store `acme-realty`" is a more useful refusal than
 * either half alone.
 *
 * Spaces and underscores become hyphens because that is what somebody typing a business name means,
 * and because silently dropping them would turn "Acme Realty" into `acmerealty` — a different
 * subdomain from the one they will expect to see.
 */
export function normalizeSubdomain(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/-{2,}/g, '-');
}

/**
 * The sentence to show somebody, or `null` when the value is usable.
 *
 * Written as sentences rather than codes for the reason `installValidationCopy` exists: Zod's
 * "String must contain at least 3 character(s)" reached users once already in this codebase, under
 * the phone box on the lead form. The caller passes the **normalized** value.
 */
export function subdomainProblem(subdomain: string): string | null {
  if (subdomain.length === 0) return 'Choose an address for this site.';
  if (subdomain.length < SUBDOMAIN_MIN_LENGTH) {
    return `An address needs at least ${SUBDOMAIN_MIN_LENGTH} characters.`;
  }
  if (subdomain.length > SUBDOMAIN_MAX_LENGTH) {
    return `An address can be at most ${SUBDOMAIN_MAX_LENGTH} characters.`;
  }
  if (!SUBDOMAIN_SHAPE.test(subdomain)) {
    return 'An address can use only letters, numbers and hyphens, and cannot start or end with a hyphen.';
  }
  if (RESERVED_SUBDOMAINS.includes(subdomain)) {
    return `“${subdomain}” is reserved by the platform. Try another address.`;
  }
  return null;
}

/**
 * Normalizes a page path to the stored form: leading slash, no trailing slash, lowercase, and
 * nothing after a `?` or `#`.
 *
 * The query string is dropped rather than refused because a path is a *location* and a query is an
 * argument to it: storing `/pricing?utm_source=x` would make two rows for one page the first time
 * somebody pasted a tracked link into the editor. `api_logs_path_is_a_path` makes the same
 * distinction for the same reason, one module over, and a CHECK enforces it here too so that
 * "something other than this function wrote the row" is unrepresentable rather than merely unlikely.
 */
export function normalizePagePath(input: string): string {
  const withoutQuery = input.split(/[?#]/)[0] ?? '';
  const trimmed = withoutQuery.trim().toLowerCase();
  if (trimmed === '' || trimmed === '/') return WEBSITE_HOME_PATH;
  const withLeadingSlash = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  const collapsed = withLeadingSlash.replace(/\/{2,}/g, '/');
  return collapsed.endsWith('/') ? collapsed.slice(0, -1) : collapsed;
}

/**
 * Character-for-character the regex in `website_pages_path_is_a_path`. The two have to agree: a
 * CHECK that says what belongs in a table while the service writes something else is a 500 nobody
 * sees until that path runs, which `email_suppressions_identifier_is_an_address` found the hard way.
 */
const PAGE_SEGMENT_SHAPE = /^\/[a-z0-9]([a-z0-9-]*[a-z0-9])?(\/[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;

/** The sentence to show somebody about a page path, or `null`. Takes the **normalized** value. */
export function pagePathProblem(path: string): string | null {
  if (path === WEBSITE_HOME_PATH) return null;
  if (path.length > 512) return 'That address is too long.';
  if (!PAGE_SEGMENT_SHAPE.test(path)) {
    return 'A page address looks like /about or /services/interiors — letters, numbers and hyphens, separated by slashes.';
  }
  return null;
}
