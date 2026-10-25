import { Module } from '@nestjs/common';
import { AutomationController } from './automation.controller.js';
import { AutomationService } from './automation.service.js';

/**
 * Automation, step 1: the registry, workflows, versions and publish.
 *
 * Nothing runs yet. The executor, the guardrail counters and the run log are step 2's, and this
 * module deliberately ships without them rather than with a half-built engine: a workflow that
 * can be published and never runs is honest, and `docs/implementation-roadmap.md` says so in the
 * step entry. What it does give step 2 is the one thing an executor needs and cannot invent — a
 * published version to pin to, and an indexed answer to "who listens to this event".
 */
@Module({
  controllers: [AutomationController],
  providers: [AutomationService],
  exports: [AutomationService],
})
export class AutomationModule {}
