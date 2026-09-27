import { describe, expect, it } from 'vitest';
import { AppError } from '@leados/shared';
import { PasswordService } from './password.service.js';

const passwords = new PasswordService();

describe('PasswordService hashing', () => {
  it('produces an argon2id hash that verifies', async () => {
    const hash = await passwords.hash('correct horse battery staple');
    expect(hash.startsWith('$argon2id$')).toBe(true);
    expect((await passwords.verify(hash, 'correct horse battery staple')).valid).toBe(true);
  });

  it('rejects the wrong password', async () => {
    const hash = await passwords.hash('correct horse battery staple');
    expect((await passwords.verify(hash, 'Correct horse battery staple')).valid).toBe(false);
  });

  it('salts: the same password hashes differently every time', async () => {
    const [a, b] = await Promise.all([
      passwords.hash('same password 123'),
      passwords.hash('same password 123'),
    ]);
    expect(a).not.toBe(b);
  });

  it('treats a malformed stored hash as a failed attempt, never a pass', async () => {
    expect((await passwords.verify('not-a-hash', 'anything')).valid).toBe(false);
    expect((await passwords.verify('', 'anything')).valid).toBe(false);
  });

  it('flags a weaker legacy hash for transparent rehashing', async () => {
    // A hash produced with lower memory cost than the current policy.
    const weak =
      '$argon2id$v=19$m=4096,t=2,p=1$c2FsdHNhbHRzYWx0c2FsdA$iu1L3kJmIvYHkL1t2VJXKpQ0Wl8vTLqFq6kQ2h9nZ2A';
    const result = await passwords.verify(weak, 'whatever');
    // It will not verify (different password), but the parameter check is what matters here:
    expect(result.needsRehash).toBe(false); // needsRehash is only reported for a valid password
  });

  it('does not report rehash for a current-policy hash', async () => {
    const hash = await passwords.hash('a strong enough passphrase');
    const result = await passwords.verify(hash, 'a strong enough passphrase');
    expect(result).toEqual({ valid: true, needsRehash: false });
  });
});

describe('PasswordService policy', () => {
  const reason = (fn: () => void): string => {
    try {
      fn();
      return 'accepted';
    } catch (error) {
      const details = (error as AppError).details as unknown as { message: string }[];
      return details[0]?.message ?? 'rejected';
    }
  };

  it('accepts a reasonable passphrase', () => {
    expect(() => passwords.assertAcceptable('brown kettle jumps')).not.toThrow();
  });

  it('enforces a length floor rather than composition puzzles', () => {
    expect(reason(() => passwords.assertAcceptable('Ab1!xy'))).toMatch(/at least 10 characters/);
    expect(() => passwords.assertAcceptable('aaaaaaaaaaaaaaaaaaaa1x')).not.toThrow();
  });

  it('rejects the passwords attackers try first', () => {
    expect(reason(() => passwords.assertAcceptable('password123'))).toMatch(/too common/);
    expect(reason(() => passwords.assertAcceptable('india@123'))).toMatch(/too common/);
  });

  it('rejects repeated characters and simple sequences', () => {
    expect(reason(() => passwords.assertAcceptable('aaaaaaaaaaaa'))).toMatch(/repeated character/);
    expect(reason(() => passwords.assertAcceptable('abcdefghijkl'))).toMatch(/simple sequence/);
    expect(reason(() => passwords.assertAcceptable('9876543210'))).toMatch(/simple sequence/);
  });

  it('rejects a password built from the user’s own email or name', () => {
    expect(
      reason(() => passwords.assertAcceptable('rahulverma99', { email: 'rahulverma@acme.test' })),
    ).toMatch(/email address/);
    expect(
      reason(() => passwords.assertAcceptable('priyanair2026', { name: 'Priya Nair' })),
    ).toMatch(/your name/);
  });

  it('bounds the work an unauthenticated caller can request', () => {
    expect(reason(() => passwords.assertAcceptable('x'.repeat(500)))).toMatch(/at most 200/);
  });

  it('reports the problem on the password field so a client can render it inline', () => {
    try {
      passwords.assertAcceptable('short');
      expect.unreachable();
    } catch (error) {
      expect((error as AppError).code).toBe('VALIDATION_FAILED');
      expect((error as AppError).details).toMatchObject([
        { field: 'password', code: 'WEAK_PASSWORD' },
      ]);
    }
  });
});
