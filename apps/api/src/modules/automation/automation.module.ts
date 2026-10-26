import { Module } from '@nestjs/common';
import { CrmConfigModule } from '../crm-config/crm-config.module.js';
import { LeadsModule } from '../leads/leads.module.js';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { SlaModule } from '../sla/sla.module.js';
import { TasksModule } from '../tasks/tasks.module.js';
import { WebhooksModule } from '../webhooks/webhooks.module.js';
import { WhatsAppModule } from '../whatsapp/whatsapp.module.js';
import { AutomationController } from './automation.controller.js';
import { AutomationDispatchService } from './automation-dispatch.service.js';
import { AutomationExecutorService } from './automation-executor.service.js';
import { AutomationFactsService } from './automation-facts.service.js';
import { AutomationGuardrailsService } from './automation-guardrails.service.js';
import { AutomationHandlersService } from './automation-handlers.service.js';
import { AutomationRegistryCheck } from './automation.registry-check.js';
import { AutomationRunsService } from './automation-runs.service.js';
import { AutomationService } from './automation.service.js';
import {
  AutomationResumeSweepProcessor,
  AutomationStepProcessor,
  AutomationTriggerProcessor,
} from './automation.processor.js';

/**
 * Automation: the registry, the workflows, and the engine that runs them.
 *
 * The imports are the honest shape of what an action does — a workflow that changes a status goes
 * through `LeadsService`, so the history row, the SLA clock, the outbox event and the timeline
 * entry all happen. A module that reached Prisma directly would skip all four, and the lead would
 * move with no record of why.
 *
 * `AutomationRegistryCheck` runs on `onApplicationBootstrap`, so every application built from
 * these modules reconciles the registry against the handlers — including the ones the tests
 * build, which is the lesson the request-log hook paid for.
 */
@Module({
  imports: [
    LeadsModule,
    TasksModule,
    CrmConfigModule,
    NotificationsModule,
    WhatsAppModule,
    WebhooksModule,
    SlaModule,
  ],
  controllers: [AutomationController],
  providers: [
    AutomationService,
    AutomationRunsService,
    AutomationDispatchService,
    AutomationExecutorService,
    AutomationFactsService,
    AutomationGuardrailsService,
    AutomationHandlersService,
    AutomationRegistryCheck,
    AutomationTriggerProcessor,
    AutomationStepProcessor,
    AutomationResumeSweepProcessor,
  ],
  exports: [
    AutomationService,
    AutomationRunsService,
    AutomationDispatchService,
    AutomationExecutorService,
    AutomationTriggerProcessor,
    AutomationStepProcessor,
    AutomationResumeSweepProcessor,
  ],
})
export class AutomationModule {}
