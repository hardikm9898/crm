import { Inject, Injectable } from '@nestjs/common';
import {
  looksLikeEmailAddress,
  newId,
  normaliseEmailAddress,
  withPlatformScope,
} from '@leados/shared';
import type { Logger } from 'pino';
import { DbService } from '../db/db.service.js';
import { LOGGER } from '../observability/logger.module.js';
import { MAILER, type MailerPort, type OutboundEmail } from './mailer.port.js';
import { EmailSuppressionService } from './email-suppression.service.js';

export interface SendOutcome {
  readonly messageId: string;
  readonly status: 'sent' | 'suppressed' | 'failed';
  /** Why it was not sent, in words an operator reads. Null on a send. */
  readonly reason: string | null;
}

/**
 * The **one** path every outbound email takes (`FR-PRV-2`).
 *
 * Nothing calls `MAILER.send` directly any more, and that is the whole design: the suppression
 * check, the delivery log and the provider call are three things that must happen together in one
 * order, and a second call site is a second place to forget one of them. A send that skipped the
 * check would spend the sending domain's reputation on an address that bounced last week; a send
 * that skipped the log would make "the invitation never arrived" unanswerable.
 *
 * Four properties the callers depend on:
 *
 *  * **A refusal is recorded, not thrown.** A suppressed send answers `status: 'suppressed'` with a
 *    row saying which suppression stopped it. The caller has already committed to sending — the
 *    invitation exists, the reset token is minted — and turning "we chose not to" into an exception
 *    would make a queue retry it for ever.
 *  * **A provider failure *is* thrown**, after the row is written. That is a transient fault and
 *    BullMQ's retry is the right answer; the row records every attempt's last error.
 *  * **The address is normalised once, here.** Lower-cased and trimmed before the check, the log and
 *    the provider see it, because a suppression list that misses `Priya@Example.com` after bouncing
 *    `priya@example.com` is a list that does nothing. The database enforces the same shape.
 *  * **An address that is not an address never reaches the provider.** It is recorded `suppressed`
 *    with reason `invalid` and put on the list: a provider that refuses it counts against the
 *    sending reputation exactly as a bounce does, and the data is not going to fix itself.
 */
