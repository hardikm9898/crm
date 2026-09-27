/**
 * Canonical application errors. Every error crossing the HTTP boundary carries a
 * stable machine-readable `code` that clients branch on, plus a human message
 * (docs/api-architecture.md §2).
 */

export type ErrorCode =
  // 400
  | 'VALIDATION_FAILED'
  | 'INVALID_PHONE'
  | 'INVALID_CUSTOM_FIELD'
  | 'UNKNOWN_FIELD'
  // 401
  | 'UNAUTHENTICATED'
  | 'TOKEN_EXPIRED'
  | 'TOKEN_REUSED'
  | 'INVALID_API_KEY'
  // 403
  | 'FORBIDDEN'
  | 'PERMISSION_DENIED'
  | 'OUT_OF_DATA_SCOPE'
  | 'ORG_SUSPENDED'
  | 'TRIAL_EXPIRED'
  | 'SUBSCRIPTION_INACTIVE'
  | 'FEATURE_NOT_IN_PLAN'
  | 'LIMIT_EXCEEDED'
  // 404
  | 'NOT_FOUND'
  // 409
  | 'CONFLICT'
  | 'DUPLICATE_LEAD'
  | 'STALE_VERSION'
  | 'IDEMPOTENT_REPLAY_MISMATCH'
  // 422
  | 'BUSINESS_RULE_VIOLATION'
  // 429
  | 'RATE_LIMITED'
  // 5xx
  | 'INTEGRATION_UNAVAILABLE'
  | 'PROVIDER_ERROR'
  | 'INTERNAL_ERROR';

export interface FieldError {
  readonly field: string;
  readonly code: string;
  readonly message: string;
}

export class AppError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly status: number,
    readonly details?: readonly FieldError[] | Record<string, unknown>,
  ) {
    super(message);
    this.name = 'AppError';
  }

  static validation(message: string, details?: readonly FieldError[]): AppError {
    return new AppError('VALIDATION_FAILED', message, 400, details);
  }

  static unauthenticated(message = 'Authentication required'): AppError {
    return new AppError('UNAUTHENTICATED', message, 401);
  }

  static permissionDenied(permission: string): AppError {
    return new AppError('PERMISSION_DENIED', `Missing permission: ${permission}`, 403, {
      permission,
    });
  }

  /**
   * Cross-tenant and out-of-scope access resolve to 404, never 403, so the API never
   * discloses that another tenant's resource exists (docs/security.md §3).
   */
  static notFound(resource: string, code: ErrorCode = 'NOT_FOUND'): AppError {
    return new AppError(code, `${resource} not found`, 404);
  }

  static conflict(message: string, code: ErrorCode = 'CONFLICT'): AppError {
    return new AppError(code, message, 409);
  }

  static businessRule(message: string, details?: Record<string, unknown>): AppError {
    return new AppError('BUSINESS_RULE_VIOLATION', message, 422, details);
  }

  static limitExceeded(feature: string, limit: number, used: number): AppError {
    return new AppError('LIMIT_EXCEEDED', `Plan limit reached for ${feature}`, 403, {
      feature,
      limit,
      used,
    });
  }

  static internal(message = 'Something went wrong'): AppError {
    return new AppError('INTERNAL_ERROR', message, 500);
  }
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}
