import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId, newToken } from '@leados/shared';
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
      // `params`, not a top-level key. This fixture was `{ type: 'hero', text: 'two' }` until step
      // 3's validator refused it: a block shape that was never valid, which nothing noticed while
      // blocks were stored uninterpreted. The registry found it on its first run.
      payload: { title: 'Version two', blocks: [{ type: 'hero', params: { heading: 'two' } }] },
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

describe('the public read path (step 2)', () => {
  /** No token. A visitor has no session, which is the whole point of the route. */
  async function visit(subdomain: string) {
    return call<EnvelopeBody<Served & { site: { name: string; subdomain: string } }>>(ctx.app, {
      method: 'GET',
      url: `/api/v1/public/sites/${subdomain}`,
    });
  }

  it('serves a published site to a caller with no session', async () => {
    const { site } = await siteReadyToPublish('public');
    await setup('POST', `/websites/${site.id}/publish`, { token: orgA.token });

    const response = await visit(site.subdomain);
    expect(response.statusCode).toBe(200);
    expect(response.body.data.version).toBe(1);
    expect(response.body.data.snapshot.pages.map((page) => page.title)).toEqual(['Welcome']);
  });

  it('answers 404 for a draft, identically to a site that never existed', async () => {
    const draft = await setup<Website>('POST', '/websites', {
      token: orgA.token,
      payload: { name: 'Not yet', subdomain: `${SUFFIX}-unpublished` },
    });

    const onDraft = await visit(draft.subdomain);
    const onNothing = await visit(`${SUFFIX}-never-existed`);

    // The criterion: a workspace's unreleased site is not public information. A distinct "not
    // published yet" response would make its existence, its name and its owner's plans readable by
    // anybody who guessed the address.
    expect(onDraft.statusCode).toBe(404);
    expect(onNothing.statusCode).toBe(404);
    expect(onDraft.body.error?.code).toBe(onNothing.body.error?.code);
    expect(onDraft.body.error?.message).toBe(onNothing.body.error?.message);
    // …and the draft's own name is not in the body, which is what "indistinguishable" has to mean
    // in practice rather than in the status code alone.
    expect(JSON.stringify(onDraft.body)).not.toMatch(/Not yet/);
  });

  it('stops serving a site taken offline', async () => {
    const { site } = await siteReadyToPublish('offlinepublic');
    await setup('POST', `/websites/${site.id}/publish`, { token: orgA.token });
    expect((await visit(site.subdomain)).statusCode).toBe(200);

    await setup('POST', `/websites/${site.id}/unpublish`, { token: orgA.token });
    expect((await visit(site.subdomain)).statusCode).toBe(404);
  });

  it('serves the snapshot, not the draft', async () => {
    const { site, homeId } = await siteReadyToPublish('publicdraft');
    await setup('POST', `/websites/${site.id}/publish`, { token: orgA.token });
    const before = await visit(site.subdomain);

    await setup('PATCH', `/websites/${site.id}/pages/${homeId}`, {
      token: orgA.token,
      payload: { title: 'Changed after publishing' },
    });

    const after = await visit(site.subdomain);
    expect(after.body.data.snapshot).toEqual(before.body.data.snapshot);
    expect(JSON.stringify(after.body)).not.toMatch(/Changed after publishing/);
  });

  it('leaks no identifier a visitor has no business holding', async () => {
    const { site } = await siteReadyToPublish('publicleak');
    await setup('POST', `/websites/${site.id}/publish`, { token: orgA.token });
    const serialized = JSON.stringify((await visit(site.subdomain)).body);

    // The renderer needs the content and the version it came from. It does not need the workspace's
    // id, the site's id or the page ids, and a public response carrying them hands an integrator —
    // or a competitor — the identifiers every authenticated route is keyed on.
    expect(serialized).not.toContain(orgA.organizationId);
    expect(serialized).not.toContain(site.id);
  });

  it('resolves the subdomain case-insensitively, because a browser will not', async () => {
    const { site } = await siteReadyToPublish('publiccase');
    await setup('POST', `/websites/${site.id}/publish`, { token: orgA.token });
    expect((await visit(site.subdomain.toUpperCase())).statusCode).toBe(200);
  });
});

