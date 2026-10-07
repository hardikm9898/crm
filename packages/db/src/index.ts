export { createDbClient, createUnscopedDbClient } from './client.js';
export type { DbClient, DbClientOptions, DbTransactionClient, UnscopedDbClient } from './client.js';
export {
  CrossTenantAccessError,
  tenantScopeExtension,
  isTenantModel,
  type ScopeViolation,
  type TenantModel,
  type TenantScopeOptions,
} from './tenant-scope.js';
export { PLATFORM_MODELS, TENANT_MODELS, tenantColumnFor } from './tenant-models.js';
export { assertTenantRegistryComplete } from './registry-check.js';
export { withAuditPurge } from './audit-purge.js';
export {
  DEFAULT_PLAN_SETTING_KEY,
  FEATURE_SEEDS,
  PLAN_SEEDS,
  seedPlatformCatalogue,
} from './seeding/platform-catalogue.js';
export {
  CRM_DEFAULT_SEEDS,
  seedCrmDefaults,
  seedDealPipeline,
  seedPaymentMethods,
  seedTaskConfig,
  seedSlaPolicy,
  seedWorkingHours,
  seedDefaultAssignmentRule,
  seedDefaultTags,
  SCORING_DEFAULT_SEEDS,
  seedScoringAndViews,
  type CrmDefaultsResult,
  type ScoringDefaultsResult,
} from './seeding/crm-defaults.js';
export {
  applyIndustryTemplate,
  seedIndustryTemplates,
  type AppliedTemplate,
} from './seeding/industry-templates.js';

// Model types and enums, so application modules never import @prisma/client directly.
export * from '../generated/prisma/models.js';
export * from '../generated/prisma/enums.js';
export { Prisma } from '../generated/prisma/client.js';
