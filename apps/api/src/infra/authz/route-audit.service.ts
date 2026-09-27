import { Inject, Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants.js';
import { DiscoveryService, MetadataScanner, Reflector } from '@nestjs/core';
import type { Logger } from 'pino';
import { LOGGER } from '../observability/logger.module.js';
import { IS_PUBLIC_KEY } from '../../modules/auth/guards/public.decorator.js';
import { PERMISSION_EXEMPT_KEY, REQUIRED_PERMISSION_KEY } from './permission.decorator.js';

/**
 * Fails startup if any route lacks an authorization declaration.
 *
 * Reviews catch missing decorators unreliably, and the cost of missing one is an endpoint
 * that any authenticated user of any tenant can call. So the process refuses to start
 * instead: every route must carry exactly one of
 *
 *   • `@Public()`                     — reachable without authentication
 *   • `@RequirePermission(...)`       — needs that permission
 *   • `@NoPermissionRequired(reason)` — authenticated, no specific permission, with a reason
 *
 * This is the enforcement behind "every mutation must have authorization"
 * (docs/README.md rule 11, docs/security.md §4).
 */

export interface RouteDeclaration {
  readonly controller: string;
  readonly method: string;
  readonly httpMethod: string;
  readonly path: string;
  readonly declaration: 'public' | 'permission' | 'exempt' | 'missing';
  readonly permission?: string;
  readonly exemptReason?: string;
}

const HTTP_METHOD_NAMES: Record<number, string> = {
  0: 'GET',
  1: 'POST',
  2: 'PUT',
  3: 'DELETE',
  4: 'PATCH',
  5: 'ALL',
  6: 'OPTIONS',
  7: 'HEAD',
  8: 'SEARCH',
};

@Injectable()
export class RouteAuditService implements OnApplicationBootstrap {
  constructor(
    private readonly discovery: DiscoveryService,
    private readonly scanner: MetadataScanner,
    private readonly reflector: Reflector,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  onApplicationBootstrap(): void {
    const routes = this.collect();
    const undeclared = routes.filter((route) => route.declaration === 'missing');

    if (undeclared.length > 0) {
      throw new Error(
        'Routes without an authorization declaration (add @RequirePermission, @Public or ' +
          '@NoPermissionRequired):\n' +
          undeclared
            .map(
              (route) =>
                `  • ${route.httpMethod} ${route.path} → ${route.controller}.${route.method}`,
            )
            .join('\n'),
      );
    }

    const counts = routes.reduce<Record<string, number>>((totals, route) => {
      totals[route.declaration] = (totals[route.declaration] ?? 0) + 1;
      return totals;
    }, {});
    this.logger.info({ routes: routes.length, ...counts }, 'route authorization audit passed');
  }

  /** Exposed so tests can assert over the same view of the routing table. */
  collect(): RouteDeclaration[] {
    const routes: RouteDeclaration[] = [];

    for (const wrapper of this.discovery.getControllers()) {
      const instance = wrapper.instance as Record<string, unknown> | undefined;
      if (!instance || !wrapper.metatype) continue;

      const controllerPath = this.pathOf(Reflect.getMetadata(PATH_METADATA, wrapper.metatype));
      const prototype = Object.getPrototypeOf(instance) as object;

      for (const methodName of this.scanner.getAllMethodNames(prototype)) {
        const handler = (instance as Record<string, unknown>)[methodName];
        if (typeof handler !== 'function') continue;

        const routePath = Reflect.getMetadata(PATH_METADATA, handler);
        if (routePath === undefined) continue; // not a route

        const httpMethodCode = Reflect.getMetadata(METHOD_METADATA, handler) as number | undefined;
        const targets = [handler, wrapper.metatype] as const;

        const isPublic =
          this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [...targets]) === true;
        const exemptReason = this.reflector.getAllAndOverride<string>(PERMISSION_EXEMPT_KEY, [
          ...targets,
        ]);
        const required = this.reflector.getAllAndOverride<{ permission: string }>(
          REQUIRED_PERMISSION_KEY,
          [...targets],
        );

        routes.push({
          controller: wrapper.metatype.name,
          method: methodName,
          httpMethod: HTTP_METHOD_NAMES[httpMethodCode ?? 0] ?? 'GET',
          path: joinPaths(controllerPath, this.pathOf(routePath)),
          declaration: isPublic
            ? 'public'
            : required
              ? 'permission'
              : exemptReason
                ? 'exempt'
                : 'missing',
          ...(required ? { permission: required.permission } : {}),
          ...(exemptReason ? { exemptReason } : {}),
        });
      }
    }

    return routes;
  }

  private pathOf(value: unknown): string {
    if (typeof value === 'string') return value;
    if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
    return '';
  }
}

function joinPaths(controllerPath: string, routePath: string): string {
  const segments = [controllerPath, routePath]
    .map((segment) => segment.replace(/^\/+|\/+$/g, ''))
    .filter((segment) => segment.length > 0);
  return `/${segments.join('/')}`;
}
