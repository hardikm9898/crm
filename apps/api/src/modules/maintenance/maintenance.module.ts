import { Module } from '@nestjs/common';
import { DocumentsModule } from '../documents/documents.module.js';
import {
  DocumentExpiryProcessor,
  InvitationExpiryProcessor,
  ActivityPartitionProcessor,
  LeadRecycleProcessor,
  OutboxReapProcessor,
  SessionPruneProcessor,
  TrialCheckProcessor,
} from './maintenance.processors.js';

/**
 * Scheduled housekeeping. No controllers: this module exists only to own processors, which the
 * composition root collects into `JOB_PROCESSORS`.
 */
@Module({
  imports: [DocumentsModule],
  providers: [
    SessionPruneProcessor,
    InvitationExpiryProcessor,
    TrialCheckProcessor,
    OutboxReapProcessor,
    ActivityPartitionProcessor,
    LeadRecycleProcessor,
    DocumentExpiryProcessor,
  ],
  exports: [
    SessionPruneProcessor,
    InvitationExpiryProcessor,
    TrialCheckProcessor,
    OutboxReapProcessor,
    ActivityPartitionProcessor,
    LeadRecycleProcessor,
    DocumentExpiryProcessor,
  ],
})
export class MaintenanceModule {}
