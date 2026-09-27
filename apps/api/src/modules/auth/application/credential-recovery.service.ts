import { createHash, randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { AppError, newId, withPlatformScope } from '@leados/shared';
import { DbService } from '../../../infra/db/db.service.js';
import { APP_CONFIG } from '../../../infra/config/config.module.js';
import type { AppConfig } from '../../../infra/config/config.schema.js';
import { MAILER, type MailerPort } from '../../../infra/mail/mailer.port.js';
import { requestStore } from '../../../infra/http/request-store.js';
import { PasswordService } from './password.service.js';
import { SessionService } from './session.service.js';

/**
 * Email verification and password reset (FR-IAM-1).
 *
 * Shared properties of both flows:
 *  • Only a hash of the token is stored; the plaintext exists in the email alone.
 *  • Single use, short expiry, and previous outstanding tokens are invalidated on issue.
 *  • Requesting a reset for an unknown address returns the same response as a known one —
 *    otherwise the endpoint becomes an account-enumeration oracle.
 *  • Completing a reset revokes every existing session: if the password was reset because
 *    of a compromise, leaving the attacker's session alive defeats the point.
 */
const VERIFICATION_TTL_HOURS = 72;
const RESET_TTL_MINUTES = 60;

@Injectable()
export class CredentialRecoveryService {
  constructor(
    private readonly db: DbService,
    private readonly passwords: PasswordService,
    private readonly sessions: SessionService,
    @Inject(MAILER) private readonly mailer: MailerPort,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  // ── Email verification ────────────────────────────────────────────────────

  async sendVerificationEmail(userId: string, email: string): Promise<void> {
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + VERIFICATION_TTL_HOURS * 3_600_000);

    await withPlatformScope('auth: issue email verification', async () => {
      await this.db.client.$transaction(async (tx) => {
        await tx.emailVerification.updateMany({
          where: { userId, verifiedAt: null },
          data: { expiresAt: new Date() },
        });
        await tx.emailVerification.create({
          data: { id: newId(), userId, email, tokenHash: hashToken(token), expiresAt },
        });
      });
    });

    const link = `${this.config.WEB_ORIGIN}/verify-email?token=${token}`;
    await this.mailer.send({
      to: email,
      kind: 'email_verification',
      subject: 'Confirm your email address',
      text: `Confirm your email address to finish setting up your account:\n\n${link}\n\nThis link expires in ${VERIFICATION_TTL_HOURS} hours.`,
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
    if (!user || user.deletedAt !== null || user.status === 'disabled') return;

    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + RESET_TTL_MINUTES * 60_000);

    await withPlatformScope('auth: issue password reset', async () => {
      await this.db.client.$transaction(async (tx) => {
        // Only the newest link works, so an older email cannot be replayed.
        await tx.passwordReset.updateMany({
          where: { userId: user.id, usedAt: null },
          data: { expiresAt: new Date() },
        });
        await tx.passwordReset.create({
          data: {
            id: newId(),
            userId: user.id,
            tokenHash: hashToken(token),
            requestedIp: requestStore.get()?.ip ?? null,
            expiresAt,
          },
        });
      });
    });

    const link = `${this.config.WEB_ORIGIN}/reset-password?token=${token}`;
    await this.mailer.send({
      to: user.email,
      kind: 'password_reset',
      subject: 'Reset your password',
      text: `Someone asked to reset the password for this account.\n\n${link}\n\nThis link expires in ${RESET_TTL_MINUTES} minutes. If it wasn't you, you can ignore this email.`,
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

    await this.mailer.send({
      to: record.user.email,
      kind: 'security_notice',
      subject: 'Your password was changed',
      text: 'Your password was just changed and you have been signed out on all devices. If this was not you, reset your password immediately.',
    });

    return { userId: record.userId };
  }
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
