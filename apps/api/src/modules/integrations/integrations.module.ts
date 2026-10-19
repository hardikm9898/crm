import { Module } from '@nestjs/common';
import { IngestionModule } from '../ingestion/ingestion.module.js';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { GenericWebhookAdapter } from './adapters/generic-webhook.adapter.js';
import { GoogleAdsLeadsAdapter } from './adapters/google-ads-leads.adapter.js';
import { MetaLeadAdsAdapter } from './adapters/meta-lead-ads.adapter.js';
import { PostmarkAdapter } from './adapters/postmark.adapter.js';
import { WhatsAppCloudAdapter } from './adapters/whatsapp-cloud.adapter.js';
import { IntegrationHealthService } from './integration-health.service.js';
import { IntegrationInboundController } from './integration-inbound.controller.js';
import { IntegrationInboundService } from './integration-inbound.service.js';
import { IntegrationRegistryService } from './integration-registry.service.js';
import { IntegrationVaultService } from './integration-vault.service.js';
import { IntegrationsController } from './integrations.controller.js';
import {
  IntegrationHealthCheckProcessor,
  IntegrationIngestEventProcessor,
  IntegrationRetrySweepProcessor,
} from './integrations.processor.js';
import { IntegrationsService } from './integrations.service.js';

/**
 * The integration framework: a provider registry, a credential vault, per-connection health checks
 * and the generic mapping templates (Phase 4's own words for its scope).
 *
 * `IngestionModule` because an inbound connection's payload goes through `IngestionService.capture`
 * — the one pipeline `FR-CAP-4` asks for, with the never-lose store, the idempotency guarantee, the
 * duplicate rules and the timeline that come with it. Writing a second capture path here would be
 * a second answer to "what happens when a lead arrives", and the one that is wrong is always the
 * one nothing runs.
 *
 * `NotificationsModule` because a credential that has been refused is somebody's email or lead
 * capture silently stopping, and the one message that says so must reach the people who can fix it.
 *
 * Nothing is exported but the service and the processor: the vault is deliberately reachable only
 * from inside this module, because a credential's plaintext has no business leaving it.
 */
@Module({
  imports: [IngestionModule, NotificationsModule],
  controllers: [IntegrationsController, IntegrationInboundController],
  providers: [
    PostmarkAdapter,
    GenericWebhookAdapter,
    MetaLeadAdsAdapter,
    GoogleAdsLeadsAdapter,
    WhatsAppCloudAdapter,
    IntegrationRegistryService,
    IntegrationVaultService,
    IntegrationHealthService,
    IntegrationsService,
    IntegrationInboundService,
    IntegrationHealthCheckProcessor,
    IntegrationIngestEventProcessor,
    IntegrationRetrySweepProcessor,
  ],
  exports: [
    IntegrationsService,
    IntegrationInboundService,
    // Exported because `WhatsAppAccountsService` discovers a WABA's numbers through it. An adapter
    // speaks HTTP and returns domain-shaped results; the module that owns the tables persists.
    WhatsAppCloudAdapter,
    IntegrationHealthCheckProcessor,
    IntegrationIngestEventProcessor,
    IntegrationRetrySweepProcessor,
  ],
})
export class IntegrationsModule {}
