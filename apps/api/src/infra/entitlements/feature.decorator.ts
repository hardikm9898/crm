import { SetMetadata } from '@nestjs/common';

export const REQUIRED_FEATURE_KEY = 'leados:requiredFeature';

/**
 * Declares that a route needs a plan feature. The guard answers with
 * `403 FEATURE_NOT_IN_PLAN` and names the feature, so the client can render an upgrade
 * prompt instead of a broken screen (docs/frontend-architecture.md §8).
 */
export const RequireFeature = (featureKey: string): MethodDecorator & ClassDecorator =>
  SetMetadata(REQUIRED_FEATURE_KEY, featureKey);
