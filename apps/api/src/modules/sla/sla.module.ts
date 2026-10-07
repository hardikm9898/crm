import { Module } from '@nestjs/common';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { SlaController } from './sla.controller.js';
import { SlaService } from './sla.service.js';
import { SlaPoliciesService } from './sla-policies.service.js';
import { SlaCalendarService } from './sla-calendar.service.js';
import { SlaEscalationNotificationProcessor, SlaSweepProcessor } from './sla.processor.js';

/**
 * SLA policies, clocks, the sweep and escalation (`FR-TSK-8`).
 *
 * `SlaService` is exported because the writes that start and satisfy a clock belong to the module
 * that caused them — a lead being captured, a follow-up being completed — and happen inside that
 * module's own transaction. A clock started by a separate call after the fact would be a clock that
 * does not exist when the capture is rolled back.
 */
@Module({
  imports: [NotificationsModule],
  controllers: [SlaController],
  providers: [
    SlaService,
    SlaPoliciesService,
    SlaCalendarService,
    SlaSweepProcessor,
    SlaEscalationNotificationProcessor,
  ],
  exports: [SlaService, SlaCalendarService, SlaSweepProcessor, SlaEscalationNotificationProcessor],
})
export class SlaModule {}
