import 'reflect-metadata';
import { resolve } from 'node:path';
import { config as loadDotenv } from 'dotenv';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Logger } from 'pino';
import { AppModule } from './app.module.js';
import { APP_CONFIG } from './infra/config/config.module.js';
import type { AppConfig } from './infra/config/config.schema.js';
import { LOGGER } from './infra/observability/logger.module.js';
import { PinoLoggerService } from './infra/observability/logger.js';
import { EnvelopeInterceptor } from './infra/http/envelope.interceptor.js';
import { AppExceptionFilter } from './infra/http/app-exception.filter.js';
import { OutboxDispatcherService } from './infra/outbox/outbox-dispatcher.service.js';
import { WorkerService } from './infra/queue/worker.service.js';
import { resolveProcessors } from './infra/queue/processor.registry.js';
import { SchedulerService } from './infra/queue/scheduler.service.js';

loadDotenv({ path: resolve(import.meta.dirname, '../../../.env'), quiet: true });

/**
 * One image, several roles (docs/system-architecture.md §2). `ROLE` selects which:
 *
 *   api        HTTP + realtime
 *   collector  webhooks and tracking beacons only (Phase 4; currently identical to api)
 *   worker     queue consumers **and** the outbox dispatcher
 *   scheduler  registers repeatable jobs and heartbeats
 *
 * Splitting them means a WhatsApp backlog cannot slow the dashboard, and the ingestion tier can
 * be scaled on its own.
 */
async function bootstrap(): Promise<void> {
  const role = process.env['ROLE'] ?? 'api';
  if (role === 'worker' || role === 'scheduler') {
    await bootstrapBackgroundProcess(role);
    return;
  }
  await bootstrapHttp();
}

async function bootstrapHttp(): Promise<void> {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({
      // Request ids come from our own middleware so they are consistent across processes and
      // appear in logs, responses, audit rows and traces alike.
      genReqId: () => '',
      bodyLimit: 256 * 1024,
      trustProxy: true,
    }),
    { bufferLogs: true },
  );

  const config = app.get<AppConfig>(APP_CONFIG);
  const logger = app.get<Logger>(LOGGER);

  // /api/v1/* for the product API; /health/* stays unversioned so orchestrator and load
  // balancer probes never move (docs/api-architecture.md §1).
  app.setGlobalPrefix('api/v1', { exclude: ['health/live', 'health/ready', 'health/deep'] });

  app.useLogger(new PinoLoggerService(logger));
  app.useGlobalInterceptors(new EnvelopeInterceptor());
  app.useGlobalFilters(new AppExceptionFilter(logger));
  app.enableShutdownHooks();

  app.enableCors({ origin: [config.WEB_ORIGIN], credentials: true, maxAge: 600 });

  await app.listen({ port: config.PORT, host: '0.0.0.0' });
  logger.info({ role: config.ROLE, port: config.PORT, env: config.NODE_ENV }, 'api listening');
}

/**
 * Workers and the scheduler need the application's wiring but not an HTTP server, so they run as
 * an application context. No port is opened, which also means nothing can accidentally route
 * traffic to a worker.
 */
async function bootstrapBackgroundProcess(role: 'worker' | 'scheduler'): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, { bufferLogs: true });
  const logger = app.get<Logger>(LOGGER);
  app.useLogger(new PinoLoggerService(logger));
  app.enableShutdownHooks();

  if (role === 'worker') {
    // QUEUES=notifications,maintenance restricts this process to a subset, so a busy queue can be
    // given its own deployment.
    const only = process.env['QUEUES']
      ?.split(',')
      .map((name) => name.trim())
      .filter((name) => name.length > 0);
    app.get(WorkerService).start(resolveProcessors(app), only as never);

    // The dispatcher lives with the workers: it is the component that turns committed events into
    // queued jobs (ADR-0006).
    await app.get(OutboxDispatcherService).start();
    logger.info({ role, queues: only ?? 'all' }, 'worker process started');
  } else {
    await app.get(SchedulerService).start();
    logger.info({ role }, 'scheduler process started');
  }
}

bootstrap().catch((error: unknown) => {
  // Configuration and wiring failures must be loud and fatal: a process that starts with half its
  // dependencies is worse than one that refuses to start.
  console.error('failed to start:', error);
  process.exit(1);
});
