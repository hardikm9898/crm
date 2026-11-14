import { describe, expect, it } from 'vitest';
import {
  BUSINESS_KINDS,
  REDIRECT_KINDS,
  SEO_DESCRIPTION_MAX,
  SEO_TITLE_MAX,
  checkPageSeo,
  checkSeoDefaults,
  isAbsoluteHttpUrl,
  normalizeTwitterHandle,
  redirectTargetProblem,
  siteAbsoluteUrl,
  siteBaseUrl,
} from './website-seo.js';

describe('checkPageSeo', () => {
  it('accepts an empty object: a page that inherits is the common case', () => {
    const { problems, normalized } = checkPageSeo({});
    expect(problems).toEqual([]);
    expect(normalized).toEqual({});
  });

  it('refuses a key nobody declared, addressed at that key', () => {
    // A `desciption` that nothing refuses is a setting which silently does nothing for ever, on
    // the one screen whose whole purpose is being read by a machine.
    const { problems } = checkPageSeo({ desciption: 'oops' });
    expect(problems).toHaveLength(1);
    expect(problems[0]?.field).toBe('seo.desciption');
    expect(problems[0]?.code).toBe('UNKNOWN_KEY');
    expect(problems[0]?.message).toContain('desciption');
  });

  it('refuses a relative canonical and says what is wrong with it', () => {
    const { problems } = checkPageSeo({ canonicalUrl: '/pricing' });
    expect(problems).toHaveLength(1);
    expect(problems[0]?.field).toBe('seo.canonicalUrl');
    // The sentence names the fix. "Invalid" leaves somebody retyping the same address.
    expect(problems[0]?.message).toContain('https://');
  });

  it('refuses a relative social image, which is the commonest Open Graph mistake', () => {
    expect(checkPageSeo({ ogImageUrl: '/logo.png' }).problems).toHaveLength(1);
    expect(checkPageSeo({ ogImageUrl: 'https://cdn.example.com/logo.png' }).problems).toEqual([]);
  });

  it('refuses an over-long title and names the ceiling', () => {
    const { problems } = checkPageSeo({ title: 'a'.repeat(SEO_TITLE_MAX + 1) });
    expect(problems[0]?.code).toBe('TOO_LONG');
    expect(problems[0]?.message).toContain(String(SEO_TITLE_MAX));
    expect(checkPageSeo({ title: 'a'.repeat(SEO_TITLE_MAX) }).problems).toEqual([]);
  });

  it('treats a blank string as absent rather than as a value', () => {
    // A form submits '' for a box somebody cleared, and storing that would put an empty
    // description tag on the page — worse than none, which at least lets a crawler infer one.
    const { problems, normalized } = checkPageSeo({ title: '   ', description: '' });
    expect(problems).toEqual([]);
    expect(normalized).toEqual({});
  });

  it('treats an empty product choice as "not chosen", not as invalid', () => {
    // The picker's own first option is "Not about one product" and submits `''`. Refusing it meant
    // the commonest state of the field was a refusal, on a form somebody had filled in correctly —
    // found by a browser check, because every unit test passed a real id or nothing at all.
    const { problems, normalized } = checkPageSeo({ productId: '', noindex: true });
    expect(problems).toEqual([]);
    expect(normalized).toEqual({ noindex: true });
  });

  it('accepts everything a cleared form sends', () => {
    // Exactly the body the page SEO form submits when every box is empty and one checkbox is on.
    const { problems } = checkPageSeo({
      title: '',
      description: '',
      canonicalUrl: '',
      ogImageUrl: '',
      noindex: true,
      productId: '',
    });
    expect(problems).toEqual([]);
  });

  it('refuses a productId that is not an id', () => {
    expect(checkPageSeo({ productId: 'the blue one' }).problems).toHaveLength(1);
    expect(checkPageSeo({ productId: '0193f1a2-0000-7000-8000-000000000001' }).problems).toEqual(
      [],
    );
  });

  it('addresses problems at the prefix it is given', () => {
    // The page editor submits `seo`; a different caller may carry it elsewhere, and a screen can
    // only print a problem against a control if the field path matches what it rendered.
    const { problems } = checkPageSeo({ nope: 1 }, 'pages[2].seo');
    expect(problems[0]?.field).toBe('pages[2].seo.nope');
  });

  it('keeps a false noindex out of the stored value', () => {
    // `noindex: false` is the default, so storing it would put a key in every snapshot that means
    // nothing — which a reader of the version history has to look past.
    expect(checkSeoDefaults({ noindex: false }).normalized).toEqual({});
    expect(checkSeoDefaults({ noindex: true }).normalized).toEqual({ noindex: true });
  });
});