describe('the block registry (step 3)', () => {
  it('serves the catalogue the editor renders its controls from', async () => {
    const catalogue = await setup<
      { type: string; label: string; hint: string; group: string; params: unknown[] }[]
    >('GET', '/websites/block-catalogue', { token: orgA.token });

    // The editor fetches this and renders a control per field. If it were empty the add-block menu
    // would render as a picker with nothing in it, which looks exactly like a workspace with
    // nothing configured — the defect `REFERENCE_SOURCES` exists to prevent one registry over.
    expect(catalogue.length).toBeGreaterThan(0);
    for (const spec of catalogue) {
      expect(spec.label.length, spec.type).toBeGreaterThan(0);
      expect(spec.hint.length, spec.type).toBeGreaterThan(0);
      expect(Array.isArray(spec.params), spec.type).toBe(true);
    }
    // `quote` is the type added by this step, and it is the proof of the step's exit criterion: it
    // cost one declaration and one renderer, and no editor code.
    expect(catalogue.map((spec) => spec.type)).toContain('quote');
  });

  it('is readable with website:read and refused without a session', async () => {
    const anonymous = await api('GET', '/websites/block-catalogue');
    expect(anonymous.statusCode).toBe(401);
  });

  it('accepts blocks the registry knows', async () => {
    const { site, homeId } = await siteReadyToPublish('blocksok');
    const response = await api('PATCH', `/websites/${site.id}/pages/${homeId}`, {
      token: orgA.token,
      payload: {
        blocks: [
          { type: 'hero', params: { heading: 'Welcome', ctaHref: 'https://example.com' } },
          { type: 'quote', params: { text: 'They were quick.', attribution: 'Asha' } },
          { type: 'list', params: { items: ['One', 'Two'] } },
        ],
      },
    });
    expect(response.statusCode).toBe(200);
  });

  it('refuses a block type it does not know, and names it', async () => {
    const { site, homeId } = await siteReadyToPublish('blocksunknown');
    const response = await api('PATCH', `/websites/${site.id}/pages/${homeId}`, {
      token: orgA.token,
      payload: { blocks: [{ type: 'pricing_table_v2', params: {} }] },
    });
    // Refused on write even though the renderer tolerates an unknown type on read: nothing should
    // be able to save a block this release cannot draw, while a rollback to a newer release's
    // snapshot must still render. That asymmetry is the registry's design, not an inconsistency.
    expect(response.statusCode).toBe(400);
    expect(JSON.stringify(response.body)).toMatch(/pricing_table_v2/);
  });

  it('addresses each problem at the block and field it belongs to', async () => {
    const { site, homeId } = await siteReadyToPublish('blockfields');
    const response = await api('PATCH', `/websites/${site.id}/pages/${homeId}`, {
      token: orgA.token,
      payload: {
        blocks: [
          { type: 'hero', params: { heading: 'Fine' } },
          { type: 'hero', params: {} },
          { type: 'image', params: { src: 'javascript:alert(1)' } },
        ],
      },
    });
    expect(response.statusCode).toBe(400);
    const fields = (
      (response.body.error?.details ?? []) as { field: string; message: string }[]
    ).map((detail) => detail.field);
    // The editor points at the input that is wrong rather than printing one sentence at the top,
    // which it can only do because the addresses name the row.
    expect(fields).toEqual(['blocks[1].params.heading', 'blocks[2].params.src']);
  });

  it('refuses a link that executes, and says what a link may start with', async () => {
    const { site, homeId } = await siteReadyToPublish('blockurl');
    const response = await api('PATCH', `/websites/${site.id}/pages/${homeId}`, {
      token: orgA.token,
      payload: {
        blocks: [{ type: 'hero', params: { heading: 'H', ctaHref: 'javascript:void 0' } }],
      },
    });
    expect(response.statusCode).toBe(400);
    expect(JSON.stringify(response.body)).toMatch(/mailto: or tel:/);
  });

  it('validates blocks on create as well as on update', async () => {
    const { site } = await siteReadyToPublish('blockcreate');
    const response = await api('POST', `/websites/${site.id}/pages`, {
      token: orgA.token,
      payload: { path: '/bad', title: 'Bad', blocks: [{ type: 'nope', params: {} }] },
    });
    // Both write paths, because a page created wrong is as broken as one edited wrong — and the
    // first version of this wired the check into `updatePage` only.
    expect(response.statusCode).toBe(400);
  });

  it('still serves a stored block type it no longer knows, rather than blanking the page', async () => {
    const { site, homeId } = await siteReadyToPublish('blocktolerant');
    // Written past the validator, the way a snapshot from a newer release arrives after a rollback.
    await ctx.db.websitePage.update({
      where: { id: homeId },
      data: {
        blocks: [
          { type: 'hero', params: { heading: 'STILL HERE' } },
          { type: 'from_a_newer_release', params: {} },
        ],
      } as never,
    });
    await setup('POST', `/websites/${site.id}/publish`, { token: orgA.token });
    const served = await call<EnvelopeBody<Served>>(ctx.app, {
      method: 'GET',
      url: `/api/v1/public/sites/${site.subdomain}`,
    });
    expect(served.statusCode).toBe(200);
    const blocks = (served.body.data.snapshot.pages[0] as unknown as { blocks: { type: string }[] })
      .blocks;
    expect(blocks.map((block) => block.type)).toEqual(['hero', 'from_a_newer_release']);
  });
});

