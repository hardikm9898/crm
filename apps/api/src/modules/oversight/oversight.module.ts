import { Module } from '@nestjs/common';
import { OversightController } from './oversight.controller.js';
import { OversightService } from './oversight.service.js';

/**
 * Manager oversight (brief §4).
 *
 * Its own module for the reason `TodayModule` is: it composes follow-ups, leads and SLA clocks and
 * belongs to none of them. It injects no other module's service — every number is an aggregate
 * shaped for a table, and the three list endpoints would answer with three paginations instead.
 */
@Module({
  controllers: [OversightController],
  providers: [OversightService],
})
export class OversightModule {}
