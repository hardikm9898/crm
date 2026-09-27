# ADR-0001 — Multi-tenancy: shared schema with `organization_id` and composite foreign keys

**Status:** Accepted · **Date:** 2026-09-27 · Relates to `FR-TEN-3/4`, `NFR-SEC-1`

## Context
The platform must serve 100 → 1 000 → 10 000+ organizations from one deployment with absolute data
isolation, while still supporting platform-wide analytics and a single migration path. Roughly 90
tables are tenant-scoped.

## Decision
One database, one schema. Every tenant table carries `organization_id NOT NULL`, has
`UNIQUE (organization_id, id)`, and every child row references its parent with a **composite foreign
key including `organization_id`**. Isolation is enforced in four layers: request context
(AsyncLocalStorage), a scoped Prisma extension that refuses to run without a tenant context, database
constraints, and (Phase 12) Row Level Security. A generated test suite attempts cross-tenant access on
every route in CI.

## Consequences
**Positive:** one migration for all tenants; platform analytics is a normal query; connection pooling
is simple; onboarding a tenant is an `INSERT`; sharding later is mechanical because `organization_id`
prefixes every index.
**Negative:** a single application bug could in principle span tenants — mitigated by layers 3 and 4,
which turn such a bug into an error rather than a leak; noisy-neighbour risk needs per-org rate limits
and queue fairness; per-tenant restore requires logical filtering rather than a database copy.

## Alternatives rejected
- **Schema per tenant:** 10 000 schemas × ~90 tables = unmanageable migrations, connection-pool
  explosion, cross-tenant reporting becomes a fan-out.
- **Database per tenant:** strongest isolation, but unaffordable and operationally impossible at the
  target scale; platform analytics would need a separate warehouse from day one.
- **Discriminator column only (no composite FKs):** the common approach, and the reason most
  multi-tenant leaks happen — a single forgotten `where` returns another tenant's rows. Composite FKs
  cost a little schema verbosity and remove that entire failure class for referenced data.
