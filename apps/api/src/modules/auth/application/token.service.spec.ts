import { describe, expect, it } from 'vitest';
import { AppError } from '@leados/shared';
import { TokenService, parseDuration } from './token.service.js';
import type { AppConfig } from '../../../infra/config/config.schema.js';

const config = {
  JWT_ACCESS_SECRET: 'a'.repeat(48),
  JWT_REFRESH_SECRET: 'b'.repeat(48),
  ACCESS_TOKEN_TTL: '15m',
  REFRESH_TOKEN_TTL: '30d',
} as AppConfig;

const tokens = new TokenService(config);

describe('parseDuration', () => {
  it('reads the documented duration shorthand', () => {
    expect(parseDuration('30s')).toBe(30);
    expect(parseDuration('15m')).toBe(900);
    expect(parseDuration('2h')).toBe(7_200);
    expect(parseDuration('30d')).toBe(2_592_000);
    expect(parseDuration('45')).toBe(45);
  });

  it('rejects nonsense rather than silently defaulting', () => {
    expect(() => parseDuration('soon')).toThrow(/Invalid duration/);
    expect(() => parseDuration('10y')).toThrow(/Invalid duration/);
  });
});

describe('access tokens', () => {
  it('round-trips identity claims', async () => {
    const token = await tokens.signAccessToken({
      userId: 'user-1',
      organizationId: 'org-1',
      sessionId: 'session-1',
    });
    const claims = await tokens.verifyAccessToken(token);
    expect(claims.sub).toBe('user-1');
    expect(claims.org).toBe('org-1');
    expect(claims.sid).toBe('session-1');
    expect(claims.typ).toBe('access');
  });

  it('carries no permissions, so revoking a role does not wait for expiry', async () => {
    const token = await tokens.signAccessToken({
      userId: 'user-1',
      organizationId: 'org-1',
      sessionId: 'session-1',
    });
    const payload = JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString()) as Record<
      string,
      unknown
    >;
    expect(payload['permissions']).toBeUndefined();
    expect(payload['roles']).toBeUndefined();
    expect(Object.keys(payload).sort()).toEqual(
      ['aud', 'exp', 'iat', 'iss', 'jti', 'org', 'sid', 'sub', 'typ'].sort(),
    );
  });

  it('rejects a tampered token', async () => {
    const token = await tokens.signAccessToken({
      userId: 'u',
      organizationId: 'o',
      sessionId: 's',
    });
    const [header, payload, signature] = token.split('.');
    const forged = JSON.parse(Buffer.from(payload!, 'base64url').toString()) as Record<
      string,
      unknown
    >;
    forged['org'] = 'another-org';
    const tamperedPayload = Buffer.from(JSON.stringify(forged)).toString('base64url');
    await expect(
      tokens.verifyAccessToken(`${header}.${tamperedPayload}.${signature}`),
    ).rejects.toThrow(AppError);
  });

  it('rejects a token signed with the refresh secret', async () => {
    // Mint an MFA challenge (signed with the refresh secret) and try to use it as access.
    const challenge = await tokens.signMfaChallenge('user-1');
    await expect(tokens.verifyAccessToken(challenge)).rejects.toThrow(/Invalid access token/);
  });

  it('rejects garbage', async () => {
    await expect(tokens.verifyAccessToken('not.a.token')).rejects.toThrow(AppError);
    await expect(tokens.verifyAccessToken('')).rejects.toThrow(AppError);
  });
});

describe('mfa challenge tokens', () => {
  it('round-trips the subject', async () => {
    const challenge = await tokens.signMfaChallenge('user-9');
    expect((await tokens.verifyMfaChallenge(challenge)).sub).toBe('user-9');
  });

  it('cannot be satisfied by an access token', async () => {
    const access = await tokens.signAccessToken({
      userId: 'u',
      organizationId: 'o',
      sessionId: 's',
    });
    await expect(tokens.verifyMfaChallenge(access)).rejects.toThrow(/challenge is invalid/);
  });
});

describe('refresh tokens', () => {
  it('are opaque, unique, and stored only as a hash', () => {
    const first = tokens.generateRefreshToken();
    const second = tokens.generateRefreshToken();

    expect(first.token).not.toBe(second.token);
    expect(first.token).toMatch(/^[A-Za-z0-9_-]{43}$/); // 32 bytes, base64url
    expect(first.hash).toHaveLength(64); // sha256 hex
    expect(first.hash).not.toContain(first.token);
    expect(TokenService.hashToken(first.token)).toBe(first.hash);
  });
});
