import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { ApiError, request } from './api';

/**
 * Server-side session handling.
 *
 * The access token lives in an httpOnly cookie set by this app, not in `localStorage`: JavaScript
 * cannot read it, which is what limits the damage of an XSS bug (docs/security.md §2). The API's
 * refresh cookie is relayed through this app's session routes; see lib/refresh-cookie.ts.
 */
const ACCESS_COOKIE = 'leados_at';

export interface CurrentUser {
  user: { id: string; email: string; name: string; emailVerified: boolean; mfaEnabled: boolean };
  organizations: { id: string; slug: string; name: string; status: string; isOwner: boolean }[];
  activeOrganizationId: string;
  permissions: string[];
  scopes: Record<string, string>;
}

export async function readAccessToken(): Promise<string | null> {
  const store = await cookies();
  return store.get(ACCESS_COOKIE)?.value ?? null;
}

/**
 * Loads the signed-in user, or redirects to sign-in.
 *
 * Authorization is *not* decided here — the API decides, and this only reads what it reports. The
 * permission list is used to shape navigation, never to grant anything
 * (docs/frontend-architecture.md §1).
 */
export async function requireCurrentUser(): Promise<CurrentUser> {
  const token = await readAccessToken();
  if (!token) redirect('/login');

  try {
    const response = await request<CurrentUser>('/auth/me', { token });
    return response.data;
  } catch (error) {
    if (error instanceof ApiError && error.isUnauthenticated) redirect('/login?expired=1');
    throw error;
  }
}

export function can(user: CurrentUser, permission: string): boolean {
  return user.permissions.includes(permission);
}

export const ACCESS_COOKIE_NAME = ACCESS_COOKIE;
