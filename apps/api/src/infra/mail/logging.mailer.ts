import { Inject, Injectable } from '@nestjs/common';
import type { Logger } from 'pino';
import { LOGGER } from '../observability/logger.module.js';
import { APP_CONFIG } from '../config/config.module.js';
import type { AppConfig } from '../config/config.schema.js';
import type { MailerPort, OutboundEmail } from './mailer.port.js';

/**
 * Development mailer: writes the message to the log instead of sending it, so the
 * verification and reset flows are usable end to end before an email provider is wired up.
 *
 * It refuses to run in production. A silently-not-sending mailer in production would mean
 * users never receive password resets while everything appears to succeed — so the process
 * fails loudly instead.
 */
@Injectable()
export class LoggingMailer implements MailerPort {
  constructor(
    @Inject(LOGGER) private readonly logger: Logger,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {
    if (config.NODE_ENV === 'production') {
      throw new Error(
        'LoggingMailer must not be used in production: configure a real email provider adapter.',
      );
    }
  }

  async send(email: OutboundEmail): Promise<void> {
    // The body carries single-use tokens, so this is only acceptable outside production
    // (guarded in the constructor) and is logged at debug level.
    this.logger.debug(
      { kind: email.kind, to: email.to, subject: email.subject, body: email.text },
      '[dev mailer] email not sent — logged only',
    );
  }
}
