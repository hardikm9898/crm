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
