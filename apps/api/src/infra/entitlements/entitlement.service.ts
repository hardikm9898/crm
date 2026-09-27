import { Injectable } from '@nestjs/common';
import { AppError, tenantContext, withPlatformScope } from '@leados/shared';
import { DbService } from '../db/db.service.js';
import { RedisService } from '../redis/redis.service.js';

/**
 * Resolves what an organization is entitled to: plan features, plus per-organization
 * overrides (FR-BIL-2, FR-BIL-4).
 *
 * Two rules from docs/README.md shape this:
 *  • **Rule 7 — no hardcoded plans.** Limits are rows. Nothing in application code knows
 *    that "starter allows 3 users"; it asks.
 *  • **Rule 4 — no hardcoded tenant behaviour.** Sales will promise exceptions, so overrides
 *    are first-class data with a reason and an expiry, not an `if` on an organization id.
 *
 * An organization with no subscription (a fresh deployment with no plans configured) is
 * treated as unrestricted rather than locked out: refusing to work because billing is not set
 * up would be a worse failure than allowing it.
 */
const CACHE_TTL_SECONDS = 300;

export interface Entitlement {
  readonly featureKey: string;
  readonly isEnabled: boolean;
  /** `null` means unlimited. */
  readonly limit: number | null;
  readonly source: 'plan' | 'override' | 'unrestricted';
}

interface CachedEntitlements {
  readonly entries: [
    string,
    { isEnabled: boolean; limit: number | null; source: Entitlement['source'] },
  ][];
}

@Injectable()
export class EntitlementService {
  constructor(
    private readonly db: DbService,
    private readonly redis: RedisService,
  ) {}

  async get(featureKey: string, organizationId?: string): Promise<Entitlement> {
    const orgId = organizationId ?? tenantContext.organizationId(`entitlement:${featureKey}`);
    const all = await this.all(orgId);
    return (
      all.get(featureKey) ?? {
        featureKey,
        // An unknown feature key is not a licence to proceed: it means the catalogue and the
        // code disagree, which is a deployment error.
        isEnabled: false,
        limit: 0,
        source: 'plan',
      }
    );
  }

  async isEnabled(featureKey: string, organizationId?: string): Promise<boolean> {
    return (await this.get(featureKey, organizationId)).isEnabled;
  }

  /** @throws `FEATURE_NOT_IN_PLAN` with the feature named, so the UI can offer an upgrade. */
  async assertEnabled(featureKey: string, organizationId?: string): Promise<void> {
    const entitlement = await this.get(featureKey, organizationId);
    if (!entitlement.isEnabled) {
      throw new AppError(
        'FEATURE_NOT_IN_PLAN',
        'This feature is not included in your current plan',
        403,
        { feature: featureKey },
      );
    }
  }

  /**
   * Checks a countable limit before an action that would add `increment` more.
   *
   * @param currentUsage Counted by the caller, because "how many users are there" is a
   *                     domain question the entitlement layer should not answer.
   * @throws `LIMIT_EXCEEDED` carrying limit and usage — a plan condition (403), deliberately
   *         distinct from a burst rate limit (429).
   */
  async assertWithinLimit(
    featureKey: string,
    currentUsage: number,
    increment = 1,
    organizationId?: string,
  ): Promise<void> {
    const entitlement = await this.get(featureKey, organizationId);
    if (!entitlement.isEnabled) {
      throw new AppError(
        'FEATURE_NOT_IN_PLAN',
        'This feature is not included in your current plan',
        403,
        {
          feature: featureKey,
        },
      );
    }
    if (entitlement.limit === null) return; // unlimited
    if (currentUsage + increment > entitlement.limit) {
      throw AppError.limitExceeded(featureKey, entitlement.limit, currentUsage);
    }
  }

  async all(organizationId: string): Promise<Map<string, Entitlement>> {
    const cacheKey = this.redis.key(organizationId, 'entitlements');
    const cached = await this.redis.getJson<CachedEntitlements>(cacheKey);
    if (cached) {
      return new Map(
        cached.entries.map(([featureKey, value]) => [featureKey, { featureKey, ...value }]),
      );
    }

    const resolved = await this.load(organizationId);
    await this.redis.setJson(
      cacheKey,
      {
        entries: [...resolved.entries()].map(([featureKey, value]) => [
          featureKey,
          { isEnabled: value.isEnabled, limit: value.limit, source: value.source },
        ]),
      } satisfies CachedEntitlements,
      CACHE_TTL_SECONDS,
    );
    return resolved;
  }

  /** Called on plan change, override change, or subscription transition. */
  async invalidate(organizationId: string): Promise<void> {
    await this.redis.del(this.redis.key(organizationId, 'entitlements'));
  }

  private async load(organizationId: string): Promise<Map<string, Entitlement>> {
    return withPlatformScope('entitlements: resolve plan and overrides', async () => {
      const [subscription, overrides, features] = await Promise.all([
        this.db.client.subscription.findUnique({
          where: { organizationId },
          include: { plan: { include: { features: true } } },
        }),
        this.db.client.entitlementOverride.findMany({ where: { organizationId } }),
        this.db.client.feature.findMany(),
      ]);

      const resolved = new Map<string, Entitlement>();

      if (!subscription) {
        // No billing configured: do not block the product. Unrestricted is explicit and
        // visible in the `source` field rather than being an accidental effect.
        for (const feature of features) {
          resolved.set(feature.key, {
            featureKey: feature.key,
            isEnabled: true,
            limit: null,
            source: 'unrestricted',
          });
        }
      } else {
        for (const planFeature of subscription.plan.features) {
          resolved.set(planFeature.featureKey, {
            featureKey: planFeature.featureKey,
            isEnabled: planFeature.isEnabled,
            limit: planFeature.limitValue === null ? null : Number(planFeature.limitValue),
            source: 'plan',
          });
        }
      }

      const now = Date.now();
      for (const override of overrides) {
        if (override.expiresAt !== null && override.expiresAt.getTime() <= now) continue;
        const existing = resolved.get(override.featureKey);
        resolved.set(override.featureKey, {
          featureKey: override.featureKey,
          isEnabled: override.isEnabled ?? existing?.isEnabled ?? true,
          limit:
            override.limitValue === null
              ? // An override row with a null limit means "no limit", not "fall back to plan":
                // the admin set it deliberately.
                override.isEnabled === false
                ? (existing?.limit ?? null)
                : null
              : Number(override.limitValue),
          source: 'override',
        });
      }

      return resolved;
    });
  }
}
