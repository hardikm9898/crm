import type { ContentProblem } from './content-problem.js';
import { WEBSITE_HOME_PATH } from './websites.js';

/**
 * What a published page tells a crawler, and what a site tells one about the business (`FR-WEB-3`).
 *
 * **The dividing line this whole step turns on: versioned is what somebody wrote; live is what the
 * business is.** A page's title, description and social image are content — they go into the
 * snapshot, and changing them takes effect when somebody publishes, like every other word on the
 * page. The business's own facts — its name, its opening hours, the forms it owns, a product's
 * price, where a retired address now points — are read **per request, beside the snapshot**. That
 * is why `seo` and `seo_defaults` are snapshotted while `website_redirects`, `working_hours` and
 * `products` are not, and it is the same reasoning step 4 used for a form's public key.
 *
 * Getting that line wrong in either direction is a real defect, not a preference. Snapshotting a
 * price would publish a figure that goes stale the moment somebody edits the catalogue — in
 * structured data, where a stale price is a penalty rather than a typo. Versioning the opening
 * hours would mean a business that changed its Saturday hours in Settings had to remember to
 * republish a website to stop telling customers the old ones.
 *
 * **Unknown keys are refused on write and ignored on read**, the same asymmetry `validateBlocks`
 * uses and for the same reason. A `desciption` nobody refuses is a setting that silently does
 * nothing for ever; a snapshot from a newer release carrying a key this one has never heard of
 * must still render, because a rollback must not blank a live site.
 */

/** Google truncates a title around 60 characters. The ceiling is higher than the advice on
 * purpose: this is the point past which a title is certainly wrong, not the point past which it is
 * suboptimal, and a validator that enforced the advice would refuse a title somebody meant. */
export const SEO_TITLE_MAX = 70;
export const SEO_DESCRIPTION_MAX = 320;

/**
 * The schema.org types a site may declare itself as.
 *
 * A list rather than free text because this value is emitted as `@type` in JSON-LD: a typo there
 * produces a document that validates as nothing, which is indistinguishable from having published
 * no structured data at all. Every entry is a real subtype of `LocalBusiness`, so the properties
 * below are valid on all of them.
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
export type BusinessKind = (typeof BUSINESS_KINDS)[number];

/** `permanent` is a 308 and `temporary` a 307, which is stated where they are served. */
export const REDIRECT_KINDS = ['permanent', 'temporary'] as const;
export type RedirectKind = (typeof REDIRECT_KINDS)[number];

/**
 * The site-wide SEO defaults a page's own `seo` overrides.
 *
 * `business` deliberately carries **only what nothing else in the product knows**. The name, the
 * country and the logo come from the organization profile and the opening hours from the
 * workspace-wide `working_hours` rows — asking somebody to type their own trading hours a second
 * time, into a website screen, is the defect `notification_preferences.quiet_hours` was corrected
 * for: one column per reader, each able to disagree with the others.
 */
export interface WebsiteSeoDefaults {
  readonly description?: string;
  readonly ogImageUrl?: string;
  readonly twitterSite?: string;
  readonly noindex?: boolean;
  readonly business?: {
    readonly kind?: BusinessKind;
    readonly streetAddress?: string;
    readonly locality?: string;
    readonly region?: string;
    readonly postalCode?: string;
    readonly phone?: string;
    readonly priceRange?: string;
  };
}

/** A page's own overrides. Every field is optional: a page with no `seo` at all is a page that
 * inherits, which is the common case and must not need filling in. */
export interface WebsitePageSeo {
  readonly title?: string;
  readonly description?: string;
  readonly canonicalUrl?: string;
  readonly ogImageUrl?: string;
  readonly noindex?: boolean;
  /** A product in this workspace's catalogue, for `Product` structured data. Resolved per read,
   * never snapshotted: see the note at the top of this file about which side of the line a price
   * falls on. */
  readonly productId?: string;
}

/** Every key a site's `seoDefaults` may carry. Exported so `apps/web`'s hand-written copy can be
 * reconciled against it by a spec — the web runtime may not import this package. */
export const WEBSITE_SEO_DEFAULT_KEYS = [
  'description',
  'ogImageUrl',
  'twitterSite',
  'noindex',
  'business',
] as const;
const SEO_DEFAULT_KEYS: readonly string[] = WEBSITE_SEO_DEFAULT_KEYS;
const BUSINESS_KEYS = [
  'kind',
  'streetAddress',
  'locality',
  'region',
  'postalCode',
  'phone',
  'priceRange',
];
/** Every key a page's `seo` may carry. Exported for the same reconciliation. */
export const WEBSITE_PAGE_SEO_KEYS = [
  'title',
  'description',
  'canonicalUrl',
  'ogImageUrl',
  'noindex',
  'productId',
] as const;
const PAGE_SEO_KEYS: readonly string[] = WEBSITE_PAGE_SEO_KEYS;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Whether a value may be used where only an absolute address will work.
 *
 * Stricter than `isSafeBlockUrl`, which accepts a site-relative path because a button on a page
 * may legitimately link to another page of that page's own site. A social image and a canonical
 * cannot: both are read by something that is **not** the browser that loaded the page, so a
 * relative value has no base to resolve against. A relative `og:image` is the commonest Open Graph
 * mistake there is, and it fails silently — every platform simply shows no image.
 */
