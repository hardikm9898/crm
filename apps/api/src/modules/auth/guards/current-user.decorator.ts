import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import { AppError, tenantContext } from '@leados/shared';

export interface AuthenticatedUser {
  readonly userId: string;
  readonly organizationId: string;
  readonly sessionId: string;
}

/**
 * Injects the authenticated identity, taken from the request-scoped context rather than
 * from the request object — so a handler cannot be tricked by a spoofed body or header.
 *
 * A route using this needs a **person**: there is no session behind an API key, so a key reaching
 * one is told that rather than "authentication required", which would send an integrator to check
 * a credential that is working perfectly (`FR-API-1`).
 */
export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthenticatedUser => {
    const request = context.switchToHttp().getRequest<{ leados?: { sessionId?: string } }>();
    const principal = tenantContext.get();
    if (principal?.actorType === 'api_key') {
      throw new AppError(
        'FORBIDDEN',
        'This endpoint is about the signed-in person, so an API key cannot use it.',
        403,
      );
    }
    if (!principal?.actorId || !request.leados?.sessionId) throw AppError.unauthenticated();
    return {
      userId: principal.actorId,
      organizationId: principal.organizationId,
      sessionId: request.leados.sessionId,
    };
  },
);

/** For routes reachable before an organization is chosen (e.g. sign out everywhere). */
export const CurrentSession = createParamDecorator(
  (_data: unknown, context: ExecutionContext): { userId: string; sessionId: string } => {
    const request = context
      .switchToHttp()
      .getRequest<{ leados?: { userId?: string; sessionId?: string } }>();
    if (tenantContext.get()?.actorType === 'api_key') {
      throw new AppError(
        'FORBIDDEN',
        'This endpoint is about the signed-in person, so an API key cannot use it.',
        403,
      );
    }
    if (!request.leados?.userId || !request.leados.sessionId) throw AppError.unauthenticated();
    return { userId: request.leados.userId, sessionId: request.leados.sessionId };
  },
);
