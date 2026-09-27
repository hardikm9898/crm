import { Injectable, type NestMiddleware } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { newId } from '@leados/shared';
import { requestStore } from './request-store.js';

/**
 * Establishes the request id and per-request async context for every request,
 * authenticated or not. The tenant context is layered on top of this by the auth
 * guard (Phase 1 step 2) — see docs/system-architecture.md §7.
 */
@Injectable()
export class RequestContextMiddleware implements NestMiddleware {
  use(
    request: FastifyRequest['raw'] & { originalUrl?: string },
    response: FastifyReply['raw'],
    next: () => void,
  ): void {
    const incoming = request.headers['x-request-id'];
    const requestId =
      typeof incoming === 'string' && incoming.length > 0 && incoming.length <= 200
        ? incoming
        : `req_${newId()}`;

    response.setHeader('x-request-id', requestId);

    const forwardedFor = request.headers['x-forwarded-for'];
    void requestStore.run(
      {
        requestId,
        method: request.method ?? 'GET',
        // Middleware is mounted on a wildcard, which rewrites `url` to the path
        // relative to the mount point; `originalUrl` keeps the real request target.
        path: request.originalUrl ?? request.url ?? '/',
        ip:
          (typeof forwardedFor === 'string' ? forwardedFor.split(',')[0]?.trim() : undefined) ??
          request.socket.remoteAddress,
        userAgent: request.headers['user-agent'],
        startedAt: Date.now(),
      },
      async () => {
        next();
      },
    );
  }
}
