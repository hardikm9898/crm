import { describe, expect, it } from 'vitest';
import {
  BUSINESS_KINDS as SHARED_BUSINESS_KINDS,
  WEBSITE_PAGE_SEO_KEYS,
  WEBSITE_SEO_DEFAULT_KEYS,
  siteAbsoluteUrl,
} from '@leados/shared';
import type { PublishedSite, SiteBusiness, SnapshotPage } from './websites';
import {
  BUSINESS_KINDS,
  DERIVED_DESCRIPTION_MAX,
  PAGE_SEO_KEYS,
  SEO_DEFAULT_KEYS,
  absoluteSiteUrl,
  derivedDescription,
  jsonLdScript,
  localBusinessJsonLd,
  pageMetadata,
  productJsonLd,
  resolveRedirect,
  robotsTxt,
  sitemapXml,
} from './website-seo';

/**
 * This file is the reconciliation the hand-written copies in `lib/` depend on.
 *
 * `apps/web`'s runtime may not import `@leados/shared` — its entry point reaches
 * `node:async_hooks` and a client component that transitively imports it fails `next build` — so
 * each `lib/*` module hand-writes the vocabulary it needs. A spec runs in Node and may import
 * both, which is the only thing that stops the two drifting.
 */

function page(overrides: Partial<SnapshotPage> = {}): SnapshotPage {
  return {
    path: '/',
    title: 'Home',
    blocks: [],
    seo: {},
    isHome: true,
    sortOrder: 0,
    ...overrides,
  };
}

function site(overrides: Partial<PublishedSite> = {}): PublishedSite {
  return {
    site: { name: 'Acme Interiors', subdomain: 'acme', baseUrl: 'https://acme.leados.app' },
    version: 3,
    versionId: '0193f1a2-0000-7000-8000-000000000001',
    publishedAt: '2026-11-14T09:30:00.000Z',
    snapshot: { theme: {}, seoDefaults: {}, pages: [page()] },
    forms: {},
    redirects: [],
    business: null,
    products: {},
    ...overrides,
  };
}

describe('the hand-written registry copies', () => {
  it('reads every key the real page-SEO registry accepts', () => {
    // The direction a behaviour test cannot cover: a key added to the shared registry that this
    // renderer never reads is a setting somebody fills in and no page ever shows.
    expect([...PAGE_SEO_KEYS].sort()).toEqual([...WEBSITE_PAGE_SEO_KEYS].sort());
  });

  it('reads every key the real site-defaults registry accepts', () => {
    expect([...SEO_DEFAULT_KEYS].sort()).toEqual([...WEBSITE_SEO_DEFAULT_KEYS].sort());
  });

  it('offers exactly the kinds of business the API accepts', () => {
    // A kind in the picker the API refuses is a dropdown option that produces a refusal; one the
    // API accepts and the picker omits is a kind nobody can choose.
    expect([...BUSINESS_KINDS].sort()).toEqual([...SHARED_BUSINESS_KINDS].sort());
  });

  it('agrees with the API about where a page lives', () => {
    // A canonical URL from this app and a sitemap entry from this app both come from
    // `absoluteSiteUrl`; the API computes the base. If the two functions disagreed about the home
    // page's trailing slash, every canonical on every site would point at a redirect.
    for (const [base, path] of [
      ['https://acme.leados.app', '/'],
      ['https://acme.leados.app', '/about'],
      ['http://localhost:3000/s/acme', '/'],
      ['http://localhost:3000/s/acme', '/services/interiors'],
      ['https://acme.leados.app', ''],
    ] as const) {
      expect(absoluteSiteUrl(base, path), `${base} + ${path}`).toBe(siteAbsoluteUrl(base, path));
    }
  });
});

