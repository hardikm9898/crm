import type { IntegrationProvider, ProbeOutcome } from '@leados/shared';

/**
 * What an adapter is handed. Never the connection row: an adapter has no business reading a
 * workspace's other columns, and a narrow argument is what makes a fake adapter in a test honest.
 */
export interface AdapterContext {
  readonly connectionId: string;
  readonly organizationId: string;
  /** The decrypted credential. Held for the duration of the call and never logged. */
  readonly credential: string;
  /** The non-secret configuration the provider's `settings` describe. */
  readonly settings: Record<string, unknown>;
  readonly externalAccountId: string | null;
}

/** What a probe found, as `integration_health_checks` records it. */
export interface ProbeResult {
  readonly outcome: ProbeOutcome;
  /** How long the provider took. Null when nothing was reached at all. */
  readonly latencyMs: number | null;
  /** The provider's own words and anything else worth keeping. **Never** a credential. */
  readonly detail: Record<string, unknown>;
}

/**
 * One provider's half of the framework.
 *
 * `probe` is **optional**, deliberately. `generic_webhook` is an inbound connection authenticated
 * by a secret *we* generated: there is no endpoint to call and nothing to ask, so a provider with
 * no probe says so by not having the method rather than by throwing from it — "a port method one
 * driver has to throw from is a lie in the contract" (`mailer.port.ts`). The registry reads
 * `probeEveryMinutes` from the provider and the presence of `probe` here, and a disagreement
 * between the two fails at boot rather than producing a sweep that probes nothing.
 *
 * `validate` runs **before** anything is stored, with the credential in hand: a Postmark token
 * that is not a token, or a from-address the provider will refuse, is a 400 at connect time rather
 * than a connection whose first real send fails silently at 3am.
 */
export interface IntegrationAdapter {
  readonly provider: string;
  validate(input: {
    readonly credential: string;
    readonly settings: Record<string, unknown>;
  }): void | Promise<void>;
  probe?(context: AdapterContext): Promise<ProbeResult>;
}

/** A provider and the adapter that implements it, paired once so nothing has to look either up. */
export interface RegisteredProvider {
  readonly provider: IntegrationProvider;
  readonly adapter: IntegrationAdapter;
}
