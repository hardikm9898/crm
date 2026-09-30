import { Module } from '@nestjs/common';
import { CustomFieldsModule } from '../custom-fields/custom-fields.module.js';
import { DuplicatesModule } from '../duplicates/duplicates.module.js';
import { AssignmentModule } from '../assignment/assignment.module.js';
import { ScoringModule } from '../scoring/scoring.module.js';
import { ViewsModule } from '../views/views.module.js';
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
 *
 * Views and scoring are imported for the read side: `POST /leads/search` compiles a filter or a
 * saved view, and `/leads/:id/score-breakdown` explains the number — both belong on the lead
 * surface, which is where a person goes looking for them.
 */
@Module({
  imports: [CustomFieldsModule, DuplicatesModule, AssignmentModule, ScoringModule, ViewsModule],
  controllers: [LeadsController],
  providers: [LeadsService, LeadTimelineService],
  exports: [LeadsService],
})
export class LeadsModule {}
