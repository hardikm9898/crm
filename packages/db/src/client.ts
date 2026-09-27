import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client.js';
import { tenantScopeExtension, type TenantScopeOptions } from './tenant-scope.js';

/**
 * Prisma 7 connects through a driver adapter rather than a URL in the schema, which
 * means the pg pool is ours to size per process class: the API needs more connections
 * than a worker (docs/deployment-architecture.md §6).
 */
export interface DbClientOptions extends TenantScopeOptions {
  readonly connectionString: string;
  readonly poolMax?: number;
  readonly statementTimeoutMs?: number;
  readonly log?: boolean;
}

export type UnscopedDbClient = PrismaClient;
export type DbClient = ReturnType<typeof createDbClient>;

/**
 * The tenant-scoped client. This is what application code gets.
 * Every tenant model is filtered by the active tenant context; see src/tenant-scope.ts.
 */
export function createDbClient(options: DbClientOptions) {
  return createUnscopedDbClient(options).$extends(tenantScopeExtension(options));
}

/**
 * The raw, unscoped client. Two legitimate uses only:
 *   1. migrations/seeding, where there is no request and no tenant;
 *   2. tests that must prove isolation holds even when the extension is bypassed.
 * Application code uses `createDbClient`, and lint forbids importing Prisma directly.
 */
export function createUnscopedDbClient(options: DbClientOptions): PrismaClient {
  const adapter = new PrismaPg({
    connectionString: options.connectionString,
    max: options.poolMax ?? 10,
    statement_timeout: options.statementTimeoutMs ?? 15_000,
  });

  return new PrismaClient({
    adapter,
    log: options.log ? ['warn', 'error'] : ['error'],
  });
}
