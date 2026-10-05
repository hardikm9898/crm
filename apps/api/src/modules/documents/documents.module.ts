import { Module } from '@nestjs/common';
import { DocumentsService } from './documents.service.js';

/**
 * Documents. No controller: a file is always reached through the thing that owns it — an import's
 * error file, an export's download — because that is where the permission belongs. A generic
 * `GET /documents/:id` would have to invent one.
 */
@Module({
  providers: [DocumentsService],
  exports: [DocumentsService],
})
export class DocumentsModule {}
