import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Logger } from 'pino';
import {
  createUnscopedDbClient,
  seedPlatformCatalogue,
  withAuditPurge,
  type UnscopedDbClient,
} from '@leados/db';
import { AppModule } from '../src/app.module.js';
import { LOGGER } from '../src/infra/observability/logger.module.js';
import { RedisService } from '../src/infra/redis/redis.service.js';
import { EnvelopeInterceptor } from '../src/infra/http/envelope.interceptor.js';
import { allowEmptyJsonBody } from '../src/infra/http/empty-json-body.js';
import { installValidationCopy } from '../src/infra/http/validation-copy.js';
import { AppExceptionFilter } from '../src/infra/http/app-exception.filter.js';

/**
 * Boots the real application for end-to-end tests: real Nest wiring, real Fastify, real
 * PostgreSQL, real Redis. No mocks — the point of these tests is to prove the assembled
 * system behaves, which is also what catches dependency-injection regressions.
 */
export interface TestApp {
  app: NestFastifyApplication;
  db: UnscopedDbClient;
  close: () => Promise<void>;
}

export async function bootTestApp(): Promise<TestApp> {
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter(), {
    logger: false,
    // Nest otherwise calls process.abort() on a wiring error, killing the worker and
    // hiding the cause.
    abortOnError: false,
  });

  const logger = app.get<Logger>(LOGGER);
  app.setGlobalPrefix('api/v1', { exclude: ['health/live', 'health/ready', 'health/deep'] });
  installValidationCopy();
  allowEmptyJsonBody(app, 256 * 1024);
  app.useGlobalInterceptors(new EnvelopeInterceptor());
  app.useGlobalFilters(new AppExceptionFilter(logger));
  await app.init();
  await app.getHttpAdapter().getInstance().ready();

  const db = createUnscopedDbClient({
    connectionString: process.env['DATABASE_URL']!,
    poolMax: 5,
  });

  // Reference data, not fixtures: without the permission catalogue and a plan, creating an
  // organization is impossible (role_permissions references permissions). Idempotent, so
  // the suite is self-sufficient on a freshly migrated database.
  await seedPlatformCatalogue(db);

  // Rate-limit counters outlive a test run by design (15-minute windows), so clear the
  // ones this suite owns. Safe because tests run against their own Redis database.
  await clearAuthThrottles(app);

  return {
    app,
    db,
    close: async () => {
      await db.$disconnect();
      await app.close();
    },
  };
}

/**
 * Clears sign-in throttle counters. Deliberately surgical rather than flushing the
 * database, so a mistakenly shared Redis URL cannot wipe development state.
 */
async function clearAuthThrottles(app: NestFastifyApplication): Promise<void> {
  const redis = app.get(RedisService);
  const keys = await redis.client.keys('platform:auth:fail:*');
  if (keys.length > 0) await redis.del(...keys);
}

/** Removes everything a test created, respecting the append-only audit log. */
export async function cleanupUsers(db: UnscopedDbClient, emailPattern: string): Promise<void> {
  const users = await db.user.findMany({
    where: { email: { contains: emailPattern } },
    select: { id: true },
  });
  if (users.length === 0) return;
  const userIds = users.map((user) => user.id);

  const memberships = await db.membership.findMany({
    where: { userId: { in: userIds } },
    select: { organizationId: true },
  });
  const organizationIds = [...new Set(memberships.map((m) => m.organizationId))];

  if (organizationIds.length > 0) {
    await withAuditPurge(db, 'e2e test cleanup', async (tx) => {
      await tx.auditLog.deleteMany({ where: { organizationId: { in: organizationIds } } });
    });
    await db.organization.deleteMany({ where: { id: { in: organizationIds } } });
  }
  await db.user.deleteMany({ where: { id: { in: userIds } } });
}

export interface JsonResponse<T = Record<string, unknown>> {
  statusCode: number;
  body: T;
  headers: Record<string, string | string[] | undefined>;
}

/** Thin request helper so the tests read as HTTP conversations. */
export async function call<T = Record<string, unknown>>(
  app: NestFastifyApplication,
  options: {
    method: 'GET' | 'POST' | 'DELETE' | 'PATCH' | 'PUT';
    url: string;
    payload?: unknown;
    token?: string;
    headers?: Record<string, string>;
    /** Presented as x-forwarded-for, so IP-based throttling can be tested in isolation. */
    ip?: string;
  },
): Promise<JsonResponse<T>> {
  const response = await app.inject({
    method: options.method,
    url: options.url,
    ...(options.payload === undefined ? {} : { payload: options.payload as object }),
    headers: {
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      ...(options.ip ? { 'x-forwarded-for': options.ip } : {}),
      ...options.headers,
    },
  });
  return {
    statusCode: response.statusCode,
    body: response.json<T>(),
    headers: response.headers as Record<string, string | string[] | undefined>,
  };
}

export interface EnvelopeBody<T> {
  success: boolean;
  data: T;
  message?: string;
  error?: { code: string; message: string; details?: unknown };
}
