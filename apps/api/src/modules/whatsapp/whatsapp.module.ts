import { Module } from '@nestjs/common';
import { IntegrationsModule } from '../integrations/integrations.module.js';
import { LeadsModule } from '../leads/leads.module.js';
import { ConversationsService } from './conversations.service.js';
import { WhatsAppAccountsService } from './whatsapp-accounts.service.js';
import { WhatsAppInboundService } from './whatsapp-inbound.service.js';
import { ConversationsController, WhatsAppController } from './whatsapp.controller.js';
import { WhatsAppIngestMessageProcessor } from './whatsapp.processor.js';

/**
 * WhatsApp: a connected number, and the messages it receives (Phase 5 step 1).
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
 */
@Module({
  imports: [IntegrationsModule, LeadsModule],
  controllers: [ConversationsController, WhatsAppController],
  providers: [
    WhatsAppInboundService,
    WhatsAppAccountsService,
    ConversationsService,
    WhatsAppIngestMessageProcessor,
  ],
  exports: [WhatsAppInboundService, ConversationsService, WhatsAppIngestMessageProcessor],
})
export class WhatsAppModule {}
