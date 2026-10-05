import { apiBaseUrl } from '@/lib/api';
import { readAccessToken } from '@/lib/session';

/**
 * Relays an import's failed-rows file to the browser.
 *
 * The access token is an httpOnly cookie, so the browser cannot call the API directly — a download
 * link has to pass through the web app. This is a plain relay: no parsing, no re-encoding, and the
 * API's own `content-disposition` is honoured, so the file the person saves is byte-for-byte the
 * file the API wrote. Re-building the CSV here would be a second implementation of the format.
 */
export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params;
  const token = await readAccessToken();
  if (!token) return new Response('Please sign in again.', { status: 401 });

  const upstream = await fetch(`${apiBaseUrl()}/api/v1/imports/${id}/errors.csv`, {
    headers: { authorization: `Bearer ${token}` },
    cache: 'no-store',
  });
  if (!upstream.ok) {
    return new Response('That file is no longer available.', { status: upstream.status });
  }

  return new Response(upstream.body, {
    status: 200,
    headers: {
      'content-type': upstream.headers.get('content-type') ?? 'text/csv; charset=utf-8',
      'content-disposition':
        upstream.headers.get('content-disposition') ?? `attachment; filename="errors.csv"`,
      'x-content-type-options': 'nosniff',
      'cache-control': 'no-store',
    },
  });
}
