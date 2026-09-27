# ADR-0007 — Postgres full-text search before adopting a search engine

**Status:** Accepted · **Date:** 2026-09-27 · Relates to `FR-VIEW-1`

## Context

Global search must cover leads, customers, phones (partial, E.164-aware), emails, conversations,
message bodies, deals and tasks, tenant-scoped, under 500 ms p95.

## Decision

Postgres: `tsvector` + GIN for text, `pg_trgm` for partial/fuzzy matches (e.g. last four digits of a
phone), per-entity fan-out with limits, merged and ranked in the API — all behind a
`SearchRepository` interface. OpenSearch becomes an implementation of that interface if and when
volume demands it.

## Consequences

**Positive:** no extra infrastructure, no index-sync consistency problem, no second copy of PII to
secure, transactional freshness.
**Negative:** relevance tuning is cruder than a dedicated engine; multi-partition message search needs
care; heavy search load competes with transactional load (mitigated by the read replica at stage B).

## Alternatives rejected

- **OpenSearch/Elasticsearch from day one:** a second datastore to operate, secure, back up and keep in
  sync — and a second place a tenant-isolation bug could live.
- **Meilisearch/Typesense:** lighter, but still a sync pipeline and a second PII store for a
  requirement Postgres meets at current scale.
