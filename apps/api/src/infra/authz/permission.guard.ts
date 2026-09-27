import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AppError, scopeAtLeast, tenantContext } from '@leados/shared';
import { IS_PUBLIC_KEY } from '../../modules/auth/guards/public.decorator.js';
import {
  PERMISSION_EXEMPT_KEY,
  REQUIRED_PERMISSION_KEY,
  type RequiredPermission,
} from './permission.decorator.js';

/**
 * Enforces the permission a route declares (docs/security.md §4).
 *
 * Runs after `AuthGuard`, so a principal is present. Three outcomes:
 *  • public route → allowed;
 *  • explicitly exempt route → allowed (the caller's own identity/session endpoints);
 *  • otherwise the declared permission must be held, at or above the declared scope.
 *
 * A route with no declaration reaches here only if the boot-time audit was bypassed, so it
 * is refused rather than allowed — the guard's default is "no".
 */
@Injectable()
export class PermissionGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const targets = [context.getHandler(), context.getClass()];

    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, targets) === true) return true;
    if (this.reflector.getAllAndOverride<string>(PERMISSION_EXEMPT_KEY, targets)) return true;

    const required = this.reflector.getAllAndOverride<RequiredPermission>(
      REQUIRED_PERMISSION_KEY,
      targets,
    );
    if (!required) {
      // Should be unreachable: RouteAuditService fails startup for undeclared routes.
      throw new AppError('FORBIDDEN', 'This endpoint is not available', 403, {
        reason: 'route declares no permission',
      });
    }

    const principal = tenantContext.get();
    if (!principal) throw AppError.unauthenticated();

    if (!principal.permissions.has(required.permission)) {
      throw AppError.permissionDenied(required.permission);
    }

    const minimumScope = required.minimumScope;
    if (minimumScope) {
      const granted = principal.scopes.get(required.permission) ?? 'own';
      if (!scopeAtLeast(granted, minimumScope)) {
        // The caller holds the permission, but not widely enough for what this route does.
        throw new AppError(
          'OUT_OF_DATA_SCOPE',
          `This action needs ${required.permission} across the ${minimumScope}; yours applies to ${granted}.`,
          403,
          { permission: required.permission, granted, required: minimumScope },
        );
      }
    }

    return true;
  }
}
