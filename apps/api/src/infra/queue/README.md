# Queue runtime (`infra/queue`)

**Purpose.** Run work that must not happen inside an HTTP request: sending email, reacting to
domain events, and scheduled housekeeping. An API handler never calls an external service
(Rule 17, `NFR-PERF-5`).

## Processes

One image, four roles (`ROLE=`):

| Role        | Runs                                                                             |
| ----------- | -------------------------------------------------------------------------------- |
| `api`       | HTTP + realtime                                                                  |
| `collector` | Webhooks and tracking beacons (Phase 4)                                          |
| `worker`    | Queue consumers **and** the outbox dispatcher. `QUEUES=notifications` narrows it |
| `scheduler` | Registers repeatable jobs, writes a heartbeat                                    |

Workers and the scheduler boot as a Nest _application context_ — the same wiring, no port — so
nothing can accidentally route traffic to a worker.

## Queues today

`notifications` (email delivery, 5 attempts, concurrency 10) and `maintenance` (scheduled sweeps,
3 attempts, concurrency 2). Separate rather than one firehose so a backlog in one cannot delay the
other, and each scales alone. The remaining queues from
`docs/queue-event-architecture.md` §3 arrive with the phases that need them.

## How a job comes to exist

```
use-case  ──[same transaction]──▶  outbox_events
                                        │  OutboxDispatcherService
                                        ▼  (FOR UPDATE SKIP LOCKED + LISTEN/NOTIFY)
                                   BullMQ queue
                                        │  WorkerService
                                        ▼  (tenant context restored from the payload)
                                    JobProcessor
```

Producers never name a consumer: `EVENT_SUBSCRIPTIONS` maps event → queue + job, so adding a
reaction to an event is a line there plus a processor.

## Guarantees and how they are achieved

| Guarantee                                | Mechanism                                                                                   |
| ---------------------------------------- | ------------------------------------------------------------------------------------------- |
| A committed event is eventually enqueued | Enqueue, _then_ mark published. A crash in between re-enqueues — never loses                |
| A re-dispatch is one effect              | `jobId` is derived from `eventId` (`outboxJobId`), so BullMQ collapses duplicates           |
| Concurrent dispatchers don't collide     | `FOR UPDATE SKIP LOCKED` claims disjoint rows                                               |
| A job runs in the right tenant           | `WorkerService` wraps the handler in `tenantContext.run(...)` from `payload.organizationId` |
| An exhausted job is visible              | `JobFailureRecorder` mirrors it into `job_failures`, payload redacted                       |
| A stalled outbox is noticed              | `maintenance.outbox-reap` every 5 minutes, plus `/health/deep`                              |
| A dead scheduler is noticed              | Heartbeat row; `/health/deep` reports its age                                               |

## Writing a processor

```ts
@Injectable()
export class MyProcessor implements JobProcessor {
  readonly queue = QUEUES.NOTIFICATIONS;
  readonly jobName = JOBS.MY_JOB;
  async process(payload: MyPayload, job: Job): Promise<void> { … }
}
```

Then add the class to `PROCESSOR_TYPES` in `processor.registry.ts` and provide+export it from the
module that owns it. The integration suite asserts that every subscribed event and every schedule
has a processor, so a forgotten registration fails CI.

Two rules for the body:

- **Be idempotent.** Delivery is at-least-once; derive any key from the event, never the attempt.
- **Identify the subject from `payload.aggregateId`**, not from a field inside `payload`. The
  envelope is the stable contract; payload bodies evolve, and an event emitted by an older release
  must still process. A job whose subject cannot be determined is logged and dropped rather than
  retried five times.

## Why processors are passed in, not injected

`WorkerService.start(processors)` takes the list as an argument. Processors live in the domain
modules that own them, and those modules depend on this infrastructure — injecting them here would
invert that. Worse, because `QueueModule` is `@Global()`, a module-local default provider silently
shadowed the root module's override, producing a worker that consumed nothing and logged no error.
Passing the list from the bootstrap keeps the dependency direction one-way and the failure visible.