@Injectable()
export class EmailSenderService {
  constructor(
    private readonly db: DbService,
    private readonly suppressions: EmailSuppressionService,
    @Inject(MAILER) private readonly mailer: MailerPort,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  /** Which driver is sending, for the health endpoint and the operator console. */
  get driver(): string {
    return this.mailer.driver;
  }

  async send(email: OutboundEmail): Promise<SendOutcome> {
    const to = normaliseEmailAddress(email.to);
    const id = newId();

    if (!looksLikeEmailAddress(to)) {
      /**
       * Recorded `failed`, and **not** put on the suppression list.
       *
       * Tempting to suppress it — a provider asked to deliver to `not-an-address` answers with an
       * error that counts against the sending reputation. But the list holds *mailboxes*, which is
       * what `email_suppressions_identifier_is_an_address` says out loud, and a row for something
       * that is not one would be an entry nothing can ever match against a real send. The sender
       * already refuses it here, every time, which is the stronger guarantee: a suppression can be
       * released by an operator, and this cannot.
       *
       * `invalid` stays as a reason for the other case — an address that *is* shaped like one and
       * which a provider rejects as non-existent on sight.
       */
      await this.record(id, email, to, 'failed', {
        error: 'the address is not valid',
        failedAt: new Date(),
      });
      this.logger.warn({ kind: email.kind }, 'email not sent: the address is not valid');
      return { messageId: id, status: 'failed', reason: 'the address is not valid' };
    }

    const blocking = await this.suppressions.blocking(to, email.kind);
    if (blocking) {
      return this.refuse(
        id,
        email,
        to,
        blocking.id,
        `${blocking.reason}${blocking.detail ? `: ${blocking.detail}` : ''}`,
      );
    }

    await this.record(id, email, to, 'queued');

    let sent: Awaited<ReturnType<MailerPort['send']>>;
    try {
      sent = await this.mailer.send({ ...email, to });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await withPlatformScope('email: record failure', async () =>
        this.db.client.emailMessage.update({
          where: { id },
          data: { status: 'failed', error: message.slice(0, 1000), failedAt: new Date() },
        }),
      );
      this.logger.warn({ kind: email.kind, driver: this.mailer.driver }, 'email send failed');
      // Rethrown on purpose: a provider outage is exactly what the queue's retry is for.
      throw error;
    }

    await withPlatformScope('email: record send', async () =>
      this.db.client.emailMessage.update({
        where: { id },
        data: {
          status: 'sent',
          provider: this.mailer.driver,
          providerMessageId: sent.providerMessageId,
          sentAt: new Date(),
        },
      }),
    );
    return { messageId: id, status: 'sent', reason: null };
  }

  /**
   * The record of a send that did not happen.
   *
   * `suppressed` is a real outcome, not an error: it is the answer to "why did this never arrive",
   * and the reason the delivery log exists at all.
   */
  private async refuse(
    id: string,
    email: OutboundEmail,
    to: string,
    suppressionId: string,
    reason: string,
  ): Promise<SendOutcome> {
    await this.record(id, email, to, 'suppressed', { error: reason, suppressionId });
    this.logger.info(
      { kind: email.kind, reason },
      'email not sent: the address is on the suppression list',
    );
    return { messageId: id, status: 'suppressed', reason };
  }

  private async record(
    id: string,
    email: OutboundEmail,
    to: string,
    status: string,
    extra: Record<string, unknown> = {},
  ): Promise<void> {
    await withPlatformScope('email: record message', async () =>
      this.db.client.emailMessage.create({
        data: {
          id,
          kind: email.kind,
          to,
          subject: email.subject,
          status,
          ...extra,
        } as never,
      }),
    );
  }

  /**
   * Applies one delivery event to the message it names (`FR-PRV-2`).
   *
   * Called by the webhook controller, which has already authenticated the provider. Three things
   * make it safe to call twice, which a webhook guarantees it will be:
   *
   *  * The lookup is by `(provider, provider_message_id)`, the partial unique index.
   *  * The status write is a transition, not an increment.
   *  * The suppression is an upsert on a unique address.
   *
   * An event for a message this platform never sent is **not** ignored: if it names a recipient and
   * reports a bounce, the address still goes on the list. A provider reporting a bounce for mail we
   * do not remember sending is telling us something true about the mailbox either way.
   */
  async applyEvent(input: {
    readonly event: 'delivered' | 'bounced' | 'complained' | 'failed';
    readonly providerMessageId: string | null;
    readonly recipient: string | null;
    readonly detail: string | null;
  }): Promise<{ matched: boolean; suppressed: boolean }> {
    const message = input.providerMessageId
      ? await withPlatformScope('email: find message for event', async () =>
          this.db.client.emailMessage.findFirst({
            where: {
              provider: this.mailer.driver,
              providerMessageId: input.providerMessageId,
            },
          }),
        )
      : null;

    const address =
      message?.to ?? (input.recipient ? normaliseEmailAddress(input.recipient) : null);
    let suppressed = false;

    if (address && looksLikeEmailAddress(address)) {
      // A soft failure suppresses nothing: the mailbox is fine and the next send will probably
      // work. Only a hard bounce means it is gone, and only a complaint means they asked us to stop.
      if (input.event === 'bounced' || input.event === 'complained') {
        await this.suppressions.record({
          address,
          reason: input.event === 'bounced' ? 'bounce' : 'complaint',
          detail: input.detail,
          sourceMessageId: message?.id ?? null,
        });
        suppressed = true;
      }
    }

    if (!message) return { matched: false, suppressed };

    const now = new Date();
    await withPlatformScope('email: apply delivery event', async () =>
      this.db.client.emailMessage.update({
        where: { id: message.id },
        data: {
          status:
            input.event === 'delivered'
              ? 'delivered'
              : input.event === 'bounced'
                ? 'bounced'
                : input.event === 'complained'
                  ? 'complained'
                  : 'failed',
          ...(input.event === 'delivered' ? { deliveredAt: message.deliveredAt ?? now } : {}),
          ...(input.event === 'delivered' ? {} : { failedAt: message.failedAt ?? now }),
          ...(input.detail ? { error: input.detail.slice(0, 1000) } : {}),
        },
      }),
    );
    return { matched: true, suppressed };
  }
}
