# ADR-0010 — Pre-aggregated rollups for dashboards; Postgres now, columnar later

**Status:** Accepted · **Date:** 2026-09-27 · Relates to `FR-ANL-5`, `NFR-PERF-2`, `NFR-SCALE-4`

## Context

Website analytics generates the highest event volume in the product (potentially hundreds of millions
of rows/month at stage B). Dashboards must answer in under a second and must not degrade as history
grows.

## Decision

Raw events land in daily-partitioned `website_events` with an idempotency key. Rollup workers compute
`daily_website_metrics`, `daily_funnel_metrics`, `daily_source_metrics`, `daily_campaign_metrics`,
`daily_user_metrics`, `daily_org_metrics` and `daily_platform_metrics` every 5 minutes for the current
day and recompute the previous day nightly (late events are handled by whole-day recomputation, never
by mutating counters). Dashboards read **only** rollups plus a short Redis cache. Raw events are kept
for drill-down and re-aggregation under a plan-based retention, behind an `AnalyticsRepository`
interface so ClickHouse can replace Postgres for raw storage without changing collector or dashboard
contracts.

## Consequences

**Positive:** dashboard cost is independent of event volume; rollups survive raw-event expiry so
history is never lost; re-aggregation makes correctness recoverable after a bug.
**Negative:** up to 5 minutes of staleness on today's numbers (a separate Redis-backed realtime view
covers the last 30 minutes); rollup definitions must be versioned and backfilled when they change;
more moving parts than querying raw data.

## Alternatives rejected

- **Query raw events per dashboard request:** fails at stage A, catastrophically at stage B.
- **Materialized views:** refresh cost and locking are hard to control per tenant, and incremental
  refresh is limited.
- **ClickHouse from day one:** a second datastore to operate and secure before the volume justifies it;
  the adapter keeps the migration cheap when it does.
