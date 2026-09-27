import 'reflect-metadata';
import { resolve } from 'node:path';
import { config as loadDotenv } from 'dotenv';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from './app.module.js';
import { APP_CONFIG } from './infra/config/config.module.js';
import type { AppConfig } from './infra/config/config.schema.js';
import { LOGGER } from './infra/observability/logger.module.js';
import { PinoLoggerService } from './infra/observability/logger.js';
import type { Logger } from 'pino';
import { EnvelopeInterceptor } from './infra/http/envelope.interceptor.js';
import { AppExceptionFilter } from './infra/http/app-exception.filter.js';

loadDotenv({ path: resolve(import.meta.dirname, '../../../.env'), quiet: true });

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({
      // Request ids come from our own middleware so they are consistent across
      // processes and appear in logs, responses, audit rows and traces alike.
      genReqId: () => '',
      bodyLimit: 256 * 1024,
      trustProxy: true,
    }),
    { bufferLogs: true },
  );

  // /api/v1/* for the product API; /health/* stays unversioned so orchestrator and load
  // balancer probes never move (docs/api-architecture.md §1).
  app.setGlobalPrefix('api/v1', { exclude: ['health/live', 'health/ready', 'health/deep'] });

  const config = app.get<AppConfig>(APP_CONFIG);
  const logger = app.get<Logger>(LOGGER);

  app.useLogger(new PinoLoggerService(logger));
  app.useGlobalInterceptors(new EnvelopeInterceptor());
  app.useGlobalFilters(new AppExceptionFilter(logger));
  app.enableShutdownHooks();

  app.enableCors({
    origin: [config.WEB_ORIGIN],
    credentials: true,
    maxAge: 600,
  });

  await app.listen({ port: config.PORT, host: '0.0.0.0' });
  logger.info({ role: config.ROLE, port: config.PORT, env: config.NODE_ENV }, 'api listening');
}

bootstrap().catch((error: unknown) => {
  // Configuration and wiring failures must be loud and fatal: a process that starts
  // with half its dependencies is worse than one that refuses to start.
  console.error('failed to start:', error);
  process.exit(1);
});
