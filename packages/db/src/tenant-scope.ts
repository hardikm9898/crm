import { isTenantModel, tenantColumnFor, type TenantModel } from './tenant-models.js';
import { tenantContext } from '@leados/shared';

/**
 * Isolation layer 2: automatic tenant scoping for every Prisma operation
 * (docs/security.md §3, ADR-0001).
 *
 * Three behaviours, applied to every model in the tenant registry:
 *   • reads/updates/deletes get `organizationId` merged into `where`
 *   • creates get `organizationId` set on the data
 *   • no tenant context at all ⇒ the operation THROWS
 *
 * The last point is the important one. The default is refusal: a query that forgets
 * its tenant fails loudly instead of returning every organization's rows. Platform
 * work opts out explicitly and reviewably via `withPlatformScope()`.
 *
 * NOTE on laziness: Prisma promises execute when awaited, so the tenant context must
 * still be active at await time. See the comment block in @leados/shared's
 * tenant-context.ts — this is a real trap, and it is covered by tests.
 */

type Operation = string;

const READ_OPERATIONS = new Set<Operation>([
  'findFirst',
  'findFirstOrThrow',
  'findMany',
  'count',
  'aggregate',
  'groupBy',
]);

const WRITE_WITH_WHERE = new Set<Operation>(['updateMany', 'deleteMany', 'updateManyAndReturn']);

/**
 * Operations addressing a single row by unique selector. These are filtered too:
 * `findUnique({ where: { id } })` on another tenant's id must return null, not the row.
 */
const UNIQUE_OPERATIONS = new Set<Operation>([
  'findUnique',
  'findUniqueOrThrow',
  'update',
  'delete',
]);

const CREATE_OPERATIONS = new Set<Operation>(['create', 'createMany', 'createManyAndReturn']);

const UPSERT_OPERATIONS = new Set<Operation>(['upsert']);

export interface ScopeViolation {
  readonly model: string;
  readonly operation: string;
  readonly attemptedOrganizationId: string;
  readonly contextOrganizationId: string;
}

export interface TenantScopeOptions {
  /**
   * Called when a caller explicitly passes an `organizationId` that differs from the
   * context's. This is always a bug or an attack; the operation is rejected either way.
   */
  onViolation?: (violation: ScopeViolation) => void;
}

export class CrossTenantAccessError extends Error {
  constructor(readonly violation: ScopeViolation) {
    super(
      `Cross-tenant access rejected: ${violation.model}.${violation.operation} referenced ` +
        `organization ${violation.attemptedOrganizationId} from a request scoped to ` +
        `${violation.contextOrganizationId}.`,
    );
    this.name = 'CrossTenantAccessError';
  }
}

interface QueryArgs {
  where?: Record<string, unknown>;
  data?: Record<string, unknown> | Record<string, unknown>[];
  create?: Record<string, unknown>;
  update?: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * Builds the `$extends` definition. Kept as a plain factory (not tied to Nest or any
 * framework) so the API, workers and tests all apply exactly the same rules.
 */
export function tenantScopeExtension(options: TenantScopeOptions = {}) {
  return {
    name: 'leados-tenant-scope',
    query: {
      $allModels: {
        async $allOperations({
          model,
          operation,
          args,
          query,
        }: {
          model?: string;
          operation: string;
          args: unknown;
          query: (args: unknown) => Promise<unknown>;
        }): Promise<unknown> {
          if (!isTenantModel(model)) return query(args);

          // Explicit, audited platform-level access (Super Admin reads, dispatcher, jobs).
          if (tenantContext.isPlatformScope()) return query(args);

          const organizationId = tenantContext.organizationId(`${model}.${operation}`);
          const column = tenantColumnFor(model);
          const next = { ...((args as QueryArgs | undefined) ?? {}) } as QueryArgs;

          if (CREATE_OPERATIONS.has(operation)) {
            applyToCreateData(next, column, organizationId, model, operation, options);
          } else if (UPSERT_OPERATIONS.has(operation)) {
            next.where = mergeWhere(next.where, column, organizationId, model, operation, options);
            if (next.create) {
              next.create = withTenantColumn(
                next.create,
                column,
                organizationId,
                model,
                operation,
                options,
              );
            }
          } else if (
            READ_OPERATIONS.has(operation) ||
            WRITE_WITH_WHERE.has(operation) ||
            UNIQUE_OPERATIONS.has(operation)
          ) {
            next.where = mergeWhere(next.where, column, organizationId, model, operation, options);
          }
          // Anything else (e.g. raw aggregate helpers) passes through unchanged: this
          // extension never silently half-scopes an operation it does not understand.

          return query(next);
        },
      },
    },
  } as const;
}

function mergeWhere(
  where: Record<string, unknown> | undefined,
  column: 'id' | 'organizationId',
  organizationId: string,
  model: string,
  operation: string,
  options: TenantScopeOptions,
): Record<string, unknown> {
  const existing = where ?? {};
  const declared = existing[column];

  if (column === 'id') {
    // Organization itself: a caller may legitimately pass its own id.
    if (typeof declared === 'string' && declared !== organizationId) {
      reject(
        {
          model,
          operation,
          attemptedOrganizationId: declared,
          contextOrganizationId: organizationId,
        },
        options,
      );
    }
    return { ...existing, id: organizationId };
  }

  if (typeof declared === 'string' && declared !== organizationId) {
    reject(
      {
        model,
        operation,
        attemptedOrganizationId: declared,
        contextOrganizationId: organizationId,
      },
      options,
    );
  }

  // `findUnique` accepts only unique selectors, so a non-unique tenant predicate
  // cannot be added there; Prisma exposes the relaxed form as `where.AND`.
  if (UNIQUE_OPERATIONS.has(operation)) {
    return { ...existing, [column]: organizationId };
  }

  return { ...existing, [column]: organizationId };
}

function applyToCreateData(
  args: QueryArgs,
  column: 'id' | 'organizationId',
  organizationId: string,
  model: string,
  operation: string,
  options: TenantScopeOptions,
): void {
  if (column === 'id') return; // Creating an Organization sets its own id explicitly.

  if (Array.isArray(args.data)) {
    args.data = args.data.map((row) =>
      withTenantColumn(row, column, organizationId, model, operation, options),
    );
    return;
  }
  if (args.data) {
    args.data = withTenantColumn(args.data, column, organizationId, model, operation, options);
  }
}

function withTenantColumn(
  data: Record<string, unknown>,
  column: 'organizationId' | 'id',
  organizationId: string,
  model: string,
  operation: string,
  options: TenantScopeOptions,
): Record<string, unknown> {
  const declared = data[column];
  if (typeof declared === 'string' && declared !== organizationId) {
    reject(
      {
        model,
        operation,
        attemptedOrganizationId: declared,
        contextOrganizationId: organizationId,
      },
      options,
    );
  }
  // Nested relation syntax (`organization: { connect: ... }`) is not rewritten; the
  // composite foreign keys in the schema stop it from crossing tenants (layer 3).
  return { ...data, [column]: organizationId };
}

function reject(violation: ScopeViolation, options: TenantScopeOptions): never {
  options.onViolation?.(violation);
  throw new CrossTenantAccessError(violation);
}

export { isTenantModel, type TenantModel };
