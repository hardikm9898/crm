import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { FastifyRequest } from 'fastify';

type ParserDone = (error: Error | null, body?: unknown) => void;

/**
 * Lets an action endpoint be called with no body.
 *
 * Fastify's default JSON parser rejects an empty body when `content-type: application/json` is set,
 * with `Body cannot be empty when content-type is set to 'application/json'` — a 400 that reads like
 * a validation failure and is not one. Every HTTP client that sets a default JSON content-type
 * (fetch wrappers, axios, the web app's own `callApi`) sends exactly that shape when it POSTs an
 * action with nothing to say: `/leads/:id/restore`, `/leads/:id/recompute-score`,
 * `/duplicates/:id/dismiss`, `/auth/logout-all`.
 *
 * Requiring `{}` instead would be a rule every caller has to know, forever, discovered one endpoint
 * at a time. So an empty body parses as an empty object and the route's own Zod schema decides
 * whether that is acceptable — which is where the decision belongs.
 *
 * **Why `useBodyParser` rather than Fastify's own API:** Nest registers its parsers during
 * `listen()`, *after* any bootstrap code runs, so `addContentTypeParser` — with or without
 * `removeContentTypeParser` or `removeAllContentTypeParsers` first — loses the race and the app dies
 * with `FST_ERR_CTP_ALREADY_PRESENT`. `useBodyParser` registers the parser *and* marks the adapter's
 * parsers as registered, which is the only way to replace the default rather than collide with it.
 *
 * Registered here rather than inline in the bootstrap so the test harness applies identical
 * behaviour; a convention that holds in production but not in tests is one the tests cannot defend.
 */
export function allowEmptyJsonBody(app: NestFastifyApplication, bodyLimit: number): void {
  const parse = (_request: FastifyRequest, body: Buffer | string, done: ParserDone): void => {
    const text = Buffer.isBuffer(body) ? body.toString('utf8').trim() : String(body ?? '').trim();
    if (text === '') {
      done(null, {});
      return;
    }
    try {
      done(null, JSON.parse(text));
    } catch (error) {
      // A malformed body is still a 400 — a different failure from an absent one, and it should
      // stay distinguishable in the logs.
      done(error as Error, undefined);
    }
  };

  const adapter = app.getHttpAdapter();
  // `useBodyParser` is optional on the base adapter type, so it is narrowed rather than asserted:
  // if a future Nest drops it, this fails to compile instead of failing at boot.
  if (typeof adapter.useBodyParser !== 'function') {
    throw new Error('The Fastify adapter no longer exposes useBodyParser');
  }
  adapter.useBodyParser('application/json', false, { bodyLimit }, parse as never);
}
