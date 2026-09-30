import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common';
import { map, type Observable } from 'rxjs';
import { requestStore } from './request-store.js';

/**
 * The single response envelope for the whole API (docs/api-architecture.md §2):
 *
 *   { "success": true, "data": …, "message": …, "meta": { requestId, pagination? } }
 *
 * Applied globally so no controller can invent its own shape. A handler may return a
 * `Paginated` result and the pagination block is lifted into `meta` automatically.
 */

export interface Paginated<T> {
  readonly items: readonly T[];
  /**
   * Extra context about *this* result, merged into the envelope's `meta`.
   *
   * Without it a paginated handler can only return rows: every other key it returns is dropped on
   * the floor, silently. That cost a debugging session — `POST /leads/search` echoes which saved
   * view ran and which conditions were applied, and the answer simply never reached the client.
   */
  readonly meta?: Record<string, unknown>;
  readonly pagination: {
    readonly limit: number;
    readonly nextCursor: string | null;
    readonly prevCursor?: string | null;
    readonly hasMore: boolean;
    readonly total?: number;
    readonly totalIsEstimate?: boolean;
  };
}

export interface ResponseEnvelope<T> {
  success: true;
  data: T;
  message?: string;
  meta: Record<string, unknown>;
}

export const MESSAGE_KEY = '__message';

function isPaginated<T>(value: unknown): value is Paginated<T> {
  return (
    typeof value === 'object' &&
    value !== null &&
    'items' in value &&
    'pagination' in value &&
    Array.isArray((value as { items: unknown }).items)
  );
}

@Injectable()
export class EnvelopeInterceptor implements NestInterceptor {
  intercept(_context: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle().pipe(
      map((payload: unknown): unknown => {
        // Endpoints that must return a bare body (webhook acks, health probes used by
        // load balancers, redirects) opt out by marking the payload.
        if (payload !== null && typeof payload === 'object' && '__raw' in payload) {
          return (payload as { __raw: unknown }).__raw;
        }

        const meta: Record<string, unknown> = {};
        const requestId = requestStore.requestId();
        if (requestId) meta['requestId'] = requestId;

        if (isPaginated(payload)) {
          meta['pagination'] = payload.pagination;
          if (payload.meta) Object.assign(meta, payload.meta);
          return { success: true, data: payload.items, meta } satisfies ResponseEnvelope<unknown>;
        }

        let data = payload;
        let message: string | undefined;
        if (payload !== null && typeof payload === 'object' && MESSAGE_KEY in payload) {
          const { [MESSAGE_KEY]: extracted, ...rest } = payload as Record<string, unknown>;
          message = typeof extracted === 'string' ? extracted : undefined;
          data = rest;
        }

        const envelope: ResponseEnvelope<unknown> = { success: true, data: data ?? null, meta };
        if (message) envelope.message = message;
        return envelope;
      }),
    );
  }
}

/** Attaches a user-facing message to a handler's return value. */
export function withMessage<T extends object>(
  data: T,
  message: string,
): T & { [MESSAGE_KEY]: string } {
  return { ...data, [MESSAGE_KEY]: message };
}

/** Bypasses the envelope for responses whose shape is dictated by an external caller. */
export function raw<T>(body: T): { __raw: T } {
  return { __raw: body };
}
