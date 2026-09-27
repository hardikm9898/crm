import { Inject, Injectable } from '@nestjs/common';
import { newId, newToken, withPlatformScope } from '@leados/shared';
import type { Job } from 'bullmq';
import type { Logger } from 'pino';
import { DbService } from '../../../infra/db/db.service.js';
import { LOGGER } from '../../../infra/observability/logger.module.js';
import { APP_CONFIG } from '../../../infra/config/config.module.js';
import type { AppConfig } from '../../../infra/config/config.schema.js';
import { MAILER, type MailerPort } from '../../../infra/mail/mailer.port.js';
import { JOBS, QUEUES } from '../../../infra/queue/queue.constants.js';
import type { JobProcessor } from '../../../infra/queue/job-processor.js';
import type { JobPayload } from '../../../infra/queue/queue.service.js';
import { TokenService } from '../application/token.service.js';

/**
 * Credential emails — verification, reset and the "your password changed" notice — sent from the
 * queue rather than from the request.
 *
 * As with invitations, the single-use token is minted **here**, so no usable credential is ever
 * written to the outbox table or a queue payload. Both processors are safe to retry: a retry
 * supersedes the previous link.
 */
/**
 * As with invitations, the subject comes from the envelope's `aggregateId` — stable across payload
 * changes — with the payload body as a fallback for events emitted before that was relied upon.
 */
interface UserMailPayload extends JobPayload {
  readonly aggregateId?: string;
  readonly payload?: { readonly userId?: string };
}

function subjectUserId(payload: UserMailPayload): string | null {
  return payload.aggregateId ?? payload.payload?.userId ?? null;
}

const VERIFICATION_TTL_HOURS = 72;
const RESET_TTL_MINUTES = 60;

@Injectable()
export class EmailVerificationMailProcessor implements JobProcessor<UserMailPayload> {
  readonly queue = QUEUES.NOTIFICATIONS;
  readonly jobName = JOBS.MAIL_EMAIL_VERIFICATION;

  constructor(
    private readonly db: DbService,
    @Inject(MAILER) private readonly mailer: MailerPort,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  async process(payload: UserMailPayload, _job: Job): Promise<void> {
    const userId = subjectUserId(payload);
    if (!userId) {
      this.logger.error({ payload }, 'verification mail job has no user id; dropping');
      return;
    }

    const user = await withPlatformScope('verification mail: load user', async () =>
      this.db.client.user.findUnique({ where: { id: userId } }),
    );
    if (!user || user.deletedAt !== null) {
      this.logger.warn({ userId }, 'user vanished before verification email was sent');
      return;
    }
    if (user.emailVerifiedAt !== null) return; // already confirmed; nothing to ask for

    const token = newToken(32);
    await withPlatformScope('verification mail: issue token', async () => {
      await this.db.client.$transaction(async (tx) => {
        // Only the newest link works, so a superseded email cannot be replayed.
        await tx.emailVerification.updateMany({
          where: { userId, verifiedAt: null },
          data: { expiresAt: new Date() },
        });
        await tx.emailVerification.create({
          data: {
            id: newId(),
            userId,
            email: user.email,
            tokenHash: TokenService.hashToken(token),
            expiresAt: new Date(Date.now() + VERIFICATION_TTL_HOURS * 3_600_000),
          },
        });
      });
    });

    await this.mailer.send({
      to: user.email,
      kind: 'email_verification',
      subject: 'Confirm your email address',
      text:
        `Confirm your email address to finish setting up your account:\n\n` +
        `${this.config.WEB_ORIGIN}/verify-email?token=${token}\n\n` +
        `This link expires in ${VERIFICATION_TTL_HOURS} hours.`,
    });
  }
}

@Injectable()
export class PasswordResetMailProcessor implements JobProcessor<UserMailPayload> {
  readonly queue = QUEUES.NOTIFICATIONS;
  readonly jobName = JOBS.MAIL_PASSWORD_RESET;

  constructor(
    private readonly db: DbService,
    @Inject(MAILER) private readonly mailer: MailerPort,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  async process(payload: UserMailPayload, _job: Job): Promise<void> {
    const userId = subjectUserId(payload);
    if (!userId) {
      this.logger.error({ payload }, 'password reset mail job has no user id; dropping');
      return;
    }

    const user = await withPlatformScope('reset mail: load user', async () =>
      this.db.client.user.findUnique({ where: { id: userId } }),
    );
    if (!user || user.deletedAt !== null || user.status === 'disabled') {
      this.logger.warn({ userId }, 'password reset requested for an unusable account');
      return;
    }

    const token = newToken(32);
    await withPlatformScope('reset mail: issue token', async () => {
      await this.db.client.$transaction(async (tx) => {
        await tx.passwordReset.updateMany({
          where: { userId, usedAt: null },
          data: { expiresAt: new Date() },
        });
        await tx.passwordReset.create({
          data: {
            id: newId(),
            userId,
            tokenHash: TokenService.hashToken(token),
            expiresAt: new Date(Date.now() + RESET_TTL_MINUTES * 60_000),
          },
        });
      });
    });

    await this.mailer.send({
      to: user.email,
      kind: 'password_reset',
      subject: 'Reset your password',
      text:
        `Someone asked to reset the password for this account.\n\n` +
        `${this.config.WEB_ORIGIN}/reset-password?token=${token}\n\n` +
        `This link expires in ${RESET_TTL_MINUTES} minutes. If it wasn't you, you can ignore this email.`,
    });
  }
}

@Injectable()
export class SecurityNoticeMailProcessor implements JobProcessor<UserMailPayload> {
  readonly queue = QUEUES.NOTIFICATIONS;
  readonly jobName = JOBS.MAIL_SECURITY_NOTICE;

  constructor(
    private readonly db: DbService,
    @Inject(MAILER) private readonly mailer: MailerPort,
  ) {}

  async process(payload: UserMailPayload, _job: Job): Promise<void> {
    const userId = subjectUserId(payload);
    if (!userId) return;

    const user = await withPlatformScope('security notice: load user', async () =>
      this.db.client.user.findUnique({ where: { id: userId } }),
    );
    if (!user) return;

    await this.mailer.send({
      to: user.email,
      kind: 'security_notice',
      subject: 'Your password was changed',
      text:
        'Your password was just changed and you have been signed out on all devices. ' +
        'If this was not you, reset your password immediately.',
    });
  }
}
