import { SetMetadata } from '@nestjs/common';
import type { DataScope, Permission } from '@leados/shared';

export const REQUIRED_PERMISSION_KEY = 'leados:requiredPermission';
export const PERMISSION_EXEMPT_KEY = 'leados:permissionExempt';

export interface RequiredPermission {
  readonly permission: Permission;
  /**
   * Minimum scope the grant must reach for this route. A route listing the whole
   * organization's users needs `organization`; a route returning "my leads" needs only `own`.
   * Defaults to `own`, i.e. holding the permission at any scope is enough.
   */
  readonly minimumScope?: DataScope;
}

/**
 * Declares what a route requires. Authorization is deny-by-default at two levels:
 *
 *  1. the guard refuses a caller without the permission;
 *  2. **a route that declares nothing at all fails at boot** (see RouteAuditService) — so
 *     "I forgot to add the decorator" cannot ship as "anyone authenticated may do this".
 *
 * Code checks permissions, never role names (FR-IAM-3).
 */
export const RequirePermission = (
  permission: Permission,
  options: { minimumScope?: DataScope } = {},
): MethodDecorator & ClassDecorator =>
  SetMetadata(REQUIRED_PERMISSION_KEY, {
    permission,
    minimumScope: options.minimumScope,
  } satisfies RequiredPermission);

/**
 * Marks a route that is authenticated but needs no specific permission — the endpoints that
 * describe or manage the caller's *own* identity and session (`/auth/me`, MFA setup, session
 * list). The reason is recorded so the exemption is reviewable rather than habitual.
 */
export const NoPermissionRequired = (reason: string): MethodDecorator & ClassDecorator =>
  SetMetadata(PERMISSION_EXEMPT_KEY, reason);
