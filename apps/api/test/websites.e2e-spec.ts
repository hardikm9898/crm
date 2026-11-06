import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newToken } from '@leados/shared';
import { bootTestApp, call, cleanupUsers, type EnvelopeBody, type TestApp } from './app-harness.js';

/**
 * THE WEBSITES SUITE — Phase 7, step 1 (`FR-WEB-1`, `FR-WEB-2`, `FR-WEB-5`).
 *
 * The step's three exit criteria, and nothing about rendering, which is step 2's:
 *
 *  1. **A published version is immutable.** Enforced by a trigger, so this suite asserts the
 *     consequence a person would notice: editing after a publish leaves what is being served
 *     alone.
 *  2. **A rollback reproduces the previous snapshot exactly** — compared by deep equality, not by
 *     bytes, because JSONB normalizes key order and whitespace and a byte comparison would be
 *     asserting something Postgres does not promise.
 *  3. **An edit to a draft never changes what is being served**, which is criterion 1 from the
 *     other side and the one a reviewer would actually check by hand.
 */

const SUFFIX = newToken(4)
  .toLowerCase()
  .replace(/[^a-z0-9]/g, '');
const EMAIL_MARKER = `e2eweb${SUFFIX}`;
const PASSWORD = 'a quiet november harbour';

let ctx: TestApp;
let orgA: { token: string; organizationId: string; userId: string };
let orgB: { token: string; organizationId: string };

async function api<T>(
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  url: string,
  options: { token?: string; payload?: unknown } = {},
) {
  return call<EnvelopeBody<T>>(ctx.app, {
    method,
    url: `/api/v1${url}`,
    ...(options.token === undefined ? {} : { token: options.token }),
    ...(options.payload === undefined ? {} : { payload: options.payload }),
  });
}

/** Setup goes through a helper that throws, so a refused fixture cannot take an assertion with it. */
async function setup<T>(
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  url: string,
  options: { token?: string; payload?: unknown } = {},
): Promise<T> {
  const response = await api<T>(method, url, options);
  if (response.statusCode >= 300) {
    throw new Error(`${method} ${url} → ${response.statusCode} ${JSON.stringify(response.body)}`);
  }
  return response.body.data;
}

async function register(name: string) {
  const registered = await setup<{
    organization: { id: string };
    user: { id: string };
    tokens: { accessToken: string };
  }>('POST', '/auth/register', {
    payload: {
      email: `${EMAIL_MARKER}${name}@test.local`,
      password: PASSWORD,
      name: 'Website Owner',
      organizationName: `WEB ${name}`,
    },
  });
  return {
    token: registered.tokens.accessToken,
    organizationId: registered.organization.id,
    userId: registered.user.id,
  };
}

interface Website {
  id: string;
  name: string;
  subdomain: string;
  status: string;
  publishedVersionId: string | null;
  pages: {
    id: string;
    path: string;
    title: string;
    isHome: boolean;
    status: string;
    blocks: unknown;
  }[];
}

interface Version {
  id: string;
  version: number;
  restoredFromVersionId: string | null;
}

interface Served {
  version: number;
  versionId: string;
  snapshot: { theme: unknown; seoDefaults: unknown; pages: { path: string; title: string }[] };
}

/** A site with a published home page, ready to publish. Each test gets its own. */
async function siteReadyToPublish(label: string, token = orgA.token) {
  const site = await setup<Website>('POST', '/websites', {
    token,
    payload: { name: `Site ${label}`, subdomain: `${SUFFIX}-${label}` },
  });
  const home = site.pages.find((page) => page.isHome);
  if (!home) throw new Error('a new site should come with a home page');
  await setup('PATCH', `/websites/${site.id}/pages/${home.id}`, {
    token,
    payload: { status: 'published', title: 'Welcome' },
  });
  return { site, homeId: home.id };
}

beforeAll(async () => {
  ctx = await bootTestApp();
  orgA = await register('a');
  orgB = await register('b');
}, 120_000);

afterAll(async () => {
  await cleanupUsers(ctx.db, EMAIL_MARKER);
  await ctx?.close();
});