describe('pageMetadata', () => {
  it('canonicalises to the page’s own address by default', () => {
    // The actual value of a canonical: `?utm_source=whatsapp` on a shared link is the same page,
    // and without this every tracked link looks like a duplicate.
    const meta = pageMetadata(site(), page({ path: '/services' }));
    expect(meta.alternates?.canonical).toBe('https://acme.leados.app/services');
  });

  it('lets a page override the canonical outright', () => {
    const meta = pageMetadata(
      site(),
      page({ seo: { canonicalUrl: 'https://acme.example/original' } }),
    );
    expect(meta.alternates?.canonical).toBe('https://acme.example/original');
  });

  it('appends the site name to the default title and not to an override', () => {
    // Somebody filling in a title tag is controlling the sixty characters a search result shows.
    // Appending to that would be overriding the override.
    expect(pageMetadata(site(), page({ title: 'Our work' })).title).toBe(
      'Our work · Acme Interiors',
    );
    expect(
      pageMetadata(site(), page({ seo: { title: 'Interior design in Bengaluru' } })).title,
    ).toBe('Interior design in Bengaluru');
  });

  it('falls back from the page to the site to the page’s own words', () => {
    const withBlocks = page({
      blocks: [
        {
          type: 'hero',
          params: { heading: 'Hi', subheading: 'We fit out homes across the city.' },
        },
      ],
    });
    expect(pageMetadata(site(), page({ seo: { description: 'Page copy' } })).description).toBe(
      'Page copy',
    );
    expect(
      pageMetadata(
        site({ snapshot: { theme: {}, seoDefaults: { description: 'Site copy' }, pages: [] } }),
        page(),
      ).description,
    ).toBe('Site copy');
    expect(pageMetadata(site(), withBlocks).description).toBe('We fit out homes across the city.');
  });

  it('omits the description entirely when there is nothing to say', () => {
    // An empty `<meta name="description" content="">` is worse than no tag: it tells a crawler
    // the page has no summary rather than letting it infer one.
    expect(pageMetadata(site(), page()).description).toBeUndefined();
  });

  it('asks for no index and no follow when either level says so', () => {
    // `nofollow` travels with `noindex` deliberately: a page the business keeps out of search
    // should not be passing authority onward either.
    expect(pageMetadata(site(), page({ seo: { noindex: true } })).robots).toEqual({
      index: false,
      follow: false,
    });
    expect(
      pageMetadata(
        site({ snapshot: { theme: {}, seoDefaults: { noindex: true }, pages: [] } }),
        page(),
      ).robots,
    ).toEqual({ index: false, follow: false });
    expect(pageMetadata(site(), page()).robots).toBeUndefined();
  });

  it('uses the small Twitter card when there is no image', () => {
    // The large card with nothing in it renders as a blank rectangle, which looks worse than the
    // small card it replaced. `Twitter` is a union in Next's types and `card` is only on some
    // members of it, so this reads the object rather than the narrowed type.
    const card = (meta: ReturnType<typeof pageMetadata>): unknown =>
      (meta.twitter as Record<string, unknown> | null | undefined)?.card;
    expect(card(pageMetadata(site(), page()))).toBe('summary');
    expect(
      card(pageMetadata(site(), page({ seo: { ogImageUrl: 'https://cdn.example/x.png' } }))),
    ).toBe('summary_large_image');
  });

  it('ignores a key an older release never heard of', () => {
    // Writes refuse an unknown key; reads tolerate one. That asymmetry is what lets a rollback to
    // an older release keep rendering instead of blanking a live site.
    const meta = pageMetadata(site(), page({ seo: { futureThing: 'x', title: 'Kept' } }));
    expect(meta.title).toBe('Kept');
  });
});

describe('derivedDescription', () => {
  it('skips a heading too short to be a summary', () => {
    expect(
      derivedDescription(page({ blocks: [{ type: 'text', params: { body: 'Hello' } }] })),
    ).toBeUndefined();
  });

  it('flattens whitespace and cuts at a word boundary', () => {
    const long = `${'word '.repeat(60)}end`;
    const result = derivedDescription(page({ blocks: [{ type: 'text', params: { body: long } }] }));
    expect(result).toBeDefined();
    expect(result!.length).toBeLessThanOrEqual(DERIVED_DESCRIPTION_MAX + 1);
    // A description sliced mid-word reads as broken software.
    expect(result).toMatch(/…$/);
    expect(result).not.toMatch(/wor…$/);
  });

  it('takes the first block that has something to say', () => {
    const result = derivedDescription(
      page({
        blocks: [
          { type: 'image', params: { src: 'https://x/y.png', alt: 'A room' } },
          { type: 'text', params: { body: 'We fit out homes and offices across Bengaluru.' } },
        ],
      }),
    );
    expect(result).toBe('We fit out homes and offices across Bengaluru.');
  });
});