export function isAbsoluteHttpUrl(value: string): boolean {
  try {
    const url = new URL(value.trim());
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * A Twitter/X site handle as the card expects it: one leading `@`.
 *
 * Normalised here and **only** here. A screen that cleaned the value too would be a second answer
 * to one question, and the two would eventually disagree about what a pasted profile URL becomes —
 * which is the canned-reply shortcut lesson, in a different field.
 */
export function normalizeTwitterHandle(input: string): string {
  const trimmed = input.trim();
  if (trimmed === '') return '';
  const fromUrl = trimmed.match(/^https?:\/\/(?:www\.)?(?:twitter|x)\.com\/([A-Za-z0-9_]{1,15})/);
  const bare = (fromUrl?.[1] ?? trimmed).replace(/^@+/, '');
  return bare === '' ? '' : `@${bare}`;
}

function textProblems(
  value: unknown,
  field: string,
  label: string,
  max: number,
  out: ContentProblem[],
): string | undefined {
  if (typeof value !== 'string') {
    out.push({ field, code: 'INVALID', message: `${label} must be text.` });
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed === '') return undefined;
  if (trimmed.length > max) {
    out.push({
      field,
      code: 'TOO_LONG',
      message: `${label} can be at most ${max} characters.`,
    });
    return undefined;
  }
  return trimmed;
}

function unknownKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  prefix: string,
  out: ContentProblem[],
): void {
  for (const key of Object.keys(value)) {
    if (allowed.includes(key)) continue;
    out.push({
      field: `${prefix}${key}`,
      code: 'UNKNOWN_KEY',
      // Named rather than listed: somebody reading this has mistyped one key, and a list of the
      // nine valid ones buries the one word that is wrong.
      message: `There is no setting called “${key}”.`,
    });
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Checks and normalises a site's SEO defaults.
 *
 * Returns the value to store **and** the problems, rather than one or the other, so the caller
 * writes `normalized` only when `problems` is empty and never has to normalise a second time. The
 * pair mirrors `normalizeSubdomain` / `subdomainProblem` one module over.
 */
export function checkSeoDefaults(input: unknown): {
  problems: ContentProblem[];
  normalized: WebsiteSeoDefaults;
} {
  const problems: ContentProblem[] = [];
  const record = asRecord(input);
  if (record === null) {
    return {
      problems: [
        { field: 'seoDefaults', code: 'INVALID', message: 'The SEO settings must be an object.' },
      ],
      normalized: {},
    };
  }
  unknownKeys(record, SEO_DEFAULT_KEYS, 'seoDefaults.', problems);

  const normalized: Record<string, unknown> = {};

  if (record.description !== undefined && record.description !== null) {
    const value = textProblems(
      record.description,
      'seoDefaults.description',
      'The site description',
      SEO_DESCRIPTION_MAX,
      problems,
    );
    if (value !== undefined) normalized.description = value;
  }

  if (record.ogImageUrl !== undefined && record.ogImageUrl !== null) {
    const value = textProblems(
      record.ogImageUrl,
      'seoDefaults.ogImageUrl',
      'The sharing image address',
      500,
      problems,
    );
    if (value !== undefined) {
      if (!isAbsoluteHttpUrl(value)) {
        problems.push({
          field: 'seoDefaults.ogImageUrl',
          code: 'INVALID',
          message:
            'A sharing image needs its full address, starting with https:// — a path like /logo.png will not show up anywhere.',
        });
      } else normalized.ogImageUrl = value;
    }
  }

  if (record.twitterSite !== undefined && record.twitterSite !== null) {
    if (typeof record.twitterSite !== 'string') {
      problems.push({
        field: 'seoDefaults.twitterSite',
        code: 'INVALID',
        message: 'The X (Twitter) name must be text.',
      });
    } else {
      const handle = normalizeTwitterHandle(record.twitterSite);
      if (handle === '') {
        // An empty result from a non-empty input is a value nothing could read, so it is refused
        // rather than quietly stored as nothing.
        if (record.twitterSite.trim() !== '') {
          problems.push({
            field: 'seoDefaults.twitterSite',
            code: 'INVALID',
            message: 'That does not look like an X (Twitter) name — try @yourbusiness.',
          });
        }
      } else if (handle.length > 16) {
        problems.push({
          field: 'seoDefaults.twitterSite',
          code: 'TOO_LONG',
          message: 'An X (Twitter) name is at most 15 characters.',
        });
      } else normalized.twitterSite = handle;
    }
  }

  if (record.noindex !== undefined && record.noindex !== null) {
    if (typeof record.noindex !== 'boolean') {
      problems.push({
        field: 'seoDefaults.noindex',
        code: 'INVALID',
        message: 'Ask search engines not to list this site must be yes or no.',
      });
    } else if (record.noindex) normalized.noindex = true;
  }

  if (record.business !== undefined && record.business !== null) {
    const business = asRecord(record.business);
    if (business === null) {
      problems.push({
        field: 'seoDefaults.business',
        code: 'INVALID',
        message: 'The business details must be an object.',
      });
    } else {
      unknownKeys(business, BUSINESS_KEYS, 'seoDefaults.business.', problems);
      const out: Record<string, unknown> = {};
      if (typeof business.kind === 'string' && business.kind.trim() === '') {
        // Same reasoning as `productId` above: an empty select is a question nobody answered.
      } else if (business.kind !== undefined && business.kind !== null) {
        if (!BUSINESS_KINDS.includes(business.kind as BusinessKind)) {
          problems.push({
            field: 'seoDefaults.business.kind',
            code: 'INVALID',
            message: 'Choose one of the available kinds of business.',
          });
        } else out.kind = business.kind;
      }
      for (const [key, label, max] of [
        ['streetAddress', 'The street address', 200],
        ['locality', 'The town or city', 100],
        ['region', 'The state or region', 100],
        ['postalCode', 'The postcode', 24],
        ['phone', 'The phone number', 32],
        ['priceRange', 'The price range', 24],
      ] as const) {
        if (business[key] === undefined || business[key] === null) continue;
        const value = textProblems(
          business[key],
          `seoDefaults.business.${key}`,
          label,
          max,
          problems,
        );
        if (value !== undefined) out[key] = value;
      }
      if (Object.keys(out).length > 0) normalized.business = out;
    }
  }

  return { problems, normalized: normalized as WebsiteSeoDefaults };
}

/** Checks and normalises a page's SEO overrides. `prefix` addresses the problems at whichever
 * field the caller's request carries them under. */
export function checkPageSeo(
  input: unknown,
  prefix = 'seo',
): { problems: ContentProblem[]; normalized: WebsitePageSeo } {
  const problems: ContentProblem[] = [];
  const record = asRecord(input);
  if (record === null) {
    return {
      problems: [
        { field: prefix, code: 'INVALID', message: 'The SEO settings must be an object.' },
      ],
      normalized: {},
    };
  }
  unknownKeys(record, PAGE_SEO_KEYS, `${prefix}.`, problems);

  const normalized: Record<string, unknown> = {};

  for (const [key, label, max] of [
    ['title', 'The page title', SEO_TITLE_MAX],
    ['description', 'The page description', SEO_DESCRIPTION_MAX],
  ] as const) {
    if (record[key] === undefined || record[key] === null) continue;
    const value = textProblems(record[key], `${prefix}.${key}`, label, max, problems);
    if (value !== undefined) normalized[key] = value;
  }

  for (const [key, label, sentence] of [
    [
      'canonicalUrl',
      'The canonical address',
      'A canonical address needs its full address, starting with https:// — a path like /pricing tells a search engine nothing it can resolve.',
    ],
    [
      'ogImageUrl',
      'The sharing image address',
      'A sharing image needs its full address, starting with https:// — a path like /photo.jpg will not show up anywhere.',
    ],
  ] as const) {
    if (record[key] === undefined || record[key] === null) continue;
    const value = textProblems(record[key], `${prefix}.${key}`, label, 500, problems);
    if (value === undefined) continue;
    if (!isAbsoluteHttpUrl(value)) {
      problems.push({ field: `${prefix}.${key}`, code: 'INVALID', message: sentence });
    } else normalized[key] = value;
  }

  if (record.noindex !== undefined && record.noindex !== null) {
    if (typeof record.noindex !== 'boolean') {
      problems.push({
        field: `${prefix}.noindex`,
        code: 'INVALID',
        message: 'Ask search engines not to list this page must be yes or no.',
      });
    } else if (record.noindex) normalized.noindex = true;
  }

  // `''` is **not chosen**, not invalid. The picker's own first option is "Not about one product"
  // and submits an empty value, so refusing it meant the commonest state of the field — nobody has
  // linked a product — was a refusal with "Choose a product." under it, on a form somebody had
  // filled in correctly. Every other field here reaches the same conclusion through
  // `textProblems`; this one did not go through it and had to be told. The same family as
  // `Number('')` being 0: a coercion used on form input has to refuse what a blank box means, not
  // reuse it.
  if (typeof record.productId === 'string' && record.productId.trim() === '') {
    // nothing to store, and nothing to complain about
  } else if (record.productId !== undefined && record.productId !== null) {
    if (typeof record.productId !== 'string' || !UUID.test(record.productId)) {
      problems.push({
        field: `${prefix}.productId`,
        code: 'INVALID',
        message: 'Choose a product.',
      });
    } else normalized.productId = record.productId;
  }

  return { problems, normalized: normalized as WebsitePageSeo };
}

/**
 * The sentence to show about a redirect's destination, or `null`.
 *
 * A destination may be a path on this site or a full `http(s)` address — moving a page and moving
 * a whole business to a new domain are both things a redirect is for.
 *
 * **It deliberately does not reuse `isSafeBlockUrl`**, which was the first draft and was wrong:
 * that function accepts `mailto:` and `tel:` because a *button on a page* may legitimately link to
 * either, and a 308 to a `mailto:` is not a thing a browser can usefully follow. Reusing it would
 * have put a value on this column that `website_redirects_to_is_a_destination` refuses — a
 * constraint saying what belongs in a table while the service writes something else, which is a
 * 500 nobody sees until that path runs. The rule here is the CHECK's rule, and
 * `schema-objects.int-spec.ts` evaluates the installed expression against this function rather
 * than against a second copy of the regex.
 *
 * A query string is allowed, unlike in a page path: a destination is an address somebody is sent
 * to, and sending them to `/offers?from=old-page` is a reasonable thing to want. A page path is a
 * *location* in a site, which is why that side drops the query.
 */
export function redirectTargetProblem(target: string): string | null {
  const trimmed = target.trim();
  if (trimmed === '') return 'Say where this address should go.';
  if (trimmed.length > 1024) return 'That destination is too long.';
  const ok =
    trimmed === '/' ||
    // Not `startsWith('/')` alone: `//evil.example` is protocol-relative, which a browser resolves
    // against the current scheme — an off-site redirect that does not look like one in a list.
    (trimmed.startsWith('/') && !trimmed.startsWith('//')) ||
    isAbsoluteHttpUrl(trimmed);
  if (!ok) {
    return 'A destination is either a path on this site like /services, or a full address starting with https://.';
  }
  return null;
}

// ---------------------------------------------------------------------------
// Where a site lives
// ---------------------------------------------------------------------------
//
// In this package rather than in the API because `apps/web` hand-writes its own copy of
// `siteAbsoluteUrl` — its runtime may not import this package at all — and a spec there
// reconciles the two by driving the same inputs through both. A function only the API could see
// would be one the web app's copy could silently drift from, which is the whole reason
// `TASK_BUCKETS` and `lib/tasks.ts` are arranged this way.

export interface SiteAddressing {
  /** Where this product's web app is, e.g. `http://localhost:3000`. */
  readonly webOrigin: string;
  /** The bare domain tenant sites are served under, e.g. `leados.app`, or undefined. */
  readonly baseDomain: string | undefined;
}

/**
 * The base URL of a site: everything before a page's path.
 *
 * With `WEBSITE_BASE_DOMAIN` set this is a real origin (`https://acme.leados.app`); without it,
 * it is the renderer's own path-based address (`http://localhost:3000/s/acme`). Both are correct
 * addresses for the deployment that produces them, which is what makes the variable's absence
 * safe rather than a half-configured product.
 *
 * **No trailing slash, ever.** Next redirects `/s/acme/` to `/s/acme`, and a canonical that points
 * at a redirect is a canonical a crawler discards — so the one place that could reasonably add a
 * slash is the one place it must not.
 */
export function siteBaseUrl(subdomain: string, addressing: SiteAddressing): string {
  const slug = subdomain.trim().toLowerCase();
  if (addressing.baseDomain !== undefined && addressing.baseDomain !== '') {
    return `https://${slug}.${addressing.baseDomain}`;
  }
  return `${addressing.webOrigin.replace(/\/+$/, '')}/s/${encodeURIComponent(slug)}`;
}

/**
 * The absolute address of one page.
 *
 * The home page is the base itself, not the base plus `/`, for the trailing-slash reason above.
 */
export function siteAbsoluteUrl(baseUrl: string, path: string): string {
  if (path === WEBSITE_HOME_PATH || path === '') return baseUrl;
  return `${baseUrl}${path.startsWith('/') ? path : `/${path}`}`;
}