describe('a new site', () => {
  it('arrives as a draft, with a home page, serving nothing', async () => {
    const site = await setup<Website>('POST', '/websites', {
      token: orgA.token,
      payload: { name: 'Acme Realty', subdomain: `${SUFFIX}-new` },
    });
    expect(site.status).toBe('draft');
    expect(site.publishedVersionId).toBeNull();
    // A site with no pages opens the editor on nothing, so the home page comes with it — as a
    // draft, because creating a site must not put anything in front of the public.
    expect(site.pages).toHaveLength(1);
    expect(site.pages[0]?.isHome).toBe(true);
    expect(site.pages[0]?.status).toBe('draft');

    // Nothing is served, and the refusal is a 404 rather than a 200 with an empty body: there is
    // no site at that address yet.
    const served = await api('GET', `/websites/${site.id}/served`, { token: orgA.token });
    expect(served.statusCode).toBe(404);
  });

  it('normalizes the address somebody typed', async () => {
    const site = await setup<Website>('POST', '/websites', {
      token: orgA.token,
      payload: { name: 'Spaces', subdomain: `  ${SUFFIX.toUpperCase()} Spaces  ` },
    });
    expect(site.subdomain).toBe(`${SUFFIX}-spaces`);
  });

  it('refuses an address that is not an address, with a sentence and a 400', async () => {
    const response = await api('POST', '/websites', {
      token: orgA.token,
      payload: { name: 'Bad', subdomain: 'ab' },
    });
    // 400 and not 422: a value that fails validation is `VALIDATION_FAILED`, and asserting 422
    // here would pass only by accident.
    expect(response.statusCode).toBe(400);
    expect(JSON.stringify(response.body)).toMatch(/at least 3 characters/);
  });

  it('refuses a reserved address and names it', async () => {
    const response = await api('POST', '/websites', {
      token: orgA.token,
      payload: { name: 'Reserved', subdomain: 'api' },
    });
    expect(response.statusCode).toBe(400);
    expect(JSON.stringify(response.body)).toMatch(/reserved by the platform/);
  });

  it('refuses an address another workspace holds, with a sentence rather than a 500', async () => {
    const subdomain = `${SUFFIX}-contested`;
    await setup('POST', '/websites', {
      token: orgA.token,
      payload: { name: 'Ours', subdomain },
    });
    const response = await api('POST', '/websites', {
      token: orgB.token,
      payload: { name: 'Theirs', subdomain },
    });
    // The check runs under `withPlatformScope`, because the scoped client cannot see org A's row.
    // Without it this is a raw unique violation: a 500 on a mistake that has a sentence somebody
    // can act on. 422, because the value is well-formed and the rule is about the world.
    expect(response.statusCode).toBe(422);
    expect(JSON.stringify(response.body)).toMatch(/already taken/);
  });
});

describe('pages', () => {
  it('normalizes a path and refuses one that is not a slug', async () => {
    const { site } = await siteReadyToPublish('paths');
    const page = await setup<{ path: string }>('POST', `/websites/${site.id}/pages`, {
      token: orgA.token,
      payload: { path: '/Services/Interiors/', title: 'Interiors' },
    });
    expect(page.path).toBe('/services/interiors');

    const refused = await api('POST', `/websites/${site.id}/pages`, {
      token: orgA.token,
      payload: { path: '/not_a_slug.html', title: 'Nope' },
    });
    expect(refused.statusCode).toBe(400);
  });

  it('moves the home page rather than refusing a second one', async () => {
    const { site } = await siteReadyToPublish('home');
    const second = await setup<{ id: string }>('POST', `/websites/${site.id}/pages`, {
      token: orgA.token,
      payload: { path: '/landing', title: 'Landing', isHome: true },
    });
    const after = await setup<Website>('GET', `/websites/${site.id}`, { token: orgA.token });
    const homes = after.pages.filter((page) => page.isHome);
    // The partial unique allows one home page; making a second one home has to clear the first in
    // the same transaction, or the caller is told about an index instead of about their site.
    expect(homes).toHaveLength(1);
    expect(homes[0]?.id).toBe(second.id);
  });

  it('refuses deleting the home page, and says what to do instead', async () => {
    const { site, homeId } = await siteReadyToPublish('nodelete');
    const response = await api('DELETE', `/websites/${site.id}/pages/${homeId}`, {
      token: orgA.token,
    });
    expect(response.statusCode).toBe(422);
    expect(JSON.stringify(response.body)).toMatch(/Make another page the home page first/);
  });
});

