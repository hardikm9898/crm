import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { tenantContext } from '@leados/shared';
import { EntitlementService } from './entitlement.service.js';
import { REQUIRED_FEATURE_KEY } from './feature.decorator.js';

/**
 * Enforces plan features on routes that declare one. Separate from the permission guard
 * because the questions differ: permission asks "may this person", entitlement asks "does
 * this organization pay for it" — and the answers need different responses in the UI.
 */
@Injectable()
export class EntitlementGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly entitlements: EntitlementService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const featureKey = this.reflector.getAllAndOverride<string>(REQUIRED_FEATURE_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!featureKey) return true;
    if (!tenantContext.get()) return true; // unauthenticated routes carry no entitlement

    await this.entitlements.assertEnabled(featureKey);
    return true;
  }
}
