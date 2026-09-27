import { createHash, randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { SignJWT, jwtVerify, type JWTPayload } from 'jose';
import { AppError, newId } from '@leados/shared';
import { APP_CONFIG } from '../../../infra/config/config.module.js';
import type { AppConfig } from '../../../infra/config/config.schema.js';

/**
 * Token minting and verification (docs/security.md §2).
 *
 * Access tokens are short-lived JWTs carrying only identity: subject, active
 * organization and session id. **Permissions are deliberately not in the token** — they
 * are loaded per request from a version-keyed cache, so revoking a role takes effect
 * immediately instead of when the token expires, and tokens stay small.
 *
 * Refresh tokens are opaque random values; only their SHA-256 hash is stored, so a
 * database read cannot be replayed as a session.
 *
 * Note: HS256 with separate access/refresh secrets, not RS256 as Phase 0 sketched.
 * RS256 earns its key-management cost when a *second* party must verify tokens without
 * being able to mint them; today the API is the only verifier. The claim set and this
 * interface are unchanged by a later switch.
 */

export type TokenPurpose = 'access' | 'mfa_challenge';

export interface AccessTokenClaims extends JWTPayload {
  sub: string;
  org: string | null;
  sid: string;
  typ: TokenPurpose;
}

export interface MfaChallengeClaims extends JWTPayload {
  sub: string;
  typ: 'mfa_challenge';
}

@Injectable()
export class TokenService {
  private readonly accessSecret: Uint8Array;
  private readonly refreshSecret: Uint8Array;
  readonly accessTtlSeconds: number;
  readonly refreshTtlSeconds: number;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    const encoder = new TextEncoder();
    this.accessSecret = encoder.encode(config.JWT_ACCESS_SECRET);
    this.refreshSecret = encoder.encode(config.JWT_REFRESH_SECRET);
    this.accessTtlSeconds = parseDuration(config.ACCESS_TOKEN_TTL);
    this.refreshTtlSeconds = parseDuration(config.REFRESH_TOKEN_TTL);
  }

  async signAccessToken(input: {
    userId: string;
    organizationId: string | null;
    sessionId: string;
  }): Promise<string> {
    return new SignJWT({ org: input.organizationId, sid: input.sessionId, typ: 'access' })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject(input.userId)
      .setJti(newId())
      .setIssuedAt()
      .setIssuer('leados')
      .setAudience('leados-api')
      .setExpirationTime(`${this.accessTtlSeconds}s`)
      .sign(this.accessSecret);
  }

  async verifyAccessToken(token: string): Promise<AccessTokenClaims> {
    try {
      const { payload } = await jwtVerify(token, this.accessSecret, {
        issuer: 'leados',
        audience: 'leados-api',
      });
      if (payload['typ'] !== 'access') throw new Error('wrong token type');
      return payload as AccessTokenClaims;
    } catch (error) {
      const expired = error instanceof Error && error.message.includes('exp');
      throw new AppError(
        expired ? 'TOKEN_EXPIRED' : 'UNAUTHENTICATED',
        expired ? 'Access token has expired' : 'Invalid access token',
        401,
      );
    }
  }

  /**
   * Short-lived token proving "password accepted, second factor still owed". Signed with
   * the refresh secret so it can never be mistaken for an access token.
   */
  async signMfaChallenge(userId: string): Promise<string> {
    return new SignJWT({ typ: 'mfa_challenge' })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject(userId)
      .setJti(newId())
      .setIssuedAt()
      .setIssuer('leados')
      .setAudience('leados-mfa')
      .setExpirationTime('5m')
      .sign(this.refreshSecret);
  }

  async verifyMfaChallenge(token: string): Promise<MfaChallengeClaims> {
    try {
      const { payload } = await jwtVerify(token, this.refreshSecret, {
        issuer: 'leados',
        audience: 'leados-mfa',
      });
      if (payload['typ'] !== 'mfa_challenge') throw new Error('wrong token type');
      return payload as MfaChallengeClaims;
    } catch {
      throw new AppError('UNAUTHENTICATED', 'Multi-factor challenge is invalid or expired', 401);
    }
  }

  /** Opaque refresh token: the plaintext goes to the client, the hash to the database. */
  generateRefreshToken(): { token: string; hash: string } {
    const token = randomBytes(32).toString('base64url');
    return { token, hash: TokenService.hashToken(token) };
  }

  /**
   * SHA-256, not Argon2: these are 256-bit random values, so there is nothing to
   * brute-force, and lookup by hash must be a fast indexed read.
   */
  static hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }
}

export function parseDuration(value: string): number {
  const match = /^(\d+)\s*([smhd])?$/.exec(value.trim());
  if (!match) throw new Error(`Invalid duration: ${value}`);
  const amount = Number(match[1]);
  const multiplier = { s: 1, m: 60, h: 3_600, d: 86_400 }[match[2] ?? 's'] ?? 1;
  return amount * multiplier;
}
