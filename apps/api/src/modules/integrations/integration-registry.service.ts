import { Inject, Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import { AppError, INTEGRATION_PROVIDERS, type IntegrationProvider } from '@leados/shared';
import type { Logger } from 'pino';
import { LOGGER } from '../../infra/observability/logger.module.js';
import { GenericWebhookAdapter } from './adapters/generic-webhook.adapter.js';
import { GoogleAdsLeadsAdapter } from './adapters/google-ads-leads.adapter.js';
import { MetaLeadAdsAdapter } from './adapters/meta-lead-ads.adapter.js';
import { PostmarkAdapter } from './adapters/postmark.adapter.js';
import { WhatsAppCloudAdapter } from './adapters/whatsapp-cloud.adapter.js';
import type { IntegrationAdapter, RegisteredProvider } from './integration.port.js';

/**
 * The provider registry (Phase 4's "provider registry").
 *
 * `INTEGRATION_PROVIDERS` in `@leados/shared` is the **catalogue** — what the screen offers and
 * what a mapping may say. This is where each entry meets the code that implements it, and the
 * reason it is a service with an `onApplicationBootstrap` rather than a plain map:
 *
 *  * **A provider with no adapter fails at boot**, like a route with no authorization declaration.
 *    The alternative is a connect button that answers 500 the first time somebody presses it —
 *    a screen offering a button that cannot work, which is the half-built shape this codebase
 *    keeps paying for. The check runs inside `app.init()`, so the e2e harness runs it too.
 *  * **So does a `probeEveryMinutes` with no `probe`.** The health sweep reads the cadence from the
 *    catalogue and the capability from the adapter; a provider that claims a cadence and cannot be
 *    probed would make the sweep a no-op that looks scheduled — the silent failure
 *    `docs/queue-event-architecture.md` §5 exists to make visible. The converse is allowed: an
 *    adapter *may* implement `probe` and ask never to be probed on a schedule, which is what a
 *    manual "test this connection" button is.
 */
@Injectable()
export class IntegrationRegistryService implements OnApplicationBootstrap {
  private readonly adapters = new Map<string, IntegrationAdapter>();

  constructor(
    postmark: PostmarkAdapter,
    genericWebhook: GenericWebhookAdapter,
    metaLeadAds: MetaLeadAdsAdapter,
    googleAdsLeads: GoogleAdsLeadsAdapter,
    whatsappCloud: WhatsAppCloudAdapter,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {
    for (const adapter of [postmark, genericWebhook, metaLeadAds, googleAdsLeads, whatsappCloud]) {
      this.adapters.set(adapter.provider, adapter);
    }
  }

  onApplicationBootstrap(): void {
    const missing: string[] = [];
    const unprobeable: string[] = [];
    const unverifiable: string[] = [];
    const unreadable: string[] = [];
    const unfetchable: string[] = [];
    const incoherent: string[] = [];
    for (const provider of INTEGRATION_PROVIDERS) {
      const adapter = this.adapters.get(provider.key);
      if (!adapter) {
        missing.push(provider.key);
        continue;
      }
      if (provider.probeEveryMinutes !== null && adapter.probe === undefined) {
        unprobeable.push(provider.key);
      }
      // The same reconciliation, for every other thing a provider declares about itself. Each of
      // these is a 500 on the first real delivery if it is wrong, and a boot failure if it is
      // checked — which is the trade this check exists to make.
      if (provider.inboundVerification !== 'none' && adapter.verifyInbound === undefined) {
        unverifiable.push(provider.key);
      }
      // Keyed on what the provider **declares** its deliveries are, not on a near-synonym: a
      // provider whose body names its own events needs the parser that reads them, and one whose
      // body is a single lead must not have one — the stub returning `[]` that satisfied an
      // `inboundVerification`-based check is exactly how the status-receipt 400 hid.
      if (provider.deliveryShape === 'events' && adapter.parseDelivery === undefined) {
        unreadable.push(provider.key);
      }
      if (provider.deliveryShape === 'none' && provider.inboundVerification !== 'none') {
        incoherent.push(provider.key);
      }
      if (provider.deliveryShape !== 'none' && provider.inboundVerification === 'none') {
        incoherent.push(provider.key);
      }
      if (provider.deliveryIsAReference && adapter.fetchLead === undefined) {
        unfetchable.push(provider.key);
      }
    }
    const orphans = [...this.adapters.keys()].filter(
      (key) => !INTEGRATION_PROVIDERS.some((provider) => provider.key === key),
    );

    const faults = [
      ...missing.map((key) => `${key} is in the catalogue with no adapter`),
      ...unprobeable.map((key) => `${key} asks to be probed and its adapter cannot be`),
      ...unverifiable.map((key) => `${key} declares an inbound verification its adapter cannot do`),
      ...unreadable.map((key) => `${key} accepts deliveries its adapter cannot read`),
      ...unfetchable.map((key) => `${key} says its delivery is a reference and cannot fetch a lead`),
      ...incoherent.map(
        (key) => `${key}'s delivery shape and its inbound verification disagree about whether it posts to us`,
      ),
      ...orphans.map((key) => `${key} has an adapter and is not in the catalogue`),
    ];
    if (faults.length > 0) {
      // Thrown, not logged: Nest hides boot errors behind `process.abort()` unless the application
      // is built with `abortOnError: false` — which the tests do — so this is a failing suite in CI
      // and a dead process in production, both of which are better than a dead button.
      throw new Error(`the integration registry is inconsistent: ${faults.join('; ')}`);
    }
    this.logger.debug(
      { providers: INTEGRATION_PROVIDERS.map((provider) => provider.key) },
      'integration providers registered',
    );
  }

  /** The catalogue, for the screen. */
  providers(): readonly IntegrationProvider[] {
    return INTEGRATION_PROVIDERS;
  }

  /** The pair, or a 400 naming what a client asked for — never an undefined somebody dereferences. */
  require(key: string): RegisteredProvider {
    const provider = INTEGRATION_PROVIDERS.find((entry) => entry.key === key);
    const adapter = this.adapters.get(key);
    if (!provider || !adapter) {
      throw AppError.validation('That is not a provider we can connect', [
        {
          field: 'provider',
          code: 'UNKNOWN_PROVIDER',
          message: `Choose one of: ${INTEGRATION_PROVIDERS.map((entry) => entry.key).join(', ')}.`,
        },
      ]);
    }
    return { provider, adapter };
  }

  /** Whether this provider can be asked anything at all — what the health sweep selects on. */
  canProbe(key: string): boolean {
    return this.adapters.get(key)?.probe !== undefined;
  }
}
