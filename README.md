# Lead OS

A multi-tenant SaaS **Lead Operating System** for B2C businesses: lead management, CRM, official
WhatsApp communication, marketing automation, website building, website analytics and revenue
attribution — built so a small business can answer four questions without training:

- **Sales executive:** _What do I need to do today?_
- **Sales manager:** _Which leads are being missed?_
- **Business owner:** _Where do my leads come from, and which source makes revenue?_
- **Marketing manager:** _Where am I spending, and what actually converts?_

## Status

**Phase 1 — Foundation. Steps 1–5 landed.** Two Phase 1 exit criteria remain open, both about
verification rather than code (a CI run, and a compose boot on a machine with Docker) — they are named
in [implementation-roadmap.md](./docs/implementation-roadmap.md#exit-criteria--reviewed-2026-09-27)
along with the limitations carried forward. **Phase 2 (CRM core) has not started.**

What works today: multi-tenant workspaces with three of the four planned isolation layers (row-level
security is deliberately Phase 12 — see [ADR-0001](./docs/decisions/ADR-0001-multi-tenancy-model.md)),
authentication (password, TOTP,
sessions, invitations, multi-organization membership), data-driven RBAC with data scopes, plans and
entitlements with a trial lifecycle, a transactional outbox with workers and a scheduler, an audit
trail, and a web app covering sign-in, the authenticated shell, and workspace administration.
**333 tests** (166 unit, 167 integration) run against real PostgreSQL and Redis.

## Getting started

```bash
pnpm bootstrap          # .env + install + docker deps + migrate + seed (idempotent)
pnpm dev                # API on :4000, web on :3000
pnpm dev:worker         # separate terminal — drains the outbox and sends mail
pnpm dev:scheduler      # separate terminal — trial lifecycle, invitation expiry, pruning
```

**The worker is not optional for anything that sends email.** The outbox dispatcher lives with the
workers, so an API-only process queues nothing: an invitation is created, committed, and then nothing
happens. `pnpm dev:worker` runs at `LOG_LEVEL=debug` for exactly that reason.

The seed creates two demo organizations that deliberately **share a customer phone number**, so a
query that forgets its tenant filter returns two rows instead of one during ordinary development.
Every seeded account signs in with the password the seed prints at the end of its run
(`SEED_PASSWORD` overrides it); `owner@acme-realty.test` is the one with full access.

Email is a development logger that writes to the log and refuses to run in production, so invitation
and reset links are readable rather than sent.

## Architecture

The full architecture is in [`docs/`](./docs/) and is the contract implementation must follow. Where
code and docs disagree, one of them is a bug and both get fixed in the same change.

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
| [decisions/](./docs/decisions/)                                   | ADRs 0001–0013 with rejected alternatives                          |
| [open-questions.md](./docs/open-questions.md)                     | Gaps, working assumptions, decisions still needed                  |

## Stack, as built

TypeScript 6 (ESM throughout) · Next.js 16 App Router + React 19 + Tailwind CSS 4 · NestJS 12 on
Fastify 5 · Prisma 7 with the `pg` driver adapter · PostgreSQL 16 · Redis 7 + BullMQ 6 · Vitest 5 ·
pnpm + Turborepo · Docker · GitHub Actions.

A modular monolith with a separate worker fleet — see
[ADR-0002](./docs/decisions/ADR-0002-modular-monolith.md). Where this departs from the Phase 0 plan
(Next 16 not 15, NestJS 12 not 11, no component library yet, server components instead of a client
query cache) the reasons are recorded in
[ADR-0011](./docs/decisions/ADR-0011-esm-and-toolchain-pins.md) and
[frontend-architecture.md §10](./docs/frontend-architecture.md#10-as-built--phase-1-step-5).

## Next step

**Phase 2, step 1 — the lead model:** leads, the custom-field engine, pipelines and statuses as
tenant data, and the append-only timeline that every later feature writes to. Plus the two open
Phase 1 verifications (open a pull request so CI runs; boot the compose stack on a machine with
Docker).
