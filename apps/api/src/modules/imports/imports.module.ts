import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { CustomFieldsModule } from '../custom-fields/custom-fields.module.js';
import { DocumentsModule } from '../documents/documents.module.js';
import { DuplicatesModule } from '../duplicates/duplicates.module.js';
import { LeadsModule } from '../leads/leads.module.js';
import { ImportCatalogueService } from './import-catalogue.service.js';
import { ImportRunnerService } from './import-runner.service.js';
import { ImportProcessProcessor } from './imports.processor.js';
import { ImportsController } from './imports.controller.js';
import { ImportsService } from './imports.service.js';

/**
 * Imports.
 *
 * Imports `LeadsModule` because an imported lead is created through the same service as a manual
 * one — duplicate rules, assignment, timeline, outbox and all (`FR-IO-2`). `AuthModule` is here for
 * `PrincipalService`: a background run acts as the person who asked for it, so it has to be able to
 * rebuild their permissions and data scope without a session.
 */
@Module({
  imports: [LeadsModule, DuplicatesModule, DocumentsModule, CustomFieldsModule, AuthModule],
  controllers: [ImportsController],
  providers: [ImportsService, ImportCatalogueService, ImportRunnerService, ImportProcessProcessor],
  exports: [ImportsService, ImportRunnerService, ImportProcessProcessor],
})
export class ImportsModule {}
