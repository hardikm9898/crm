import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { ApiKeyAuthService } from './api-key-auth.service.js';
import { ApiKeysController } from './api-keys.controller.js';
import { ApiKeysService } from './api-keys.service.js';
import { ApiLogHookInstaller } from './api-log.installer.js';
import { ApiLogService } from './api-log.service.js';
import { ApiLogPartitionProcessor } from './api-log.processor.js';
import { ApiLogsController } from './api-logs.controller.js';

/**
 * The developer platform's credential, and what it did (`FR-API-1`, `FR-API-2`, `FR-SA-4`).
 *
 * The keys lived in `IngestionModule` while the public endpoint was the only surface they could
 * reach, with a note saying to split them out when keys started carrying scopes for the
 * authenticated REST surface. This is that moment: a key is now a credential for the whole product,
 * so it has its own module, together with the authenticator the global guard calls and the request
 * log that makes an integration debuggable from the outside.
 *
 * `IngestAuthService` stays in `IngestionModule`: the public endpoint's order of checks, its
 * signature and its `ingest:*` scopes are that endpoint's, and the two authenticators share the
 * key **table** rather than a code path — which is deliberate, because "the same checks in a
 * different order" is how one of them quietly loses one.
 *
 * `AuthModule` is imported for `PrincipalService`: a key acts as the member who created it, with
 * that member's current grants resolved on every request.
 */
@Module({
  imports: [AuthModule],
  controllers: [ApiKeysController, ApiLogsController],
  providers: [
    ApiKeysService,
    ApiKeyAuthService,
    ApiLogService,
    ApiLogHookInstaller,
    ApiLogPartitionProcessor,
  ],
  exports: [ApiKeysService, ApiKeyAuthService, ApiLogService, ApiLogPartitionProcessor],
})
export class ApiKeysModule {}
