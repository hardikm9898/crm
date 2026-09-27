import { describe, expect, it } from 'vitest';
import { ApiError, ERROR_COPY, describeError } from './api';

describe('describeError', () => {
  it("prefers this app's copy for a code it knows", () => {
    const error = new ApiError(403, 'PERMISSION_DENIED', 'Missing permission: role:read');
    // The API's message names an internal permission key; the person reading the screen needs the
    // consequence, not the key.
    expect(describeError(error)).toBe(ERROR_COPY['PERMISSION_DENIED']);
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
