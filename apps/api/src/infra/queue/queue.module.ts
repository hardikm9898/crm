import { Global, Module } from '@nestjs/common';
import { JobFailureRecorder } from './job-failure.recorder.js';
import { QueueService } from './queue.service.js';
import { SchedulerService } from './scheduler.service.js';
import { WorkerService } from './worker.service.js';

/**
 * Queue infrastructure. Processors are contributed by the domain modules that own them and
 * collected here through `JOB_PROCESSORS`, so this module never imports a domain module.
 */
@Global()
@Module({
  providers: [QueueService, JobFailureRecorder, WorkerService, SchedulerService],
  exports: [QueueService, JobFailureRecorder, WorkerService, SchedulerService],
})
export class QueueModule {}
