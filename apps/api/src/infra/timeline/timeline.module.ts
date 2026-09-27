import { Global, Module } from '@nestjs/common';
import { TimelineService } from './timeline.service.js';

/**
 * Global because rule 6 applies to every module: anything a business owner would want to see on a
 * lead is written here, and a feature that has to import a module to comply is a feature that will
 * quietly skip it.
 */
@Global()
@Module({
  providers: [TimelineService],
  exports: [TimelineService],
})
export class TimelineModule {}
