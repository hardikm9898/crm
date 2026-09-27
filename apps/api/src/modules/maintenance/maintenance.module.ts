import { Module } from '@nestjs/common';
import {
  InvitationExpiryProcessor,
  OutboxReapProcessor,
  SessionPruneProcessor,
  TrialCheckProcessor,
} from './maintenance.processors.js';

/**
 * Scheduled housekeeping. No controllers: this module exists only to own processors, which the
 * composition root collects into `JOB_PROCESSORS`.
 */
@Module({
  providers: [
    SessionPruneProcessor,
    InvitationExpiryProcessor,
    TrialCheckProcessor,
    OutboxReapProcessor,
  ],
  exports: [
    SessionPruneProcessor,
    InvitationExpiryProcessor,
    TrialCheckProcessor,
    OutboxReapProcessor,
  ],
})
export class MaintenanceModule {}
