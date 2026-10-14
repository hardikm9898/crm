import { Inject, Injectable } from '@nestjs/common';
import { newId } from '@leados/shared';
import type { Logger } from 'pino';
import { LOGGER } from '../observability/logger.module.js';
import { APP_CONFIG } from '../config/config.module.js';
import type { AppConfig } from '../config/config.schema.js';
import type { MailerPort, OutboundEmail, ParsedEmailEvent, SentEmail } from './mailer.port.js';

/**
 * Development mailer: writes the message to the log instead of sending it, so the verification,
 * reset and invitation flows are usable end to end before an email provider is wired up.
 *
 * It refuses to run in production. A silently-not-sending mailer in production would mean users
 * never receive password resets while everything appears to succeed — so the process fails loudly
 * instead.
 *
 * It still returns a **message id**, and the delivery log still records the send. That is what lets
 * the whole bounce path be exercised locally: the operator posts a webhook naming that id and
 * watches the address land on the suppression list. A driver that answered `null` would make the
 * one mechanism worth testing untestable without a provider account.
 */
@Injectable()
export class LoggingMailer implements MailerPort {
  readonly driver = 'log';
  readonly sends = false;

  constructor(
    @Inject(LOGGER) private readonly logger: Logger,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {
    if (config.NODE_ENV === 'production') {
      throw new Error(
        'LoggingMailer must not be used in production: set EMAIL_DRIVER to a real provider.',
      );
    }
  }

  async send(email: OutboundEmail): Promise<SentEmail> {
    // The body carries single-use tokens, so this is only acceptable outside production
    // (guarded in the constructor) and is logged at debug level.
    const providerMessageId = `dev-${newId()}`;
    this.logger.debug(
      {
        kind: email.kind,
        to: email.to,
        subject: email.subject,
        body: email.text,
        providerMessageId,
      },
      '[dev mailer] email not sent — logged only',
    );
    return { providerMessageId };
  }

  /**
   * Reads the same shape the real driver does, so a local webhook exercises the real path.
   *
   * Deliberately a *tolerant* reader rather than a second format: `{ event, providerMessageId,
   * recipient?, detail? }`, which is the parsed shape itself. Inventing a third vocabulary for the
   * development driver would mean the thing tested locally is not the thing that runs.
   */
  parseEvent(body: unknown): readonly ParsedEmailEvent[] {
    const rows = Array.isArray(body) ? body : [body];
    const parsed: ParsedEmailEvent[] = [];
    for (const row of rows) {
      if (row === null || typeof row !== 'object') continue;
      const record = row as Record<string, unknown>;
      const event = record['event'];
      if (
        event !== 'delivered' &&
        event !== 'bounced' &&
        event !== 'complained' &&
        event !== 'failed'
      ) {
        continue;
      }
      parsed.push({
        event,
        providerMessageId:
          typeof record['providerMessageId'] === 'string' ? record['providerMessageId'] : null,
        recipient: typeof record['recipient'] === 'string' ? record['recipient'] : null,
        detail: typeof record['detail'] === 'string' ? record['detail'] : null,
      });
    }
    return parsed;
  }
}