describe('sitemapXml', () => {
  it('lists every page in the snapshot, which is what makes drafts structurally absent', () => {
    // The snapshot holds the pages that were `published` at the moment of the publish, so a draft
    // is not filtered out here — it was never in the input. Step 2's draft-leak guarantee, one
    // layer out.
    const xml = sitemapXml(
      site({
        snapshot: {
          theme: {},
          seoDefaults: {},
          pages: [page(), page({ path: '/about', isHome: false })],
        },
      }),
    );
    expect(xml).toContain('<loc>https://acme.leados.app</loc>');
    expect(xml).toContain('<loc>https://acme.leados.app/about</loc>');
    expect(xml.match(/<url>/g)).toHaveLength(2);
    expect(xml).toMatch(/^<\?xml version="1\.0" encoding="UTF-8"\?>/);
  });

  it('leaves out a page the site asked not to list', () => {
    // A sitemap entry for a `noindex` page is a contradiction Search Console reports as an error,
    // and the two settings are filled in on different screens.
    const xml = sitemapXml(
      site({
        snapshot: {
          theme: {},
          seoDefaults: {},
          pages: [page(), page({ path: '/thanks', isHome: false, seo: { noindex: true } })],
        },
      }),
    );
    expect(xml).toContain('<loc>https://acme.leados.app</loc>');
    expect(xml).not.toContain('/thanks');
    expect(xml.match(/<url>/g)).toHaveLength(1);
  });

  it('is an empty urlset when the whole site is noindex, not a broken document', () => {
    const xml = sitemapXml(
      site({ snapshot: { theme: {}, seoDefaults: { noindex: true }, pages: [page()] } }),
    );
    expect(xml).not.toContain('<url>');
    expect(xml).toContain('<urlset');
    expect(xml.trimEnd()).toMatch(/<\/urlset>$/);
  });

  it('dates every page with the publish instant', () => {
    // A published version is a single act. The per-page `updated_at` of a draft is a date the
    // public has never seen.
    expect(sitemapXml(site())).toContain('<lastmod>2026-11-14T09:30:00.000Z</lastmod>');
  });

  it('escapes XML in an address', () => {
    const xml = sitemapXml(
      site({ site: { name: 'A', subdomain: 'a', baseUrl: 'https://x.test/a&b' } }),
    );
    expect(xml).toContain('https://x.test/a&amp;b');
    expect(xml).not.toMatch(/a&b/);
  });
});

describe('robotsTxt', () => {
  it('advertises the sitemap', () => {
    expect(robotsTxt(site())).toContain('Sitemap: https://acme.leados.app/sitemap.xml');
  });

  it('still allows crawling when the site asks not to be listed', () => {
    // The instinct is `Disallow: /`, and it is exactly wrong: Disallow stops the crawler fetching
    // the page, so it never sees the `noindex` tag, so a site already in the index stays there —
    // permanently. Allowing the crawl and serving `noindex` is the only pair that deindexes.
    const text = robotsTxt(
      site({ snapshot: { theme: {}, seoDefaults: { noindex: true }, pages: [page()] } }),
    );
    expect(text).toContain('Allow: /');
    expect(text).not.toContain('Disallow');
    // But it does not advertise a list of pages the business asked you not to list.
    expect(text).not.toContain('Sitemap:');
  });
});

