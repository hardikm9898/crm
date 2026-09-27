import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AppError, tenantContext, withPlatformScope } from '@leados/shared';
import type { FastifyRequest } from 'fastify';
import { SetMetadata } from '@nestjs/common';
import { DbService } from '../db/db.service.js';
import { RedisService } from '../redis/redis.service.js';

export const ALLOW_WHEN_RESTRICTED_KEY = 'leados:allowWhenRestricted';

/**
 * Marks a route that stays available when an organization is in restricted mode — billing,
 * and the read-only surfaces a customer needs in order to decide to pay or to export.
 */
export const AllowWhenRestricted = (): MethodDecorator & ClassDecorator =>
  SetMetadata(ALLOW_WHEN_RESTRICTED_KEY, true);

/**
 * Restricted mode after a trial or subscription lapses (FR-BIL-3).
 *
 * The product promise is explicit: **data is preserved, not deleted.** So an organization past
 * its grace period keeps read access and keeps its exports and billing pages, but cannot
 * create or change business data. That is a materially different experience from being locked
 * out, and it is the one that lets a customer come back.
 *
 * Reads stay open, writes are refused with a distinct code so the UI can explain *why* and
 * offer the upgrade — rather than showing a generic permission error.
 */
const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const CACHE_TTL_SECONDS = 60;

interface SubscriptionState {
  readonly restricted: boolean;
  readonly reason: 'trial_expired' | 'subscription_expired' | null;
}

@Injectable()
export class SubscriptionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly db: DbService,
    private readonly redis: RedisService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const principal = tenantContext.get();
    if (!principal) return true; // unauthenticated routes have no subscription to check

    const request = context.switchToHttp().getRequest<FastifyRequest>();
    if (READ_METHODS.has(request.method.toUpperCase())) return true;

    if (
      this.reflector.getAllAndOverride<boolean>(ALLOW_WHEN_RESTRICTED_KEY, [
        context.getHandler(),
        context.getClass(),
      ]) === true
    ) {
      return true;
    }

    const state = await this.stateFor(principal.organizationId);
    if (!state.restricted) return true;

    throw new AppError(
      state.reason === 'trial_expired' ? 'TRIAL_EXPIRED' : 'SUBSCRIPTION_INACTIVE',
      state.reason === 'trial_expired'
        ? 'Your free trial has ended. Your data is safe — choose a plan to continue working.'
        : 'Your subscription has lapsed. Your data is safe — renew to continue working.',
      403,
      { readOnly: true },
    );
  }

  /** Called when a subscription changes so the next request sees the new state. */
  async invalidate(organizationId: string): Promise<void> {
    await this.redis.del(this.redis.key(organizationId, 'subscription-state'));
  }

  private async stateFor(organizationId: string): Promise<SubscriptionState> {
    const cacheKey = this.redis.key(organizationId, 'subscription-state');
    const cached = await this.redis.getJson<SubscriptionState>(cacheKey);
    if (cached) return cached;

    const state = await withPlatformScope('subscription: resolve write access', async () => {
      const subscription = await this.db.client.subscription.findUnique({
        where: { organizationId },
      });
      // No subscription at all: a fresh deployment with no plans configured must still work.
      if (!subscription) return { restricted: false, reason: null } satisfies SubscriptionState;

      const now = Date.now();

      if (subscription.status === 'trialing') {
        const trialOver =
          subscription.trialEndsAt !== null && subscription.trialEndsAt.getTime() <= now;
        // Grace keeps writes open past the trial end; only after it does the tenant go read-only.
        const graceOver =
          subscription.graceEndsAt === null || subscription.graceEndsAt.getTime() <= now;
        return {
          restricted: trialOver && graceOver,
          reason: trialOver && graceOver ? 'trial_expired' : null,
        } satisfies SubscriptionState;
      }

      if (subscription.status === 'expired' || subscription.status === 'cancelled') {
        return { restricted: true, reason: 'subscription_expired' } satisfies SubscriptionState;
      }

      if (subscription.status === 'grace' || subscription.status === 'past_due') {
        const graceOver =
          subscription.graceEndsAt !== null && subscription.graceEndsAt.getTime() <= now;
        return {
          restricted: graceOver,
          reason: graceOver ? 'subscription_expired' : null,
        } satisfies SubscriptionState;
      }

      return { restricted: false, reason: null } satisfies SubscriptionState;
    });

    await this.redis.setJson(cacheKey, state, CACHE_TTL_SECONDS);
    return state;
  }
}
