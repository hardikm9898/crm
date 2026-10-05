import { Injectable } from '@nestjs/common';
import {
  AppError,
  widestScope,
  type DataScope,
  type TenantPrincipal,
  withPlatformScope,
} from '@leados/shared';
import { DbService } from '../../../infra/db/db.service.js';
import { RedisService } from '../../../infra/redis/redis.service.js';

/**
 * Turns a verified token into a `TenantPrincipal`: the object every authorization decision
 * and every scoped query depends on (docs/security.md §3 layer 1, §4).
 *
 * Permissions are resolved from the database rather than read from the token, so removing
 * a role takes effect on the next request instead of when the token expires. To keep that
 * affordable the result is cached in Redis under a **version-keyed** name; bumping the
 * organization's scope version invalidates every member's cached grants at once, which is
 * what a role change does.
 *
 * Where several roles grant the same permission, the widest data scope wins.
 */
const CACHE_TTL_SECONDS = 300;

interface CachedGrants {
  readonly permissions: string[];
  readonly scopes: [string, DataScope][];
  readonly teamIds: string[];
  readonly branchIds: string[];
}

@Injectable()
export class PrincipalService {
  constructor(
    private readonly db: DbService,
    private readonly redis: RedisService,
  ) {}

  /**
   * @throws `ORG_SUSPENDED` / `SUBSCRIPTION_INACTIVE` when the organization may not be used.
   *         Membership problems resolve to 404-style refusals, never "this org exists but
   *         you are not in it".
   */
  async build(input: {
    userId: string;
    organizationId: string;
    sessionId: string;
    requestId: string;
  }): Promise<TenantPrincipal> {
    const membership = await withPlatformScope('auth: resolve membership', async () =>
      this.db.client.membership.findUnique({
        where: {
          organizationId_userId: { organizationId: input.organizationId, userId: input.userId },
        },
        include: { organization: { select: { status: true, deletedAt: true } } },
      }),
    );

    if (
      !membership ||
      membership.deletedAt !== null ||
      membership.organization.deletedAt !== null
    ) {
      throw new AppError('FORBIDDEN', 'You do not have access to this organization', 403);
    }
    if (membership.status !== 'active') {
      throw new AppError('FORBIDDEN', 'Your access to this organization is not active', 403);
    }
    assertOrganizationUsable(membership.organization.status);

    const grants = await this.resolveGrants(input.organizationId, input.userId);

    return {
      organizationId: input.organizationId,
      actorType: 'user',
      actorId: input.userId,
      permissions: new Set(grants.permissions),
      scopes: new Map(grants.scopes),
      teamIds: grants.teamIds,
      branchIds: grants.branchIds,
      requestId: input.requestId,
    };
  }

  /** Called whenever roles, grants, team membership or branch assignment change. */
  async invalidateOrganization(organizationId: string): Promise<void> {
    await this.redis.client
      .incr(this.versionKey(organizationId))
      .catch(() => undefined /* cache outage degrades to a database read */);
  }

  private async resolveGrants(organizationId: string, userId: string): Promise<CachedGrants> {
    const version = await this.scopeVersion(organizationId);
    // Cache unavailable: read through to the database rather than trusting — or writing — an entry
    // under a version we could not establish.
    if (version === null) return this.loadGrants(organizationId, userId);

    const cacheKey = this.redis.key(organizationId, 'grants', `v${version}`, userId);
    const cached = await this.redis.getJson<CachedGrants>(cacheKey);
    if (cached) return cached;

    const fresh = await this.loadGrants(organizationId, userId);
    await this.redis.setJson(cacheKey, fresh, CACHE_TTL_SECONDS);
    return fresh;
  }

  private async loadGrants(organizationId: string, userId: string): Promise<CachedGrants> {
    return withPlatformScope('auth: load role grants', async () => {
      const [userRoles, teamMemberships, membership] = await Promise.all([
        this.db.client.userRole.findMany({
          where: { organizationId, userId },
          include: {
            role: {
              include: { permissions: { select: { permissionKey: true, scope: true } } },
            },
          },
        }),
        this.db.client.teamMember.findMany({
          where: { organizationId, userId },
          select: { teamId: true },
        }),
        this.db.client.membership.findUnique({
          where: { organizationId_userId: { organizationId, userId } },
          select: { defaultBranchId: true },
        }),
      ]);

      const scopes = new Map<string, DataScope>();
      for (const userRole of userRoles) {
        if (userRole.role.deletedAt !== null) continue;
        for (const grant of userRole.role.permissions) {
          const existing = scopes.get(grant.permissionKey);
          scopes.set(
            grant.permissionKey,
            existing ? widestScope(existing, grant.scope) : grant.scope,
          );
        }
      }

      return {
        permissions: [...scopes.keys()],
        scopes: [...scopes.entries()],
        teamIds: teamMemberships.map((team) => team.teamId),
        branchIds: membership?.defaultBranchId ? [membership.defaultBranchId] : [],
      };
    });
  }

  /**
   * The current grant-cache generation, or `null` when the cache cannot be reached.
   *
   * **The absent key is version 0, not 1.** `invalidateOrganization` invalidates by `INCR`, and
   * `INCR` on a missing key produces 1 — so with a default of 1 the *first* role change in a
   * workspace's life wrote the same version it was already caching under, and the stale grants
   * stayed live for the full five-minute TTL. Every later change worked, which is exactly what
   * makes it the kind of bug that reaches production: it only misfires once per workspace, on the
   * change somebody makes while setting the workspace up.
   */
  private async scopeVersion(organizationId: string): Promise<number | null> {
    try {
      const value = await this.redis.client.get(this.versionKey(organizationId));
      return value === null ? 0 : Number(value);
    } catch {
      return null;
    }
  }

  private versionKey(organizationId: string): string {
    return this.redis.key(organizationId, 'grants', 'version');
  }
}

/**
 * Organization lifecycle gate. Data is never destroyed on expiry — access is
 * restricted and the state is reported distinctly so the UI can show the right screen
 * (FR-TEN-6, FR-BIL-3).
 */
export function assertOrganizationUsable(status: string): void {
  switch (status) {
    case 'active':
    case 'trialing':
    case 'past_due': // still usable; dunning is in progress
    case 'grace':
      return;
    case 'suspended':
      throw new AppError('ORG_SUSPENDED', 'This organization has been suspended', 403);
    case 'cancelled':
      throw new AppError(
        'SUBSCRIPTION_INACTIVE',
        'This organization’s subscription has ended. Your data is retained — reactivate to continue.',
        403,
      );
    default:
      throw new AppError('FORBIDDEN', 'This organization is not available', 403);
  }
}
