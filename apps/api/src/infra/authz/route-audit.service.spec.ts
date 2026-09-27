import { describe, expect, it, vi } from 'vitest';
import { Controller, Get, Post } from '@nestjs/common';
import { MetadataScanner, Reflector } from '@nestjs/core';
import type { DiscoveryService } from '@nestjs/core';
import type { Logger } from 'pino';
import { RouteAuditService } from './route-audit.service.js';
import { NoPermissionRequired, RequirePermission } from './permission.decorator.js';
import { Public } from '../../modules/auth/guards/public.decorator.js';

/**
 * The audit's contract is that the process refuses to start when a route is undeclared.
 * That promise is only worth anything if it is tested, so these tests build controllers with
 * each kind of declaration and assert what the audit does with them.
 */

@Controller('declared')
class DeclaredController {
  @Public()
  @Get('open')
  open(): void {}

  @Get('list')
  @RequirePermission('lead:read')
  list(): void {}

  @Post('self')
  @NoPermissionRequired('own session')
  self(): void {}

  /** Not a route: no HTTP method decorator, so the audit must ignore it. */
  helper(): void {}
}

@Controller('leaky')
class LeakyController {
  @Get('oops')
  oops(): void {}
}

function auditFor(...controllers: object[]): RouteAuditService {
  const discovery = {
    getControllers: () =>
      controllers.map((ControllerClass) => ({
        instance: new (ControllerClass as new () => object)(),
        metatype: ControllerClass,
      })),
  } as unknown as DiscoveryService;

  const logger = { info: vi.fn() } as unknown as Logger;
  return new RouteAuditService(discovery, new MetadataScanner(), new Reflector(), logger);
}

describe('RouteAuditService', () => {
  it('classifies each declaration and ignores non-route methods', () => {
    const routes = auditFor(DeclaredController).collect();

    expect(routes).toHaveLength(3); // `helper` is not a route
    expect(routes.find((route) => route.path === '/declared/open')?.declaration).toBe('public');
    expect(routes.find((route) => route.path === '/declared/list')).toMatchObject({
      declaration: 'permission',
      permission: 'lead:read',
      httpMethod: 'GET',
    });
    expect(routes.find((route) => route.path === '/declared/self')).toMatchObject({
      declaration: 'exempt',
      exemptReason: 'own session',
      httpMethod: 'POST',
    });
  });

  it('passes startup when every route is declared', () => {
    expect(() => auditFor(DeclaredController).onApplicationBootstrap()).not.toThrow();
  });

  it('refuses to start when a route declares nothing, and names it', () => {
    // The whole point: a forgotten decorator is a boot failure, not a silently open endpoint.
    try {
      auditFor(DeclaredController, LeakyController).onApplicationBootstrap();
      expect.unreachable('should have thrown');
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain('/leaky/oops');
      expect(message).toContain('LeakyController.oops');
      expect(message).toContain('@RequirePermission');
      // Routes that are fine must not be reported as problems.
      expect(message).not.toContain('/declared/list');
    }
  });
});
