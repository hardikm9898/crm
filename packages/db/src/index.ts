export { createDbClient, createUnscopedDbClient } from './client.js';
export type { DbClient, DbClientOptions, UnscopedDbClient } from './client.js';
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

// Model types and enums, so application modules never import @prisma/client directly.
export * from '../generated/prisma/models.js';
export * from '../generated/prisma/enums.js';
export { Prisma } from '../generated/prisma/client.js';
