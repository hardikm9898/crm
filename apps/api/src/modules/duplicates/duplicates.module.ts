import { Module } from '@nestjs/common';
import { SlaModule } from '../sla/sla.module.js';
import { DuplicateDetectionService } from './duplicate-detection.service.js';
import { DuplicatesController } from './duplicates.controller.js';
import { DuplicatesService } from './duplicates.service.js';
import { MergeService } from './merge.service.js';

/**
 * Duplicate detection and merge. `DuplicateDetectionService` is exported because lead creation runs
 * it on the write path, inside the transaction that would otherwise create a second record.
 */
@Module({
  imports: [SlaModule],
  controllers: [DuplicatesController],
  providers: [DuplicateDetectionService, DuplicatesService, MergeService],
  exports: [DuplicateDetectionService, MergeService],
})
export class DuplicatesModule {}
