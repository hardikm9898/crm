import { NextResponse } from 'next/server';
import { z } from 'zod';
import { apiBaseUrl } from '@/lib/api';
import { rewriteRefreshCookiePath } from '@/lib/refresh-cookie';
import { ACCESS_COOKIE_NAME } from '@/lib/session';

/**
 * Accepting an invitation, then signing the person straight in.
 *
 * The API returns a full session, so this route stores it exactly as sign-in does — an invitee who
 * has to accept and *then* find the sign-in page has been given two steps where one would do.
 */
const bodySchema = z
  .object({
    token: z.string().min(10).max(400),
    name: z.string().trim().min(1).max(120).optional(),
    password: z.string().min(1).max(200).optional(),
  })
  .strict();

const ACCESS_TOKEN_MAX_AGE_SECONDS = 15 * 60;

export async function POST(request: Request): Promise<NextResponse> {
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      {
        success: false,
        error: { code: 'VALIDATION_FAILED', message: 'This invitation link looks incomplete.' },
      },
      { status: 400 },
    );
  }

  const upstream = await fetch(`${apiBaseUrl()}/api/v1/auth/invitations/accept`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
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
          message: 'This invitation could not be accepted.',
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
  const upstreamCookie = upstream.headers.get('set-cookie');
  if (upstreamCookie) {
    response.headers.append('set-cookie', rewriteRefreshCookiePath(upstreamCookie));
  }
  return response;
}

export const dynamic = 'force-dynamic';