describe('publishing', () => {
  it('refuses to publish a site with no published pages', async () => {
    const site = await setup<Website>('POST', '/websites', {
      token: orgA.token,
      payload: { name: 'Empty', subdomain: `${SUFFIX}-empty` },
    });
    const response = await api('POST', `/websites/${site.id}/publish`, { token: orgA.token });
    // Publishing nothing would answer 404 from a URL the owner has just been given, which reads as
    // the product being broken rather than as the site being empty.
    expect(response.statusCode).toBe(422);
    expect(JSON.stringify(response.body)).toMatch(/no published pages/);
  });

  it('serves the snapshot, and an edit to the draft does not change it', async () => {
    const { site, homeId } = await siteReadyToPublish('edit');
    await setup('POST', `/websites/${site.id}/publish`, { token: orgA.token });

    const before = await setup<Served>('GET', `/websites/${site.id}/served`, { token: orgA.token });
    expect(before.version).toBe(1);
    expect(before.snapshot.pages.map((page) => page.title)).toEqual(['Welcome']);

    // The edit. This is the step's third exit criterion, and the one somebody would check by hand.
    await setup('PATCH', `/websites/${site.id}/pages/${homeId}`, {
      token: orgA.token,
      payload: { title: 'Rewritten while live' },
    });
    await setup('PATCH', `/websites/${site.id}`, {
      token: orgA.token,
      payload: { theme: { accent: 'green' } },
    });

    const after = await setup<Served>('GET', `/websites/${site.id}/served`, { token: orgA.token });
    expect(after.versionId).toBe(before.versionId);
    expect(after.snapshot).toEqual(before.snapshot);

    // …and the draft really did change, so the assertion above is not passing because the edit was
    // silently dropped. A test that cannot tell those two apart passes hardest when the feature is
    // broken.
    const draft = await setup<Website>('GET', `/websites/${site.id}`, { token: orgA.token });
    expect(draft.pages.find((page) => page.id === homeId)?.title).toBe('Rewritten while live');
  });

  it('keeps the version it last served when taken offline, so republishing is one write', async () => {
    const { site } = await siteReadyToPublish('offline');
    const published = await setup<Website>('POST', `/websites/${site.id}/publish`, {
      token: orgA.token,
    });
    const versionId = published.publishedVersionId;
    expect(versionId).not.toBeNull();

    const offline = await setup<Website>('POST', `/websites/${site.id}/unpublish`, {
      token: orgA.token,
    });
    expect(offline.status).toBe('draft');
    // The one-way CHECK is what permits this. A biconditional would make taking a site offline
    // either impossible or destructive.
    expect(offline.publishedVersionId).toBe(versionId);

    const served = await api('GET', `/websites/${site.id}/served`, { token: orgA.token });
    expect(served.statusCode).toBe(404);
  });
});

