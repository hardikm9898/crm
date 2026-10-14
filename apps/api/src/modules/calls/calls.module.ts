import { Module } from '@nestjs/common';
import { LeadContactModule } from '../lead-contact/lead-contact.module.js';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { TasksModule } from '../tasks/tasks.module.js';
import { CallOutcomesController, CallsController } from './calls.controller.js';
import { CallsService } from './calls.service.js';
import { CallOutcomesService } from './call-outcomes.service.js';
import { CallOutcomeSweepProcessor } from './calls.processor.js';

/**
 * Calls, and the vocabulary they use (`FR-CALL-1..3`).
 *
 * `TelephonyModule` is not imported: it is `@Global()`, because the port is infrastructure the way
 * storage and mail are, and a second module needing it (a provider webhook controller in Phase 4)
 * should not have to be wired to it.
 *
 * `TasksModule` because `finishFollowUp` completes a real task through `TasksService` — the outcome
 * vocabulary, the next follow-up and the reminders all belong to it, and reimplementing any of that
 * here would be a second task engine. `LeadContactModule` because a call that reached somebody is
 * a contact, written by the same service a completed follow-up uses. `NotificationsModule` for the
 * nudge sweep, which is what turns an attempt nobody recorded into a record.
 */
@Module({
  imports: [TasksModule, LeadContactModule, NotificationsModule],
  controllers: [CallsController, CallOutcomesController],
  providers: [CallsService, CallOutcomesService, CallOutcomeSweepProcessor],
  exports: [CallsService, CallOutcomeSweepProcessor],
})
export class CallsModule {}
