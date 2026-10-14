import type { EmailEvent, EmailKind } from '@leados/shared';

/**
 * Outbound email, behind a port so the provider is swappable
 * (`docs/integration-architecture.md` §2, ADR-0028).
 *
 * The contract is written from what the **product** needs, not from what any provider offers:
 *
 *  * **`send` answers with the provider's own message id**, because that id is the only way a
 *    delivery webhook can find the row it is about. A port that returned `void` — which this one
 *    did until Phase 3 step 7 — makes a bounce unattributable, and an unattributable bounce is a
 *    suppression list that can never be filled.
 *  * **`parseEvent` turns a provider's payload into one of four words.** Postmark says `HardBounce`
 *    and `SpamComplaint`, SES says `Bounce` with a `bounceType` — so the vocabulary differs per
 *    driver and the mapping belongs *in* the driver. Everything above the port sees `delivered`,
 *    `bounced`, `complained`, `failed`.
 *  * **Nothing above the port writes a row.** `EmailSenderService` does, before and after asking,
 *    so a provider failure leaves a record of the attempt rather than nothing.
 *
 * What is deliberately **not** here: templates (a provider's template store is a second place for
 * the copy to live), scheduled sends (the queue already does that, and better), and anything that
 * reads from the provider. A port method one driver has to throw from is a lie in the contract.
 */

export interface OutboundEmail {
  /** Lower-cased by the sender before it gets here; the database enforces it too. */
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  /** Machine-readable kind, for the delivery log and the suppression rules. */
  readonly kind: EmailKind;
  /** Set when the message is about a notification, so a reply-to can differ. */
  readonly replyTo?: string;
}

export interface SentEmail {
  /** The provider's id for this message. `null` only from a driver that does not send. */
  readonly providerMessageId: string | null;
}

/**
 * One delivery event, as the product understands it.
 *
 * `providerMessageId` is how it finds its message; a payload that carries none is one nothing can
 * be done with, and the webhook says so rather than guessing from the address.
 */
export interface ParsedEmailEvent {
  readonly event: EmailEvent;
  readonly providerMessageId: string | null;
  /** The address the provider reported, for the suppression row when the message is unknown. */
  readonly recipient: string | null;
  /** What the provider actually said — "mailbox full", "user unknown". */
  readonly detail: string | null;
}

export interface MailerPort {
  /** Which driver is in use, for the health endpoint and the delivery log's `provider` column. */
  readonly driver: string;
  /** Whether this driver actually puts mail on the wire. `false` for the development logger. */
  readonly sends: boolean;
  send(email: OutboundEmail): Promise<SentEmail>;
  /**
   * Reads a webhook body. Returns `[]` for an event this driver does not care about — an open, a
   * click — rather than throwing: a provider adding an event type must not start failing webhooks.
   */
  parseEvent(body: unknown): readonly ParsedEmailEvent[];
}

export const MAILER = Symbol('MAILER');
