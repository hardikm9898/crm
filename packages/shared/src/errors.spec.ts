import { describe, expect, it } from 'vitest';
import { AppError, isAppError } from './errors.js';

describe('AppError', () => {
  it('carries a stable code and HTTP status', () => {
    const error = AppError.validation('Invalid body', [
      { field: 'phone', code: 'INVALID_PHONE', message: 'Not a valid number' },
    ]);
    expect(error.code).toBe('VALIDATION_FAILED');
    expect(error.status).toBe(400);
    expect(error.details).toHaveLength(1);
  });

  it('resolves cross-tenant access to 404 so existence is never disclosed', () => {
    const error = AppError.notFound('Lead');
    expect(error.status).toBe(404);
    expect(error.message).toBe('Lead not found');
  });

  it('reports plan limits with the numbers a client needs to render an upgrade prompt', () => {
    const error = AppError.limitExceeded('leads', 1000, 1000);
    expect(error.status).toBe(403);
    expect(error.code).toBe('LIMIT_EXCEEDED');
    expect(error.details).toMatchObject({ feature: 'leads', limit: 1000, used: 1000 });
  });

  it('is detectable across module boundaries', () => {
    expect(isAppError(AppError.internal())).toBe(true);
    expect(isAppError(new Error('plain'))).toBe(false);
  });
});
