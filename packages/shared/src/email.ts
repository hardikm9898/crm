/**
 * Outbound email vocabulary (`FR-PRV-2`, `FR-NOT-2`, `FR-NOT-3`).
 *
 * Here because four consumers must agree: the sender that checks the suppression list, the provider
 * webhook that fills it, the notification producer that chooses the email channel, and the screen
 * that tells a workspace one of its members cannot be reached.
 */

/**
 * What an email is *for*.
 *
 * Not a template name and not a subject line: this is the thing the suppression rules reason about,
 * which is why it is a closed list rather than a free string.
 */
export const EMAIL_KINDS = [
  'email_verification',
  'password_reset',
  'security_notice',
  'invitation',
  'notification',
] as const;
export type EmailKind = (typeof EMAIL_KINDS)[number];

/**
 * The kinds somebody asked for about **their own account**, which a "stop emailing me" does not
 * cover.
 *
 * The same principle `FR-NOT-3` states one layer up — "system/security notices are not opt-out" —
 * and the reason it matters here is concrete: a complaint is a request to stop being *contacted*,
 * and treating it as consent to be locked out of your own account would turn a spam click into an
 * account you can never recover. A hard bounce is different: see `suppressionBlocks`.
 */
export const ESSENTIAL_EMAIL_KINDS: readonly EmailKind[] = [
  'email_verification',
  'password_reset',
  'security_notice',
];

export function isEssentialEmailKind(kind: string): boolean {
  return (ESSENTIAL_EMAIL_KINDS as readonly string[]).includes(kind);
}

/**
 * Where an email got to.
 *
 * `suppressed` is a real outcome and not an error: the send was refused on purpose, by us, before a
 * byte left the building. Recording it is the whole point — "the invitation never arrived" has to
 * have an answer, and "we decided not to send it, because the address bounced on the 3rd" is a
 * much better one than silence.
 */
export const EMAIL_STATUSES = [
  'queued',
  'sent',
  'delivered',
  'bounced',
  'complained',
  'failed',
  'suppressed',
] as const;
export type EmailStatus = (typeof EMAIL_STATUSES)[number];

/** The statuses that mean the provider has stopped telling us anything new. */
export const SETTLED_EMAIL_STATUSES: readonly EmailStatus[] = [
  'delivered',
  'bounced',
  'complained',
  'failed',
  'suppressed',
];

/**
 * Why an address is on the list (`docs/database-design.md` §13).
 *
 * `invalid` is ours, not a provider's: an address the sender itself could not even attempt.
 */
export const SUPPRESSION_REASONS = ['bounce', 'complaint', 'invalid', 'manual'] as const;
export type SuppressionReason = (typeof SUPPRESSION_REASONS)[number];

/** How much a suppression stops. */
export const SUPPRESSION_SCOPES = ['all', 'non_essential'] as const;
export type SuppressionScope = (typeof SUPPRESSION_SCOPES)[number];

/**
 * How much each reason stops — the decision the whole suppression list turns on.
 *
 *  * **`bounce` and `invalid` stop everything.** The mailbox does not exist. Sending anyway is a
 *    certain failure *and* a certain reputation cost, and there is no message important enough to
 *    be worth sending to an address that cannot receive it.
 *  * **`complaint` and `manual` stop everything else.** Somebody said "stop emailing me", which is
 *    about being contacted — not about the password reset they themselves asked for thirty seconds
 *    ago. Treating a spam click as consent to be locked out of your own account is the kind of
 *    literal-mindedness that loses a customer who was only annoyed.
 */
export function suppressionBlocks(reason: string): SuppressionScope {
  return reason === 'bounce' || reason === 'invalid' ? 'all' : 'non_essential';
}

/** Whether a suppression for `reason` stops an email of this `kind`. */
export function suppressionStops(reason: string, kind: string): boolean {
  return suppressionBlocks(reason) === 'all' || !isEssentialEmailKind(kind);
}

/**
 * The form an address is stored and compared in: trimmed and lower-cased, and nothing else.
 *
 * Deliberately **not** canonicalised further. Stripping dots or a `+tag` — the trick that makes
 * `a.b+news@gmail.com` and `ab@gmail.com` "the same" at one provider — would suppress addresses no
 * provider ever complained about, at every provider where they are genuinely different mailboxes.
 * A suppression list that over-matches silently stops mail somebody is waiting for.
 */
export function normaliseEmailAddress(address: string): string {
  return address.trim().toLowerCase();
}

/** A shape check, not a validator: the provider is the only thing that knows if it exists. */
export function looksLikeEmailAddress(address: string): boolean {
  const value = normaliseEmailAddress(address);
  return /^[^\s@]+@[^\s@.]+\.[^\s@]+$/.test(value) && value.length <= 320;
}

/**
 * The provider-neutral event a webhook is turned into.
 *
 * The drivers differ in wording — Postmark says `HardBounce` and `SpamComplaint`, SES says
 * `Bounce` with a `bounceType` — so the mapping lives in each driver and everything above the port
 * sees these four.
 */
export const EMAIL_EVENTS = ['delivered', 'bounced', 'complained', 'failed'] as const;
export type EmailEvent = (typeof EMAIL_EVENTS)[number];

/** The status an event moves a message to. */
export function statusForEmailEvent(event: EmailEvent): EmailStatus {
  switch (event) {
    case 'delivered':
      return 'delivered';
    case 'bounced':
      return 'bounced';
    case 'complained':
      return 'complained';
    default:
      return 'failed';
  }
}

/**
 * Whether an event should put the address on the suppression list, and why.
 *
 * A **soft** bounce (a full mailbox, a greylisting) is `failed` and suppresses nothing: the address
 * is fine and the next send will probably work. Only a hard bounce means the mailbox is gone.
 */
export function suppressionFor(event: EmailEvent): SuppressionReason | null {
  if (event === 'bounced') return 'bounce';
  if (event === 'complained') return 'complaint';
  return null;
}
