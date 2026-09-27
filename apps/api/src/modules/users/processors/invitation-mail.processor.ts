import { Inject, Injectable } from '@nestjs/common';
import { newToken, withPlatformScope } from '@leados/shared';
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
import { TokenService } from '../../auth/application/token.service.js';

/**
 * Sends an invitation email, triggered by the `invitation.sent` domain event.
 *
 * **The token is minted here, not by the request.** A single-use credential in a queue payload or
 * in the outbox table would be a durable secret sitting in two more places than it needs to; so
 * the invitation row is created with an unusable placeholder hash, and this processor generates
 * the real token, records its hash, and puts the plaintext only in the email.
 *
 * Idempotency: a retry mints a fresh token and replaces the hash, which invalidates any link from
 * a previous attempt. That is the correct outcome — the recipient uses whichever email arrived —
 * and it keeps at-most-one usable link per invitation.
 */
/**
 * The subject is taken from the event envelope's `aggregateId`, which is part of the outbox
 * contract, rather than from a field inside `payload`. Payload bodies evolve; the envelope does
 * not — and an event emitted by an older release must still be processable.
 */
interface InvitationMailPayload extends JobPayload {
  readonly aggregateId?: string;
  readonly payload?: { readonly invitationId?: string };
}

const INVITATION_TTL_HOURS = 72;

@Injectable()
export class InvitationMailProcessor implements JobProcessor<InvitationMailPayload> {
  readonly queue = QUEUES.NOTIFICATIONS;
  readonly jobName = JOBS.MAIL_INVITATION;

  constructor(
    private readonly db: DbService,
    @Inject(MAILER) private readonly mailer: MailerPort,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  async process(payload: InvitationMailPayload, _job: Job): Promise<void> {
    const invitationId = payload.aggregateId ?? payload.payload?.invitationId;
    if (!invitationId) {
      // Nothing identifies the invitation, so no retry can help. Recorded and dropped rather than
      // burning five attempts on a payload that will never be valid.
      this.logger.error({ payload }, 'invitation mail job has no invitation id; dropping');
      return;
    }

    const invitation = await withPlatformScope('invitation mail: load invitation', async () =>
      this.db.client.invitation.findUnique({
        where: { id: invitationId },
        include: { role: { select: { name: true } }, organization: { select: { name: true } } },
      }),
    );

    if (!invitation) {
      // Deleted between enqueue and delivery. Nothing to send and nothing to retry.
      this.logger.warn({ invitationId }, 'invitation vanished before its email was sent');
      return;
    }
    if (invitation.status !== 'pending' || invitation.revokedAt !== null) {
      this.logger.info(
        { invitationId, status: invitation.status },
        'invitation no longer pending; not sending',
      );
      return;
    }

    const token = newToken(32);
    const expiresAt = new Date(Date.now() + INVITATION_TTL_HOURS * 3_600_000);

    await withPlatformScope('invitation mail: store token hash', async () => {
      await this.db.client.invitation.update({
        where: { id: invitationId },
        data: { tokenHash: TokenService.hashToken(token), expiresAt },
      });
    });

    await this.mailer.send({
      to: invitation.email,
      kind: 'invitation',
      subject: `You have been invited to ${invitation.organization.name}`,
      text:
        `You have been invited to join ${invitation.organization.name} as ${invitation.role.name}.\n\n` +
        `${this.config.WEB_ORIGIN}/accept-invitation?token=${token}\n\n` +
        `This invitation expires in ${INVITATION_TTL_HOURS} hours.`,
    });
  }
}
