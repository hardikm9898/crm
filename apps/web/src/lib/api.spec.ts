import { describe, expect, it } from 'vitest';
import { ApiError, ERROR_COPY, ERROR_FALLBACKS, describeError } from './api';

describe('describeError', () => {
  it("prefers this app's copy for a code it knows", () => {
    const error = new ApiError(403, 'PERMISSION_DENIED', 'Missing permission: role:read');
    // The API's message names an internal permission key; the person reading the screen needs the
    // consequence, not the key.
    expect(describeError(error)).toBe(ERROR_COPY['PERMISSION_DENIED']);
  });

  it('keeps the API’s own sentence for a refusal it wrote for a person', () => {
    // This is the one that was wrong, product-wide: every business-rule refusal read "That is not
    // allowed.", throwing away the sentence that said what to do instead.
    const error = new ApiError(
      422,
      'BUSINESS_RULE_VIOLATION',
      'The counter is already at 2. It can be moved forward, but not back.',
    );
    expect(describeError(error)).toContain('moved forward');
    expect(describeError(error)).not.toBe(ERROR_FALLBACKS['BUSINESS_RULE_VIOLATION']);
  });

  it('uses the generic sentence only when the API supplied none', () => {
    expect(describeError(new ApiError(422, 'BUSINESS_RULE_VIOLATION', ''))).toBe(
      ERROR_FALLBACKS['BUSINESS_RULE_VIOLATION'],
    );
  });

  it('still hides an internal message behind this app’s copy where that matters', () => {
    // A permission key, a plan flag and a tenant-context error are not sentences for a browser.
    for (const code of ['PERMISSION_DENIED', 'TOKEN_EXPIRED', 'FEATURE_NOT_IN_PLAN']) {
      expect(describeError(new ApiError(403, code, 'Missing permission: role:read'))).not.toContain(
        'role:read',
      );
    }
  });

  it('falls back to the API message for a code it has no copy for', () => {
    expect(describeError(new ApiError(400, 'SOME_NEW_CODE', 'Specific server explanation'))).toBe(
      'Specific server explanation',
    );
  });

  it('never leaks a non-API failure verbatim', () => {
    expect(describeError(new TypeError('fetch failed: ECONNREFUSED 127.0.0.1:4000'))).toBe(
      'Something went wrong. Please try again.',
    );
  });

  it('treats only 401 as "sign in again"', () => {
    expect(new ApiError(401, 'TOKEN_EXPIRED', 'x').isUnauthenticated).toBe(true);
    expect(new ApiError(403, 'PERMISSION_DENIED', 'x').isUnauthenticated).toBe(false);
  });

  it('has copy for every failure a lapsed or limited tenant can hit', () => {
    // These are the codes the entitlement and subscription guards raise; a missing entry here shows
    // a raw server string to someone who is about to be asked for money.
    for (const code of [
      'TRIAL_EXPIRED',
      'SUBSCRIPTION_INACTIVE',
      'FEATURE_NOT_IN_PLAN',
      'LIMIT_EXCEEDED',
      'ORG_SUSPENDED',
    ]) {
      expect(ERROR_COPY[code]).toBeTruthy();
    }
  });
});
