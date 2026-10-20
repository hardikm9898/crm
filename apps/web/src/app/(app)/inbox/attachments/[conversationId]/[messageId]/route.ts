import { apiBaseUrl } from '@/lib/api';
import { readAccessToken } from '@/lib/session';

/**
 * Relays one WhatsApp attachment to the browser (`FR-WA-3`).
 *
 * The access token is an httpOnly cookie, so an `<img src>` pointed at the API would be an
 * unauthenticated request — a download link has to pass through this app, exactly as the export
 * and the import error file already do. A plain relay: the API's own `content-type` and
 * `content-disposition` are honoured, so a photo stays inline and a document stays a download, and
 * nothing here decides which.
 *
 * `nosniff` and `no-store` are repeated rather than relayed on purpose: they are this response's
 * guarantees, and a header missing upstream must not become a header missing here.
 */
export async function GET(
  _request: Request,
  context: { params: Promise<{ conversationId: string; messageId: string }> },
): Promise<Response> {
  const { conversationId, messageId } = await context.params;
  const token = await readAccessToken();
  if (!token) return new Response('Please sign in again.', { status: 401 });

  const upstream = await fetch(
    `${apiBaseUrl()}/api/v1/conversations/${conversationId}/messages/${messageId}/media`,
    { headers: { authorization: `Bearer ${token}` }, cache: 'no-store' },
  );
  if (!upstream.ok) {
    // The API's refusal says why — too large, not arrived, no longer stored — and that sentence is
    // already on the thread beside the message. Here it would be a bare page, so this answers the
    // status and leaves the explanation where somebody is looking.
    return new Response('That file is not available.', { status: upstream.status });
  }

  return new Response(upstream.body, {
    status: 200,
    headers: {
      'content-type': upstream.headers.get('content-type') ?? 'application/octet-stream',
      'content-disposition': upstream.headers.get('content-disposition') ?? 'attachment',
      'x-content-type-options': 'nosniff',
      'cache-control': 'no-store',
    },
  });
}
