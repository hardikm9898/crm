import { apiBaseUrl } from '@/lib/api';
import { readAccessToken } from '@/lib/session';

/**
 * Relays a quotation's PDF to the browser.
 *
 * The access token is an httpOnly cookie, so the browser cannot call the API directly — a document
 * link has to pass through the web app. A plain relay: no parsing, no re-encoding, and the API's
 * own `content-disposition` is honoured, so the file is byte-for-byte the file the API rendered.
 * Re-drawing the document here would be a second implementation of it, which is exactly what
 * ADR-0018 and ADR-0019 exist to prevent.
 */
export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params;
  const token = await readAccessToken();
  if (!token) return new Response('Please sign in again.', { status: 401 });

  const upstream = await fetch(`${apiBaseUrl()}/api/v1/quotations/${id}/pdf`, {
    headers: { authorization: `Bearer ${token}` },
    cache: 'no-store',
  });
  if (!upstream.ok) {
    return new Response('That quotation is not available.', { status: upstream.status });
  }

  return new Response(upstream.body, {
    status: 200,
    headers: {
      'content-type': upstream.headers.get('content-type') ?? 'application/pdf',
      'content-disposition':
        upstream.headers.get('content-disposition') ?? 'inline; filename="quotation.pdf"',
      'x-content-type-options': 'nosniff',
      'cache-control': 'no-store',
    },
  });
}