describe('a form on a page (step 4, FR-WEB-6)', () => {
  /** The minimum usable form. A page places one that already exists; it does not define one. */
  async function aForm(token = orgA.token, label = 'web') {
    return setup<{ id: string; publicKey: string; name: string }>('POST', '/forms', {
      token,
      payload: {
        name: `Enquiry ${label} ${SUFFIX}`,
        settings: { thankYouMessage: 'Thanks.', submitLabel: 'Send' },
        fields: [
          { standardFieldKey: 'fullName', label: 'Your name', isRequired: true },
          { standardFieldKey: 'phone', label: 'Mobile number', isRequired: true },
        ],
      },
    });
  }

  it('declares the form picker’s endpoint beside the kind', async () => {
    const response = await api<unknown>('GET', '/websites/block-catalogue', { token: orgA.token });
    const references = (response.body.meta as { references?: { kind: string; source: string }[] })
      ?.references;
    // A `reference` parameter names a kind, and a picker with no endpoint behind it renders empty —
    // which looks exactly like a workspace with no forms. The kind and its source travel together.
    expect(references?.find((entry) => entry.kind === 'form')?.source).toBe('/forms');
  });

  it('accepts a form block naming a form in this workspace', async () => {
    const form = await aForm();
    const { site, homeId } = await siteReadyToPublish('formok');
    const response = await api('PATCH', `/websites/${site.id}/pages/${homeId}`, {
      token: orgA.token,
      payload: {
        blocks: [{ type: 'form', params: { formId: form.id, heading: 'Ask us anything' } }],
      },
    });
    expect(response.statusCode).toBe(200);
  });

  it('refuses a form id that is not a form', async () => {
    const { site, homeId } = await siteReadyToPublish('formmissing');
    const response = await api('PATCH', `/websites/${site.id}/pages/${homeId}`, {
      token: orgA.token,
      payload: { blocks: [{ type: 'form', params: { formId: newId() } }] },
    });
    expect(response.statusCode).toBe(400);
    expect(JSON.stringify(response.body)).toMatch(/no longer exists/);
  });

  it("refuses another workspace's form, identically to one that does not exist", async () => {
    const theirs = await aForm(orgB.token, 'theirs');
    const { site, homeId } = await siteReadyToPublish('formcross');
    const response = await api('PATCH', `/websites/${site.id}/pages/${homeId}`, {
      token: orgA.token,
      payload: { blocks: [{ type: 'form', params: { formId: theirs.id } }] },
    });
    // The scoped client cannot see their row, so "somebody else's form" and "no such form" are the
    // same refusal — which is the right pair: a distinguishable answer would make a form id an
    // oracle for which workspaces have which forms.
    expect(response.statusCode).toBe(400);
    expect(JSON.stringify(response.body)).toMatch(/no longer exists/);
  });

  it('hands the visitor the form’s key, resolved now rather than snapshotted', async () => {
    const form = await aForm(orgA.token, 'served');
    const { site, homeId } = await siteReadyToPublish('formserved');
    await setup('PATCH', `/websites/${site.id}/pages/${homeId}`, {
      token: orgA.token,
      payload: { blocks: [{ type: 'form', params: { formId: form.id } }] },
    });
    await setup('POST', `/websites/${site.id}/publish`, { token: orgA.token });

    const served = await call<EnvelopeBody<{ forms: Record<string, { key: string }> }>>(ctx.app, {
      method: 'GET',
      url: `/api/v1/public/sites/${site.subdomain}`,
    });
    expect(served.statusCode).toBe(200);
    // The key, not the questions: the questions come from `/public/forms/:key` in the visitor's
    // browser, so editing a form does not leave a published page asking the old ones.
    expect(served.body.data.forms[form.id]?.key).toBe(form.publicKey);
  });

  it('stops handing out the key when the form is switched off', async () => {
    const form = await aForm(orgA.token, 'off');
    const { site, homeId } = await siteReadyToPublish('formoff');
    await setup('PATCH', `/websites/${site.id}/pages/${homeId}`, {
      token: orgA.token,
      payload: { blocks: [{ type: 'form', params: { formId: form.id } }] },
    });
    await setup('POST', `/websites/${site.id}/publish`, { token: orgA.token });
    await setup('PATCH', `/forms/${form.id}`, { token: orgA.token, payload: { isActive: false } });

    const served = await call<EnvelopeBody<{ forms: Record<string, { key: string }> }>>(ctx.app, {
      method: 'GET',
      url: `/api/v1/public/sites/${site.subdomain}`,
    });
    // Absent rather than reported. A form switched off between the publish and the visit is the
    // ordinary case, and the renderer draws nothing for that block — which is also why this is
    // resolved per read and not frozen into the version.
    expect(served.body.data.forms[form.id]).toBeUndefined();
  });

  it('keeps the page, referrer and device a site can see, which the capture used to drop', async () => {
    const form = await aForm(orgA.token, 'context');
    const submission = await call<EnvelopeBody<{ message?: string }>>(ctx.app, {
      method: 'POST',
      url: `/api/v1/public/forms/${form.publicKey}/submissions`,
      payload: {
        answers: { 'standard:fullName': 'Asha Rao', 'standard:phone': '+919845012345' },
        utm: { utm_source: 'google', utm_campaign: 'spring' },
        pageUrl: 'https://acme.example/pricing',
        referrer: 'https://www.google.com/',
        sessionId: `sess-${SUFFIX}`,
        visitorId: `vis-${SUFFIX}`,
        device: 'mobile',
      },
    });
    expect(submission.statusCode).toBeLessThan(300);

    const lead = await ctx.db.lead.findFirstOrThrow({
      where: { organizationId: orgA.organizationId, phoneE164: '+919845012345' },
      orderBy: { createdAt: 'desc' },
    });
    const touchpoint = await ctx.db.leadTouchpoint.findFirstOrThrow({
      where: { leadId: lead.id, sequence: 1 },
    });

    // All three were stored on `form_submissions` and then dropped before the lead: `referrer` was
    // read and discarded, `visitorId` was passed to the capture and written nowhere, `device` did
    // not exist. Attribution only in the submission row is attribution no report can reach.
    const metadata = touchpoint.metadata as Record<string, unknown>;
    expect(metadata['referrer']).toBe('https://www.google.com/');
    expect(metadata['device']).toBe('mobile');
    expect(metadata['visitorId']).toBe(`vis-${SUFFIX}`);
    expect(touchpoint.landingPageUrl).toBe('https://acme.example/pricing');
    expect(touchpoint.sessionId).toBe(`sess-${SUFFIX}`);
    expect((touchpoint.utm as Record<string, unknown>)['utm_campaign']).toBe('spring');

    // …and on the timeline entry whose whole job is "where did this lead come from", because a
    // fact a report holds and a person cannot read is half a fact.
    const entry = await ctx.db.activity.findFirstOrThrow({
      where: { leadId: lead.id, type: 'lead.source_captured' },
    });
    const payload = entry.payload as Record<string, unknown>;
    expect(payload['referrer']).toBe('https://www.google.com/');
    expect(payload['device']).toBe('mobile');
    expect(payload['landingPageUrl']).toBe('https://acme.example/pricing');
  });
});

