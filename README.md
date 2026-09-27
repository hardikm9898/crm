# Lead OS

A multi-tenant SaaS **Lead Operating System** for B2C businesses: lead management, CRM, official
WhatsApp communication, marketing automation, website building, website analytics and revenue
attribution — built so a small business can answer four questions without training:

- **Sales executive:** _What do I need to do today?_
- **Sales manager:** _Which leads are being missed?_
- **Business owner:** _Where do my leads come from, and which source makes revenue?_
- **Marketing manager:** _Where am I spending, and what actually converts?_

## Status

**Phase 0 — Architecture. Complete. No application code yet, by design.**

The full architecture is in [`docs/`](./docs/) and is the contract implementation must follow:

| Document                                                          | Contents                                                           |
| ----------------------------------------------------------------- | ------------------------------------------------------------------ |
| [docs/README.md](./docs/README.md)                                | Index, one-paragraph architecture, non-negotiable rules            |
| [product-requirements.md](./docs/product-requirements.md)         | Numbered requirements (`FR-*`, `NFR-*`) + gap analysis             |
| [system-architecture.md](./docs/system-architecture.md)           | Topology, modules, tenancy, request lifecycle, scaling             |
| [database-design.md](./docs/database-design.md)                   | ERD, ~100 tables, indexes, isolation constraints, partitioning     |
| [api-architecture.md](./docs/api-architecture.md)                 | REST conventions, errors, filter DSL, public ingestion, webhooks   |
| [frontend-architecture.md](./docs/frontend-architecture.md)       | Next.js structure, design system, mobile-first executive workspace |
| [queue-event-architecture.md](./docs/queue-event-architecture.md) | Outbox, queues, retries, automation engine                         |
| [integration-architecture.md](./docs/integration-architecture.md) | Provider adapters, WhatsApp Cloud API, credential vault            |
| [security.md](./docs/security.md)                                 | Threat model, authn/authz, 4-layer tenant isolation, privacy       |
| [deployment-architecture.md](./docs/deployment-architecture.md)   | Docker, CI/CD, observability, backup/restore, runbooks             |
| [implementation-roadmap.md](./docs/implementation-roadmap.md)     | Phases 1–12 with **exit criteria**                                 |
| [traceability.md](./docs/traceability.md)                         | Every brief section → requirement → design location                |
| [decisions/](./docs/decisions/)                                   | ADRs 0001–0010 with rejected alternatives                          |
| [open-questions.md](./docs/open-questions.md)                     | Gaps, working assumptions, decisions still needed                  |

## Planned stack

TypeScript · Next.js 15 (App Router) · NestJS 11 · PostgreSQL 16 · Redis 7 + BullMQ ·
S3-compatible storage · Socket.IO · Prisma · Tailwind + shadcn/ui · Docker · GitHub Actions.
A modular monolith with a separate worker fleet — see [ADR-0002](./docs/decisions/ADR-0002-modular-monolith.md).

## Next step

Phase 1, step 1: scaffold the monorepo, the dev stack, the Prisma skeleton for
platform/organization/identity, and the tenant-context + scoped-repository layer **with its failing-by-default
test** — the smallest change set that makes the tenant-isolation guarantee testable before any feature exists.
