import { describe, expect, it } from 'vitest';
import { readRefreshToken, rewriteRefreshCookiePath } from './refresh-cookie';

describe('rewriteRefreshCookiePath', () => {
  it('replaces the API path with one this app actually serves', () => {
    const rewritten = rewriteRefreshCookiePath(
      'leados_rt=abc; Path=/api/v1/auth; HttpOnly; SameSite=Lax; Max-Age=2592000',
    );
    expect(rewritten).toContain('Path=/');
    expect(rewritten).not.toContain('/api/v1/auth');
  });

  it('keeps every other attribute, so httpOnly and the lifetime survive the relay', () => {
    const rewritten = rewriteRefreshCookiePath(
      'leados_rt=abc; Path=/api/v1/auth; HttpOnly; SameSite=Lax',
    );
    expect(rewritten).toContain('HttpOnly');
    expect(rewritten).toContain('SameSite=Lax');
    expect(rewritten).toContain('leados_rt=abc');
  });

  it('adds a path when the cookie has none', () => {
    expect(rewriteRefreshCookiePath('leados_rt=abc; HttpOnly')).toContain('Path=/');
  });

  it('matches the attribute case-insensitively, because servers spell it either way', () => {
    expect(rewriteRefreshCookiePath('leados_rt=abc; path=/api/v1/auth')).toContain('Path=/');
  });
});

describe('readRefreshToken', () => {
  it('finds the token among other cookies', () => {
    expect(readRefreshToken('leados_at=xyz; leados_rt=abc; other=1')).toBe('abc');
  });

  it('decodes a percent-encoded value', () => {
    expect(readRefreshToken('leados_rt=a%2Bb')).toBe('a+b');
  });

  it('returns null when the cookie is absent or the header is missing', () => {
    expect(readRefreshToken('leados_at=xyz')).toBeNull();
    expect(readRefreshToken(null)).toBeNull();
  });

  it('does not match a cookie whose name merely ends with the same letters', () => {
    expect(readRefreshToken('not_leados_rt=abc')).toBeNull();
  });
});
