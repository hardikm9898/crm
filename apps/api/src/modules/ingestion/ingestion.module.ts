import { Module } from '@nestjs/common';
import { CustomFieldsModule } from '../custom-fields/custom-fields.module.js';
import { LeadsModule } from '../leads/leads.module.js';
import { IngestAuthService } from './ingest-auth.service.js';
import { IngestionController } from './ingestion.controller.js';
import { IdempotencyPruneProcessor } from './ingestion.processor.js';
import { IngestionService } from './ingestion.service.js';
import { PublicIngestController } from './public-ingest.controller.js';

/**
 * The public lead API, and the store of everything it has been sent.
 *
 * The keys **left** this module in step 4, which is the moment its previous note said to split
 * them out: a key now carries permission scopes for the authenticated REST surface as well, so it
 * is a credential for the whole product rather than for this endpoint, and it lives in
 * `ApiKeysModule` with the authenticator the global guard calls and the request log. What stays
 * here is `IngestAuthService` — this endpoint's own order of checks, its signature, and its
 * `ingest:*` scopes.
 *
 * `LeadsModule` because a capture goes through `LeadsService.create`, the one ingestion path
 * `FR-CAP-4` asks for; `CustomFieldsModule` because a payload's `customFields` are resolved
 * against the workspace's own definitions by key.
 */
@Module({
  imports: [LeadsModule, CustomFieldsModule],
  controllers: [IngestionController, PublicIngestController],
  providers: [IngestionService, IngestAuthService, IdempotencyPruneProcessor],
  exports: [IngestionService, IngestAuthService, IdempotencyPruneProcessor],
})
export class IngestionModule {}
