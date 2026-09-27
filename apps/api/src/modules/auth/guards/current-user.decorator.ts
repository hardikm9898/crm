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
 */
export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthenticatedUser => {
    const request = context.switchToHttp().getRequest<{ leados?: { sessionId?: string } }>();
    const principal = tenantContext.get();
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
    if (!request.leados?.userId || !request.leados.sessionId) throw AppError.unauthenticated();
    return { userId: request.leados.userId, sessionId: request.leados.sessionId };
  },
);
