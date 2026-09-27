import { Module } from '@nestjs/common';
import { CustomFieldsModule } from '../custom-fields/custom-fields.module.js';
import { LeadTimelineService } from './lead-timeline.service.js';
import { LeadsController } from './leads.controller.js';
import { LeadsService } from './leads.service.js';

/**
 * Leads. Imports the custom-field engine because every lead write validates its `customValues`
 * against the tenant's definitions.
 */
@Module({
  imports: [CustomFieldsModule],
  controllers: [LeadsController],
  providers: [LeadsService, LeadTimelineService],
  exports: [LeadsService],
})
export class LeadsModule {}
