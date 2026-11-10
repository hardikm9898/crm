# Lead OS

A multi-tenant SaaS **Lead Operating System** for B2C businesses: lead management, CRM, official
WhatsApp communication, marketing automation, website building, website analytics and revenue
attribution — built so a small business can answer four questions without training:

- **Sales executive:** _What do I need to do today?_
- **Sales manager:** _Which leads are being missed?_
- **Business owner:** _Where do my leads come from, and which source makes revenue?_
- **Marketing manager:** _Where am I spending, and what actually converts?_

## Status

**Phases 0–6 landed, and Phase 7 steps 1–2.** Phase 6 (automation) is complete but for one of the brief's two reference
flows — abandoned checkout — which is blocked on Phase 7's websites and payments rather than on
anything in Phase 6; every Phase 6 exit criterion is measured in
[implementation-roadmap.md](./docs/implementation-roadmap.md). **Phase 7 is in progress** — steps 1 and 2
of seven have landed; Phases 8–12 have not started.

What works today:

- **Foundation** — multi-tenant workspaces with three of the four planned isolation layers (row-level
  security is deliberately Phase 12, see [ADR-0001](./docs/decisions/ADR-0001-multi-tenancy-model.md));
  authentication (password, TOTP, sessions, invitations, multi-organization membership); data-driven
  RBAC with data scopes; plans, entitlements and the trial lifecycle; a transactional outbox with a
  worker fleet and a scheduler; an audit trail.
- **CRM core** — leads with a custom-field engine, duplicate detection and merge, the assignment
  engine, scoring, saved views and a filter DSL, CSV import/export, customers and conversion, deals
  with products and line items, quotations with versioning and a rendered PDF, payments, and
  industry templates behind an onboarding wizard.
- **Work management** — tasks and follow-ups, an SLA clock that runs on business hours, `/today`,
  the notification centre with quiet hours, manager oversight, the call log, and email sending with
  bounce suppression.
- **Capture & developer platform** — hosted capture forms, the signed public lead API, outbound
  webhooks, API keys with a request log, a published OpenAPI contract generated from the validators
  that guard the routes, and Meta Lead Ads + Google Ads lead-form ingestion.
- **WhatsApp** — a connected Cloud API number, template sending inside the 24-hour window, media in
  both directions, the shared inbox with canned replies, and usage metering.
- **Automation** — a registry-driven workflow engine with version pinning, durable steps, five
  guardrails, a preview that executes nothing, retry-from-failed-step, and starter workflows per
  industry.
- **Websites (Phase 7 steps 1–2)** — the website and page model, a platform subdomain, and
  draft/publish/rollback, where a published version is immutable by trigger and a rollback writes a
  new version carrying an older snapshot; plus the renderer that serves a published site statically
  at `/s/<subdomain>`, with the cache tag dropped by the publish itself (measured at 856 ms from
  pressing Publish to the new version being served). A draft is never served, and is
  indistinguishable from a site that never existed.

**2 977 tests** — 1 277 unit (728 shared, 366 web, 175 api, 8 db) and 1 700 integration (946 api
e2e, 754 db) — run against real PostgreSQL and Redis, as reported by the Phase 6 step 3 run. The API
publishes **351 operations across 256 paths** ([docs/openapi.json](./docs/openapi.json)).

**One Phase 1 exit criterion is still open:** the compose stack has never been booted on a machine
with Docker — it was built in a container with no Docker daemon, with PostgreSQL and Redis run
natively. The other, "the tenancy suite runs in CI", is closed: `main` exists and
[the workflow](./.github/workflows/ci.yml) runs on it and on every pull request.

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
| [decisions/](./docs/decisions/)                                   | ADRs 0001–0043 with rejected alternatives                          |
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

**Phase 7, step 3 — the block editor**, and the boot check that reconciles a declared block type
against the renderer that draws it, so a declared type with no renderer is a failed startup rather
than a blank section on somebody's live site. The
[step plan](./docs/implementation-roadmap.md) holds the remaining five steps, with the two exit
criteria that need real hosting and real DNS named up front rather than left to the gate, and with
the `≥6 templates` scope line flagged as contradicting the decision recorded for B1 in
[open-questions.md](./docs/open-questions.md).

A site is reachable at `/s/<subdomain>` on the platform origin; host-based routing for
`acme.leados.app` and verified custom domains is step 6's.

Phase 6's abandoned-checkout reference flow does **not** close in Phase 7. A site built there can
carry a checkout, but the event saying one began is Phase 8's tracker (`checkout_start`), so that flow
closes in Phase 8. An earlier version of this section said otherwise.

The one remaining Phase 1 verification — booting the compose stack on a machine with Docker — is the
other open item.
