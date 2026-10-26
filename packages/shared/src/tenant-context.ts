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
  /**
   * The **person** this request acts as: a user id for `user`, `platform` and `api_key` actors,
   * and undefined for `system`/`automation`.
   *
   * For a key that is the member who created it, which is what makes `created_by_id`,
   * `changed_by_id`, `assigned_by_id` and every other person-reference in this product correct
   * without a single writer having to know a key was involved. It was the key's own id for one
   * afternoon, and three leads were written claiming to have been created by a member who does not
   * exist — no foreign key catches it, because these columns reference a `Membership` by
   * convention in some tables and not at all in others.
   */
  readonly actorId?: string;
  /** Which credential, when the actor is an `api_key`. Provenance, never authority. */
  readonly apiKeyId?: string;
  readonly permissions: ReadonlySet<string>;
  /** Widest data scope granted across the actor's roles, per permission. */
  readonly scopes: ReadonlyMap<string, DataScope>;
  readonly teamIds: readonly string[];
  readonly branchIds: readonly string[];
  readonly requestId: string;
  /** Present only while platform staff are impersonating a tenant user (FR-TEN-7). */
  readonly impersonation?: { readonly platformUserId: string; readonly sessionId: string };
  /**
   * Present only while an automation step is running (`FR-AUT-6`).
   *
   * It is on the principal rather than passed down through every service because loop detection
   * has to catch **every** event a step causes, however deep: an action calls `LeadsService`,
   * which emits `lead.status_changed` through its own `OutboxService.emit`, which would otherwise
   * emit at depth zero and let the workflow trigger itself for ever. `emit` reads the depth from
   * here, so a service that has never heard of automation still produces a correctly attributed
   * event — the same reason `actorType` lives here.
   */
  readonly automation?: {
    readonly runId: string;
    readonly workflowId: string;
    /** How many automation-caused events deep this run already is. */
    readonly causationDepth: number;
  };
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

/**
 * The principal an automation step runs as.
 *
 * `actorType: 'automation'` is what puts "a workflow did this" in the audit log, and `actorId` is
 * deliberately absent: a workflow is not a person, and a person-reference written from it would be
 * a claim about a member who did not do it. Every column that needs a person — a task's assignee, a
 * note's author — is written from the step's own parameters instead.
 */
export function automationPrincipal(
  organizationId: string,
  requestId: string,
  automation: { runId: string; workflowId: string; causationDepth: number },
  permissions: readonly string[] = [],
): TenantPrincipal {
  return {
    organizationId,
    actorType: 'automation',
    permissions: new Set(permissions),
    /**
     * Every permission at **organization** scope.
     *
     * `canAct` and `filterFor` default an absent entry to `own`, which compares the row against
     * `actorId` — and a workflow has none, so every write through a service answered "Lead not
     * found" and every read came back empty. The scope has to be the workspace's because that is
     * whose instruction a workflow is: it is not acting for a person, and narrowing it to one
     * would mean a workflow could only touch the leads of a member it does not have.
     *
     * What keeps that safe is the **permission set**, which the engine enumerates rather than
     * granting wholesale — so adding an action is a moment where somebody decides what it may do.
     */
    scopes: new Map(permissions.map((permission) => [permission, 'organization' as const])),
    teamIds: [],
    branchIds: [],
    requestId,
    automation,
  };
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
