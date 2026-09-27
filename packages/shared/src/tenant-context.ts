import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * The tenant context: isolation layer 1 (docs/security.md §3).
 *
 * Populated ONLY from a verified principal (JWT, API key, public key or a
 * webhook-resolved connection) — never from a header, query parameter or body,
 * so a request can never ask to be another tenant. Background jobs re-establish
 * the same context from their payload.
 *
 * ── Why AsyncLocalStorage and what to watch out for ─────────────────────────
 * Prisma promises are LAZY: the query (and therefore the tenant-scoping
 * extension) runs when the promise is awaited, not when it is created. So the
 * context must still be active at await time:
 *
 *     ✗ await tenantContext.run(ctx, () => db.lead.findMany())   // context gone
 *     ✓ await tenantContext.run(ctx, async () => db.lead.findMany())
 *
 * In the app this is a non-issue because the whole request/job is wrapped, but
 * the async-callback form is mandatory and `run()`'s type enforces it.
 */

export type DataScope = 'own' | 'team' | 'branch' | 'organization';

export type ActorType = 'user' | 'system' | 'automation' | 'api_key' | 'platform';

export interface TenantPrincipal {
  readonly organizationId: string;
  readonly actorType: ActorType;
  /** User id for `user`/`platform` actors; api key id for `api_key`; undefined for system/automation. */
  readonly actorId?: string;
  readonly permissions: ReadonlySet<string>;
  /** Widest data scope granted across the actor's roles, per permission. */
  readonly scopes: ReadonlyMap<string, DataScope>;
  readonly teamIds: readonly string[];
  readonly branchIds: readonly string[];
  readonly requestId: string;
  /** Present only while platform staff are impersonating a tenant user (FR-TEN-7). */
  readonly impersonation?: { readonly platformUserId: string; readonly sessionId: string };
}

export class TenantContextMissingError extends Error {
  constructor(operation: string) {
    super(
      `No tenant context for "${operation}". Every tenant-scoped operation must run inside ` +
        `tenantContext.run(...). If this is deliberate platform work, use withPlatformScope().`,
    );
    this.name = 'TenantContextMissingError';
  }
}

interface Store {
  principal: TenantPrincipal | null;
  /** Explicit, audited escape hatch for platform-level work. */
  platformScope: boolean;
}

const storage = new AsyncLocalStorage<Store>();

export const tenantContext = {
  /**
   * Runs `fn` with `principal` as the active tenant context.
   * `fn` must be async so that lazily-evaluated promises resolve inside the scope.
   */
  run<T>(principal: TenantPrincipal, fn: () => Promise<T>): Promise<T> {
    return storage.run({ principal, platformScope: false }, fn);
  },

  /**
   * Opens an empty context for a unit of work whose principal is not known yet — a request
   * that has not been authenticated at the point the scope must begin.
   *
   * Used by the HTTP middleware, which runs before the authentication guard. The guard then
   * fills it in with `setPrincipal`.
   */
  runEmpty<T>(fn: () => Promise<T>): Promise<T> {
    return storage.run({ principal: null, platformScope: false }, fn);
  },

  /**
   * Populates the context opened by `runEmpty`.
   *
   * Why this exists instead of the more obvious `enterWith`: a Nest guard is *awaited* by
   * the framework, and `AsyncLocalStorage.enterWith` only affects the async resource it is
   * called on. The continuation that runs the route handler belongs to the caller's
   * resource, so a principal set with `enterWith` inside a guard is invisible to the
   * handler — silently, which is the worst possible failure mode for tenant scoping.
   *
   * Mutating the store object that `runEmpty` put in place works because every async
   * resource in the request shares that one object by reference.
   *
   * @throws when no context is open — better to fail the request than to run unscoped.
   */
  setPrincipal(principal: TenantPrincipal): void {
    const store = storage.getStore();
    if (!store) {
      throw new Error(
        'setPrincipal requires an open tenant context. Wrap the request in tenantContext.runEmpty().',
      );
    }
    store.principal = principal;
  },

  /** Current principal, or null outside any context. */
  get(): TenantPrincipal | null {
    return storage.getStore()?.principal ?? null;
  },

  /** Current principal, throwing when absent. Used by the scoped data layer. */
  require(operation: string): TenantPrincipal {
    const principal = storage.getStore()?.principal;
    if (!principal) throw new TenantContextMissingError(operation);
    return principal;
  },

  organizationId(operation: string): string {
    return tenantContext.require(operation).organizationId;
  },

  isPlatformScope(): boolean {
    return storage.getStore()?.platformScope === true;
  },

  has(permission: string): boolean {
    return storage.getStore()?.principal?.permissions.has(permission) ?? false;
  },

  scopeFor(permission: string): DataScope | null {
    return storage.getStore()?.principal?.scopes.get(permission) ?? null;
  },
};

/**
 * Deliberately bypasses tenant scoping for platform-level work (Super Admin reads,
 * cross-tenant maintenance jobs, the outbox dispatcher). Greppable by design: every
 * call site is reviewable, and callers are expected to audit-log the reason.
 */
export function withPlatformScope<T>(reason: string, fn: () => Promise<T>): Promise<T> {
  if (reason.trim().length === 0) throw new Error('withPlatformScope requires a reason');
  const current = storage.getStore();
  return storage.run({ principal: current?.principal ?? null, platformScope: true }, fn);
}

/** Convenience for jobs and tests: a system principal with no user behind it. */
export function systemPrincipal(
  organizationId: string,
  requestId: string,
  permissions: readonly string[] = [],
): TenantPrincipal {
  return {
    organizationId,
    actorType: 'system',
    permissions: new Set(permissions),
    scopes: new Map(),
    teamIds: [],
    branchIds: [],
    requestId,
  };
}
