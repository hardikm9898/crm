import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { apiBaseUrl } from '@/lib/api';
import {
  REFRESH_COOKIE_NAME,
  REFRESH_COOKIE_PATH,
  rewriteRefreshCookiePath,
} from '@/lib/refresh-cookie';
import { ACCESS_COOKIE_NAME } from '@/lib/session';

/**
 * Sign-in and sign-out, proxied through the app so the access token can be stored in an httpOnly
 * cookie the browser cannot read.
 *
 * No token ever reaches JavaScript, which is what limits the damage of an XSS bug. The API's own
 * refresh cookie is set by the API and scoped to `/api/v1/auth`; this route manages only the
 * short-lived access token (docs/security.md §2).
 */
const credentialsSchema = z
  .object({
    email: z.string().trim().toLowerCase().email(),
    password: z.string().min(1),
  })
  .strict();

const ACCESS_TOKEN_MAX_AGE_SECONDS = 15 * 60;

export async function POST(request: Request): Promise<NextResponse> {
  const parsed = credentialsSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      {
        success: false,
        error: { code: 'VALIDATION_FAILED', message: 'Enter your email and password' },
      },
      { status: 400 },
    );
  }

  const upstream = await fetch(`${apiBaseUrl()}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(parsed.data),
    cache: 'no-store',
  });

  const envelope = (await upstream.json().catch(() => null)) as {
    success?: boolean;
    data?: { tokens?: { accessToken: string }; mfaRequired?: boolean; challengeToken?: string };
    error?: { code: string; message: string };
  } | null;

  if (!upstream.ok || !envelope?.success) {
    // The API's codes and messages are already written for a person; pass them through rather than
    // inventing a second vocabulary for the same failures.
    return NextResponse.json(
      {
        success: false,
        error: envelope?.error ?? { code: 'INTERNAL_ERROR', message: 'Sign-in failed' },
      },
      { status: upstream.status },
    );
  }

  // An account with MFA gets a challenge instead of tokens.
  if (envelope.data?.mfaRequired === true) {
    return NextResponse.json({
      success: true,
      data: { mfaRequired: true, challengeToken: envelope.data.challengeToken },
    });
  }

  const accessToken = envelope.data?.tokens?.accessToken;
  if (!accessToken) {
    return NextResponse.json(
      { success: false, error: { code: 'INTERNAL_ERROR', message: 'Sign-in failed' } },
      { status: 502 },
    );
  }

  const response = NextResponse.json({ success: true, data: { signedIn: true } });
  response.cookies.set({
    name: ACCESS_COOKIE_NAME,
    value: accessToken,
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: ACCESS_TOKEN_MAX_AGE_SECONDS,
  });
  // Forward the API's refresh cookie so the session can be renewed later, re-scoped to this app's
  // session routes — see lib/refresh-cookie.ts for why the path has to be rewritten.
  const upstreamCookie = upstream.headers.get('set-cookie');
  if (upstreamCookie) {
    response.headers.append('set-cookie', rewriteRefreshCookiePath(upstreamCookie));
  }
  return response;
}

/**
 * Signing out revokes the refresh token at the API as well as clearing the cookie here: dropping
 * only the cookie would leave a live session that could still be renewed from a stolen refresh
 * token (docs/security.md §2).
 */
export async function DELETE(request: Request): Promise<NextResponse> {
  const token = (await cookies()).get(ACCESS_COOKIE_NAME)?.value ?? null;

  // A failure upstream must not strand the person in a signed-in-looking shell, so the cookie is
  // cleared either way and the outcome is reported honestly.
  let revoked: boolean;
  try {
    const upstream = await fetch(`${apiBaseUrl()}/api/v1/auth/logout`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        // The refresh cookie is what identifies the session to revoke.
        ...(request.headers.get('cookie')
          ? { cookie: request.headers.get('cookie') as string }
          : {}),
      },
      body: '{}',
      cache: 'no-store',
    });
    revoked = upstream.ok;
  } catch {
    revoked = false;
  }

  const response = NextResponse.json({ success: true, data: { signedOut: true, revoked } });
  response.cookies.set({ name: ACCESS_COOKIE_NAME, value: '', path: '/', maxAge: 0 });
  response.cookies.set({
    name: REFRESH_COOKIE_NAME,
    value: '',
    path: REFRESH_COOKIE_PATH,
    maxAge: 0,
  });
  return response;
}

export const dynamic = 'force-dynamic';
