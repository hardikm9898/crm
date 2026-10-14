import { Module } from '@nestjs/common';
import { CustomFieldsModule } from '../custom-fields/custom-fields.module.js';
import { LeadsModule } from '../leads/leads.module.js';
import { FormsController } from './forms.controller.js';
import { FormsService } from './forms.service.js';
import { FormThrottleService } from './form-throttle.service.js';
import { PublicFormsController } from './public-forms.controller.js';
import { PublicFormsService } from './public-forms.service.js';

/**
 * Capture forms (`FR-CAP-2`), both sides of them.
 *
 * `LeadsModule` because a submission goes through `LeadsService.create` — the one ingestion path
 * `FR-CAP-4` asks for, with duplicate detection, scoring, assignment, the SLA clock, the timeline
 * and the events already in it. A second capture path here would be a second set of rules, and the
 * one that disagreed would be the one running on the public internet.
 *
 * `CustomFieldsModule` because a form's questions are partly the workspace's own lead fields, and
 * their type, options and required-ness belong to the definition rather than to the form.
 */
@Module({
  imports: [LeadsModule, CustomFieldsModule],
  controllers: [FormsController, PublicFormsController],
  providers: [FormsService, PublicFormsService, FormThrottleService],
  exports: [FormsService, PublicFormsService],
})
export class FormsModule {}
