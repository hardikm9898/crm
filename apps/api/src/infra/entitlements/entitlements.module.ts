import { Global, Module } from '@nestjs/common';
import { EntitlementGuard } from './entitlement.guard.js';
import { EntitlementService } from './entitlement.service.js';
import { SubscriptionGuard } from './subscription.guard.js';
import { UsageService } from './usage.service.js';

@Global()
@Module({
  providers: [EntitlementService, UsageService, EntitlementGuard, SubscriptionGuard],
  exports: [EntitlementService, UsageService, EntitlementGuard, SubscriptionGuard],
})
export class EntitlementsModule {}
