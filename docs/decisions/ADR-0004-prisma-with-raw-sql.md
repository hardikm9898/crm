# ADR-0004 — Prisma with a tenant-scoping extension, plus typed raw SQL for analytics

**Status:** Accepted · **Date:** 2026-09-27

## Context

We need type-safe data access, a solid migration tool, automatic tenant scoping, and the ability to
write partitioned-table aggregations and window functions that ORMs express badly.

## Decision

Prisma 6 as the primary ORM with a client extension that injects `organization_id` on every
tenant-scoped operation and **throws** when no tenant context is present. Repositories are the only
callers of Prisma (lint-enforced). Analytics, rollups and reports use parameterized raw SQL behind
repository interfaces. Postgres features Prisma does not model (partitions, expression indexes, RLS
policies, triggers, generated columns) are managed in hand-written migration SQL.

## Consequences

**Positive:** compile-time safety for 95% of queries; tenancy enforced in one place rather than in
hundreds of `where` clauses; full SQL power where it is needed.
**Negative:** two query styles to review; Prisma's raw escape hatch must be lint-guarded against
string interpolation; partitioned tables need care in the schema file.

## Alternatives rejected

- **Prisma only:** cannot express the analytics queries efficiently.
- **Kysely/Drizzle only:** better SQL ergonomics, weaker migration ecosystem and no equivalent of the
  extension hook that gives us automatic tenant scoping today.
- **TypeORM:** history of migration and typing sharp edges at this scale.

### Amendment, 2026-09-28 (implementation)

Two query styles is not the real cost of this decision. The real cost is that **`prisma migrate
diff` proposes deleting every database object the schema file cannot describe**, and it does so
quietly, inside an otherwise correct migration.

The step-2 migration was generated with six `DROP` statements at its head: the three-column foreign
key that makes "a lead in a stage of another pipeline" unrepresentable, the unique index that
supports it, and the four GIN and trigram indexes behind lead search. Prisma had not lost them — it
had never been able to see them. They were applied, and nothing failed: search kept returning the
right rows by scanning, and a guarantee the database used to enforce simply stopped existing.

So this decision now carries two obligations, and they are not optional:

1. **Every generated migration is read before it is applied**, and drops of hand-written objects are
   deleted from it. `--create-only` exists for this.
2. **Every hand-written object is listed in `packages/db/src/schema-objects.int-spec.ts`**, which
   asserts its presence against a real database. A new index, trigger, check or composite FK that is
   not listed there is one a future migration will remove without a single test going red.

The alternative — keeping only what Prisma can express — was reconsidered and rejected again: it
would mean giving up partitioning, composite FKs spanning three columns, expression indexes and
partial unique indexes, which is most of what makes the schema trustworthy.
