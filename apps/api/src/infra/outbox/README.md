# infra/outbox

Events leave the system through a table, in the same transaction as the write that caused them
(rule 5, [ADR-0006](../../../../../docs/decisions/ADR-0006-transactional-outbox.md)).

| File                           | Role                                                                 |
| ------------------------------ | -------------------------------------------------------------------- |
| `outbox.service.ts`            | `emit(tx, events)` — the only way to publish; requires a transaction |
| `outbox-dispatcher.service.ts` | Claims rows, enqueues BullMQ jobs, marks published                   |
| `event-subscriptions.ts`       | Event name → queue + job name, and `outboxJobId()`                   |

**Why a table rather than a publish call.** A handler that calls an external API inside a transaction
either blocks the transaction or loses the event when the commit fails. Writing a row makes the event
as durable as the entity it describes, and exactly as atomic.

**Ordering of the dispatcher's two steps is the whole design.** It enqueues **then** marks published,
so a crash between the two re-enqueues rather than losing the event — and because the job id is
derived from the `eventId`, a re-dispatch is one effect, not two. Claiming uses
`FOR UPDATE SKIP LOCKED` so several dispatchers never fight, and `LISTEN/NOTIFY` wakes it so latency
is not bounded by a poll interval.

**Two traps, both paid for:**

- **BullMQ rejects a custom job id containing `:`** — it reserves the character for its own key names.
  Every enqueue failed while the dispatcher's own metrics looked healthy. Always build the id with
  `outboxJobId()`; never inline it.
- **Processors read their subject from `payload.aggregateId`,** not from a field inside `payload`. The
  envelope is stable; payload bodies change, and an event emitted by an older release still has to
  process. A processor that reached into `payload.invitationId` broke the moment the payload changed.

Consumers are idempotent on `eventId`. The dispatcher runs only in a `ROLE=worker` process, so an
API-only deployment queues nothing — worth knowing when a manual test of an email flow appears to do
nothing at all.
