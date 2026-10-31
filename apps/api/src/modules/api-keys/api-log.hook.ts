import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { logPath } from '@leados/shared';
import type { ApiLogService } from './api-log.service.js';

/**
 * What a request carries once its credential has been recognised.
 *
 * Written by whichever authenticator ran — the global guard for the REST surface, the controller
 * for the public ingestion endpoint — and read only by the response hook below. A request with no
 * such mark is not logged in `api_logs` at all: it is either the web app's own session traffic or a
 * credential that resolved to no workspace, and neither has a workspace to file a row under.
 */
export interface ApiRequestMark {
  readonly organizationId: string;
  readonly apiKeyId: string | null;
  readonly surface: 'rest' | 'public_ingest';
  /**
   * The client's address as the authenticator resolved it.
   *
   * Carried rather than read from `request.ip` here, because the proxy chain is read in one place
   * in this product (the request-context middleware) and `onResponse` runs in a different async
   * context from the request it describes. The authenticator has the authoritative value — it is
   * what the allowlist was checked against — so it hands it over rather than being read twice.
   */
  readonly ip: string | null;
}

type MarkedRequest = FastifyRequest & {
  leadosApi?: ApiRequestMark;
  leadosErrorCode?: string;
};

export function markApiRequest(request: unknown, mark: ApiRequestMark): void {
  (request as MarkedRequest).leadosApi = mark;
}

export function markErrorCode(request: unknown, code: string): void {
  (request as MarkedRequest).leadosErrorCode = code;
}

/**
 * Records every key-authenticated request, from the response hook rather than an interceptor.
 *
 * A Nest interceptor would see only the requests that reach a handler: a 401 from the guard, a 403
 * from the permission guard and a 429 from the rate limiter — the three answers an integrator most
 * needs to see — all happen outside it. Fastify's `onResponse` runs after every one of them, and
 * after the exception filter has written the envelope, so the status and the error code it records
 * are the ones the caller actually received.
 *
 * Installed by `ApiLogHookInstaller` on application bootstrap, **not** from `main.ts`: a hook
 * registered in one bootstrap path is absent from every other application built from the same
 * modules — the test harness builds its own, and the first run of this suite recorded nothing at
 * all while the product recorded everything.
 */
export function installApiLogging(fastify: FastifyInstance, logs: ApiLogService): void {
  fastify.addHook('onResponse', (request: FastifyRequest, reply: FastifyReply, done) => {
    // `done` first, in a hook that must not delay the connection being released. Everything after
    // it is bookkeeping, and `record` neither awaits nor throws.
    done();
    const marked = request as MarkedRequest;
    const mark = marked.leadosApi;
    if (!mark) return;

    logs.record({
      organizationId: mark.organizationId,
      apiKeyId: mark.apiKeyId,
      surface: mark.surface,
      method: request.method,
      path: logPath(request.url),
      statusCode: reply.statusCode,
      // Only ever present on a refusal: the filter is the one thing that writes it.
      errorCode: reply.statusCode >= 400 ? (marked.leadosErrorCode ?? null) : null,
      durationMs: Math.round(reply.elapsedTime),
      bytesIn: contentLength(request.headers['content-length']),
      bytesOut: contentLength(reply.getHeader('content-length')),
      // From the **reply**: the request-context middleware puts the id it minted there, and the
      // request's own header is only set when a client sent one.
      requestId: reply.getHeader('x-request-id')?.toString() ?? '',
      ip: mark.ip ?? request.ip ?? null,
      // Bounded: a header is whatever the caller sent, and this column is read on a screen.
      userAgent: request.headers['user-agent']?.slice(0, 256) ?? null,
      createdAt: new Date(),
    });
  });
}

function contentLength(value: unknown): number {
  const parsed = Number(value);
  // `Number(null)` and `Number('')` are both 0, which is the right answer here and is still worth
  // being explicit about: an absent length means "nothing measurable", not "a header we trusted".
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : 0;
}
