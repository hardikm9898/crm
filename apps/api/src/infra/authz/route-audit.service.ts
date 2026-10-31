import { Inject, Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import {
  HTTP_CODE_METADATA,
  METHOD_METADATA,
  PATH_METADATA,
  ROUTE_ARGS_METADATA,
} from '@nestjs/common/constants.js';
import { DiscoveryService, MetadataScanner, Reflector } from '@nestjs/core';
import type { ZodType } from 'zod';
import type { Logger } from 'pino';
import { LOGGER } from '../observability/logger.module.js';
import { IS_PUBLIC_KEY } from '../../modules/auth/guards/public.decorator.js';
import { REQUIRED_FEATURE_KEY } from '../entitlements/feature.decorator.js';
import { SESSION_ONLY_KEY } from '../../modules/auth/guards/session-only.decorator.js';
import { ZodBody } from '../http/zod-validation.pipe.js';
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
  /** From `@RequireFeature`: the plan feature this route needs, if any. */
  readonly feature?: string;
  /** From `@SessionOnly`: a route about the signed-in person, which an API key cannot reach. */
  readonly sessionOnly?: boolean;
  /** `@HttpCode`, or the convention: 201 for a POST, 200 for everything else. */
  readonly successStatus: number;
  /**
   * The Zod schemas the route's **own pipes** validate with, read off the pipe instances in
   * Nest's argument metadata.
   *
   * This is what makes the published document impossible to drift from the product: the thing
   * that documents an endpoint is the thing that refuses a bad request to it. The alternative —
   * `@ApiBody()` beside `@Body(zodBody(...))` — is two descriptions of one contract, and the
   * one that is wrong is always the one nobody runs.
   */
  readonly bodySchema?: ZodType;
  readonly querySchema?: ZodType;
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

        const httpMethod = HTTP_METHOD_NAMES[httpMethodCode ?? 0] ?? 'GET';
        const feature = this.reflector.getAllAndOverride<string>(REQUIRED_FEATURE_KEY, [
          ...targets,
        ]);
        const sessionOnly =
          this.reflector.getAllAndOverride<boolean>(SESSION_ONLY_KEY, [...targets]) === true;
        const httpCode = Reflect.getMetadata(HTTP_CODE_METADATA, handler) as number | undefined;
        const schemas = zodSchemasOf(prototype, methodName);

        routes.push({
          controller: wrapper.metatype.name,
          method: methodName,
          httpMethod,
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
          ...(feature ? { feature } : {}),
          ...(sessionOnly ? { sessionOnly: true } : {}),
          successStatus: httpCode ?? (httpMethod === 'POST' ? 201 : 200),
          ...schemas,
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

/**
 * The Zod schemas attached to a handler's `@Body()` / `@Query()` pipes.
 *
 * Nest stores one entry per parameter under `ROUTE_ARGS_METADATA`, keyed `"<paramtype>:<index>"`,
 * each carrying the pipe instances the parameter was decorated with. A `ZodBody` pipe holds the
 * schema it validates against, so reading it here means the document and the validator cannot
 * disagree.
 */
function zodSchemasOf(
  prototype: object,
  methodName: string,
): { bodySchema?: ZodType; querySchema?: ZodType } {
  const metadata = Reflect.getMetadata(ROUTE_ARGS_METADATA, prototype.constructor, methodName) as
    Record<string, { pipes?: unknown[] }> | undefined;
  if (!metadata) return {};

  const found: { bodySchema?: ZodType; querySchema?: ZodType } = {};
  for (const [key, entry] of Object.entries(metadata)) {
    const paramType = Number(key.split(':')[0]);
    // 3 = BODY, 4 = QUERY in Nest's `RouteParamtypes`. Written as numbers because the enum is
    // not exported from the public entry point, and named here so the next reader knows why.
    if (paramType !== 3 && paramType !== 4) continue;
    const pipe = (entry.pipes ?? []).find(
      (candidate): candidate is ZodBody<unknown> => candidate instanceof ZodBody,
    );
    if (!pipe) continue;
    if (paramType === 3) found.bodySchema = pipe.schema;
    else found.querySchema = pipe.schema;
  }
  return found;
}
