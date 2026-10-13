import { Module } from '@nestjs/common';
import { TodayController } from './today.controller.js';
import { TodayService } from './today.service.js';

/**
 * The executive workspace (`FR-TSK-7`).
 *
 * Its own module rather than a route on `TasksModule`, because it composes three modules' subjects
 * — follow-ups, leads and SLA clocks — and belongs to none of them. It injects no other module's
 * service: every section is a query of its own, shaped for a card rather than for a record, and
 * going through the three list endpoints would mean three paginations, three presenters and three
 * sets of filters to answer a question that has none.
 */
@Module({
  controllers: [TodayController],
  providers: [TodayService],
})
export class TodayModule {}
