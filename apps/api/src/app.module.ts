import { Module, type MiddlewareConsumer, type NestModule } from '@nestjs/common';
import { ConfigModule } from './infra/config/config.module.js';
import { DbModule } from './infra/db/db.module.js';
import { LoggerModule } from './infra/observability/logger.module.js';
import { RequestContextMiddleware } from './infra/http/request-context.middleware.js';
import { HealthModule } from './modules/health/health.module.js';

/**
 * Domain modules are added here as each phase lands. The infrastructure modules below
 * are global, so no domain module ever wires up its own database client, logger or
 * configuration (docs/system-architecture.md §5).
 */
@Module({
  imports: [ConfigModule, LoggerModule, DbModule, HealthModule],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestContextMiddleware).forRoutes('*path');
  }
}
