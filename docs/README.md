# Lead OS — Documentation Index

**Lead OS** is a multi-tenant B2C Lead Management, CRM, WhatsApp Communication, Marketing
Automation and Business Growth platform. It is designed as a _Lead Operating System_: every
capability in the product hangs off a single, complete, auditable lead timeline.

> **Status: Phase 0 (Architecture).** No application code exists yet. This directory is the
> contract that Phase 1+ implementation must follow. If an implementation decision contradicts
> a document here, either the code is wrong or the document must be amended in the same PR.

## Reading order

| #   | Document                                                     | What it answers                                                                                                     |
| --- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| 1   | [product-requirements.md](./product-requirements.md)         | What we are building, for whom, with numbered requirements (`FR-*`, `NFR-*`) that everything else traces back to.   |
| 2   | [system-architecture.md](./system-architecture.md)           | Runtime topology, module boundaries, tenancy model, request lifecycle, scaling plan.                                |
| 3   | [database-design.md](./database-design.md)                   | ERD, every table, keys, indexes, tenant-isolation constraints, custom-field and timeline strategy, partitioning.    |
| 4   | [api-architecture.md](./api-architecture.md)                 | REST conventions, envelopes, errors, pagination, filter DSL, public ingestion API, outbound webhooks, OpenAPI.      |
| 5   | [frontend-architecture.md](./frontend-architecture.md)       | Next.js structure, state/data layer, design system, dynamic field rendering, mobile-first executive workspace.      |
| 6   | [queue-event-architecture.md](./queue-event-architecture.md) | Domain events, transactional outbox, queue catalogue, retry/DLQ, schedulers, the automation engine runtime.         |
| 7   | [integration-architecture.md](./integration-architecture.md) | Provider adapter contracts (WhatsApp, Ads, telephony, payments, storage), credential vault, health monitoring.      |
| 8   | [security.md](./security.md)                                 | Authn/authz, RBAC + data scopes, tenant isolation defence-in-depth, crypto, webhook verification, privacy controls. |
| 9   | [deployment-architecture.md](./deployment-architecture.md)   | Environments, Docker/compose, CI/CD, migrations, observability, backup/restore, runbooks.                           |
| 10  | [implementation-roadmap.md](./implementation-roadmap.md)     | Phase-by-phase plan with deliverables and **exit criteria** per phase.                                              |
| —   | [decisions/](./decisions/)                                   | ADRs: the _why_ behind each binding choice, with rejected alternatives.                                             |
| —   | [traceability.md](./traceability.md)                         | Brief section → requirement → design doc. The coverage proof.                                                       |
| —   | [glossary.md](./glossary.md)                                 | Canonical vocabulary. Use these words in code, UI and docs.                                                         |
| —   | [open-questions.md](./open-questions.md)                     | Gaps found in the requirements, assumptions taken, and decisions the business owner still has to make.              |

## The one-paragraph architecture

A **pnpm + Turborepo monorepo** containing a **modular monolith** API (NestJS + TypeScript), a
**Next.js 15 App Router** web client, and a **worker** process that shares the API's domain
modules. State lives in **PostgreSQL 16** (single shared schema, `organization_id` on every
tenant row, composite foreign keys so a row can never reference another tenant's row),
**Redis 7** (cache, rate limits, BullMQ), and **S3-compatible object storage**. All slow or
external work leaves the request through a **transactional outbox** into **BullMQ** queues, so
an HTTP handler never calls Meta, never sends email, and never aggregates analytics. Every
external system is reached through a **provider adapter interface**, never directly, so WhatsApp,
Ads, telephony and payments are swappable. Every state change writes an **activity** (the lead
timeline) and, where it matters, an immutable **audit log**.

## Non-negotiables (Development Rules, restated as gates)

These are enforced in review and, where possible, in CI:

1. **No hardcoded tenant behaviour.** No `if (org === 'acme')`. Ever.
2. **No hardcoded lead fields, pipeline stages, statuses, sources, plans or limits.** All are tenant data or platform configuration.
3. **Every tenant-scoped query goes through the tenant-scoped repository layer.** A raw unscoped query on a tenant table fails review; an ESLint rule + integration test suite backs this.
4. **Every mutation has an explicit permission check.** No implicit "logged in is enough".
5. **Every inbound webhook is idempotent** on a provider event id.
6. **Every job is retryable and idempotent**; failures land in a DLQ that a human can see.
7. **Every list endpoint is paginated.** No unbounded `findMany`.
8. **Multi-step critical writes run in a transaction** and emit their events through the outbox in that same transaction.
9. **Secrets never reach the frontend.** Integration credentials are encrypted at rest and only decrypted inside worker/API process memory.
10. **Documentation ships with the code.** A module PR that changes an endpoint, table or event without updating its docs is incomplete.
