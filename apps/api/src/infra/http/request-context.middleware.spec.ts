import { describe, expect, it } from 'vitest';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { RequestContextMiddleware } from './request-context.middleware.js';
import { requestStore, type RequestMetadata } from './request-store.js';

type RawRequest = FastifyRequest['raw'] & { originalUrl?: string };

function fakeRequest(overrides: Partial<RawRequest> = {}): RawRequest {
  return {
    method: 'GET',
    url: '/',
    headers: {},
    socket: { remoteAddress: '10.0.0.1' },
    ...overrides,
  } as RawRequest;
}

function fakeResponse(): { raw: FastifyReply['raw']; headers: Record<string, string> } {
  const headers: Record<string, string> = {};
  return {
    raw: {
      setHeader: (name: string, value: string) => (headers[name] = value),
    } as unknown as FastifyReply['raw'],
    headers,
  };
}

/** Runs the middleware and returns the context observed inside the downstream handler. */
function capture(request: RawRequest): {
  context: RequestMetadata | undefined;
  headers: Record<string, string>;
} {
  const middleware = new RequestContextMiddleware();
  const response = fakeResponse();
  let context: RequestMetadata | undefined;
  middleware.use(request, response.raw, () => {
    context = requestStore.get();
  });
  return { context, headers: response.headers };
}

describe('RequestContextMiddleware', () => {
  it('generates a request id and echoes it in the response header', () => {
    const { context, headers } = capture(fakeRequest());
    expect(context?.requestId).toMatch(/^req_/);
    expect(headers['x-request-id']).toBe(context?.requestId);
  });

  it('adopts an inbound request id so a trace spans services', () => {
    const { context } = capture(fakeRequest({ headers: { 'x-request-id': 'req_edge_1' } }));
    expect(context?.requestId).toBe('req_edge_1');
  });

  it('ignores an absurdly long inbound id rather than logging it', () => {
    const { context } = capture(fakeRequest({ headers: { 'x-request-id': 'x'.repeat(500) } }));
    expect(context?.requestId).toMatch(/^req_/);
  });

  it('records the real request target, not the wildcard mount path', () => {
    // Nest mounts middleware on a wildcard, which rewrites `url` to '/'. Without
    // preferring originalUrl every log line and audit row would say '/'.
    const { context } = capture(fakeRequest({ url: '/', originalUrl: '/api/v1/leads?limit=25' }));
    expect(context?.path).toBe('/api/v1/leads?limit=25');
  });

  it('prefers the client IP from x-forwarded-for behind a proxy', () => {
    const { context } = capture(
      fakeRequest({ headers: { 'x-forwarded-for': '203.0.113.7, 10.0.0.5' } }),
    );
    expect(context?.ip).toBe('203.0.113.7');
  });

  it('falls back to the socket address with no proxy header', () => {
    expect(capture(fakeRequest()).context?.ip).toBe('10.0.0.1');
  });

  it('leaves no context behind once the request finishes', () => {
    capture(fakeRequest());
    expect(requestStore.get()).toBeUndefined();
  });
});
