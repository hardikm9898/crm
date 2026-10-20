import { Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { FastifyInstance, FastifyRequest } from 'fastify';

type ParserDone = (error: Error | null, body?: unknown) => void;

/** Everything a WhatsApp attachment may arrive as, which is "anything", bounded by size. */
const MEDIA_CONTENT_TYPE = 'application/octet-stream';

/**
 * The content types the upload route accepts as raw bytes.
 *
 * A browser's `fetch(file)` sends the file's **own** type, so the list has to cover what people
 * actually attach rather than one catch-all — and `application/octet-stream` is what a client with
 * no idea sends.
 */
// `text/plain` is deliberately absent: too many clients default to it, and a parser registered for
// it would give every such client a 16 MB body limit on the one path that allows uploads. A type
// nobody listed is refused by Fastify with a bare 415 rather than by the hook, which is a less
// helpful sentence and the honest one — this product has no parser for it.
export const MEDIA_CONTENT_TYPES = [
  MEDIA_CONTENT_TYPE,
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'video/mp4',
  'video/3gpp',
  'audio/mpeg',
  'audio/ogg',
  'audio/mp4',
  'audio/aac',
  'audio/amr',
  'application/pdf',
  'application/msword',
  'application/vnd.ms-excel',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/zip',
] as const;

/**
 * Accepts a WhatsApp attachment as a raw request body (`FR-WA-3`).
 *
 * The CSV upload's shape, for the same three reasons — one file and nothing else, so multipart
 * would add a dependency and a second body limit for no second part; a per-content-type limit, so
 * `application/json` keeps its 256 KiB while a photo may be sixteen megabytes; and an `onRequest`
 * guard, because **a content-type parser is global and Fastify parses the body before any guard
 * runs** — without it an unauthenticated request to `/auth/login` could have 16 MB buffered for it
 * just by claiming `content-type: image/png`.
 *
 * Installed as an `onApplicationBootstrap` provider rather than from `main.ts`, which is the
 * difference from the CSV parser: a hook registered in the HTTP bootstrap is **absent from every
 * application the tests build**, and the suite that proves the upload works would be proving it
 * against a parser the running product has and the tests do not. Nest runs this inside
 * `app.init()`, which is before Fastify's `ready()` and before Nest registers its own parsers
 * during `listen()` — the ordering `useBodyParser` needs.
 */
@Injectable()
export class MediaUploadInstaller implements OnApplicationBootstrap {
  constructor(private readonly adapters: HttpAdapterHost) {}

  onApplicationBootstrap(): void {
    // `useBodyParser` is Fastify's own addition to the adapter and is not on Nest's abstract type,
    // which is why this is narrowed rather than assumed: a different adapter has no parsers to
    // register and this installer does nothing at all.
    const adapter = this.adapters.httpAdapter as
      | (NestFastifyApplication['getHttpAdapter'] extends () => infer A ? A : never)
      | undefined;
    const withParser = adapter as unknown as
      | {
          useBodyParser?: (
            type: string,
            rawBody: boolean,
            options: { bodyLimit: number },
            parser: unknown,
          ) => void;
          getInstance?: <T>() => T;
        }
      | undefined;
    // `null` **and** `undefined`: a **standalone** application context (the OpenAPI writer, the
    // schema-object tooling) has `httpAdapter === null`, and a check written only for `undefined`
    // read straight through it and died on `Cannot read properties of null`. Anything registered on
    // `onApplicationBootstrap` runs in every context Nest can build, HTTP or not.
    if (
      withParser === null ||
      withParser === undefined ||
      typeof withParser.useBodyParser !== 'function'
    ) {
      return;
    }
    const instance = withParser.getInstance?.<FastifyInstance>();
    if (typeof instance?.addHook !== 'function') return;

    instance.addHook('onRequest', (request, reply, done) => {
      const contentType = (request.headers['content-type'] ?? '').split(';')[0]?.trim() ?? '';
      if (!(MEDIA_CONTENT_TYPES as readonly string[]).includes(contentType)) {
        done();
        return;
      }
      const path = request.url.split('?')[0] ?? '';
      // The one shape of path that may carry bytes. Checked before a byte is read.
      if (/\/conversations\/[^/]+\/attachments$/.test(path)) {
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
      // Buffered, not streamed: the storage port takes a `Buffer`, which is the same constraint
      // that caps an export at 100 000 rows and an attachment at sixteen megabytes.
      done(null, Buffer.isBuffer(body) ? body : Buffer.from(String(body ?? ''), 'utf8'));
    };
    for (const contentType of MEDIA_CONTENT_TYPES) {
      withParser.useBodyParser(contentType, false, { bodyLimit: MEDIA_BODY_LIMIT }, parse as never);
    }
  }
}

/**
 * Sixteen megabytes, which is the largest attachment this product stores.
 *
 * A constant rather than configuration: it is the same number `MEDIA_LIMITS` enforces per type, and
 * two answers to "how big may a file be" is how one of them ends up wrong.
 */
export const MEDIA_BODY_LIMIT = 16 * 1024 * 1024;
