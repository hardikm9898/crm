/**
 * Outbound email, behind a port so the provider is swappable
 * (docs/integration-architecture.md §2). A real provider adapter (SES/Postmark) plus
 * bounce/complaint webhooks feeding the suppression list arrives in Phase 3.
 */
export interface OutboundEmail {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  /** Machine-readable kind, for delivery logs and per-type preferences. */
  readonly kind: 'email_verification' | 'password_reset' | 'invitation' | 'security_notice';
}

export interface MailerPort {
  send(email: OutboundEmail): Promise<void>;
}

export const MAILER = Symbol('MAILER');
