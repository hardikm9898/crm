import { describe, expect, it } from 'vitest';
import { Reflector } from '@nestjs/core';
import { AppError, tenantContext, type DataScope, type TenantPrincipal } from '@leados/shared';
import type { ExecutionContext } from '@nestjs/common';
import { PermissionGuard } from './permission.guard.js';
import { IS_PUBLIC_KEY } from '../../modules/auth/guards/public.decorator.js';
import { PERMISSION_EXEMPT_KEY, REQUIRED_PERMISSION_KEY } from './permission.decorator.js';

/** Minimal ExecutionContext carrying metadata, which is all the guard reads. */
function contextWith(metadata: Record<string, unknown>): ExecutionContext {
  class Handler {}
  const handler = (): void => undefined;
  for (const [key, value] of Object.entries(metadata)) {
    Reflect.defineMetadata(key, value, handler);
  }
  return {
    getHandler: () => handler,
    getClass: () => Handler,
    switchToHttp: () => ({ getRequest: () => ({ method: 'GET' }) }),
  } as unknown as ExecutionContext;
}

const guard = new PermissionGuard(new Reflector());

function principal(permissions: string[], scopes: [string, DataScope][] = []): TenantPrincipal {
  return {
    organizationId: 'org-1',
    actorType: 'user',
    actorId: 'user-1',
    permissions: new Set(permissions),
    scopes: new Map(scopes),
    teamIds: [],
    branchIds: [],
    requestId: 'req-1',
  };
}

describe('PermissionGuard', () => {
  it('allows a public route', () => {
    expect(guard.canActivate(contextWith({ [IS_PUBLIC_KEY]: true }))).toBe(true);
  });

  it('allows an explicitly exempt route', () => {
    expect(guard.canActivate(contextWith({ [PERMISSION_EXEMPT_KEY]: 'own session' }))).toBe(true);
  });

  it('refuses a route that declares nothing — the default is no', () => {
    // Unreachable in practice because the boot audit fails first, but the guard must not be
    // the component that decides to allow it.
    expect(() => guard.canActivate(contextWith({}))).toThrow(AppError);
  });

  it('allows a caller holding the declared permission', async () => {
    const context = contextWith({ [REQUIRED_PERMISSION_KEY]: { permission: 'lead:read' } });
    await tenantContext.run(principal(['lead:read']), async () => {
      expect(guard.canActivate(context)).toBe(true);
    });
  });

  it('refuses a caller without it, naming the permission', async () => {
    const context = contextWith({ [REQUIRED_PERMISSION_KEY]: { permission: 'user:manage' } });
    await tenantContext.run(principal(['lead:read']), async () => {
      try {
        guard.canActivate(context);
        expect.unreachable('should have thrown');
      } catch (error) {
        expect((error as AppError).code).toBe('PERMISSION_DENIED');
        expect((error as AppError).message).toContain('user:manage');
      }
    });
  });

  it('refuses when the grant is too narrow for the route', async () => {
    const context = contextWith({
      [REQUIRED_PERMISSION_KEY]: { permission: 'user:read', minimumScope: 'organization' },
    });
    await tenantContext.run(principal(['user:read'], [['user:read', 'own']]), async () => {
      try {
        guard.canActivate(context);
        expect.unreachable('should have thrown');
      } catch (error) {
        expect((error as AppError).code).toBe('OUT_OF_DATA_SCOPE');
        expect((error as AppError).details).toMatchObject({
          granted: 'own',
          required: 'organization',
        });
      }
    });
  });

  it('accepts a wider grant than the route requires', async () => {
    const context = contextWith({
      [REQUIRED_PERMISSION_KEY]: { permission: 'user:read', minimumScope: 'team' },
    });
    await tenantContext.run(principal(['user:read'], [['user:read', 'branch']]), async () => {
      expect(guard.canActivate(context)).toBe(true);
    });
  });

  it('refuses when there is no principal at all', () => {
    const context = contextWith({ [REQUIRED_PERMISSION_KEY]: { permission: 'lead:read' } });
    expect(() => guard.canActivate(context)).toThrow(/Authentication required/);
  });
});
