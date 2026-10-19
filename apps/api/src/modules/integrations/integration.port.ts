import type { IntegrationProvider, ProbeOutcome } from '@leados/shared';

/**
 * What an adapter is handed. Never the connection row: an adapter has no business reading a
 * workspace's other columns, and a narrow argument is what makes a fake adapter in a test honest.
 */
export interface AdapterContext {
  readonly connectionId: string;
  readonly organizationId: string;
  /**
   * The decrypted secrets, by the names the provider's `credentialFields` declare.
   *
   * A map rather than one string, because Meta Lead Ads needs two that do different jobs: an app
   * secret to prove a delivery is Meta's, and a page token to fetch the lead it refers to. A single
   * `credential` would have forced the second one into `settings`, which are rendered and shown
   * back — the thing a secret must never be.
   */
  readonly secrets: Readonly<Record<string, string>>;
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

/** Why a delivery was not accepted, in the words an integrator can act on. */
export interface VerificationResult {
  readonly ok: boolean;
  readonly message?: string;
}

/**
 * One event out of one delivery.
 *
 * A delivery may carry several — Meta batches `entry[].changes[]` — and each is deduplicated on its
 * own `externalId`, because a retry of a batch of three must not turn on whether all three were new.
 */
export interface ProviderDelivery {
  /** The provider's own id for this event: Meta's `leadgen_id`, Google's `lead_id`. */
  readonly externalId: string;
  /** The provider's own name for what happened, kept so an unknown type is acknowledged, not 4xx'd. */
  readonly eventType: string;
  /**
   * The event as the capture pipeline should see it: **flattened**, in the provider's own field
   * names, so a dot path is enough to map it. Empty when the delivery is only a reference.
   */
  readonly payload: Record<string, unknown>;
}

/**
 * One provider's half of the framework.
 *
 * Everything but `validate` is optional, and each absence is a statement rather than an oversight:
 *
 *  * **`probe`** — `generic_webhook` and `google_ads_leads` are inbound connections authenticated by
 *    a secret *we* generated. There is no endpoint of theirs to call and nothing to ask, so a
 *    provider with no probe says so by not having the method rather than by throwing from it — "a
 *    port method one driver has to throw from is a lie in the contract" (`mailer.port.ts`).
 *  * **`verifyInbound`** — absent for a provider that does not post to us at all (Postmark, here).
 *    Present for the three shapes that do, which is the point: ours and Meta's are an HMAC over the
 *    raw body in a header, and Google Ads sends a key **inside** the body. A framework that assumed
 *    one shape would be reopened for each provider.
 *  * **`challenge`** — Meta will not deliver anything until the callback URL answers a `hub.challenge`
 *    echo. Nobody else does this.
 *  * **`parseDelivery`** — how one request becomes zero or more events with the provider's own ids.
 *  * **`fetchLead`** — only for a provider whose delivery is a reference. Meta sends a `leadgen_id`
 *    and the answers are a second request, with the page token.
 *
 * The registry reconciles each of these against the provider's own declarations at boot, so a
 * provider that claims `inboundVerification: 'hmac_header'` with no `verifyInbound`, or
 * `deliveryIsAReference` with no `fetchLead`, fails startup rather than answering 500 on the first
 * real delivery.
 */
export interface IntegrationAdapter {
  readonly provider: string;
  validate(input: {
    readonly secrets: Readonly<Record<string, string>>;
    readonly settings: Record<string, unknown>;
  }): void | Promise<void>;
  probe?(context: AdapterContext): Promise<ProbeResult>;
  verifyInbound?(input: {
    readonly rawBody: string;
    readonly headers: Readonly<Record<string, string | undefined>>;
    readonly body: Record<string, unknown>;
    readonly secrets: Readonly<Record<string, string>>;
    readonly settings: Record<string, unknown>;
  }): VerificationResult;
  challenge?(input: {
    readonly query: Readonly<Record<string, string | undefined>>;
    readonly secrets: Readonly<Record<string, string>>;
    readonly settings: Record<string, unknown>;
  }): string | null;
  parseDelivery?(body: Record<string, unknown>): readonly ProviderDelivery[];
  fetchLead?(input: {
    readonly externalId: string;
    readonly context: AdapterContext;
  }): Promise<Record<string, unknown>>;
}

/** A provider and the adapter that implements it, paired once so nothing has to look either up. */
export interface RegisteredProvider {
  readonly provider: IntegrationProvider;
  readonly adapter: IntegrationAdapter;
}
