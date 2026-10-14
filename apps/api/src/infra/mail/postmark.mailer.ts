import { Inject, Injectable } from '@nestjs/common';
import type { Logger } from 'pino';
import { LOGGER } from '../observability/logger.module.js';
import { APP_CONFIG } from '../config/config.module.js';
import type { AppConfig } from '../config/config.schema.js';
import type { MailerPort, OutboundEmail, ParsedEmailEvent, SentEmail } from './mailer.port.js';

/**
 * Postmark, over plain HTTPS (`FR-PRV-2`, ADR-0028).
 *
 * Chosen as the first real driver for two reasons that have nothing to do with the provider's
 * marketing: its send is **one JSON POST**, so there is no SDK to pin and no transitive dependency
 * tree inside the thing that sends password resets; and its delivery webhook carries the message id
 * it was given, which is what makes a bounce attributable at all.
 *
 * It is deliberately thin. Templates, tagging, batching and the message-stream API are all things
 * the provider offers and the product does not need: every one of them would be a second place for
 * the copy or the schedule to live.
 */
@Injectable()
export class PostmarkMailer implements MailerPort {
  readonly driver = 'postmark';
  readonly sends = true;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  async send(email: OutboundEmail): Promise<SentEmail> {
    const response = await fetch(`${this.config.POSTMARK_API_URL}/email`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        'X-Postmark-Server-Token': this.config.POSTMARK_SERVER_TOKEN ?? '',
      },
      body: JSON.stringify({
        From: this.config.EMAIL_FROM,
        To: email.to,
        Subject: email.subject,
        TextBody: email.text,
        ...((email.replyTo ?? this.config.EMAIL_REPLY_TO)
          ? { ReplyTo: email.replyTo ?? this.config.EMAIL_REPLY_TO }
          : {}),
        /**
         * Postmark's own suppression list is left to do its job as well as ours.
         *
         * Two lists sounds like one too many; it is not. Theirs protects the shared sending IP and
         * answers with a 406 we must not retry. Ours is what lets the product *say* why a message
         * was not sent, which an opaque 406 three weeks later cannot.
         */
        TrackOpens: false,
      }),
    });

    const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok) {
      // The provider's own words, kept: "inactive recipient" and "invalid email" are different
      // problems with different answers, and a generic failure message loses both.
      const message =
        typeof body['Message'] === 'string' ? body['Message'] : `HTTP ${response.status}`;
      this.logger.warn(
        { status: response.status, code: body['ErrorCode'], kind: email.kind },
        'postmark refused a send',
      );
      throw new Error(`postmark: ${message}`);
    }

    return {
      providerMessageId: typeof body['MessageID'] === 'string' ? body['MessageID'] : null,
    };
  }

  /**
   * Postmark's webhook vocabulary, mapped to the product's four words.
   *
   * The distinction that matters is **hard versus soft**: `HardBounce` and `BadEmailAddress` mean
   * the mailbox is gone and belong on the suppression list; `SoftBounce`, `Transient` and
   * `DnsError` mean try again later and must not. A driver that collapsed them would quietly stop
   * mailing somebody whose inbox was full for an afternoon.
   */
  parseEvent(body: unknown): readonly ParsedEmailEvent[] {
    const rows = Array.isArray(body) ? body : [body];
    const parsed: ParsedEmailEvent[] = [];

    for (const row of rows) {
      if (row === null || typeof row !== 'object') continue;
      const record = row as Record<string, unknown>;
      const type = typeof record['RecordType'] === 'string' ? record['RecordType'] : '';
      const providerMessageId =
        typeof record['MessageID'] === 'string' ? record['MessageID'] : null;
      const recipient =
        typeof record['Email'] === 'string'
          ? record['Email']
          : typeof record['Recipient'] === 'string'
            ? record['Recipient']
            : null;
      const detail =
        typeof record['Description'] === 'string'
          ? record['Description']
          : typeof record['Details'] === 'string'
            ? record['Details']
            : null;

      if (type === 'Delivery') {
        parsed.push({ event: 'delivered', providerMessageId, recipient, detail });
        continue;
      }
      if (type === 'SpamComplaint') {
        parsed.push({ event: 'complained', providerMessageId, recipient, detail });
        continue;
      }
      if (type === 'SubscriptionChange') {
        // Somebody used the provider's own unsubscribe link. That is a complaint in everything but
        // name, and ignoring it would have us keep sending what they just asked us to stop.
        if (record['SuppressSending'] === true) {
          parsed.push({ event: 'complained', providerMessageId, recipient, detail });
        }
        continue;
      }
      if (type === 'Bounce') {
        const bounceType = typeof record['Type'] === 'string' ? record['Type'] : '';
        // An unsubscribe arrives as a *bounce* type in Postmark's vocabulary and is nothing of the
        // kind: the mailbox is fine and the person asked us to stop. Suppressing it as a bounce
        // would block the password reset they request next week.
        const event =
          bounceType === 'Unsubscribe'
            ? 'complained'
            : HARD_BOUNCE_TYPES.includes(bounceType)
              ? 'bounced'
              : 'failed';
        parsed.push({ event, providerMessageId, recipient, detail: detail ?? bounceType });
        continue;
      }
      // Open, Click, anything a later Postmark release adds: not an error, just not ours.
    }

    return parsed;
  }
}

/**
 * The bounce types that mean the mailbox does not exist.
 *
 * Everything else Postmark reports — `SoftBounce`, `Transient`, `DnsError`, `SpamNotification`,
 * `Blocked` — is a reason to try again or to look at the sending domain, not a reason to stop
 * writing to this person for ever. `Unsubscribe` is handled above: it arrives as a bounce type and
 * is a request, not a failure.
 */
const HARD_BOUNCE_TYPES: readonly string[] = ['HardBounce', 'BadEmailAddress'];
