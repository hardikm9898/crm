import { describe, expect, it } from 'vitest';
import { redact } from './job-failure.recorder.js';

/**
 * A failure table is exactly where a customer's phone number or a single-use token would linger,
 * so redaction is part of the contract rather than a nicety.
 */
describe('redact', () => {
  it('removes secrets and personal data, keeping the shape', () => {
    expect(
      redact({
        organizationId: 'org-1',
        payload: { userId: 'user-1', email: 'someone@example.com', token: 'abc123' },
        attempts: 3,
      }),
    ).toEqual({
      organizationId: 'org-1',
      payload: { userId: 'user-1', email: '[redacted]', token: '[redacted]' },
      attempts: 3,
    });
  });

  it('redacts nested and array values', () => {
    expect(redact({ recipients: [{ email: 'a@b.c' }, { email: 'd@e.f' }] })).toEqual({
      recipients: [{ email: '[redacted]' }, { email: '[redacted]' }],
    });
  });

  it('redacts message bodies, which can carry a reset link', () => {
    expect(
      redact({ subject: 'Reset your password', text: 'https://app/reset?token=secret' }),
    ).toEqual({
      subject: 'Reset your password',
      text: '[redacted]',
    });
  });

  it('passes primitives and null through', () => {
    expect(redact(null)).toBeNull();
    expect(redact(42)).toBe(42);
    expect(redact('plain')).toBe('plain');
  });
});
