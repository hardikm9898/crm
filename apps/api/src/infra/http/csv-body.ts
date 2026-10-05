import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { FastifyRequest } from 'fastify';

type ParserDone = (error: Error | null, body?: unknown) => void;

/** The content types a spreadsheet export actually arrives as. */
export const CSV_CONTENT_TYPES = [
  'text/csv',
  'application/csv',
  'application/vnd.ms-excel',
] as const;

/**
 * Accepts a CSV upload as a raw request body.
 *
 * **Why not multipart.** An import is one file and nothing else. `@fastify/multipart` would add a
 * dependency, a streaming-to-disk story and a second place where a body limit is configured, to
 * carry a payload that has no other parts. A raw body with the file's own content type is what
 * `curl --data-binary`, `fetch(file)` and the web app's server action all produce naturally, and
 * the file name travels as a query parameter where it is visible in the access log.
 *
 * **Why a separate parser rather than a bigger global limit.** The body limit is per content type,
 * so `application/json` keeps its 256 KiB — a JSON flood stays bounded — while a CSV may be
 * `UPLOAD_MAX_BYTES`. One global limit would have to be the larger of the two, which would make
 * every JSON endpoint a 20 MB sink.
 *
 * **Why the path guard.** A content-type parser is global to the server, and Fastify parses the
 * body *before* any guard runs — so without this hook an unauthenticated request to `/auth/login`
 * could have 20 MB buffered for it just by claiming `content-type: text/csv`. The hook refuses a
 * CSV content type anywhere but the upload routes, at `onRequest`, which is before a single byte of
 * the body is read. `text/plain` is deliberately *not* in the list: it is the default for too many
 * clients to be worth a large limit.
 *
 * The body is handed on as a **string**, decoded as UTF-8 with the BOM left in place:
 * `stripBom`/`sniffDelimiter` in `@leados/shared` want the bytes as the file had them, because the
 * BOM is evidence about where the file came from.
 */
export function allowCsvUpload(
  app: NestFastifyApplication,
  bodyLimit: number,
  allowedPathPrefixes: readonly string[],
): void {
  const adapter = app.getHttpAdapter();
  if (typeof adapter.useBodyParser !== 'function') {
    throw new Error('The Fastify adapter no longer exposes useBodyParser');
  }

  adapter.getInstance().addHook('onRequest', (request, reply, done) => {
    const contentType = (request.headers['content-type'] ?? '').split(';')[0]?.trim() ?? '';
    if (!CSV_CONTENT_TYPES.includes(contentType as (typeof CSV_CONTENT_TYPES)[number])) {
      done();
      return;
    }
    const path = request.url.split('?')[0] ?? '';
    if (allowedPathPrefixes.some((prefix) => path.startsWith(prefix))) {
      done();
      return;
    }
    reply.code(415).send({
      error: {
        code: 'UNSUPPORTED_MEDIA_TYPE',
        message: 'This endpoint does not accept a file upload.',
      },
    });
  });

  const parse = (_request: FastifyRequest, body: Buffer | string, done: ParserDone): void => {
    const text = Buffer.isBuffer(body) ? body.toString('utf8') : String(body ?? '');
    done(null, text);
  };
  for (const contentType of CSV_CONTENT_TYPES) {
    adapter.useBodyParser(contentType, false, { bodyLimit }, parse as never);
  }
}