describe('checkSeoDefaults', () => {
  it('normalises an X handle from a pasted profile URL', () => {
    // One place does this. A screen that also cleaned the value would be a second answer to one
    // question, and the two would eventually disagree about what a pasted URL becomes.
    expect(normalizeTwitterHandle('https://x.com/acmeinteriors')).toBe('@acmeinteriors');
    expect(normalizeTwitterHandle('https://twitter.com/acmeinteriors')).toBe('@acmeinteriors');
    expect(normalizeTwitterHandle('@acme')).toBe('@acme');
    expect(normalizeTwitterHandle('acme')).toBe('@acme');
    expect(normalizeTwitterHandle('@@acme')).toBe('@acme');
    expect(normalizeTwitterHandle('   ')).toBe('');
  });

  it('stores the normalised handle, not what was typed', () => {
    expect(checkSeoDefaults({ twitterSite: 'https://x.com/acme' }).normalized).toEqual({
      twitterSite: '@acme',
    });
  });

  it('refuses something that cannot be a handle at all', () => {
    const { problems } = checkSeoDefaults({ twitterSite: '@@@' });
    expect(problems).toHaveLength(1);
    expect(problems[0]?.field).toBe('seoDefaults.twitterSite');
  });

  it('refuses a business kind that is not a schema.org type', () => {
    // A typo in `@type` produces a document that validates as nothing, which is indistinguishable
    // from having published no structured data at all.
    expect(checkSeoDefaults({ business: { kind: 'Shop' } }).problems).toHaveLength(1);
    for (const kind of BUSINESS_KINDS) {
      expect(checkSeoDefaults({ business: { kind } }).problems).toEqual([]);
    }
  });

  it('treats an empty business kind as "not chosen"', () => {
    expect(checkSeoDefaults({ business: { kind: '' } }).problems).toEqual([]);
  });

  it('accepts everything a cleared site-SEO form sends', () => {
    const { problems } = checkSeoDefaults({
      description: '',
      ogImageUrl: '',
      twitterSite: '',
      noindex: false,
      business: {
        kind: '',
        streetAddress: '',
        locality: '',
        region: '',
        postalCode: '',
        phone: '',
        priceRange: '',
      },
    });
    expect(problems).toEqual([]);
  });

  it('refuses an unknown key inside business, addressed at the nested path', () => {
    const { problems } = checkSeoDefaults({ business: { city: 'Bengaluru' } });
    expect(problems[0]?.field).toBe('seoDefaults.business.city');
  });

  it('drops an empty business object rather than storing one', () => {
    expect(checkSeoDefaults({ business: {} }).normalized).toEqual({});
  });

  it('bounds the description', () => {
    expect(
      checkSeoDefaults({ description: 'a'.repeat(SEO_DESCRIPTION_MAX + 1) }).problems[0]?.code,
    ).toBe('TOO_LONG');
  });

  it('refuses a non-object outright', () => {
    for (const value of [null, 'text', 42, ['a']]) {
      expect(checkSeoDefaults(value).problems).toHaveLength(1);
    }
  });
});

describe('redirectTargetProblem', () => {
  it('accepts a path on this site and a full address elsewhere', () => {
    for (const ok of ['/', '/services', '/offers?from=old', 'https://example.com/moved']) {
      expect(redirectTargetProblem(ok), ok).toBeNull();
    }
  });

  it('refuses a protocol-relative address, which is an off-site redirect in disguise', () => {
    // `//evil.example` resolves against the current scheme, so it reads as a path in a list of
    // redirects and behaves as another domain.
    expect(redirectTargetProblem('//evil.example')).not.toBeNull();
  });

  it('refuses the schemes a page may link to but a redirect cannot follow', () => {
    // The first draft reused `isSafeBlockUrl`, which accepts these because a *button* may link to
    // them. A 308 to a `mailto:` is not something a browser can usefully do, and the CHECK on the
    // column refuses it — so reusing that function would have written a value the column rejects.
    for (const bad of ['mailto:hello@example.com', 'tel:+919845012345', 'javascript:alert(1)']) {
      expect(redirectTargetProblem(bad), bad).not.toBeNull();
    }
  });

  it('refuses nothing at all', () => {
    expect(redirectTargetProblem('   ')).not.toBeNull();
  });

  it('has two kinds, which are the two HTTP semantics', () => {
    expect([...REDIRECT_KINDS]).toEqual(['permanent', 'temporary']);
  });
});

describe('isAbsoluteHttpUrl', () => {
  it('accepts only http and https', () => {
    expect(isAbsoluteHttpUrl('https://example.com')).toBe(true);
    expect(isAbsoluteHttpUrl('http://example.com')).toBe(true);
    for (const bad of ['/logo.png', 'ftp://example.com', 'mailto:a@b.c', 'example.com', '']) {
      expect(isAbsoluteHttpUrl(bad), bad).toBe(false);
    }
  });
});

describe('siteBaseUrl and siteAbsoluteUrl', () => {
  const web = { webOrigin: 'http://localhost:3000', baseDomain: undefined };

  it('serves a path-based address when no website domain is configured', () => {
    // The point of the optional variable: unset, it produces a working address, not a broken one.
    expect(siteBaseUrl('acme', web)).toBe('http://localhost:3000/s/acme');
  });

  it('serves a subdomain when one is configured', () => {
    expect(siteBaseUrl('acme', { ...web, baseDomain: 'leados.app' })).toBe(
      'https://acme.leados.app',
    );
  });

  it('treats an empty domain as unset', () => {
    // An empty string is how most process managers say "not configured", and reading it as a
    // domain produces `https://acme.`.
    expect(siteBaseUrl('acme', { ...web, baseDomain: '' })).toBe('http://localhost:3000/s/acme');
  });

  it('never ends in a slash', () => {
    // Next redirects `/s/acme/` to `/s/acme`, and a canonical pointing at a redirect is discarded.
    expect(siteBaseUrl('acme', { ...web, webOrigin: 'http://localhost:3000/' })).toBe(
      'http://localhost:3000/s/acme',
    );
  });

  it('lowercases the subdomain', () => {
    expect(siteBaseUrl('ACME', web)).toBe('http://localhost:3000/s/acme');
  });

  it('gives the base itself for the home page', () => {
    expect(siteAbsoluteUrl('https://acme.leados.app', '/')).toBe('https://acme.leados.app');
    expect(siteAbsoluteUrl('https://acme.leados.app', '')).toBe('https://acme.leados.app');
  });

  it('appends any other path', () => {
    expect(siteAbsoluteUrl('https://acme.leados.app', '/services/interiors')).toBe(
      'https://acme.leados.app/services/interiors',
    );
    expect(siteAbsoluteUrl('http://localhost:3000/s/acme', '/about')).toBe(
      'http://localhost:3000/s/acme/about',
    );
  });
});
