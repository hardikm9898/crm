import { Module } from '@nestjs/common';
import { IntegrationsModule } from '../integrations/integrations.module.js';
import { LeadsModule } from '../leads/leads.module.js';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { ConversationsService } from './conversations.service.js';
import { WhatsAppAccountsService } from './whatsapp-accounts.service.js';
import { WhatsAppInboundService } from './whatsapp-inbound.service.js';
import { WhatsAppMediaService } from './whatsapp-media.service.js';
import {
  WhatsAppDownloadMediaProcessor,
  WhatsAppMediaRetryProcessor,
} from './whatsapp-media.processor.js';
import { WhatsAppRateLimiter } from './whatsapp-rate-limiter.service.js';
import { WhatsAppSendService } from './whatsapp-send.service.js';
import {
  WhatsAppSendMessageProcessor,
  WhatsAppSendRetryProcessor,
} from './whatsapp-send.processor.js';
import { WhatsAppStatusService } from './whatsapp-status.service.js';
import {
  WhatsAppIngestStatusProcessor,
  WhatsAppSyncTemplatesProcessor,
} from './whatsapp-status.processor.js';
import { WhatsAppTemplatesService } from './whatsapp-templates.service.js';
import {
  ConversationsController,
  WhatsAppController,
  WhatsAppTemplatesController,
} from './whatsapp.controller.js';
import { MediaUploadInstaller } from '../../infra/http/media-body.js';
import { WhatsAppIngestMessageProcessor } from './whatsapp.processor.js';

/**
 * WhatsApp: a connected number, the messages it receives, and the replies it sends (Phase 5
 * steps 1 and 2).
 *
 * `IntegrationsModule` because the credential, the health and the inbound door all belong to the
 * integration framework — this module is the **shape** WhatsApp adds: a business account, its
 * numbers, and the conversations a message arrives into. The dependency runs this way round on
 * purpose: `IntegrationInboundService` knows only a **job name**, chosen from the provider's
 * declared capabilities, so there is no cycle and the second messaging provider needs no change to
 * the code that routes it.
 *
 * `LeadsModule` because a message from a number nobody recognises creates a lead, through
 * `LeadsService.create` — the one ingestion path `FR-CAP-4` asks for, with the duplicate rules, the
 * assignment engine, the SLA clock and the outbox events that come with it.
 *
 * `NotificationsModule` because `FR-WA-9` asks for a failed send that is never silent: the agent
 * who sent it is told, through the one method every producer in this product goes through.
 *
 * `MediaUploadInstaller` is a provider here rather than a line in `main.ts` because a Fastify hook
 * registered from the HTTP bootstrap is **absent from every application the tests build** — the
 * upload suite would then be proving the parser the running product has and the tests do not.
 */
@Module({
  imports: [IntegrationsModule, LeadsModule, NotificationsModule],
  controllers: [ConversationsController, WhatsAppController, WhatsAppTemplatesController],
  providers: [
    WhatsAppInboundService,
    WhatsAppAccountsService,
    ConversationsService,
    WhatsAppSendService,
    WhatsAppStatusService,
    WhatsAppTemplatesService,
    WhatsAppMediaService,
    WhatsAppRateLimiter,
    MediaUploadInstaller,
    WhatsAppIngestMessageProcessor,
    WhatsAppIngestStatusProcessor,
    WhatsAppSendMessageProcessor,
    WhatsAppSendRetryProcessor,
    WhatsAppSyncTemplatesProcessor,
    WhatsAppDownloadMediaProcessor,
    WhatsAppMediaRetryProcessor,
  ],
  exports: [
    WhatsAppInboundService,
    ConversationsService,
    WhatsAppSendService,
    WhatsAppStatusService,
    WhatsAppTemplatesService,
    WhatsAppIngestMessageProcessor,
    WhatsAppIngestStatusProcessor,
    WhatsAppSendMessageProcessor,
    WhatsAppSendRetryProcessor,
    WhatsAppSyncTemplatesProcessor,
    WhatsAppMediaService,
    WhatsAppDownloadMediaProcessor,
    WhatsAppMediaRetryProcessor,
  ],
})
export class WhatsAppModule {}
