import { Module } from '@nestjs/common';
import { SlaModule } from '../sla/sla.module.js';
import { LeadContactService } from './lead-contact.service.js';

/**
 * One service, deliberately in its own module.
 *
 * Every channel that reaches a person needs it — follow-ups today, calls now, WhatsApp and email in
 * Phases 4–5 — and none of them should have to import `LeadsModule` (which pulls in custom fields,
 * duplicates, assignment, scoring, views and customers) to write two columns on a lead.
 */
@Module({
  imports: [SlaModule],
  providers: [LeadContactService],
  exports: [LeadContactService],
})
export class LeadContactModule {}
