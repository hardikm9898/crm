# infra/timeline

The append-only timeline writer ([ADR-0009](../../../../../docs/decisions/ADR-0009-append-only-timeline.md)).
Rule 6: anything a business owner would want to see on a lead is written here, and a feature that
skips it is unfinished.

It sits in `infra/` for the same reason `AuditService` and `OutboxService` do — every module writes to
it and it holds no domain logic. The read side (filtering, grouping, actor resolution, pagination) is
a product surface and lives in `modules/leads`.

## What it enforces so callers do not have to

**`occurredAt` is required and never defaults to `now()`.** `activities` is partitioned by that column
and its idempotency key includes it, so a processor that re-derived the instant on retry would write a
second row instead of colliding with the first. Requiring the argument makes that impossible to get
wrong by omission.

**Attribution is ambient.** Actor type and id come from the tenant context, exactly as the audit trail
does it, so an entry cannot claim to be someone else. `actorLabel` is only for non-people — a rule, a
webhook; a person's name is resolved from `users` at read time.

**There is no update and no delete.** Append-only is the whole value: a timeline you can edit is a
timeline nobody can rely on. An integration test asserts no such route exists.

## One writer per entry

Either the domain service writes the entry inside its own transaction — no `sourceEventId` needed,
because the transaction is already atomic — **or** a processor writes it from an event, carrying the
event id so a retry collides. Both writing the same type produces duplicates, because the service's
entry has no key to collide against. A unique violation on a `sourceEventId` write is swallowed: the
row is already there, which is the desired end state.

## Partitioning, and what it costs

Monthly range partitions on `occurred_at`. Two departures from this codebase's usual shape, both
required by PostgreSQL rather than chosen:

- the primary key contains the partition key: `(id, occurred_at)`;
- the unique constraint does too: `(organization_id, source_event_id, occurred_at)`.

`activities_default` catches instants outside the pre-created months — a backdated import, clock skew
— so such a write succeeds rather than 500s. Rows there are an anomaly: they are un-prunable by
retention and they **block attaching the month they belong to**. The
`maintenance.activity-partitions` job creates partitions three months ahead daily and reports
anything sitting in the default.
