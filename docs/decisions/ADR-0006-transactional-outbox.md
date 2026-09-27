# ADR-0006 — Transactional outbox for event publication

**Status:** Accepted · **Date:** 2026-09-27 · Relates to `NFR-REL-2/4`, Rule 18

## Context
Lead creation must trigger assignment, scoring, a follow-up task, notifications, a WhatsApp template,
automation, webhooks, analytics stitching and metering. Enqueueing directly after `COMMIT` loses events
if the process dies in between — meaning a lead silently gets no owner and no follow-up. That is the
exact failure the product exists to prevent.

## Decision
Domain events are inserted into `outbox_events` **inside the same transaction** as the state change. A
dispatcher worker polls with `FOR UPDATE SKIP LOCKED` (woken by `LISTEN/NOTIFY`), enqueues to BullMQ,
then marks them published. Delivery is at-least-once, so every consumer must be idempotent on
`eventId`; database-level unique constraints back this up (`activities.source_event_id`,
`messages.provider_message_id`, `provider_events`).

## Consequences
**Positive:** no lost side effects, ever; events are auditable and replayable; consumers are added
without touching producers; a full causal chain (`correlationId`/`causationId`) is available in logs.
**Negative:** a small publish latency (sub-second); an extra table to maintain and monitor (outbox lag
is a paging alert); consumers must be written idempotently — enforced by review and tests.

## Alternatives rejected
- **Enqueue after commit:** the lost-event window is unacceptable here.
- **Enqueue inside the transaction:** the job can be consumed before the commit lands, causing
  not-found races; a rollback leaves a phantom job.
- **Postgres LISTEN/NOTIFY as the transport:** not durable — a disconnected listener misses events.
- **Debezium/CDC:** operationally heavy for the current stage; the outbox keeps the option open.
