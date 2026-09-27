import { Module, type MiddlewareConsumer, type NestModule } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigModule } from './infra/config/config.module.js';
import { DbModule } from './infra/db/db.module.js';
import { RedisModule } from './infra/redis/redis.module.js';
import { CryptoModule } from './infra/crypto/crypto.module.js';
import { MailModule } from './infra/mail/mail.module.js';
import { AuditModule } from './infra/audit/audit.module.js';
import { OutboxModule } from './infra/outbox/outbox.module.js';
import { LoggerModule } from './infra/observability/logger.module.js';
import { RequestContextMiddleware } from './infra/http/request-context.middleware.js';
import { AuthModule } from './modules/auth/auth.module.js';
import { AuthGuard } from './modules/auth/guards/auth.guard.js';
import { OrganizationsModule } from './modules/organizations/organizations.module.js';
import { HealthModule } from './modules/health/health.module.js';

/**
 * Composition root. Domain modules are added here as each phase lands; the infrastructure
 * modules are global, so no domain module wires up its own database client, cache, logger
 * or configuration (docs/system-architecture.md §5).
 */
@Module({
  imports: [
    ConfigModule,
    LoggerModule,
    DbModule,
    RedisModule,
    CryptoModule,
    MailModule,
    AuditModule,
    OutboxModule,
    AuthModule,
    OrganizationsModule,
    HealthModule,
  ],
  providers: [
    // Authentication is deny-by-default: registering the guard globally means a new
    // controller is protected the moment it exists, and opting out requires an explicit
    // @Public() that shows up in review (docs/security.md §4).
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestContextMiddleware).forRoutes('*path');
  }
}
