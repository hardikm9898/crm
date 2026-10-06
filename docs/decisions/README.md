# Architecture Decision Records

One file per binding decision. Format: Context → Decision → Consequences → Alternatives rejected.
A decision is changed by writing a **new** ADR that supersedes the old one, never by editing history.

| ADR                                                     | Decision                                                           | Status   |
| ------------------------------------------------------- | ------------------------------------------------------------------ | -------- |
| [0001](./ADR-0001-multi-tenancy-model.md)               | Shared schema with `organization_id` + composite FKs               | Accepted |
| [0002](./ADR-0002-modular-monolith.md)                  | Modular monolith, not microservices                                | Accepted |
| [0003](./ADR-0003-nestjs-backend.md)                    | NestJS as the API framework                                        | Accepted |
| [0004](./ADR-0004-prisma-with-raw-sql.md)               | Prisma + tenant-scoping extension, raw SQL for analytics           | Accepted |
| [0005](./ADR-0005-custom-fields-jsonb.md)               | Custom fields as JSONB + definition metadata (not EAV, not DDL)    | Accepted |
| [0006](./ADR-0006-transactional-outbox.md)              | Transactional outbox for event publication                         | Accepted |
| [0007](./ADR-0007-postgres-search-first.md)             | Postgres full-text search before a search engine                   | Accepted |
| [0008](./ADR-0008-whatsapp-official-api-only.md)        | Official Meta Cloud API only                                       | Accepted |
| [0009](./ADR-0009-append-only-timeline.md)              | Single append-only activity timeline per lead                      | Accepted |
| [0010](./ADR-0010-analytics-rollups.md)                 | Rollup tables for dashboards; Postgres now, columnar later         | Accepted |
| [0011](./ADR-0011-esm-and-toolchain-pins.md)            | ESM-first workspace, and the version pins it forces                | Accepted |
| [0012](./ADR-0012-global-identity-tenant-membership.md) | Global user identity, tenant-scoped membership                     | Accepted |
| [0013](./ADR-0013-hs256-access-tokens.md)               | HS256 access tokens until a second verifier exists                 | Accepted |
| [0014](./ADR-0014-duplicate-matching.md)                | Duplicate rules as field sets; first rule wins; phone aliases      | Accepted |
| [0015](./ADR-0015-score-as-event-sum.md)                | A lead's score is the sum of its score events                      | Accepted |
| [0016](./ADR-0016-import-through-the-domain-service.md) | Imports create leads through the domain service, not bulk insert   | Accepted |
| [0017](./ADR-0017-customer-is-a-second-record.md)       | A customer is a second record; the timeline is a union             | Accepted |
| [0018](./ADR-0018-money-arithmetic-in-one-place.md)     | Line-item arithmetic in one pure function, checked by the database | Accepted |
| [0019](./ADR-0019-quotation-versions-are-immutable.md)  | A quotation version is immutable; its PDF is a cached artefact     | Accepted |
