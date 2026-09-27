# ADR-0009 — One append-only activity timeline per lead

**Status:** Accepted · **Date:** 2026-09-27 · Relates to `FR-TL-*`

## Context

The product's core promise is that an admin opens one lead and understands the entire customer
journey: creation, source, assignment, calls, WhatsApp, emails, notes, tasks, reschedules with
reasons, status/stage changes, quotations, payments, website activity, marketing touchpoints,
automation decisions, conversion and revenue.

## Decision

A single `activities` table, append-only, monthly-partitioned on `occurred_at`, with a `type` string
from a code-owned registry, a JSONB `payload`, polymorphic subject ids, and a unique constraint on the
source event for idempotency. Activities are written by domain services and event subscribers only —
never by ad-hoc controller code. The frontend renders through a `type → component` registry and
degrades gracefully on unknown types.

### Amendment, 2026-09-27 (implementation)

This ADR originally specified `UNIQUE (organization_id, source_event_id)`. **PostgreSQL cannot create
that constraint on a table partitioned by `occurred_at`**: a unique constraint on a partitioned table
must contain every partition-key column. The same rule forces the primary key to be
`(id, occurred_at)` rather than `id`.

The implemented constraint is therefore `UNIQUE (organization_id, source_event_id, occurred_at)`, and
the guarantee survives **only because `occurred_at` is derived from the event, never from `now()`**.
`TimelineService` requires it as an argument for exactly that reason: a processor that re-derived the
instant on retry would write a second row instead of colliding with the first.

Two consequences worth stating plainly:

- A retry that changes `occurred_at` defeats idempotency. The cost of getting this wrong is a
  duplicated timeline entry, not data loss, and it is caught by the integration suite.
- The write rule is **one writer per entry**: either the domain service writes the entry inside its
  own transaction (and needs no `source_event_id`, because the transaction is already atomic), or a
  processor writes it from the event (and must carry one). Both writing the same type produces
  duplicates, since the service's entry has no key to collide against.

## Consequences

**Positive:** one query renders the timeline; new event types need no migration; immutability makes it
audit-worthy; ordering and pagination are uniform; "why did this happen" is answerable.
**Negative:** a high-volume table (hence partitioning + retention); payloads are denormalized snapshots
that can drift from current entity state (accepted — a timeline should show what was true _then_);
type-specific querying relies on the type index rather than a typed column; partitioning constrains the
keys as described in the amendment, and requires a maintenance job that keeps partitions ahead of the
calendar (`maintenance.activity-partitions`) — a month with no partition sends rows to the default
partition, which then blocks attaching the real one until they are moved.

## Alternatives rejected

- **Per-feature history tables** (call_logs, message_logs, status_changes) joined at read time: the
  timeline query becomes a 12-way union that grows with every feature, and every new channel risks
  forgetting to log.
- **Deriving the timeline from the event store:** events are for triggering side effects and are
  retention-limited; the timeline is user-facing product data with different lifecycle needs.
