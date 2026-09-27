import type { Job } from 'bullmq';
import type { JobName, QueueName } from './queue.constants.js';
import type { JobPayload } from './queue.service.js';

/**
 * A unit of background work.
 *
 * Domain modules provide their own processors (an invitation email belongs to the users module,
 * not to a generic mail service), and the worker bootstrap collects them all through the
 * `JOB_PROCESSORS` token. Adding a job is therefore a provider in the owning module rather than
 * an edit to a central switch.
 */
export interface JobProcessor<TPayload extends JobPayload = JobPayload> {
  readonly queue: QueueName;
  readonly jobName: JobName;
  /**
   * MUST be idempotent: delivery is at-least-once, so a retry has to produce one effect
   * (docs/queue-event-architecture.md §4).
   */
  process(payload: TPayload, job: Job): Promise<void>;
}
