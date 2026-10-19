import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AppError, looksLikeApiCredential, tenantContext } from '@leados/shared';
import type { FastifyRequest } from 'fastify';
import { requestStore } from '../../../infra/http/request-store.js';
import { ApiKeyAuthService } from '../../api-keys/api-key-auth.service.js';
import { markApiRequest } from '../../api-keys/api-log.hook.js';
import { PrincipalService } from '../application/principal.service.js';
import { SessionService } from '../application/session.service.js';
import { TokenService } from '../application/token.service.js';
import { IS_PUBLIC_KEY } from './public.decorator.js';

/**
 * The global authentication guard, and the place where **isolation layer 1** is
 * established: it verifies the access token, confirms the session is still live, builds the
 * `TenantPrincipal`, and runs the rest of the request inside `tenantContext`
 * (docs/security.md §3, docs/system-architecture.md §7).
 *
 * Two properties are deliberate:
 *
 *  • **The organization comes from the token, never from the request.** No header, query
 *    parameter or body field can change which tenant a request acts on.
 *
 *  • **The session is checked on every request, not just at refresh.** Access tokens are
 *    short-lived but not instantly revocable on their own; verifying the session means
 *    "sign out everywhere" and a reuse-detected family revocation take effect immediately.
 *
 * Authorization (permissions, data scopes, entitlements) is layered on top of this by the
 * guards in Phase 1 step 3; this guard establishes *who* the caller is, not *what* they
 * may do.
 *
 * **Two credentials reach the same surface** (`FR-API-1`, docs/api-architecture.md §1): a session's
 * access token, and an API key presented as `Authorization: Bearer <key id>.<secret>`. They are
 * told apart by the key id's `pk_` prefix rather than by trying one and falling back to the other,
 * so a mistyped key is refused as a bad key instead of as an expired session. Everything after
 * this guard — the permission guard, the data scope, the tenant-scoped client — works from the
 * principal and cannot tell which credential produced it, which is the property that makes the
 * whole product's routes available to an integration without a second implementation of any of it.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: TokenService,
    private readonly sessions: SessionService,
    private readonly principals: PrincipalService,
    private readonly apiKeys: ApiKeyAuthService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic === true) return true;

    const request = context.switchToHttp().getRequest<
      FastifyRequest & {
        leados?: { userId: string; sessionId: string; organizationId: string | null };
      }
    >();

    const authorization = request.headers.authorization;

    if (looksLikeApiCredential(authorization)) {
      // The client's address comes from the request context, which is where this product reads the
      // proxy chain: `request.ip` is the socket address unless Fastify is told to trust the proxy,
      // and an allowlist that silently fell back to it would refuse every request behind a load
      // balancer — while passing a test whose other half checks that a stranger is refused.
      const ip = requestStore.get()?.ip ?? request.ip;
      const authenticated = await this.apiKeys.authenticate({
        authorization,
        ip,
        requestId: requestStore.requestId() ?? '',
        // Marks the request as soon as the key resolves to a workspace, so a refusal from the
        // allowlist, the rate limiter, the secret or the scopes is in the request log too — those
        // are the four an integrator opens the log to understand.
        identify: ({ organizationId, apiKeyId }) =>
          markApiRequest(request, {
            organizationId,
            apiKeyId,
            surface: 'rest',
            ip: ip ?? null,
          }),
      });
      tenantContext.setPrincipal(authenticated.principal);
      return true;
    }

    const token = extractBearerToken(authorization);
    if (!token) throw AppError.unauthenticated();

    const claims = await this.tokens.verifyAccessToken(token);
    const session = await this.sessions.findActiveById(claims.sid);
    if (!session || session.userId !== claims.sub) {
      // Revoked, expired, or a token whose session belongs to someone else.
      throw new AppError('UNAUTHENTICATED', 'Your session has ended. Please sign in again.', 401);
    }

    // The session is authoritative for the active organization: switching org updates the
    // session, so a stale token cannot keep acting on the previous tenant.
    const organizationId = session.activeOrganizationId ?? claims.org;
    request.leados = { userId: claims.sub, sessionId: claims.sid, organizationId };

    if (!organizationId) {
      // Authenticated, but not yet in any organization (invited-but-unprovisioned). Only
      // the handful of routes that tolerate this are reachable; everything tenant-scoped
      // fails closed because there is no tenant context to run in.
      return true;
    }

    const principal = await this.principals.build({
      userId: claims.sub,
      organizationId,
      sessionId: claims.sid,
      requestId: requestStore.requestId() ?? claims.sid,
    });

    // Populates the empty scope the request-context middleware opened. A guard cannot
    // *create* the scope, because Nest awaits the guard and the handler resumes on the
    // caller's async context — see the note on tenantContext.setPrincipal.
    tenantContext.setPrincipal(principal);
    return true;
  }
}

function extractBearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const [scheme, value] = header.split(' ');
  if (!scheme || scheme.toLowerCase() !== 'bearer' || !value) return null;
  return value.trim();
}
