import { Module, type MiddlewareConsumer, type NestModule } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigModule } from './infra/config/config.module.js';
import { DbModule } from './infra/db/db.module.js';
import { RedisModule } from './infra/redis/redis.module.js';
import { CryptoModule } from './infra/crypto/crypto.module.js';
import { MailModule } from './infra/mail/mail.module.js';
import { AuditModule } from './infra/audit/audit.module.js';
import { OutboxModule } from './infra/outbox/outbox.module.js';
import { TimelineModule } from './infra/timeline/timeline.module.js';
import { QueueModule } from './infra/queue/queue.module.js';
import { MaintenanceModule } from './modules/maintenance/maintenance.module.js';
import { LoggerModule } from './infra/observability/logger.module.js';
import { RequestContextMiddleware } from './infra/http/request-context.middleware.js';
import { AuthzModule } from './infra/authz/authz.module.js';
import { PermissionGuard } from './infra/authz/permission.guard.js';
import { EntitlementsModule } from './infra/entitlements/entitlements.module.js';
import { EntitlementGuard } from './infra/entitlements/entitlement.guard.js';
import { SubscriptionGuard } from './infra/entitlements/subscription.guard.js';
import { AuthModule } from './modules/auth/auth.module.js';
import { UsersModule } from './modules/users/users.module.js';
import { IamModule } from './modules/iam/iam.module.js';
import { NotificationsModule } from './modules/notifications/notifications.module.js';
import { AuthGuard } from './modules/auth/guards/auth.guard.js';
import { OrganizationsModule } from './modules/organizations/organizations.module.js';
import { CustomFieldsModule } from './modules/custom-fields/custom-fields.module.js';
import { CrmConfigModule } from './modules/crm-config/crm-config.module.js';
import { DuplicatesModule } from './modules/duplicates/duplicates.module.js';
import { AssignmentModule } from './modules/assignment/assignment.module.js';
import { LeadsModule } from './modules/leads/leads.module.js';
import { ScoringModule } from './modules/scoring/scoring.module.js';
import { ViewsModule } from './modules/views/views.module.js';
import { CustomersModule } from './modules/customers/customers.module.js';
import { DealsModule } from './modules/deals/deals.module.js';
import { DocumentsModule } from './modules/documents/documents.module.js';
import { QuotationsModule } from './modules/quotations/quotations.module.js';
import { ExportsModule } from './modules/exports/exports.module.js';
import { ImportsModule } from './modules/imports/imports.module.js';
import { StorageModule } from './infra/storage/storage.module.js';
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
    StorageModule,
    AuditModule,
    OutboxModule,
    TimelineModule,
    QueueModule,
    AuthzModule,
    EntitlementsModule,
    AuthModule,
    OrganizationsModule,
    UsersModule,
    IamModule,
    NotificationsModule,
    // Phase 2 — CRM core
    CustomFieldsModule,
    CrmConfigModule,
    DuplicatesModule,
    AssignmentModule,
    ScoringModule,
    ViewsModule,
    LeadsModule,
    CustomersModule,
    DealsModule,
    QuotationsModule,
    DocumentsModule,
    ImportsModule,
    ExportsModule,
    MaintenanceModule,
    HealthModule,
  ],
  providers: [
    // Global guards, in order. Each is deny-by-default, and registering them globally means
    // a new controller is covered the moment it exists rather than when someone remembers
    // (docs/security.md §4, docs/system-architecture.md §7):
    //   1. who are you                     → AuthGuard (establishes the tenant context)
    //   2. may you do this, and how widely → PermissionGuard
    //   3. may this organization write     → SubscriptionGuard (restricted mode)
    //   4. does the plan include it        → EntitlementGuard
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: PermissionGuard },
    { provide: APP_GUARD, useClass: SubscriptionGuard },
    { provide: APP_GUARD, useClass: EntitlementGuard },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestContextMiddleware).forRoutes('*path');
  }
}
