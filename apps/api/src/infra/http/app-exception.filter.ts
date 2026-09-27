import {
  type ArgumentsHost,
  Catch,
  HttpException,
  HttpStatus,
  type ExceptionFilter,
} from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { AppError, isAppError, type ErrorCode } from '@leados/shared';
import { CrossTenantAccessError, Prisma } from '@leados/db';
import { TenantContextMissingError } from '@leados/shared';
import type { Logger } from 'pino';
import { requestStore } from './request-store.js';

/**
 * Maps every thrown value onto the API's error contract
 * (docs/api-architecture.md §2). Two rules matter most:
 *
 *  • Internal details never leak. Stack traces, SQL and provider payloads stay in the
 *    logs; the client gets a code, a safe message and the request id.
 *  • Tenant-isolation failures are logged at a severity that gets noticed, because a
 *    CrossTenantAccessError means application code tried to cross a tenant boundary.
 */
@Catch()
export class AppExceptionFilter implements ExceptionFilter {
  constructor(private readonly logger: Logger) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const reply = host.switchToHttp().getResponse<FastifyReply>();
    const request = requestStore.get();
    const mapped = this.map(exception);

    const logPayload = {
      requestId: request?.requestId,
      method: request?.method,
      path: request?.path,
      code: mapped.code,
      status: mapped.status,
      err:
        exception instanceof Error
          ? { message: exception.message, stack: exception.stack }
          : exception,
    };

    if (mapped.status >= 500) this.logger.error(logPayload, mapped.logMessage);
    else if (mapped.alarm) this.logger.error(logPayload, mapped.logMessage);
    else if (mapped.status >= 400) this.logger.warn(logPayload, mapped.logMessage);

    void reply.status(mapped.status).send({
      success: false,
      error: {
        code: mapped.code,
        message: mapped.message,
        ...(mapped.details ? { details: mapped.details } : {}),
        ...(request ? { requestId: request.requestId } : {}),
      },
    });
  }

  private map(exception: unknown): {
    status: number;
    code: ErrorCode;
    message: string;
    details?: unknown;
    logMessage: string;
    alarm?: boolean;
  } {
    if (isAppError(exception)) {
      return {
        status: exception.status,
        code: exception.code,
        message: exception.message,
        details: exception.details,
        logMessage: `handled application error: ${exception.code}`,
      };
    }

    // An attempt to read or write across tenants. Never a routine 4xx: it means a bug
    // or an attack, and it must be loud (docs/security.md §3).
    if (exception instanceof CrossTenantAccessError) {
      return {
        status: HttpStatus.NOT_FOUND,
        code: 'NOT_FOUND',
        message: 'Resource not found',
        logMessage: 'CROSS-TENANT ACCESS REJECTED',
        alarm: true,
      };
    }

    // A tenant-scoped query ran with no tenant context: a wiring mistake, not user error.
    if (exception instanceof TenantContextMissingError) {
      return {
        status: HttpStatus.INTERNAL_SERVER_ERROR,
        code: 'INTERNAL_ERROR',
        message: 'Something went wrong',
        logMessage: 'MISSING TENANT CONTEXT',
        alarm: true,
      };
    }

    if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      return this.mapPrisma(exception);
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const response = exception.getResponse();
      return {
        status,
        code: this.codeForStatus(status),
        message:
          typeof response === 'string'
            ? response
            : ((response as { message?: string })?.message ?? exception.message),
        logMessage: `http exception: ${status}`,
      };
    }

    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      code: 'INTERNAL_ERROR',
      message: 'Something went wrong',
      logMessage: 'unhandled exception',
    };
  }

  private mapPrisma(error: Prisma.PrismaClientKnownRequestError): {
    status: number;
    code: ErrorCode;
    message: string;
    details?: unknown;
    logMessage: string;
  } {
    switch (error.code) {
      case 'P2002': // unique constraint
        return {
          status: HttpStatus.CONFLICT,
          code: 'CONFLICT',
          message: 'A record with these details already exists',
          details: { fields: (error.meta as { target?: string[] } | undefined)?.target },
          logMessage: 'unique constraint violation',
        };
      case 'P2025': // record not found
        return {
          status: HttpStatus.NOT_FOUND,
          code: 'NOT_FOUND',
          message: 'Resource not found',
          logMessage: 'record not found',
        };
      case 'P2003': // foreign key
        return {
          status: HttpStatus.CONFLICT,
          code: 'CONFLICT',
          message: 'Related record is missing or belongs to another organization',
          logMessage: 'foreign key violation',
        };
      default:
        return {
          status: HttpStatus.INTERNAL_SERVER_ERROR,
          code: 'INTERNAL_ERROR',
          message: 'Something went wrong',
          logMessage: `unmapped prisma error ${error.code}`,
        };
    }
  }

  private codeForStatus(status: number): ErrorCode {
    switch (status) {
      case 400:
        return 'VALIDATION_FAILED';
      case 401:
        return 'UNAUTHENTICATED';
      case 403:
        return 'FORBIDDEN';
      case 404:
        return 'NOT_FOUND';
      case 409:
        return 'CONFLICT';
      case 422:
        return 'BUSINESS_RULE_VIOLATION';
      case 429:
        return 'RATE_LIMITED';
      default:
        return status >= 500 ? 'INTERNAL_ERROR' : 'VALIDATION_FAILED';
    }
  }
}

export { AppError };