describe('structured data', () => {
  const business: SiteBusiness = {
    name: 'Acme Interiors',
    legalName: 'Acme Interiors Pvt Ltd',
    country: 'IN',
    logoUrl: 'https://cdn.example/logo.png',
    timezone: 'Asia/Kolkata',
    kind: 'HomeAndConstructionBusiness',
    streetAddress: '12 MG Road',
    locality: 'Bengaluru',
    region: 'KA',
    postalCode: '560001',
    phone: '+91 80 4567 8900',
    priceRange: '₹₹',
    openingHours: [{ dayOfWeek: 1, opens: '09:30', closes: '18:00' }],
  };

  it('emits the declared kind, the address and the hours', () => {
    const data = localBusinessJsonLd(business, 'https://acme.leados.app');
    expect(data).not.toBeNull();
    expect(data!['@type']).toBe('HomeAndConstructionBusiness');
    expect(data!.url).toBe('https://acme.leados.app');
    expect(data!.address).toMatchObject({
      '@type': 'PostalAddress',
      streetAddress: '12 MG Road',
      addressCountry: 'IN',
    });
    expect(data!.openingHoursSpecification).toEqual([
      {
        '@type': 'OpeningHoursSpecification',
        // 0 is Sunday in `working_hours.day_of_week`, so 1 is Monday. Getting this off by one
        // would publish the wrong trading hours, which is the one thing worse than none.
        dayOfWeek: 'https://schema.org/Monday',
        opens: '09:30',
        closes: '18:00',
      },
    ]);
  });

  it('emits nothing when there is nothing but a name', () => {
    // An incomplete LocalBusiness is a Search Console error a business owner would have to act on,
    // about a feature they never asked for.
    expect(
      localBusinessJsonLd(
        {
          ...business,
          streetAddress: null,
          locality: null,
          postalCode: null,
          phone: null,
          openingHours: [],
        },
        'https://acme.leados.app',
      ),
    ).toBeNull();
    expect(localBusinessJsonLd(null, 'https://acme.leados.app')).toBeNull();
  });

  it('prices a product in major units as a fixed string', () => {
    const data = productJsonLd(
      {
        name: 'Modular kitchen',
        description: null,
        sku: 'MK-1',
        priceMinor: 19_90,
        currency: 'INR',
      },
      'https://acme.leados.app/kitchens',
    );
    // `19.9` is not a price and a float would eventually produce `19.900000000000002`.
    expect((data!.offers as Record<string, unknown>).price).toBe('19.90');
    expect((data!.offers as Record<string, unknown>).priceCurrency).toBe('INR');
  });

  it('omits the offer when there is no currency', () => {
    // Google requires `priceCurrency` alongside `price`, so a price with nothing to measure it in
    // is an error rather than partial information.
    const data = productJsonLd(
      { name: 'Consultation', description: null, sku: null, priceMinor: 0, currency: null },
      'https://acme.leados.app/x',
    );
    expect(data!.offers).toBeUndefined();
    expect(data!.name).toBe('Consultation');
  });

  it('emits nothing for a product that has been withdrawn', () => {
    // The API leaves a deactivated product out of the map, and structured data claiming something
    // is for sale when it has been withdrawn is worse than none.
    expect(productJsonLd(undefined, 'https://acme.leados.app/x')).toBeNull();
  });

  it('escapes a closing script tag typed into tenant content', () => {
    // The whole reason `jsonLdScript` exists. Without this a tenant can type `</script>` into a
    // description and have the rest of the document parsed as markup — stored XSS on every
    // visitor's page.
    const json = jsonLdScript({ name: '</script><img src=x onerror=alert(1)>' });
    expect(json).not.toContain('</script>');
    expect(json).not.toContain('<img');
    expect(json).toContain('\\u003c');
    // And it is still JSON a parser round-trips.
    expect(JSON.parse(json)).toEqual({ name: '</script><img src=x onerror=alert(1)>' });
  });
});

describe('resolveRedirect', () => {
  it('finds a redirect by its source path', () => {
    const subject = site({
      redirects: [{ fromPath: '/old-prices', toPath: '/pricing', kind: 'permanent' }],
    });
    expect(resolveRedirect(subject, '/old-prices')).toEqual({
      fromPath: '/old-prices',
      toPath: '/pricing',
      kind: 'permanent',
    });
    expect(resolveRedirect(subject, '/pricing')).toBeUndefined();
  });

  it('does one lookup and no chain walk', () => {
    // The API's invariant is that no destination is another redirect's source, so following one
    // hop is following all of them. A renderer that walked a chain would be code written against
    // a state the writer refuses to create.
    const subject = site({
      redirects: [
        { fromPath: '/a', toPath: '/c', kind: 'permanent' },
        { fromPath: '/b', toPath: '/c', kind: 'permanent' },
      ],
    });
    expect(resolveRedirect(subject, '/a')?.toPath).toBe('/c');
  });
});