describe('SEO (step 5, FR-WEB-3)', () => {
  it('refuses a setting nobody declared, named at the key', async () => {
    // A `desciption` that nothing refuses is a setting which silently does nothing for ever, on
    // the one screen whose entire purpose is being read by a machine.
    const { site, homeId } = await siteReadyToPublish('seounknown');
    const response = await api('PATCH', `/websites/${site.id}/pages/${homeId}`, {
      token: orgA.token,
      payload: { seo: { desciption: 'oops' } },
    });
    expect(response.statusCode).toBe(400);
    // `error.details` is the envelope's field-error list; `fieldErrors` is the *web app's* name
    // for the same thing after `lib/api.ts` keys it by field. Asserting the web app's name against
    // the API is a test that cannot pass.
    const errors = (response.body as { error?: { details?: { field: string }[] } }).error?.details;
    expect(errors?.map((entry) => entry.field)).toContain('seo.desciption');
    expect(JSON.stringify(response.body)).toMatch(/desciption/);
  });

  it('accepts the body a cleared SEO form sends', async () => {
    // Every box empty and one checkbox on, which is the commonest submission this form makes. The
    // first version refused it: `productId: ''` is the picker's own "Not about one product" option
    // and was read as an invalid id, so the screen answered "Choose a product." under a field
    // somebody had deliberately left alone. Found by the browser check — every unit test until
    // then had passed a real id or nothing at all.
    const { site, homeId } = await siteReadyToPublish('seocleared');
    const response = await api('PATCH', `/websites/${site.id}/pages/${homeId}`, {
      token: orgA.token,
      payload: {
        seo: {
          title: '',
          description: '',
          canonicalUrl: '',
          ogImageUrl: '',
          noindex: true,
          productId: '',
        },
      },
    });
    expect(response.statusCode).toBe(200);
    expect((response.body.data as { seo: unknown }).seo).toEqual({ noindex: true });
  });

  it('refuses a relative canonical and a relative sharing image', async () => {
    // A relative `og:image` is the commonest Open Graph mistake there is, and it fails silently:
    // every platform simply shows no image.
    const { site, homeId } = await siteReadyToPublish('seorelative');
    for (const payload of [{ canonicalUrl: '/pricing' }, { ogImageUrl: '/logo.png' }]) {
      const response = await api('PATCH', `/websites/${site.id}/pages/${homeId}`, {
        token: orgA.token,
        payload: { seo: payload },
      });
      expect(response.statusCode, JSON.stringify(payload)).toBe(400);
      expect(JSON.stringify(response.body)).toMatch(/https:\/\//);
    }
  });

  it('stores an X handle normalised, whatever was typed', async () => {
    // One place normalises. A screen that cleaned it too would be a second answer to one question.
    const { site } = await siteReadyToPublish('seohandle');
    const updated = await setup<{ seoDefaults: Record<string, unknown> }>(
      'PATCH',
      `/websites/${site.id}`,
      { token: orgA.token, payload: { seoDefaults: { twitterSite: 'https://x.com/acmeworks' } } },
    );
    expect(updated.seoDefaults.twitterSite).toBe('@acmeworks');
  });

  it('refuses a kind of business that is not a schema.org type', async () => {
    const { site } = await siteReadyToPublish('seokind');
    const response = await api('PATCH', `/websites/${site.id}`, {
      token: orgA.token,
      payload: { seoDefaults: { business: { kind: 'Shop' } } },
    });
    expect(response.statusCode).toBe(400);
  });

  it('serves the site’s own absolute address, which is where a canonical points', async () => {
    const { site } = await siteReadyToPublish('seobase');
    await setup('POST', `/websites/${site.id}/publish`, { token: orgA.token });
    const served = await setup<{ site: { baseUrl: string } }>(
      'GET',
      `/public/sites/${site.subdomain}`,
    );
    // One answer to "where does this site live", so a canonical and a sitemap entry cannot
    // disagree. With no WEBSITE_BASE_DOMAIN configured it is the renderer's own path-based
    // address, which is a working address rather than a half-configured one.
    expect(served.site.baseUrl).toBe(`http://localhost:3000/s/${site.subdomain}`);
    expect(served.site.baseUrl).not.toMatch(/\/$/);
  });

  it('reads the business’s opening hours from the workspace, not from the website', async () => {
    // Asking somebody to type their trading hours a second time into a website screen is the
    // defect `notification_preferences.quiet_hours` was corrected for — and here the stale copy
    // would be the one customers read.
    const { site } = await siteReadyToPublish('seobusiness');
    await setup('PATCH', `/websites/${site.id}`, {
      token: orgA.token,
      payload: {
        seoDefaults: {
          business: { kind: 'Store', streetAddress: '12 MG Road', locality: 'Bengaluru' },
        },
      },
    });
    await setup('POST', `/websites/${site.id}/publish`, { token: orgA.token });
    const served = await setup<{
      business: {
        name: string;
        kind: string;
        streetAddress: string;
        openingHours: { dayOfWeek: number; opens: string; closes: string }[];
      };
    }>('GET', `/public/sites/${site.subdomain}`);

    expect(served.business.kind).toBe('Store');
    expect(served.business.streetAddress).toBe('12 MG Road');
    // The name is the organization's own, never retyped into the website's settings. Read back
    // from the row rather than matched against a guess, which is the stronger claim and the one
    // that fails if somebody later copies the name into `seoDefaults`.
    const organization = await ctx.db.organization.findFirstOrThrow({
      where: { id: orgA.organizationId },
      select: { name: true },
    });
    expect(served.business.name).toBe(organization.name);
    // `seedWorkingHours` writes the workspace-wide set at provisioning, so these exist without
    // this suite creating them — which is the point: the website reads what the business already
    // told the product.
    expect(served.business.openingHours.length).toBeGreaterThan(0);
    for (const window of served.business.openingHours) {
      expect(window.opens).toMatch(/^\d{2}:\d{2}$/);
      expect(window.closes).toMatch(/^\d{2}:\d{2}$/);
      expect(window.dayOfWeek).toBeGreaterThanOrEqual(0);
      expect(window.dayOfWeek).toBeLessThanOrEqual(6);
    }
  });

  it('reads a product’s price live, so a published page can never quote a stale one', async () => {
    const product = await setup<{ id: string }>('POST', '/products', {
      token: orgA.token,
      payload: { name: `Modular kitchen ${SUFFIX}`, priceMinor: 250_000, currency: 'INR' },
    });
    const { site, homeId } = await siteReadyToPublish('seoproduct');
    await setup('PATCH', `/websites/${site.id}/pages/${homeId}`, {
      token: orgA.token,
      payload: { seo: { productId: product.id } },
    });
    await setup('POST', `/websites/${site.id}/publish`, { token: orgA.token });

    const before = await setup<{ products: Record<string, { priceMinor: number }> }>(
      'GET',
      `/public/sites/${site.subdomain}`,
    );
    expect(before.products[product.id]?.priceMinor).toBe(250_000);

    // No publish between the edit and the read. A price frozen into the snapshot would still read
    // 250000 here, which is the failure this reference exists to prevent — in structured data,
    // where a stale price is a penalty rather than a typo.
    await setup('PATCH', `/products/${product.id}`, {
      token: orgA.token,
      payload: { priceMinor: 275_000 },
    });
    const after = await setup<{ products: Record<string, { priceMinor: number }> }>(
      'GET',
      `/public/sites/${site.subdomain}`,
    );
    expect(after.products[product.id]?.priceMinor).toBe(275_000);
  });

  it('drops a product that has been deactivated rather than advertising it', async () => {
    const product = await setup<{ id: string }>('POST', '/products', {
      token: orgA.token,
      payload: { name: `Withdrawn ${SUFFIX}`, priceMinor: 1000, currency: 'INR' },
    });
    const { site, homeId } = await siteReadyToPublish('seogone');
    await setup('PATCH', `/websites/${site.id}/pages/${homeId}`, {
      token: orgA.token,
      payload: { seo: { productId: product.id } },
    });
    await setup('POST', `/websites/${site.id}/publish`, { token: orgA.token });
    await setup('PATCH', `/products/${product.id}`, {
      token: orgA.token,
      payload: { isActive: false },
    });
    const served = await setup<{ products: Record<string, unknown> }>(
      'GET',
      `/public/sites/${site.subdomain}`,
    );
    // Absent, not reported. Structured data claiming something is for sale when it has been
    // withdrawn is worse than none.
    expect(served.products[product.id]).toBeUndefined();
  });

  it("refuses another workspace's product, identically to one that does not exist", async () => {
    const theirs = await setup<{ id: string }>('POST', '/products', {
      token: orgB.token,
      payload: { name: `Theirs ${SUFFIX}`, priceMinor: 100, currency: 'INR' },
    });
    const { site, homeId } = await siteReadyToPublish('seocross');
    const [cross, missing] = await Promise.all([
      api('PATCH', `/websites/${site.id}/pages/${homeId}`, {
        token: orgA.token,
        payload: { seo: { productId: theirs.id } },
      }),
      api('PATCH', `/websites/${site.id}/pages/${homeId}`, {
        token: orgA.token,
        payload: { seo: { productId: newId() } },
      }),
    ]);
    // Indistinguishable on purpose: a different answer would turn a product id into an oracle.
    // `requestId` is deliberately per-request, so it is dropped before the comparison rather than
    // the whole body being compared, which would pass for the wrong reason only by accident.
    const shape = (body: unknown) => {
      const error = (body as { error?: Record<string, unknown> }).error ?? {};
      const { requestId: _ignored, ...rest } = error;
      return rest;
    };
    expect(cross.statusCode).toBe(400);
    expect(missing.statusCode).toBe(400);
    expect(shape(cross.body)).toEqual(shape(missing.body));
  });
});

describe('redirects (step 5, FR-WEB-3)', () => {
  it('redirects an old address, with no publish needed', async () => {
    const { site } = await siteReadyToPublish('redir');
    await setup('POST', `/websites/${site.id}/publish`, { token: orgA.token });
    const created = await setup<{ fromPath: string; toPath: string; kind: string }>(
      'POST',
      `/websites/${site.id}/redirects`,
      { token: orgA.token, payload: { fromPath: '/Old-Prices/', toPath: '/pricing' } },
    );
    // Normalised by the same function a page path goes through: lowercase, no trailing slash.
    expect(created.fromPath).toBe('/old-prices');
    expect(created.kind).toBe('permanent');

    const served = await setup<{ redirects: { fromPath: string; toPath: string }[] }>(
      'GET',
      `/public/sites/${site.subdomain}`,
    );
    expect(served.redirects).toEqual([
      { fromPath: '/old-prices', toPath: '/pricing', kind: 'permanent' },
    ]);
  });

  it('collapses a chain rather than refusing the second rename', async () => {
    // Renaming `/a` to `/b` and later `/b` to `/c` is an ordinary sequence. A product that refused
    // the second would be unusable; one that allowed the chain would serve two hops to a crawler
    // that counts them. So the first row is rewritten to point at the final address.
    const { site } = await siteReadyToPublish('redirchain');
    await setup('POST', `/websites/${site.id}/redirects`, {
      token: orgA.token,
      payload: { fromPath: '/a', toPath: '/b' },
    });
    await setup('POST', `/websites/${site.id}/redirects`, {
      token: orgA.token,
      payload: { fromPath: '/b', toPath: '/c' },
    });
    const rows = await setup<{ fromPath: string; toPath: string }[]>(
      'GET',
      `/websites/${site.id}/redirects`,
      { token: orgA.token },
    );
    expect(rows.map((row) => [row.fromPath, row.toPath])).toEqual([
      ['/a', '/c'],
      ['/b', '/c'],
    ]);
    // The invariant that makes a request-time loop guard unnecessary: no destination is another
    // row's source.
    const sources = new Set(rows.map((row) => row.fromPath));
    expect(rows.filter((row) => sources.has(row.toPath))).toEqual([]);
  });

  it('follows the destination when pointing at an address that has itself moved', async () => {
    const { site } = await siteReadyToPublish('redirfollow');
    await setup('POST', `/websites/${site.id}/redirects`, {
      token: orgA.token,
      payload: { fromPath: '/b', toPath: '/c' },
    });
    const created = await setup<{ toPath: string }>('POST', `/websites/${site.id}/redirects`, {
      token: orgA.token,
      payload: { fromPath: '/a', toPath: '/b' },
    });
    expect(created.toPath).toBe('/c');
  });

  it('refuses a loop, with the sentence naming both addresses', async () => {
    const { site } = await siteReadyToPublish('redirloop');
    await setup('POST', `/websites/${site.id}/redirects`, {
      token: orgA.token,
      payload: { fromPath: '/a', toPath: '/b' },
    });
    // `/b` → `/a` would make a circle of two. A browser answers ERR_TOO_MANY_REDIRECTS, which
    // explains nothing, so this is refused with a sentence instead.
    const response = await api('POST', `/websites/${site.id}/redirects`, {
      token: orgA.token,
      payload: { fromPath: '/b', toPath: '/a' },
    });
    expect(response.statusCode).toBe(400);
    expect(JSON.stringify(response.body)).toMatch(/\/a/);
    expect(JSON.stringify(response.body)).toMatch(/loop|circle/i);
  });

  it('refuses a redirect to itself', async () => {
    const { site } = await siteReadyToPublish('redirself');
    const response = await api('POST', `/websites/${site.id}/redirects`, {
      token: orgA.token,
      payload: { fromPath: '/a', toPath: '/a' },
    });
    expect(response.statusCode).toBe(400);
  });

  it('refuses a destination a browser cannot follow', async () => {
    // The first draft reused `isSafeBlockUrl`, which accepts `mailto:` because a *button* may
    // link to one — and the CHECK on the column refuses it, so that draft would have written a
    // value the database rejects. The service and the constraint now state one rule.
    const { site } = await siteReadyToPublish('redirscheme');
    for (const toPath of ['mailto:hello@example.com', '//evil.example', 'javascript:alert(1)']) {
      const response = await api('POST', `/websites/${site.id}/redirects`, {
        token: orgA.token,
        payload: { fromPath: '/a', toPath },
      });
      expect(response.statusCode, toPath).toBe(400);
    }
  });

  it('refuses a redirect whose source is a page, because the page would always win', async () => {
    const { site } = await siteReadyToPublish('redirshadow');
    const response = await api('POST', `/websites/${site.id}/redirects`, {
      token: orgA.token,
      payload: { fromPath: '/', toPath: '/elsewhere' },
    });
    expect(response.statusCode).toBe(400);
    expect(JSON.stringify(response.body)).toMatch(/page/i);
  });

  it('marks a redirect a page has since shadowed', async () => {
    // The other direction: the redirect was legal when it was made, and a page appeared at that
    // address afterwards. The page wins, and the list says so rather than leaving somebody to
    // wonder why nothing happens.
    const { site } = await siteReadyToPublish('redirlater');
    await setup('POST', `/websites/${site.id}/redirects`, {
      token: orgA.token,
      payload: { fromPath: '/offers', toPath: '/pricing' },
    });
    const beforeRows = await setup<{ shadowed: boolean }[]>(
      'GET',
      `/websites/${site.id}/redirects`,
      { token: orgA.token },
    );
    expect(beforeRows[0]?.shadowed).toBe(false);

    await setup('POST', `/websites/${site.id}/pages`, {
      token: orgA.token,
      payload: { path: '/offers', title: 'Offers' },
    });
    const afterRows = await setup<{ shadowed: boolean }[]>(
      'GET',
      `/websites/${site.id}/redirects`,
      { token: orgA.token },
    );
    expect(afterRows[0]?.shadowed).toBe(true);
  });

  it('refuses a second redirect for one address', async () => {
    const { site } = await siteReadyToPublish('redirdup');
    await setup('POST', `/websites/${site.id}/redirects`, {
      token: orgA.token,
      payload: { fromPath: '/a', toPath: '/b' },
    });
    const response = await api('POST', `/websites/${site.id}/redirects`, {
      token: orgA.token,
      payload: { fromPath: '/a', toPath: '/c' },
    });
    expect(response.statusCode).toBe(400);
  });

  it('survives a publish and a rollback, which is the step’s exit criterion', async () => {
    // The whole reason redirects are not in the snapshot. A redirect exists because an address
    // changed, and the links it serves were published by other people — so rolling the *content*
    // back must not delete it and 404 them.
    const { site, homeId } = await siteReadyToPublish('redirversion');
    const first = await setup<{ publishedVersionId: string }>(
      'POST',
      `/websites/${site.id}/publish`,
      { token: orgA.token },
    );
    await setup('POST', `/websites/${site.id}/redirects`, {
      token: orgA.token,
      payload: { fromPath: '/old-brochure', toPath: '/pricing', note: 'renamed in November' },
    });

    // A second publish: the redirect must not be snapshotted into it either.
    await setup('PATCH', `/websites/${site.id}/pages/${homeId}`, {
      token: orgA.token,
      payload: { title: 'Welcome again' },
    });
    await setup('POST', `/websites/${site.id}/publish`, { token: orgA.token });
    const afterPublish = await setup<{ redirects: { fromPath: string }[]; snapshot: unknown }>(
      'GET',
      `/public/sites/${site.subdomain}`,
    );
    expect(afterPublish.redirects.map((row) => row.fromPath)).toEqual(['/old-brochure']);
    // And it is beside the snapshot, never inside it: a reader comparing two versions must not
    // find a difference the server invented.
    expect(JSON.stringify(afterPublish.snapshot)).not.toMatch(/old-brochure/);

    await setup('POST', `/websites/${site.id}/rollback`, {
      token: orgA.token,
      payload: { versionId: first.publishedVersionId },
    });
    const afterRollback = await setup<{ redirects: { fromPath: string }[] }>(
      'GET',
      `/public/sites/${site.subdomain}`,
    );
    expect(afterRollback.redirects.map((row) => row.fromPath)).toEqual(['/old-brochure']);
  });

  it('is removable, and the removal is what stops it', async () => {
    const { site } = await siteReadyToPublish('redirdelete');
    const created = await setup<{ id: string }>('POST', `/websites/${site.id}/redirects`, {
      token: orgA.token,
      payload: { fromPath: '/gone', toPath: '/pricing' },
    });
    await setup('DELETE', `/websites/${site.id}/redirects/${created.id}`, { token: orgA.token });
    const rows = await setup<unknown[]>('GET', `/websites/${site.id}/redirects`, {
      token: orgA.token,
    });
    expect(rows).toEqual([]);
  });

  it("cannot see or change another workspace's redirect", async () => {
    const { site } = await siteReadyToPublish('redirtheirs');
    const created = await setup<{ id: string }>('POST', `/websites/${site.id}/redirects`, {
      token: orgA.token,
      payload: { fromPath: '/a', toPath: '/b' },
    });
    const response = await api('DELETE', `/websites/${site.id}/redirects/${created.id}`, {
      token: orgB.token,
    });
    // 404 on the site, before the redirect is ever looked up: a malformed id and another tenant's
    // id must be indistinguishable.
    expect(response.statusCode).toBe(404);
  });

  it('enqueues a cache drop on every change, including a removal', async () => {
    // The renderer reads redirects per request but caches the result on the site's tag, and it
    // caches a 404 too — so the address somebody is rescuing is precisely the one most likely to
    // be stale. A removal needs the drop as much as a creation: a redirect somebody deleted that
    // went on redirecting from cache would be a page nobody could reach back.
    const { site } = await siteReadyToPublish('redirevents');
    const created = await setup<{ id: string }>('POST', `/websites/${site.id}/redirects`, {
      token: orgA.token,
      payload: { fromPath: '/a', toPath: '/b' },
    });
    await setup('PATCH', `/websites/${site.id}/redirects/${created.id}`, {
      token: orgA.token,
      payload: { toPath: '/c' },
    });
    await setup('DELETE', `/websites/${site.id}/redirects/${created.id}`, { token: orgA.token });

    const events = await ctx.db.outboxEvent.findMany({
      where: {
        organizationId: orgA.organizationId,
        aggregateId: site.id,
        eventName: 'website.redirects_changed',
      },
      select: { eventName: true },
    });
    expect(events).toHaveLength(3);
  });
});
