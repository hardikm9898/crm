import { NextResponse, type NextRequest } from 'next/server';
import { apiBaseUrl } from '@/lib/api';
import { REFRESH_COOKIE_NAME, REFRESH_COOKIE_PATH } from '@/lib/refresh-cookie';
import { ACCESS_COOKIE_NAME } from '@/lib/session';

/**
 * Silent session renewal.
 *
 * Access tokens last fifteen minutes; refresh tokens last thirty days. Without this, coming back to
 * an open tab after lunch would mean signing in again even though the session is perfectly valid.
 *
 * This is Next 16's `proxy` convention (the old `middleware` name is deprecated). It only runs when
 * the access cookie is gone *and* a refresh cookie is present, so normal navigation costs nothing. Rotation happens at the API (the old refresh token is retired and reuse
 * is treated as theft, docs/security.md §2), so this must forward the new refresh cookie as well as
 * store the new access token. If renewal fails the request continues unauthenticated and the shell
 * redirects to sign-in, which is the correct outcome for an expired or stolen token.
 */
const ACCESS_TOKEN_MAX_AGE_SECONDS = 15 * 60;

export default async function proxy(request: NextRequest): Promise<NextResponse> {
  if (request.cookies.has(ACCESS_COOKIE_NAME)) return NextResponse.next();

  const refreshToken = request.cookies.get(REFRESH_COOKIE_NAME)?.value;
  if (!refreshToken) return NextResponse.next();

  let accessToken: string | null = null;
  let rotatedCookie: string | null = null;
  try {
    const upstream = await fetch(`${apiBaseUrl()}/api/v1/auth/refresh`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
      cache: 'no-store',
    });
    const envelope = (await upstream.json().catch(() => null)) as {
      success?: boolean;
      data?: { tokens?: { accessToken: string } };
    } | null;
    if (upstream.ok && envelope?.success) {
      accessToken = envelope.data?.tokens?.accessToken ?? null;
      rotatedCookie = upstream.headers.get('set-cookie');
    }
  } catch {
    accessToken = null;
  }

  if (!accessToken) {
    // The refresh token is spent, revoked or reused. Drop it so the next navigation does not pay
    // for the same failed round-trip.
    const cleared = NextResponse.next();
    cleared.cookies.set({
      name: REFRESH_COOKIE_NAME,
      value: '',
      path: REFRESH_COOKIE_PATH,
      maxAge: 0,
    });
    return cleared;
  }

  // Making the new token visible to *this* render, not just the next one, is what keeps the renewal
  // invisible: the server component reads the cookie from the forwarded request.
  request.cookies.set(ACCESS_COOKIE_NAME, accessToken);
  const response = NextResponse.next({ request });
  response.cookies.set({
    name: ACCESS_COOKIE_NAME,
    value: accessToken,
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: ACCESS_TOKEN_MAX_AGE_SECONDS,
  });
  if (rotatedCookie) {
    response.headers.append(
      'set-cookie',
      rotatedCookie.replace(/;\s*path=[^;]*/i, `; Path=${REFRESH_COOKIE_PATH}`),
    );
  }
  return response;
}

export const config = {
  // Static assets and the app's own session routes are excluded: the session routes manage these
  // cookies themselves, and running renewal there would race with them.
  matcher: ['/((?!_next/static|_next/image|favicon.ico|api/session).*)'],
};
