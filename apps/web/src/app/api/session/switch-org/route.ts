import { NextResponse } from 'next/server';
import { z } from 'zod';
import { apiBaseUrl } from '@/lib/api';
import { ACCESS_COOKIE_NAME, readAccessToken } from '@/lib/session';

/**
 * Switches the active organization.
 *
 * The active tenant is a claim inside the access token, so switching means asking the API to mint a
 * new one and replacing the cookie here. Membership is verified by the API — this route cannot be
 * used to reach an organization the caller does not belong to (docs/security.md §3).
 */
const bodySchema = z.object({ organizationId: z.string().min(1).max(64) }).strict();

const ACCESS_TOKEN_MAX_AGE_SECONDS = 15 * 60;

export async function POST(request: Request): Promise<NextResponse> {
  const token = await readAccessToken();
  if (!token) {
    return NextResponse.json(
      { success: false, error: { code: 'UNAUTHENTICATED', message: 'Please sign in again.' } },
      { status: 401 },
    );
  }

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { success: false, error: { code: 'VALIDATION_FAILED', message: 'Choose a workspace' } },
      { status: 400 },
    );
  }

  const upstream = await fetch(`${apiBaseUrl()}/api/v1/auth/switch-org`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(parsed.data),
    cache: 'no-store',
  });

  const envelope = (await upstream.json().catch(() => null)) as {
    success?: boolean;
    data?: { tokens?: { accessToken: string }; activeOrganizationId?: string };
    error?: { code: string; message: string };
  } | null;

  const accessToken = envelope?.data?.tokens?.accessToken;
  if (!upstream.ok || !envelope?.success || !accessToken) {
    return NextResponse.json(
      {
        success: false,
        error: envelope?.error ?? {
          code: 'INTERNAL_ERROR',
          message: 'Could not switch workspace',
        },
      },
      { status: upstream.ok ? 502 : upstream.status },
    );
  }

  const response = NextResponse.json({
    success: true,
    data: { activeOrganizationId: envelope.data?.activeOrganizationId },
  });
  response.cookies.set({
    name: ACCESS_COOKIE_NAME,
    value: accessToken,
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: ACCESS_TOKEN_MAX_AGE_SECONDS,
  });
  return response;
}

export const dynamic = 'force-dynamic';
