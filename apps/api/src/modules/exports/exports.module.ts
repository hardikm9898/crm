import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { CustomFieldsModule } from '../custom-fields/custom-fields.module.js';
import { DocumentsModule } from '../documents/documents.module.js';
import { ViewsModule } from '../views/views.module.js';
import { ExportGeneratorService } from './export-generator.service.js';
import { ExportGenerateProcessor } from './exports.processor.js';
import { ExportsController } from './exports.controller.js';
import { ExportsService } from './exports.service.js';

/**
 * Exports.
 *
 * `ViewsModule` for the filter compiler and saved views — exporting "what I am looking at" has to
 * run the same filter the list ran — and `AuthModule` for `PrincipalService`, because the file is
 * generated with the requester's own data scope rather than a system principal's.
 */
@Module({
  imports: [ViewsModule, DocumentsModule, CustomFieldsModule, AuthModule],
  controllers: [ExportsController],
  providers: [ExportsService, ExportGeneratorService, ExportGenerateProcessor],
  exports: [ExportsService, ExportGeneratorService, ExportGenerateProcessor],
})
export class ExportsModule {}
