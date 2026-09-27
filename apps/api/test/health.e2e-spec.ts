import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from '../src/app.module.js';
import { LOGGER } from '../src/infra/observability/logger.module.js';
import { EnvelopeInterceptor } from '../src/infra/http/envelope.interceptor.js';
import { AppExceptionFilter } from '../src/infra/http/app-exception.filter.js';
import type { Logger } from 'pino';

/**
 * End-to-end checks for the API contract every later endpoint inherits: the response
 * envelope, the error shape, request-id propagation and the health probes
 * (docs/api-architecture.md §2).
 */

let app: NestFastifyApplication;

beforeAll(async () => {
  app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter(), {
    logger: false,
    // Without this Nest calls process.abort() on a wiring error, which kills the test
    // worker and hides the actual cause.
    abortOnError: false,
  });
  const logger = app.get<Logger>(LOGGER);
  app.useGlobalInterceptors(new EnvelopeInterceptor());
  app.useGlobalFilters(new AppExceptionFilter(logger));
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
}, 60_000);

afterAll(async () => {
  await app?.close();
});

function inject(options: { method: 'GET'; url: string; headers?: Record<string, string> }) {
  return app.inject(options);
}

describe('GET /health/live', () => {
  it('reports the process is up without touching dependencies', async () => {
    const response = await inject({ method: 'GET', url: '/health/live' });
    expect(response.statusCode).toBe(200);

    const body = response.json<{ status: string; role: string; uptimeSeconds: number }>();
    // Deliberately NOT enveloped: load balancers read the status code and a flat body.
    expect(body.status).toBe('ok');
    expect(body.role).toBe('api');
    expect(body).not.toHaveProperty('success');
  });
});

describe('GET /health/ready', () => {
  it('reports every dependency it needs to serve traffic', async () => {
    const response = await inject({ method: 'GET', url: '/health/ready' });
    const body = response.json<{
      status: string;
      components: Record<string, { status: string; latencyMs?: number; detail?: string }>;
    }>();

    // Name the failing dependency on assertion failure: a bare "expected 503" is not debuggable.
    expect(response.statusCode, `body: ${JSON.stringify(body)}`).toBe(200);
    expect(body.status).toBe('up');
    expect(body.components.database?.status).toBe('up');
    expect(body.components.cache?.status).toBe('up');
  });
});

describe('GET /health/deep', () => {
  it('is enveloped and reports migrations and outbox lag', async () => {
    const response = await inject({ method: 'GET', url: '/health/deep' });
    expect(response.statusCode).toBe(200);

    const body = response.json<{
      success: boolean;
      data: {
        status: string;
        migrations: { applied: number; pending: string[] };
        outbox: { unpublished: number; oldestUnpublishedAgeSeconds: number | null };
      };
      meta: { requestId: string };
    }>();

    expect(body.success).toBe(true);
    expect(body.data.migrations.applied).toBeGreaterThan(0);
    expect(body.data.migrations.pending).toEqual([]);
    expect(body.data.outbox.unpublished).toBeTypeOf('number');
    expect(body.meta.requestId).toMatch(/^req_/);
  });

  it('reads platform-wide diagnostics without any tenant context', async () => {
    // This endpoint queries across tenants. It only works because it opts in via
    // withPlatformScope(); without that the scoped client would refuse.
    const response = await inject({ method: 'GET', url: '/health/deep' });
    expect(response.statusCode).toBe(200);
  });
});

describe('response envelope and errors', () => {
  it('returns the documented error shape for an unknown route', async () => {
    const response = await inject({ method: 'GET', url: '/does-not-exist' });
    expect(response.statusCode).toBe(404);

    const body = response.json<{
      success: boolean;
      error: { code: string; message: string; requestId: string };
    }>();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('NOT_FOUND');
    expect(body.error.requestId).toMatch(/^req_/);
    expect(body.error).not.toHaveProperty('stack');
  });

  it('honours an inbound x-request-id so a trace spans services', async () => {
    const response = await inject({
      method: 'GET',
      url: '/health/deep',
      headers: { 'x-request-id': 'req_from_edge_123' },
    });
    expect(response.headers['x-request-id']).toBe('req_from_edge_123');
    expect(response.json<{ meta: { requestId: string } }>().meta.requestId).toBe(
      'req_from_edge_123',
    );
  });

  it('generates a request id when the caller sends none', async () => {
    const response = await inject({ method: 'GET', url: '/health/deep' });
    expect(response.headers['x-request-id']).toMatch(/^req_/);
  });

  it('gives each request its own id', async () => {
    const [first, second] = await Promise.all([
      inject({ method: 'GET', url: '/health/deep' }),
      inject({ method: 'GET', url: '/health/deep' }),
    ]);
    expect(first.headers['x-request-id']).not.toBe(second.headers['x-request-id']);
  });
});
