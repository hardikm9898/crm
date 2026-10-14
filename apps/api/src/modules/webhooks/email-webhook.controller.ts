import { Body, Controller, Headers, HttpCode, Inject, Post } from '@nestjs/common';
import { AppError } from '@leados/shared';
import type { Logger } from 'pino';
import { Public } from '../auth/guards/public.decorator.js';
import { APP_CONFIG } from '../../infra/config/config.module.js';
import type { AppConfig } from '../../infra/config/config.schema.js';
import { EncryptionService } from '../../infra/crypto/encryption.service.js';
import { LOGGER } from '../../infra/observability/logger.module.js';
import { EmailSenderService } from '../../infra/mail/email-sender.service.js';
import { MAILER, type MailerPort } from '../../infra/mail/mailer.port.js';

/**
 * The provider's delivery webhook (`FR-PRV-2`).
 *
 * **The only writer of the suppression list**, which is what makes its authentication the whole
 * story: an open endpoint here lets anybody stop a workspace's mail by posting a bounce for its
 * owner's address. So the secret is required by configuration the moment a real driver is set
 * (`EMAIL_WEBHOOK_SECRET`, checked at boot), compared in constant time, and a request without it is
 * refused before the body is read for anything.
 *
 * `@Public()` because a provider has no session — and declared, not defaulted: a route that forgot
 * to say so fails at boot by design.
 *
 * Three behaviours worth knowing:
 *
 *  * **It answers 200 to an event it does not understand.** An open, a click, or a record type a
 *    later provider release adds is not an error, and a 4xx teaches the provider to retry and then
 *    disable the endpoint — which would silently stop the suppression list being filled.
 *  * **It is idempotent.** Every write underneath is a transition or an upsert on a unique key, so
 *    the at-least-once delivery a provider promises costs nothing.
 *  * **An event for a message we never sent still suppresses.** A bounce is a fact about the
 *    mailbox; forgetting the send does not make the mailbox work.
 */
@Public()
@Controller('webhooks/email')
export class EmailWebhookController {
  constructor(
    private readonly sender: EmailSenderService,
    @Inject(MAILER) private readonly mailer: MailerPort,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  @Post()
  @HttpCode(200)
  async receive(@Headers('x-webhook-secret') presented: string | undefined, @Body() body: unknown) {
    this.authenticate(presented);

    const events = this.mailer.parseEvent(body);
    let matched = 0;
    let suppressed = 0;
    for (const event of events) {
      const result = await this.sender.applyEvent(event);
      if (result.matched) matched += 1;
      if (result.suppressed) suppressed += 1;
    }

    if (events.length > 0) {
      this.logger.info(
        { driver: this.mailer.driver, events: events.length, matched, suppressed },
        'email delivery events applied',
      );
    }
    // The counts are the provider's receipt, and the operator's: "we sent you three events, two
    // matched a message we remember" is the first thing to check when a bounce does not stick.
    return { received: events.length, matched, suppressed };
  }

  /**
   * The secret, compared in constant time.
   *
   * With the development driver and no secret configured the endpoint is open, deliberately: it is
   * how the whole bounce path is exercised locally, and `EMAIL_DRIVER=log` already refuses to run
   * in production. With any real driver the secret is mandatory at boot, so there is no deployment
   * in which this is both reachable and unauthenticated.
   */
  private authenticate(presented: string | undefined): void {
    const expected = this.config.EMAIL_WEBHOOK_SECRET;
    if (!expected) {
      if (this.config.EMAIL_DRIVER === 'log') return;
      throw AppError.internal('The email webhook secret is not configured');
    }
    if (!presented || !EncryptionService.safeEqual(presented, expected)) {
      // Not "unauthorized": a webhook endpoint that distinguishes a missing secret from a wrong one
      // is an oracle for guessing it.
      throw AppError.notFound('Webhook');
    }
  }
}
