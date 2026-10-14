import { Module } from '@nestjs/common';
import { ApiKeysController } from '../api-keys/api-keys.controller.js';
import { ApiKeysService } from '../api-keys/api-keys.service.js';
import { CustomFieldsModule } from '../custom-fields/custom-fields.module.js';
import { LeadsModule } from '../leads/leads.module.js';
import { IngestAuthService } from './ingest-auth.service.js';
import { IngestionController } from './ingestion.controller.js';
import { IdempotencyPruneProcessor } from './ingestion.processor.js';
import { IngestionService } from './ingestion.service.js';
import { PublicIngestController } from './public-ingest.controller.js';

/**
 * The public lead API, its credentials, and the log of everything it has been sent.
 *
 * The keys live in this module rather than in one of their own because they exist **for** this
 * endpoint: the scopes are `ingest:*`, the only authenticator that reads them is here, and a
 * separate module would be two places to look for one feature. When the authenticated REST surface
 * arrives (`FR-API-1`) and keys start carrying read scopes for it, that is the moment to split
 * them out — not before.
 *
 * `LeadsModule` because a capture goes through `LeadsService.create`, the one ingestion path
 * `FR-CAP-4` asks for; `CustomFieldsModule` because a payload's `customFields` are resolved
 * against the workspace's own definitions by key.
 */
@Module({
  imports: [LeadsModule, CustomFieldsModule],
  controllers: [IngestionController, PublicIngestController, ApiKeysController],
  providers: [IngestionService, IngestAuthService, ApiKeysService, IdempotencyPruneProcessor],
  exports: [IngestionService, ApiKeysService, IdempotencyPruneProcessor],
})
export class IngestionModule {}
