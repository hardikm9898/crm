import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'leados:isPublic';

/**
 * Marks a route as reachable without authentication.
 *
 * Authentication is **deny-by-default**: the guard is global, so a new controller is
 * protected the moment it is added and a developer cannot forget to secure it. Opting out
 * is explicit, greppable, and reviewable — which is the only safe direction for this
 * decision (docs/security.md §4).
 */
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(IS_PUBLIC_KEY, true);
