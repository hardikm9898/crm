import { Module } from '@nestjs/common';
import { CustomFieldsModule } from '../custom-fields/custom-fields.module.js';
import { DuplicatesModule } from '../duplicates/duplicates.module.js';
import { AssignmentModule } from '../assignment/assignment.module.js';
import { LeadTimelineService } from './lead-timeline.service.js';
import { LeadsController } from './leads.controller.js';
import { LeadsService } from './leads.service.js';

/**
 * Leads.
 *
 * Imports the custom-field engine because every write validates `customValues` against the tenant's
 * definitions, and the duplicate and assignment modules because creation runs both **inside the
 * transaction that inserts the lead**: detection has to happen before a second record exists, and
 * assignment has to happen before there is a window where the lead belongs to nobody.
 */
@Module({
  imports: [CustomFieldsModule, DuplicatesModule, AssignmentModule],
  controllers: [LeadsController],
  providers: [LeadsService, LeadTimelineService],
  exports: [LeadsService],
})
export class LeadsModule {}
