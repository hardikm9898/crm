import { timingSafeEqual } from 'node:crypto';
import { revalidateTag } from 'next/cache';
import { NextResponse } from 'next/server';
import { siteCacheTag } from '@/lib/websites';

/**
 * Drops the cache tag a published site is served under (`FR-WEB-5`).
 *
 * The renderer serves a site statically with `revalidate: false` and one tag, so this route is the
 * only thing that can change what a visitor sees. The API calls it from the
 * `maintenance.site-revalidate` job, which is driven by the `website.published`,
 * `website.unpublished` and `website.rolled_back` outbox events.
 *
 * **Why a shared secret and not a session.** The caller is the API's worker, which has no user and
 * no cookie. Without the secret this route would let anybody on the internet force a revalidation
 * of any site by name — not a data leak, but a free way to make us re-fetch and re-render every
 * site in the product on demand, which is a denial-of-service with a one-line script.
 *
 * The comparison is length-then-content via `timingSafeEqual`, because a plain `!==` on a secret
 * leaks its length and its prefix to anybody willing to measure. That is cheap paranoia here, and
 * the kind this codebase already applies to sign-in (`timing-equalised failures`).
 */
export async function POST(request: Request): Promise<NextResponse> {
  const expected = process.env['WEB_REVALIDATE_SECRET'];
  if (expected === undefined || expected.length === 0) {
    // 503 rather than 500: the deployment is not configured for this, which is a different thing
    // from the route being broken, and the API's job logs the distinction either way.
    return NextResponse.json(
      { success: false, error: { code: 'NOT_CONFIGURED' } },
      { status: 503 },
    );
  }

  const presented = request.headers.get('x-revalidate-secret') ?? '';
  if (!secretMatches(presented, expected)) {
    return NextResponse.json({ success: false, error: { code: 'FORBIDDEN' } }, { status: 403 });
  }

  const body = (await request.json().catch(() => null)) as { subdomain?: unknown } | null;
  const subdomain = typeof body?.subdomain === 'string' ? body.subdomain.trim() : '';
  if (subdomain.length === 0) {
    return NextResponse.json(
      { success: false, error: { code: 'VALIDATION_FAILED', message: 'subdomain is required' } },
      { status: 400 },
    );
  }

  // One tag, the one the renderer's fetch declared. `siteCacheTag` is shared with that fetch
  // rather than the string being written twice: a tag dropped under a different name from the one
  // the page was stored under is a revalidation that silently does nothing, and the only symptom
  // is a site that never updates.
  //
  // The second argument is a cacheLife profile, and the choice is measurable rather than a matter
  // of taste. Next's own deprecation message suggests `'max'`, which marks the tag stale: the next
  // request is served the **previous** version while a re-render happens behind it, and the one
  // after that is fresh. Measured here, that meant a business pressing Publish and reloading their
  // own site saw the old page once — the single most confusing moment this feature has, because it
  // looks exactly like a publish that did not work. `{ expire: 0 }` purges instead, and the first
  // request after a publish is already the new version (measured: 1.6s end to end, including the
  // outbox and the worker).
  //
  // `updateTag` is the other "immediate" call and is not available here: it **throws** from a route
  // handler, by an explicit check on `page.endsWith('/route')`. Anybody tidying this to `updateTag`
  // gets a 500 on every publish.
  revalidateTag(siteCacheTag(subdomain), { expire: 0 });

  return NextResponse.json({ success: true, data: { revalidated: siteCacheTag(subdomain) } });
}

function secretMatches(presented: string, expected: string): boolean {
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  // `timingSafeEqual` throws on a length mismatch, so the lengths are compared first. That does
  // leak the secret's length, which is the one thing this cannot hide and does not need to.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
