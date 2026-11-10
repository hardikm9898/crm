import { describe, expect, it } from 'vitest';
import { normalizePagePath, WEBSITE_HOME_PATH as SHARED_HOME_PATH } from '@leados/shared';
import {
  WEBSITE_HOME_PATH,
  pageAt,
  pathFromSegments,
  siteCacheTag,
  themeStyle,
  isKnownBlockType,
  safeUrl,
  type SiteSnapshot,
} from './websites';

/**
 * This file is the reconciliation `lib/websites.ts` relies on.
 *
 * That module hand-writes its copy of the website vocabulary because `@leados/shared`'s entry
 * point reaches `node:async_hooks` and a client component that transitively imports it fails
 * `next build`. A spec runs in Node and may import both, which is the only place the two can be
 * compared — exactly as `lib/tasks.ts`, `lib/sla.ts` and `lib/whatsapp.ts` are compared.
 */

describe('the renderer agrees with the shared vocabulary', () => {
  it('uses the same home path', () => {
    expect(WEBSITE_HOME_PATH).toBe(SHARED_HOME_PATH);
  });

  /**
   * `pathFromSegments` reads what Next has already split and decoded; `normalizePagePath` cleans
   * what somebody typed into an editor. They are deliberately not the same function, so what has
   * to hold is that they agree on every shape a **URL** can produce — if they ever disagree, a
   * published page becomes unreachable at its own address and nothing else in the product notices.
   */
  it('resolves a URL to the path the editor would have stored', () => {
    const cases: [string[] | undefined, string][] = [
      [undefined, '/'],
      [[], '/'],
      [['about'], '/about'],
      [['services', 'interiors'], '/services/interiors'],
      [['About'], '/about'],
      [['a-b'], '/a-b'],
    ];
    for (const [segments, expected] of cases) {
      const fromUrl = pathFromSegments(segments);
      expect(fromUrl, JSON.stringify(segments)).toBe(expected);
      // …and the editor, given the same address, stores exactly that.
      expect(normalizePagePath(expected), expected).toBe(fromUrl);
    }
  });

  it('drops empty segments rather than producing a double slash', () => {
    expect(pathFromSegments(['about', ''])).toBe('/about');
    expect(pathFromSegments(['', ''])).toBe('/');
  });
});

describe('siteCacheTag', () => {
  it('is stable across the casing a browser might send', () => {
    expect(siteCacheTag('Acme')).toBe('site:acme');
    expect(siteCacheTag('  acme  ')).toBe('site:acme');
  });
});

describe('pageAt', () => {
  const snapshot: SiteSnapshot = {
    theme: {},
    seoDefaults: {},
    pages: [
      { path: '/welcome', title: 'Welcome', blocks: [], seo: {}, isHome: true, sortOrder: 0 },
      { path: '/about', title: 'About', blocks: [], seo: {}, isHome: false, sortOrder: 1 },
    ],
  };

  it('finds a page by its own path', () => {
    expect(pageAt(snapshot, '/about')?.title).toBe('About');
  });

  it('answers the home page at the root even when its path is not /', () => {
    // A site whose home page lives at a real path still has to answer at its root, or the address
    // somebody is given is a 404.
    expect(pageAt(snapshot, '/')?.title).toBe('Welcome');
  });

  it('answers nothing for a path the snapshot does not have', () => {
    // Not the home page: a stale link should tell the visitor, and a search engine should not find
    // two addresses serving one page.
    expect(pageAt(snapshot, '/pricing')).toBeUndefined();
  });
});

describe('themeStyle', () => {
  it('falls back to a neutral set that is not this product’s primary colour', () => {
    const style = themeStyle({});
    expect(style['--site-bg']).toBe('#ffffff');
    // A builder's site rendering in Lead OS blue would be our brand on their page.
    expect(style['--site-accent']).not.toContain('oklch');
  });

  it('reads the keys it allows', () => {
    const style = themeStyle({ accent: '#ff0000', font: 'Georgia, serif' });
    expect(style['--site-accent']).toBe('#ff0000');
    expect(style['--site-font']).toBe('Georgia, serif');
  });

  it('ignores a key it does not know, rather than spreading the theme', () => {
    const style = themeStyle({ accent: '#ff0000', position: 'fixed' } as Record<string, unknown>);
    expect(Object.values(style)).not.toContain('fixed');
  });

  /**
   * A theme is tenant-controlled JSON on its way into a `style` attribute. Spreading it would let a
   * saved theme inject arbitrary CSS, including a `url(...)` pointing anywhere — so the allowlist
   * is the whole defence and these are the shapes it has to refuse.
   */
  it('refuses a value that could carry CSS of its own', () => {
    for (const hostile of [
      'red; position: fixed; top: 0',
      'url(https://example.com/x.png)',
      'red} body{display:none',
      'expression(alert(1))',
      '@import "evil.css"',
      '#'.padEnd(200, 'a'),
    ]) {
      const style = themeStyle({ accent: hostile });
      expect(style['--site-accent'], hostile).toBe('#1f6feb');
    }
  });
});

describe('safeUrl', () => {
  it('accepts the schemes a link on a website legitimately uses', () => {
    expect(safeUrl('https://example.com/')).toBe('https://example.com/');
    expect(safeUrl('mailto:hello@example.com')).toBe('mailto:hello@example.com');
    expect(safeUrl('tel:+919845012345')).toBe('tel:+919845012345');
    expect(safeUrl('/about')).toBe('/about');
  });

  it('refuses a scheme that executes, and a protocol-relative URL', () => {
    // React will put `javascript:` in an href without complaint. A tenant's own editor is not a
    // trust boundary, because the person who pastes a link is not always the person who owns the
    // workspace.
    expect(safeUrl('javascript:alert(1)')).toBeNull();
    expect(safeUrl('data:text/html,<script>alert(1)</script>')).toBeNull();
    expect(safeUrl('//evil.example.com')).toBeNull();
    expect(safeUrl('not a url')).toBeNull();
    expect(safeUrl(null)).toBeNull();
  });
});

describe('isKnownBlockType', () => {
  it('knows the types this release can draw', () => {
    expect(isKnownBlockType('hero')).toBe(true);
    expect(isKnownBlockType('whatsapp_cta')).toBe(true);
  });

  it('does not know a type from a newer release, and says so without throwing', () => {
    // A published site must not go blank because somebody rolled back to a snapshot containing a
    // block this release has never heard of.
    expect(isKnownBlockType('pricing_table_v2')).toBe(false);
    expect(isKnownBlockType(undefined)).toBe(false);
    expect(isKnownBlockType(42)).toBe(false);
  });
});
