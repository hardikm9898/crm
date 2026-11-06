import { describe, expect, it } from 'vitest';
import {
  RESERVED_SUBDOMAINS,
  SUBDOMAIN_MAX_LENGTH,
  WEBSITE_HOME_PATH,
  normalizePagePath,
  normalizeSubdomain,
  pagePathProblem,
  subdomainProblem,
} from './websites.js';

describe('normalizeSubdomain', () => {
  it('lowercases and trims', () => {
    expect(normalizeSubdomain('  AcmeRealty  ')).toBe('acmerealty');
  });

  it('turns the spaces and underscores in a typed business name into hyphens', () => {
    // Dropping them instead would make "Acme Realty" into `acmerealty`, which is a different
    // address from the one somebody typing that will expect to see.
    expect(normalizeSubdomain('Acme Realty')).toBe('acme-realty');
    expect(normalizeSubdomain('acme_realty')).toBe('acme-realty');
  });

  it('collapses runs of hyphens so a typo is not a different address', () => {
    expect(normalizeSubdomain('acme  --  realty')).toBe('acme-realty');
  });
});

describe('subdomainProblem', () => {
  it('accepts an ordinary address', () => {
    expect(subdomainProblem('acme-realty')).toBeNull();
    expect(subdomainProblem('a1b')).toBeNull();
  });

  it('answers a sentence, not a code', () => {
    // The reason this function exists rather than a Zod `.min(3)`: "String must contain at least 3
    // character(s)" reached users once already in this codebase, under the phone box on the lead
    // form. Asserting the sentence is what stops that happening again here.
    expect(subdomainProblem('ab')).toMatch(/at least 3 characters/);
    expect(subdomainProblem('')).toMatch(/Choose an address/);
    expect(subdomainProblem('-nope')).toMatch(/cannot start or end with a hyphen/);
    expect(subdomainProblem('nope-')).toMatch(/cannot start or end with a hyphen/);
    expect(subdomainProblem('under_score')).toMatch(/letters, numbers and hyphens/);
  });

  it('refuses a reserved address and names it', () => {
    for (const reserved of RESERVED_SUBDOMAINS) {
      expect(subdomainProblem(reserved), reserved).toMatch(/reserved by the platform/);
    }
  });

  it('refuses one character over the limit and accepts one at it', () => {
    expect(subdomainProblem('a'.repeat(SUBDOMAIN_MAX_LENGTH))).toBeNull();
    expect(subdomainProblem('a'.repeat(SUBDOMAIN_MAX_LENGTH + 1))).toMatch(/at most/);
  });

  it('is written to be fed the normalized value', () => {
    // A caller that forgets `normalizeSubdomain` gets a refusal rather than a stored capital
    // letter, which is the safe direction for the two to disagree in.
    expect(subdomainProblem('Acme Realty')).not.toBeNull();
    expect(subdomainProblem(normalizeSubdomain('Acme Realty'))).toBeNull();
  });
});

describe('normalizePagePath', () => {
  it('reduces an empty path and a bare slash to the home path', () => {
    expect(normalizePagePath('')).toBe(WEBSITE_HOME_PATH);
    expect(normalizePagePath('/')).toBe(WEBSITE_HOME_PATH);
    expect(normalizePagePath('   ')).toBe(WEBSITE_HOME_PATH);
  });

  it('adds the leading slash and drops a trailing one', () => {
    expect(normalizePagePath('about')).toBe('/about');
    expect(normalizePagePath('/about/')).toBe('/about');
  });

  it('drops a query string and a fragment rather than refusing them', () => {
    // A path is a location and a query is an argument to it. Keeping the query would make two rows
    // for one page the first time somebody pasted a tracked campaign link into the editor.
    expect(normalizePagePath('/pricing?utm_source=newsletter')).toBe('/pricing');
    expect(normalizePagePath('/pricing#plans')).toBe('/pricing');
  });

  it('collapses double slashes and lowercases', () => {
    expect(normalizePagePath('//Services//Interiors')).toBe('/services/interiors');
  });
});

describe('pagePathProblem', () => {
  it('accepts the home path and ordinary paths', () => {
    expect(pagePathProblem('/')).toBeNull();
    expect(pagePathProblem('/about')).toBeNull();
    expect(pagePathProblem('/services/interiors')).toBeNull();
    expect(pagePathProblem('/a-b')).toBeNull();
  });

  it('refuses a path whose segment starts or ends with a hyphen', () => {
    expect(pagePathProblem('/-bad')).not.toBeNull();
    expect(pagePathProblem('/bad-')).not.toBeNull();
    expect(pagePathProblem('/ok/-bad')).not.toBeNull();
  });

  it('refuses characters a slug does not have', () => {
    expect(pagePathProblem('/o_k')).not.toBeNull();
    expect(pagePathProblem('/ok.html')).not.toBeNull();
  });

  it('answers a sentence with an example in it', () => {
    expect(pagePathProblem('/o_k')).toMatch(/\/about or \/services\/interiors/);
  });

  /**
   * The table `website_pages_path_is_a_path` is compared against in
   * `packages/db/src/schema-objects.int-spec.ts`, which drives these same inputs through Postgres.
   * It lives in both places on purpose: this spec runs in CI without a database and catches a
   * change to the function, and that one catches the two drifting apart.
   */
  it('agrees with the shape the CHECK constraint enforces', () => {
    const accepted = ['/', '/about', '/services/interiors', '/a', '/a-b', '/a--b'];
    const refused = ['/-bad', '/bad-', '/ok/-bad', '/o_k', '/ok.html', `/${'a'.repeat(600)}`];
    for (const path of accepted) expect(pagePathProblem(path), path).toBeNull();
    for (const path of refused) expect(pagePathProblem(path), path).not.toBeNull();
  });
});
