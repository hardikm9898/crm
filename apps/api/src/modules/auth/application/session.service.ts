import { Injectable } from '@nestjs/common';
import { AppError, newId, withPlatformScope } from '@leados/shared';
import { DbService } from '../../../infra/db/db.service.js';
import { requestStore } from '../../../infra/http/request-store.js';
import { TokenService } from './token.service.js';
// Prisma 7 names generated row types `<Model>Model`.
import type { SessionModel } from '@leados/db';

/**
 * Refresh-session lifecycle: creation, rotation with reuse detection, and revocation
 * (FR-IAM-2, docs/security.md §2).
 *
 * The important property is **reuse detection**. Every refresh rotates the token, so a
 * given refresh token is valid exactly once. If an already-rotated token is presented,
 * either it was stolen and replayed, or the legitimate client is racing itself — and we
 * cannot tell which. The safe response is to revoke the entire family, forcing a fresh
 * login. That converts token theft from "attacker has indefinite access" into "both
 * parties are logged out and the user is told".
 *
 * Sessions belong to the global `users` table, so every query here runs under
 * `withPlatformScope`: at refresh time there is no tenant context yet — establishing one
 * is what this flow produces.
 */

export interface IssuedSession {
  readonly sessionId: string;
  readonly refreshToken: string;
  readonly expiresAt: Date;
}

export interface RotationResult {
  readonly session: IssuedSession;
  readonly userId: string;
  readonly activeOrganizationId: string | null;
}

@Injectable()
export class SessionService {
  constructor(
    private readonly db: DbService,
    private readonly tokens: TokenService,
  ) {}

  async issue(input: {
    userId: string;
    activeOrganizationId: string | null;
    familyId?: string;
    previousSessionId?: string;
  }): Promise<IssuedSession> {
    const { token, hash } = this.tokens.generateRefreshToken();
    const sessionId = newId();
    const expiresAt = new Date(Date.now() + this.tokens.refreshTtlSeconds * 1_000);
    const request = requestStore.get();

    await withPlatformScope('auth: create refresh session', async () => {
      await this.db.client.session.create({
        data: {
          id: sessionId,
          userId: input.userId,
          familyId: input.familyId ?? sessionId,
          previousSessionId: input.previousSessionId ?? null,
          refreshTokenHash: hash,
          activeOrganizationId: input.activeOrganizationId,
          userAgent: request?.userAgent ?? null,
          ipAddress: request?.ip ?? null,
          expiresAt,
          lastUsedAt: new Date(),
        },
      });
    });

    return { sessionId, refreshToken: token, expiresAt };
  }

  /**
   * Exchanges a refresh token for a new one.
   *
   * @throws `TOKEN_REUSED` when the presented token was already rotated or revoked — the
   *         whole family is revoked first.
   */
  async rotate(refreshToken: string): Promise<RotationResult> {
    const hash = TokenService.hashToken(refreshToken);

    const session = await withPlatformScope('auth: rotate refresh session', async () =>
      this.db.client.session.findUnique({ where: { refreshTokenHash: hash } }),
    );

    if (!session) {
      throw new AppError('UNAUTHENTICATED', 'Refresh token is not recognised', 401);
    }

    if (session.revokedAt !== null) {
      // A revoked token is being replayed. If it was revoked by rotation, this is the
      // theft signal; either way, nothing in this family can be trusted any more.
      await this.revokeFamily(session.familyId, 'reuse_detected');
      throw new AppError(
        'TOKEN_REUSED',
        'This session has been ended for security reasons. Please sign in again.',
        401,
      );
    }

    if (session.expiresAt.getTime() <= Date.now()) {
      await this.revoke(session.id, 'expired');
      throw new AppError('TOKEN_EXPIRED', 'Session has expired. Please sign in again.', 401);
    }

    const next = await this.issue({
      userId: session.userId,
      activeOrganizationId: session.activeOrganizationId,
      familyId: session.familyId,
      previousSessionId: session.id,
    });

    // Rotate only after the successor exists, so a crash mid-rotation leaves the client
    // with a token that still works rather than locking them out.
    await this.revoke(session.id, 'rotated');

    return {
      session: next,
      userId: session.userId,
      activeOrganizationId: session.activeOrganizationId,
    };
  }

  async findActiveById(sessionId: string): Promise<SessionModel | null> {
    const session = await withPlatformScope('auth: load session for request', async () =>
      this.db.client.session.findUnique({ where: { id: sessionId } }),
    );
    if (!session || session.revokedAt !== null || session.expiresAt.getTime() <= Date.now()) {
      return null;
    }
    return session;
  }

  async revoke(sessionId: string, reason: string): Promise<void> {
    await withPlatformScope('auth: revoke session', async () => {
      await this.db.client.session.updateMany({
        where: { id: sessionId, revokedAt: null },
        data: { revokedAt: new Date(), revokedReason: reason },
      });
    });
  }

  /** Revokes every session descended from one login. */
  async revokeFamily(familyId: string, reason: string): Promise<number> {
    return withPlatformScope('auth: revoke session family', async () => {
      const result = await this.db.client.session.updateMany({
        where: { familyId, revokedAt: null },
        data: { revokedAt: new Date(), revokedReason: reason },
      });
      return result.count;
    });
  }

  /** Every session for a user, e.g. after a password reset or on "sign out everywhere". */
  async revokeAllForUser(userId: string, reason: string): Promise<number> {
    return withPlatformScope('auth: revoke all sessions for user', async () => {
      const result = await this.db.client.session.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: new Date(), revokedReason: reason },
      });
      return result.count;
    });
  }

  async revokeByRefreshToken(refreshToken: string, reason: string): Promise<void> {
    const hash = TokenService.hashToken(refreshToken);
    await withPlatformScope('auth: revoke by refresh token', async () => {
      await this.db.client.session.updateMany({
        where: { refreshTokenHash: hash, revokedAt: null },
        data: { revokedAt: new Date(), revokedReason: reason },
      });
    });
  }

  async setActiveOrganization(sessionId: string, organizationId: string): Promise<void> {
    await withPlatformScope('auth: switch active organization', async () => {
      await this.db.client.session.updateMany({
        where: { id: sessionId, revokedAt: null },
        data: { activeOrganizationId: organizationId, lastUsedAt: new Date() },
      });
    });
  }

  /** For the "where am I signed in" screen. Only live sessions, newest first. */
  async listForUser(userId: string): Promise<SessionModel[]> {
    return withPlatformScope('auth: list sessions', async () =>
      this.db.client.session.findMany({
        where: { userId, revokedAt: null, expiresAt: { gt: new Date() } },
        orderBy: { createdAt: 'desc' },
        take: 50,
      }),
    );
  }

  async touch(sessionId: string): Promise<void> {
    await withPlatformScope('auth: touch session', async () => {
      await this.db.client.session.updateMany({
        where: { id: sessionId },
        data: { lastUsedAt: new Date() },
      });
    });
  }
}
