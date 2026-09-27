import { createHash, randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { Secret, TOTP } from 'otpauth';
import { AppError, newId, withPlatformScope } from '@leados/shared';
import { DbService } from '../../../infra/db/db.service.js';
import { EncryptionService } from '../../../infra/crypto/encryption.service.js';

/**
 * TOTP multi-factor authentication (FR-IAM-1).
 *
 * Decisions worth stating:
 *  • The shared secret is **encrypted at rest** (AES-256-GCM, bound to the user id by
 *    AAD), so a database dump does not hand over everyone's second factor.
 *  • Enrolment is two-step: generating a secret does not enable MFA. The user must prove
 *    they can produce a code first, otherwise a mistyped setup locks them out.
 *  • Recovery codes are hashed and single-use — the documented way back in when the
 *    authenticator is lost, instead of a support ticket that bypasses MFA.
 *  • A one-step clock-skew window is allowed. Wider windows materially weaken TOTP.
 */
const ISSUER = 'Lead OS';
const RECOVERY_CODE_COUNT = 10;
const SKEW_WINDOW = 1;

export interface MfaEnrolment {
  readonly secret: string;
  readonly otpauthUrl: string;
}

@Injectable()
export class MfaService {
  constructor(
    private readonly db: DbService,
    private readonly encryption: EncryptionService,
  ) {}

  /** Step 1: generate and store a secret, without enabling MFA yet. */
  async beginEnrolment(userId: string, email: string): Promise<MfaEnrolment> {
    const secret = new Secret({ size: 20 });
    const totp = this.totp(secret.base32, email);

    await withPlatformScope('auth: store pending mfa secret', async () => {
      await this.db.client.user.update({
        where: { id: userId },
        data: {
          mfaSecretEncrypted: this.encryption.encrypt(secret.base32, this.aad(userId)),
          mfaEnabled: false,
          mfaEnrolledAt: null,
        },
      });
    });

    return { secret: secret.base32, otpauthUrl: totp.toString() };
  }

  /** Step 2: prove the authenticator works, then enable MFA and issue recovery codes. */
  async confirmEnrolment(userId: string, email: string, code: string): Promise<string[]> {
    const secret = await this.loadSecret(userId);
    if (!secret) throw AppError.businessRule('Start multi-factor setup before confirming it');
    if (!this.verifyCode(secret, email, code)) {
      throw new AppError('VALIDATION_FAILED', 'That code is not valid. Please try again.', 400);
    }

    const codes = Array.from({ length: RECOVERY_CODE_COUNT }, () => formatRecoveryCode());

    await withPlatformScope('auth: enable mfa', async () => {
      await this.db.client.$transaction(async (tx) => {
        await tx.user.update({
          where: { id: userId },
          data: { mfaEnabled: true, mfaEnrolledAt: new Date() },
        });
        // Replace any codes from a previous enrolment: old ones must stop working.
        await tx.mfaRecoveryCode.deleteMany({ where: { userId } });
        await tx.mfaRecoveryCode.createMany({
          data: codes.map((code) => ({ id: newId(), userId, codeHash: hashRecoveryCode(code) })),
        });
      });
    });

    return codes;
  }

  async disable(userId: string): Promise<void> {
    await withPlatformScope('auth: disable mfa', async () => {
      await this.db.client.$transaction(async (tx) => {
        await tx.user.update({
          where: { id: userId },
          data: { mfaEnabled: false, mfaSecretEncrypted: null, mfaEnrolledAt: null },
        });
        await tx.mfaRecoveryCode.deleteMany({ where: { userId } });
      });
    });
  }

  /** Accepts either a TOTP code or an unused recovery code. */
  async verifyChallenge(
    userId: string,
    email: string,
    code: string,
  ): Promise<{ method: 'totp' | 'recovery_code'; remainingRecoveryCodes?: number }> {
    const normalized = code.replace(/[\s-]/g, '');

    const secret = await this.loadSecret(userId);
    if (secret && this.verifyCode(secret, email, normalized)) return { method: 'totp' };

    const consumed = await this.consumeRecoveryCode(userId, normalized);
    if (consumed !== null) {
      return { method: 'recovery_code', remainingRecoveryCodes: consumed };
    }

    throw new AppError('UNAUTHENTICATED', 'That verification code is not valid', 401);
  }

  async countUnusedRecoveryCodes(userId: string): Promise<number> {
    return withPlatformScope('auth: count recovery codes', async () =>
      this.db.client.mfaRecoveryCode.count({ where: { userId, usedAt: null } }),
    );
  }

  private async consumeRecoveryCode(userId: string, code: string): Promise<number | null> {
    return withPlatformScope('auth: consume recovery code', async () => {
      const hash = hashRecoveryCode(code);
      // Conditional update: two parallel uses of one code cannot both succeed.
      const result = await this.db.client.mfaRecoveryCode.updateMany({
        where: { userId, codeHash: hash, usedAt: null },
        data: { usedAt: new Date() },
      });
      if (result.count === 0) return null;
      return this.db.client.mfaRecoveryCode.count({ where: { userId, usedAt: null } });
    });
  }

  private async loadSecret(userId: string): Promise<string | null> {
    const user = await withPlatformScope('auth: load mfa secret', async () =>
      this.db.client.user.findUnique({
        where: { id: userId },
        select: { mfaSecretEncrypted: true },
      }),
    );
    if (!user?.mfaSecretEncrypted) return null;
    return this.encryption.decrypt(user.mfaSecretEncrypted, this.aad(userId));
  }

  private verifyCode(secretBase32: string, email: string, code: string): boolean {
    if (!/^\d{6}$/.test(code)) return false;
    return this.totp(secretBase32, email).validate({ token: code, window: SKEW_WINDOW }) !== null;
  }

  private totp(secretBase32: string, email: string): TOTP {
    return new TOTP({
      issuer: ISSUER,
      label: email,
      algorithm: 'SHA1', // what every authenticator app implements
      digits: 6,
      period: 30,
      secret: Secret.fromBase32(secretBase32),
    });
  }

  private aad(userId: string): string {
    return `mfa:${userId}`;
  }
}

function formatRecoveryCode(): string {
  // Crockford-ish alphabet: no O/0 or I/1 confusion when a user reads one off paper.
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(10);
  const chars = [...bytes].map((byte) => alphabet[byte % alphabet.length]).join('');
  return `${chars.slice(0, 5)}-${chars.slice(5, 10)}`;
}

function hashRecoveryCode(code: string): string {
  return createHash('sha256').update(code.toUpperCase().replace(/[\s-]/g, '')).digest('hex');
}