describe('rollback (FR-WEB-5)', () => {
  it('restores the previous snapshot exactly, as a new version that names its source', async () => {
    const { site, homeId } = await siteReadyToPublish('rollback');

    await setup('POST', `/websites/${site.id}/publish`, { token: orgA.token });
    const first = await setup<Served>('GET', `/websites/${site.id}/served`, { token: orgA.token });

    // A second publish, with different content.
    await setup('PATCH', `/websites/${site.id}/pages/${homeId}`, {
      token: orgA.token,
      payload: { title: 'Version two', blocks: [{ type: 'hero', text: 'two' }] },
    });
    await setup('POST', `/websites/${site.id}/publish`, { token: orgA.token });
    const second = await setup<Served>('GET', `/websites/${site.id}/served`, { token: orgA.token });
    expect(second.version).toBe(2);
    expect(second.snapshot).not.toEqual(first.snapshot);

    const rolled = await setup<Website>('POST', `/websites/${site.id}/rollback`, {
      token: orgA.token,
      payload: { versionId: first.versionId },
    });
    expect(rolled.status).toBe('published');

    const served = await setup<Served>('GET', `/websites/${site.id}/served`, { token: orgA.token });
    // The criterion. Deep equality rather than bytes: JSONB does not preserve key order, so a byte
    // comparison would be asserting something Postgres never promised.
    expect(served.snapshot).toEqual(first.snapshot);
    // Forwards, not backwards: a new version carrying the old snapshot.
    expect(served.version).toBe(3);
    expect(served.versionId).not.toBe(first.versionId);

    // `data` is the array, not `{ items }`: the envelope lifts `items` and puts `pagination` under
    // `meta`. Reading `data.items` here is how this file first failed, which is the same mistake a
    // test against `GET /integrations` made one phase earlier.
    const versions = await setup<Version[]>('GET', `/websites/${site.id}/versions`, {
      token: orgA.token,
    });
    expect(versions.map((version) => version.version)).toEqual([3, 2, 1]);
    // "What was live on Tuesday" keeps one answer, and a site rolled back twice does not look like
    // a site nobody touched.
    expect(versions[0]?.restoredFromVersionId).toBe(first.versionId);
    expect(versions[1]?.restoredFromVersionId).toBeNull();
  });

  it('refuses rolling back to the version already being served', async () => {
    const { site } = await siteReadyToPublish('already');
    const published = await setup<Website>('POST', `/websites/${site.id}/publish`, {
      token: orgA.token,
    });
    const response = await api('POST', `/websites/${site.id}/rollback`, {
      token: orgA.token,
      payload: { versionId: published.publishedVersionId },
    });
    expect(response.statusCode).toBe(422);
    expect(JSON.stringify(response.body)).toMatch(/already the one being served/);
  });

  it('refuses a version id from another workspace with a 404, not a 403', async () => {
    const { site: theirs } = await siteReadyToPublish('crosstenant', orgB.token);
    const theirPublished = await setup<Website>('POST', `/websites/${theirs.id}/publish`, {
      token: orgB.token,
    });
    const { site: ours } = await siteReadyToPublish('mine');
    await setup('POST', `/websites/${ours.id}/publish`, { token: orgA.token });

    const response = await api('POST', `/websites/${ours.id}/rollback`, {
      token: orgA.token,
      payload: { versionId: theirPublished.publishedVersionId },
    });
    // A malformed id, a deleted one and another tenant's must be indistinguishable, or the shape of
    // an id becomes an oracle.
    expect(response.statusCode).toBe(404);
  });
});

describe('another workspace', () => {
  it('cannot read, edit or publish a site it does not own', async () => {
    const { site } = await siteReadyToPublish('isolation');
    for (const [method, url, payload] of [
      ['GET', `/websites/${site.id}`, undefined],
      ['PATCH', `/websites/${site.id}`, { name: 'Theirs now' }],
      ['POST', `/websites/${site.id}/publish`, undefined],
      ['GET', `/websites/${site.id}/versions`, undefined],
    ] as const) {
      const response = await api(method, url, {
        token: orgB.token,
        ...(payload === undefined ? {} : { payload }),
      });
      expect(response.statusCode, `${method} ${url}`).toBe(404);
    }
  });

  it('does not see it in the list', async () => {
    const mine = await setup<Website[]>('GET', '/websites', { token: orgA.token });
    const theirs = await setup<Website[]>('GET', '/websites', { token: orgB.token });
    expect(mine.length).toBeGreaterThan(0);
    expect(theirs.length).toBeGreaterThan(0);
    const mineIds = new Set(mine.map((site) => site.id));
    // Both non-empty first: "no overlap" between two empty lists is true and proves nothing, which
    // is the shape of assertion that passes hardest when the read is broken.
    expect(theirs.every((site) => !mineIds.has(site.id))).toBe(true);
  });
});
