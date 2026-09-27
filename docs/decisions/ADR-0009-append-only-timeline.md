# ADR-0009 — One append-only activity timeline per lead

**Status:** Accepted · **Date:** 2026-09-27 · Relates to `FR-TL-*`

## Context

The product's core promise is that an admin opens one lead and understands the entire customer
journey: creation, source, assignment, calls, WhatsApp, emails, notes, tasks, reschedules with
reasons, status/stage changes, quotations, payments, website activity, marketing touchpoints,
automation decisions, conversion and revenue.

## Decision

A single `activities` table, append-only, monthly-partitioned on `occurred_at`, with a `type` string
from a code-owned registry, a JSONB `payload`, polymorphic subject ids, and
`UNIQUE (organization_id, source_event_id)` for idempotency. Activities are written by domain services
and event subscribers only — never by ad-hoc controller code. The frontend renders through a
`type → component` registry and degrades gracefully on unknown types.

## Consequences

**Positive:** one query renders the timeline; new event types need no migration; immutability makes it
audit-worthy; ordering and pagination are uniform; "why did this happen" is answerable.
**Negative:** a high-volume table (hence partitioning + retention); payloads are denormalized snapshots
that can drift from current entity state (accepted — a timeline should show what was true _then_);
type-specific querying relies on the type index rather than a typed column.

## Alternatives rejected

- **Per-feature history tables** (call_logs, message_logs, status_changes) joined at read time: the
  timeline query becomes a 12-way union that grows with every feature, and every new channel risks
  forgetting to log.
- **Deriving the timeline from the event store:** events are for triggering side effects and are
  retention-limited; the timeline is user-facing product data with different lifecycle needs.
