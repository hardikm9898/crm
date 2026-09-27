import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { AppError, withPlatformScope } from '@leados/shared';
import { DbService } from '../../../infra/db/db.service.js';
import { OutboxService } from '../../../infra/outbox/outbox.service.js';
import { PasswordService } from './password.service.js';
import { SessionService } from './session.service.js';

/**
 * Email verification and password reset (FR-IAM-1).
 *
 * **Sending happens in a worker, not here.** The request records the intent as a domain event and
 * returns; the processor mints the single-use token and sends the email. Two reasons: an HTTP
 * handler must never wait on an email provider (Rule 17), and a token that is minted at send time
 * never exists in the outbox table or a queue payload.
 *
 * Shared properties of both flows (token minting and TTLs live in the processors):
 *  • Only a hash of the token is stored; the plaintext exists in the email alone.
 *  • Single use, and previous outstanding tokens are invalidated on issue.
 *  • Requesting a reset for an unknown address returns the same response as a known one —
 *    otherwise the endpoint becomes an account-enumeration oracle.
 *  • Completing a reset revokes every existing session: if the password was reset because
 *    of a compromise, leaving the attacker's session alive defeats the point.
 */
@Injectable()
export class CredentialRecoveryService {
  constructor(
    private readonly db: DbService,
    private readonly passwords: PasswordService,
    private readonly sessions: SessionService,
    private readonly outbox: OutboxService,
  ) {}

  // ── Email verification ────────────────────────────────────────────────────

  /**
   * Requests a verification email. Enqueued through the outbox, so the send survives a crash
   * between this transaction and delivery.
   */
  async requestEmailVerification(userId: string, email: string): Promise<void> {
    await withPlatformScope('auth: request email verification', async () => {
      await this.db.client.$transaction(async (tx) => {
        await this.outbox.emit(
          tx,
          [
            {
              name: 'user.registered',
              aggregateType: 'user',
              aggregateId: userId,
              payload: { userId, email },
            },
          ],
          { organizationId: null },
        );
      });
    });
  }

  async verifyEmail(token: string): Promise<{ userId: string; email: string }> {
    return withPlatformScope('auth: verify email', async () => {
      const record = await this.db.client.emailVerification.findUnique({
        where: { tokenHash: hashToken(token) },
      });
      if (!record || record.verifiedAt !== null || record.expiresAt.getTime() <= Date.now()) {
        throw new AppError(
          'VALIDATION_FAILED',
          'This confirmation link is invalid or has expired. Request a new one.',
          400,
        );
      }

      await this.db.client.$transaction(async (tx) => {
        await tx.emailVerification.update({
          where: { id: record.id },
          data: { verifiedAt: new Date() },
        });
        await tx.user.update({
          where: { id: record.userId },
          // Confirming an address also activates an invited account.
          data: { emailVerifiedAt: new Date(), email: record.email, status: 'active' },
        });
      });

      return { userId: record.userId, email: record.email };
    });
  }

  // ── Password reset ────────────────────────────────────────────────────────

  /** Always succeeds from the caller's point of view — see the enumeration note above. */
  async requestPasswordReset(email: string): Promise<void> {
    const normalized = email.trim().toLowerCase();
    const user = await withPlatformScope('auth: find user for reset', async () =>
      this.db.client.user.findUnique({ where: { email: normalized } }),
    );
    // Returning early for an unknown or disabled account keeps the response identical either way.
    if (!user || user.deletedAt !== null || user.status === 'disabled') return;

    await withPlatformScope('auth: request password reset', async () => {
      await this.db.client.$transaction(async (tx) => {
        await this.outbox.emit(
          tx,
          [
            {
              name: 'user.password_reset_requested',
              aggregateType: 'user',
              aggregateId: user.id,
              payload: { userId: user.id },
            },
          ],
          { organizationId: null },
        );
      });
    });
  }

  async resetPassword(token: string, newPassword: string): Promise<{ userId: string }> {
    const record = await withPlatformScope('auth: load password reset', async () =>
      this.db.client.passwordReset.findUnique({
        where: { tokenHash: hashToken(token) },
        include: { user: { select: { id: true, email: true, name: true } } },
      }),
    );

    if (!record || record.usedAt !== null || record.expiresAt.getTime() <= Date.now()) {
      throw new AppError(
        'VALIDATION_FAILED',
        'This reset link is invalid or has expired. Request a new one.',
        400,
      );
    }

    this.passwords.assertAcceptable(newPassword, {
      email: record.user.email,
      name: record.user.name,
    });
    const passwordHash = await this.passwords.hash(newPassword);

    await withPlatformScope('auth: apply password reset', async () => {
      await this.db.client.$transaction(async (tx) => {
        // Conditional update: a token cannot be spent twice, even under a race.
        const claimed = await tx.passwordReset.updateMany({
          where: { id: record.id, usedAt: null },
          data: { usedAt: new Date() },
        });
        if (claimed.count === 0) {
          throw new AppError('CONFLICT', 'This reset link has already been used', 409);
        }
        await tx.user.update({ where: { id: record.userId }, data: { passwordHash } });
      });
    });

    // The reset may be a response to a compromise; existing sessions must not survive it.
    await this.sessions.revokeAllForUser(record.userId, 'password_reset');

    await withPlatformScope('auth: notify password change', async () => {
      await this.db.client.$transaction(async (tx) => {
        await this.outbox.emit(
          tx,
          [
            {
              name: 'user.password_changed',
              aggregateType: 'user',
              aggregateId: record.userId,
              payload: { userId: record.userId },
            },
          ],
          { organizationId: null },
        );
      });
    });

    return { userId: record.userId };
  }
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
