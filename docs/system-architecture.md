# System Architecture — Lead OS

**Version:** 0.1 (Phase 0) · Traces to: `FR-TEN-*`, `NFR-SCALE-*`, `NFR-REL-*`, `NFR-PERF-*`

---

## 1. Architectural style

**Modular monolith + separate worker fleet.** One deployable API codebase organized into strict
domain modules, plus a worker process that imports the same domain modules and consumes queues.
No microservices in v1 (ADR-0002).

Rationale: the whole product's value is in the _joins_ — a lead's WhatsApp messages, tasks, website
events and campaign data must be queried and transacted together. Splitting these into services at
100 orgs buys distributed-transaction pain and buys nothing. But module boundaries are enforced
now (import rules, no cross-module table access, communication by events and public service
interfaces), so any module can be extracted later without a rewrite.

### Boundary rules (CI-enforced)

1. A module MAY import another module's **public API** (`<module>/index.ts`: service interfaces, DTOs, events) only.
2. A module MUST NOT import another module's repositories, entities, or internals.
3. A module MUST NOT read or write another module's tables directly. Cross-module reads go through the owning service; cross-module reactions go through domain events.
4. `packages/shared` may be imported by anyone; it imports nothing from apps.
5. Cycles between modules are a build failure (`eslint-plugin-boundaries` + `dependency-cruiser`).

---

## 2. Runtime topology

```
                    ┌────────────────────────────────────────────────────────────┐
                    │                  Clients                                   │
   Tenant users ───▶│  Next.js app (SSR + CSR)   Tenant's own site + our sites   │
   Meta / Google ──▶│  Webhooks                  tracker.js (analytics beacons)  │
   Customer APIs ──▶│  Public ingestion API                                      │
                    └───────────────┬────────────────────────────────────────────┘
                                    │ HTTPS
                          ┌─────────▼──────────┐
                          │  Nginx / ALB       │  TLS, HTTP/2, gzip+brotli,
                          │  (edge)            │  IP rate-limit, body caps,
                          └─────────┬──────────┘  request-id injection
            ┌───────────────────────┼───────────────────────────┐
            │                       │                           │
   ┌────────▼────────┐    ┌─────────▼─────────┐      ┌──────────▼─────────┐
   │ web (Next.js)   │    │ api (NestJS)      │      │ collector (NestJS  │
   │ SSR shell, RSC  │───▶│ REST /api/v1      │      │ sub-app, same img) │
   │ no DB access    │    │ /api/public/v1    │      │ /t/* beacons,      │
   └─────────────────┘    │ /api/admin/v1     │      │ /wh/* webhooks     │
                          │ Socket.IO gateway │      │ ack-fast, persist, │
                          └───┬───────┬───────┘      │ enqueue, no joins  │
                              │       │              └──────────┬─────────┘
                              │       │ enqueue (outbox→queues) │
              ┌───────────────▼─┐   ┌─▼──────────────────────────▼───┐
              │ PostgreSQL 16   │   │ Redis 7                        │
              │ primary (+read  │   │ BullMQ queues, cache, rate     │
              │ replica later)  │   │ limits, locks, Socket.IO pubsub│
              └───────▲─────────┘   └─────────────┬──────────────────┘
                      │                           │ consume
                      │              ┌────────────▼─────────────────────────────┐
                      └──────────────┤ workers (same image, role via env)       │
                                     │ ingestion · whatsapp-in · whatsapp-out   │
                                     │ automation · analytics-rollup · webhooks │
                                     │ notifications · imports/exports · ads    │
                                     │ scheduler (repeatable jobs only)         │
                                     └────┬─────────────────────────────────────┘
                                          │
                     ┌────────────────────┼───────────────────┬──────────────┐
                     ▼                    ▼                   ▼              ▼
              S3-compatible        Meta WhatsApp        Meta/Google Ads     SMTP /
              object storage       Cloud API            & Analytics APIs    email API
```

**Processes (all stateless, all horizontally scalable):**

| Process     | Responsibility                                                                                                                                                                                            | Scaling signal            |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| `web`       | Next.js SSR/RSC, no direct DB/Redis access to tenant data — calls the API                                                                                                                                 | Request rate              |
| `api`       | Authenticated REST, Socket.IO gateway, OpenAPI                                                                                                                                                            | Request rate, p95 latency |
| `collector` | Beacons + provider webhooks. Validate signature → persist raw → enqueue → 200. Deployed from the same image with a different role; can be scaled independently because it is the "never lose a lead" tier | Inbound event rate        |
| `worker`    | Queue consumers, one deployment per queue group so a WhatsApp backlog cannot starve analytics                                                                                                             | Queue depth, job age      |
| `scheduler` | Registers BullMQ repeatable jobs; a single logical owner via Redis lock, but crash-safe and replaceable                                                                                                   | n/a (1–2 replicas)        |

Splitting `collector` from `api` is deliberate: ingestion must stay up and fast even when the
dashboard is being hammered (`NFR-REL-1`, `NFR-PERF-5`).

---

## 3. Technology decisions

> **Revised in Phase 1 — see [ADR-0011](./decisions/ADR-0011-esm-and-toolchain-pins.md).** These pins
> are what is actually installed after building against the registry, not what Phase 0 assumed.
> NestJS 12 is ESM-only, so the entire workspace is ESM; Prisma 7 takes its connection string from
> `prisma.config.ts` and requires a driver adapter; TypeScript is held at 6.0.x because
> `typescript-eslint` peer-caps below 6.1.

| Concern        | Choice                                                                                                                    | Why (short)                                                                                                                              |
| -------------- | ------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Language       | TypeScript 6.0.x, strict, **ESM** (`nodenext`)                                                                            | One language across web/api/workers; TS 7 is blocked on typescript-eslint support (ADR-0011)                                             |
| Runtime        | Node.js 22 LTS                                                                                                            | Available in env; stable, well-supported                                                                                                 |
| API framework  | **NestJS 12** (Fastify 5), ESM-only                                                                                       | DI, module system that matches domain boundaries, guards/interceptors for tenant+RBAC, first-class OpenAPI, queue integration (ADR-0003) |
| Frontend       | **Next.js 16 App Router** + React 19 + TS                                                                                 | SSR shells, route-level code splitting, fast mobile TTI                                                                                  |
| Styling/UI     | Tailwind CSS + shadcn/ui (Radix) + lucide                                                                                 | Accessible primitives we own, no heavy design-system lock-in                                                                             |
| Client data    | TanStack Query + Zustand (UI-only state)                                                                                  | Server state cached properly; no Redux ceremony                                                                                          |
| Forms          | React Hook Form + Zod (shared schemas)                                                                                    | Same validation shape as the API                                                                                                         |
| DB             | **PostgreSQL 16**                                                                                                         | JSONB for custom fields, partitioning, strong constraints, RLS available, `pg_trgm` search                                               |
| ORM            | **Prisma 7** (`prisma-client` generator + `@prisma/adapter-pg`) + a tenant-scoping extension; typed raw SQL for analytics | Migrations + type safety; escape hatch for reporting (ADR-0004)                                                                          |
| Cache/queue    | Redis 7 + **BullMQ**                                                                                                      | Delays, repeatables, rate-limited queues, DLQ semantics                                                                                  |
| Object storage | S3-compatible (MinIO in dev)                                                                                              | Media, exports, imports, documents                                                                                                       |
| Realtime       | Socket.IO + Redis adapter                                                                                                 | Shared inbox, notifications, multi-node fanout                                                                                           |
| Email          | Provider adapter (SES/Postmark)                                                                                           | Swappable                                                                                                                                |
| Search         | Postgres (`pg_trgm`, GIN, `tsvector`) in v1; adapter allows OpenSearch later                                              | Avoid premature infra (ADR-0007)                                                                                                         |
| Observability  | pino → JSON logs, OpenTelemetry traces, Prometheus metrics, Sentry errors                                                 | Standard, vendor-portable                                                                                                                |
| Repo           | pnpm workspaces + Turborepo                                                                                               | Fast CI, shared packages                                                                                                                 |
| Containers     | Docker, multi-stage; compose for dev                                                                                      | Parity, simple ops                                                                                                                       |
| CI/CD          | GitHub Actions                                                                                                            | Required by brief                                                                                                                        |

---

## 4. Monorepo layout

```
.
├── apps/
│   ├── api/                      # NestJS: HTTP + Socket.IO + OpenAPI
│   │   └── src/
│   │       ├── main.ts            bootstrap (role: api | collector)
│   │       ├── app.module.ts
│   │       ├── infra/             config, db (scoped client), http (request context,
│   │       │                      envelope, exception filter), observability; later:
│   │       │                      redis, queues, storage, mailer, crypto/vault, outbox,
│   │       │                      telemetry, entitlements
│   │       └── modules/           ← domain modules, section 5
│   ├── worker/                    # imports api modules; queue processors only
│   ├── web/                       # Next.js app (see frontend-architecture.md)
│   └── tracker/                   # tiny vanilla TS analytics script (<4 KB gz)
├── packages/
│   ├── db/                        # prisma schema (split), migrations, seeds
│   ├── contracts/                 # Zod schemas + generated TS types shared api↔web
│   ├── shared/                    # pure utils: phone (E.164), money, dates/tz,
│   │                              #   ids (UUIDv7), result types, RBAC catalogue,
│   │                              #   tenant-context (ALS)
│   ├── domain-events/             # event names + payload schemas + versioning
│   ├── ui/                        # shared React components/design tokens
│   └── config/                    # eslint, tsconfig, tailwind, prettier presets
├── infra/                         # docker, compose, nginx, k8s later, runbooks
├── docs/                          # this directory (source of truth)
└── .github/workflows/             # CI/CD
```

---

## 5. Module architecture

Each module owns its tables, exposes a service interface, publishes events, and declares its
permissions. Standard internal shape:

```
modules/leads/
├── leads.module.ts
├── index.ts                 # PUBLIC API: LeadsService iface, DTOs, events. Nothing else escapes.
├── api/                     # controllers (http) + dto (+zod) + openapi decorators
├── domain/                  # entities/value objects + pure business rules (unit-testable, no IO)
├── application/             # use-cases/services: orchestration + transactions + outbox emit
├── infrastructure/          # repositories (tenant-scoped), mappers, external calls
├── events/                  # publishers + subscribers (reacting to other modules' events)
├── jobs/                    # queue processors owned by this module
├── permissions.ts           # permission constants registered into the RBAC catalogue
└── README.md                # purpose, tables, endpoints, permissions, events, jobs, failure modes
```

### Module map (owner → tables → key events)

| Module              | Owns                                                                                                         | Publishes                                                                |
| ------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| `platform`          | plans, plan_features, platform settings, feature flags, industry & website templates, impersonation          | `plan.changed`                                                           |
| `auth`              | sessions, refresh tokens, password resets, MFA secrets, invitations                                          | `user.logged_in`, `invitation.accepted`                                  |
| `organizations`     | organizations, branches, teams, memberships, onboarding state, org settings, working hours, holidays         | `organization.created`, `organization.suspended`, `onboarding.completed` |
| `users`             | users, profiles, availability/leave, notification preferences                                                | `user.created`, `user.availability_changed`                              |
| `iam`               | roles, permissions, role_permissions, user_roles, scopes                                                     | `role.changed`                                                           |
| `custom-fields`     | field definitions, field sections, option lists                                                              | `custom_field.created`                                                   |
| `leads`             | leads, lead_tags, lead_touchpoints, lead_status_history, lead_stage_history, duplicates, merges, recycle bin | `lead.created                                                            | updated                           | assigned    | stage_changed | status_changed | scored | converted | merged | deleted` |
| `customers`         | customers, customer_merges                                                                                   | `customer.created                                                        | merged`                           |
| `pipelines`         | pipelines, pipeline_stages                                                                                   | `pipeline.stage_changed` (config)                                        |
| `assignment`        | assignment_rules, assignment_rule_conditions, round_robin_state, lead_assignments                            | `lead.assigned`                                                          |
| `scoring`           | scoring_rules, lead_score_events                                                                             | `lead.scored`                                                            |
| `tasks`             | tasks, task_types, reschedule_reasons, task_reminders                                                        | `task.created                                                            | completed                         | rescheduled | overdue`      |
| `sla`               | sla_policies, sla_clocks, escalations                                                                        | `sla.breached                                                            | near_breach`                      |
| `activities`        | activities (timeline), notes, mentions, documents                                                            | `activity.recorded`                                                      |
| `deals`             | deals, deal_items, quotations, quotation_items, payments                                                     | `deal.won                                                                | lost`, `payment.completed`        |
| `conversations`     | conversations, participants, assignment, tags, canned replies                                                | `conversation.created                                                    | assigned                          | closed`     |
| `messages`          | messages, message_media, message_status_events                                                               | `message.received                                                        | sent                              | failed`     |
| `whatsapp`          | whatsapp_accounts, whatsapp_numbers, whatsapp_templates, provider webhooks/cursors                           | `whatsapp.template_status_changed`, `whatsapp.connection_failed`         |
| `calls`             | calls, call_outcomes, telephony provider config                                                              | `call.logged`                                                            |
| `forms`             | forms, form_fields, form_submissions                                                                         | `form.submitted`                                                         |
| `ingestion`         | inbound_payloads, ingestion_errors, ingestion source registry                                                | `lead_capture.received`, `lead_capture.failed`                           |
| `integrations`      | integration_connections (encrypted creds), sync_cursors, integration_health, provider registry               | `integration.connected                                                   | failed`                           |
| `automation`        | workflows, workflow_versions, steps, edges, runs, run_steps, enrollments, guardrail counters                 | `automation.run_started                                                  | completed                         | failed`     |
| `websites`          | websites, website_pages, website_versions, domains, templates                                                | `website.published`                                                      |
| `analytics`         | website_events (partitioned), sessions, visitors, identities, daily rollups                                  | `analytics.purchase`, `analytics.checkout_started`                       |
| `marketing`         | campaigns, ad_accounts, ad_entities, campaign_daily_metrics, attribution config, segments, seo_keywords      | `campaign.synced`                                                        |
| `subscriptions`     | subscriptions, subscription_items, usage_counters, entitlement overrides, trials                             | `trial.expiring                                                          | expired`, `subscription.past_due` |
| `billing`           | invoices, payments, payment_methods, dunning, service_packages, service_subscriptions                        | `invoice.paid                                                            | failed`                           |
| `notifications`     | notifications, deliveries, templates, preferences                                                            | `notification.created`                                                   |
| `webhooks`          | webhook_endpoints, subscriptions, deliveries, attempts                                                       | `webhook.delivery_failed`                                                |
| `api-platform`      | api_keys, api_logs, rate-limit policies                                                                      | `api_key.created                                                         | revoked`                          |
| `audit`             | audit_logs (append-only), impersonation_logs                                                                 | —                                                                        |
| `privacy`           | consents, suppressions, dsr_requests, retention_policies                                                     | `consent.revoked`                                                        |
| `imports`/`exports` | import_jobs, import_rows, export_jobs                                                                        | `import.completed`, `export.ready`                                       |
| `ai`                | ai_requests, ai_outputs, ai_usage, per-org settings                                                          | `ai.output_created`                                                      |
| `admin`             | Super Admin read models, tenant health scores, system health, support tickets                                | —                                                                        |

Dependency direction: `platform/auth/iam/organizations` ← everything. `leads` is imported by many,
imports few. `analytics`, `marketing`, `automation`, `websites` are leaves that **react to events**
rather than being called synchronously.

---

## 6. Multi-tenancy model

**Shared database, shared schema, `organization_id` on every tenant row** (ADR-0001). Rejected:
schema-per-tenant (10k schemas × ~90 tables = migration and connection nightmare) and
database-per-tenant (unaffordable at 10k, breaks platform analytics).

Isolation is **four independent layers**; any one failing must not leak data:

**Layer 1 — Request context.** An `AsyncLocalStorage` (`tenantContext`, in `@leados/shared`) is populated by a guard from
the authenticated principal (JWT `org_id`, API key's org, public key's org, or webhook-resolved org).
It holds `{ organizationId, userId, roleIds, permissions, dataScope, branchIds, teamIds, requestId, impersonation }`.
Jobs restore the same context from the job payload — **no job may run without a tenant context**
(except explicitly-marked platform jobs).

**Layer 2 — Scoped data access.** A Prisma client extension intercepts every operation on a model
registered as tenant-scoped and (a) injects `organization_id` into `where` for read/update/delete,
(b) sets `organization_id` on create, (c) **throws** if there is no tenant context. Unscoped access
requires an explicit, reviewable `withPlatformScope()` escape used only by platform code, and every
use is logged. Repositories are the only place allowed to touch Prisma.

**Layer 3 — Database constraints.** Every tenant table has `UNIQUE (organization_id, id)`, and
child rows use **composite foreign keys** that include `organization_id`:

```sql
ALTER TABLE tasks
  ADD CONSTRAINT tasks_lead_same_org_fk
  FOREIGN KEY (organization_id, lead_id) REFERENCES leads (organization_id, id) ON DELETE CASCADE;
```

A task therefore _cannot_ point at another tenant's lead even if application code is buggy. This is
the layer that turns a logic bug into a 500 instead of a data breach.

**Layer 4 — Row Level Security (defence in depth, Phase 12).** Tenant traffic uses a non-owner DB
role with `FORCE ROW LEVEL SECURITY`; policies compare `organization_id` to
`current_setting('app.current_org', true)`, set via `SET LOCAL` inside the request transaction
(pooler-safe in transaction mode). Deferred to Phase 12 because it must not be the _only_ control
and needs load validation, but the schema is built for it from day one.

**Verification.** A generated test suite enumerates every route from the OpenAPI document and, for
each, attempts access with a token from Org B against a resource in Org A, asserting 403/404 and no
body leakage. New route without a tenancy test ⇒ CI fails (`NFR-SEC-1`).

Platform-level tables (`plans`, `platform_settings`, `industry_templates`, `audit_logs` for platform
actors) are explicitly registered as non-tenant and are unreachable from tenant routes.

---

## 7. Request lifecycle

```
Nginx ─▶ RequestId ─▶ Helmet/CORS ─▶ BodyLimit ─▶ RateLimit(ip|key|org|user)
      ─▶ AuthGuard (JWT | API key HMAC | public key | webhook signature)
      ─▶ TenantGuard      → resolves org, asserts org status (suspended/expired ⇒ 403 with code)
      ─▶ SubscriptionGuard→ entitlement + usage limit for the attempted action
      ─▶ PermissionGuard  → required permission + data scope narrowing
      ─▶ ValidationPipe   → Zod/class-validator DTO, strips unknown keys
      ─▶ Controller       → thin: maps DTO → use-case
      ─▶ Use-case         → TX { domain rules → repositories → outbox_events } COMMIT
      ─▶ Interceptor      → response envelope, ETag, audit hook
      ─▶ Response
Outbox dispatcher (worker) ─▶ BullMQ ─▶ processors ─▶ activities, notifications, webhooks, external APIs
```

Rules: controllers contain no business logic; use-cases own transactions; **events are written to
the `outbox_events` table inside the same transaction** as the state change and dispatched
afterwards (at-least-once, consumers idempotent). Nothing external is called inside a transaction.

---

## 8. Data flow: the three critical paths

### 8.1 Lead capture (one path for every channel)

```
Form / Public API / Meta Lead Ads / WhatsApp / Import / Manual
        │  (adapter normalizes to CaptureLeadCommand + raw payload)
        ▼
 collector: verify → persist inbound_payloads (raw, always) → enqueue → 200 ACK
        ▼  queue: ingestion
 1 resolve org + source + campaign/ad/form + UTM + session/visitor id
 2 normalize (E.164 phone, email lowercase, names, country defaults)
 3 map fields (standard + custom); unmapped → raw_payload + "unmapped fields" surface
 4 duplicate check (ordered rules) → existing lead? → add touchpoint + activity (+ optional notify)
 5 create lead  [TX: lead + touchpoint + consent + activity + outbox events]
 6 score (rule engine)
 7 assign (rule engine; working hours, capacity, round-robin state under Redis lock)
 8 create first follow-up task per source/pipeline policy + start SLA clock
 9 outbox → lead.created / lead.assigned
        ▼
 subscribers: notifications · automation enrollment · WhatsApp welcome template ·
              outbound webhooks · analytics identity stitching · usage metering
```

Failure at any step after persistence is retried; permanent failure lands in `ingestion_errors`
with the raw payload intact and is visible + replayable in the admin UI (`NFR-REL-2`).

### 8.2 WhatsApp inbound

```
Meta ─▶ collector /wh/whatsapp/:connectionId
        verify X-Hub-Signature-256 (raw body) → 200 immediately
        persist provider_events (UNIQUE org+provider+external_event_id)  ← idempotency gate
        enqueue whatsapp-in
            ▼
        resolve number → org → contact → lead (create lead if unknown, via §8.1 pipeline)
        resolve/create conversation → insert message (UNIQUE provider_message_id)
        download media → S3 → attach
        update conversation (last_message, unread, SLA clock, reopen if closed)
        emit message.received → timeline activity, realtime push, automation trigger,
                                agent notification, scoring signal
```

Duplicate delivery from Meta stops at the unique constraint and is counted, not processed twice
(`FR-WA-6`).

### 8.3 Analytics

```
tracker.js ─▶ collector /t/e (batched, sendBeacon) ─▶ validate + bot filter
           ─▶ website_events (partitioned daily, UNIQUE org+event_id)
           ─▶ session upkeep (Redis) ─▶ identity stitch on form_submit/whatsapp_click
                                                  │
 rollup worker (every 5 min + nightly backfill) ──┘
           ─▶ daily_website_metrics / daily_funnel_metrics / daily_source_metrics
              / daily_campaign_metrics / daily_user_metrics / daily_org_metrics
           ─▶ dashboards read ONLY rollups (+ Redis cache)      (FR-ANL-5)
```

---

## 9. Caching strategy

| Layer               | Content                                                                                      | Invalidation                                                                     |
| ------------------- | -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Redis: config cache | org settings, custom-field definitions, pipelines, statuses, roles/permissions, entitlements | Versioned key `org:{id}:cfg:v{n}`; bump `n` on any config write (never TTL-only) |
| Redis: read-through | dashboard cards, rollup aggregates                                                           | TTL 60–300 s + explicit bust on relevant rollup completion                       |
| Redis: counters     | rate limits, usage meters, round-robin cursors, online presence                              | TTL / periodic flush to DB                                                       |
| HTTP                | `ETag`/`If-None-Match` on detail reads; `Cache-Control: private`                             | Content hash                                                                     |
| CDN                 | published websites, tracker.js, static assets                                                | Path/versioned URLs on publish                                                   |

Never cached: anything whose key does not include `organization_id`. Cache keys are constructed by a
single helper that _requires_ an org id, so a cache cannot become a cross-tenant leak.

---

## 10. Scaling plan

| Stage               | Load                                           | Actions                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **A: 100 orgs**     | ~50 k leads/mo, ~500 k msgs/mo                 | Single Postgres (managed, 4 vCPU), 1 Redis, 2 api + 1 collector + 2 worker replicas. Indexes and partitions already in place.                                                                                                                                                                                                                                                              |
| **B: 1,000 orgs**   | ~1 M leads/mo, ~10 M msgs/mo, ~200 M events/mo | Read replica for reports/exports; split worker deployments per queue group; PgBouncer; partition maintenance automated; hot config in Redis; S3 lifecycle rules; rollups at 5-min cadence.                                                                                                                                                                                                 |
| **C: 10,000+ orgs** | ~10× B                                         | Move `website_events` + `messages` analytics to ClickHouse behind the existing analytics adapter; consider extracting `collector` + `analytics` + `whatsapp` into separate services (module boundaries already permit); shard Postgres by `organization_id` range if needed (org id is in every key and every index prefix, so sharding is mechanical); per-tenant queue fairness weights. |

Design choices that make the above mechanical rather than a rewrite: `organization_id` leads every
composite index; no cross-tenant joins exist; all writes flow through use-cases + outbox; all
external systems are behind adapters; analytics reads go through a repository interface, not raw SQL
in controllers.

---

## 11. Failure isolation

| Failure                   | Behaviour                                                                                                                                                                                     | Guarantee                     |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| Meta API down             | Outbound sends retry with backoff; queue drains when restored; UI shows integration degraded                                                                                                  | No message loss, no lead loss |
| Meta webhook storm        | Collector acks fast; queue absorbs; per-org concurrency caps prevent one tenant starving others                                                                                               | Fair processing               |
| Postgres primary failover | API returns 503 with retry-after; collector persists to Redis-backed buffer queue for the outage window                                                                                       | Bounded ingest durability     |
| Redis down                | API degrades: cache misses hit DB, rate limits fail **closed** for public endpoints and **open** for authenticated reads; jobs pause, nothing is dropped (outbox retains undispatched events) | No event loss                 |
| Worker crash mid-job      | BullMQ re-delivers; processors are idempotent on natural keys                                                                                                                                 | Exactly-once effects          |
| Bad automation            | Guardrails: caps, loop detection, kill switch, per-org concurrency                                                                                                                            | Blast radius contained        |
| Tenant floods API         | Per-org + per-key token buckets, queue weight limits                                                                                                                                          | Noisy-neighbour contained     |

---

## 12. Environments

`local` (docker compose: postgres, redis, minio, mailhog) → `ci` (ephemeral services, migrations from
scratch, seeded fixtures) → `staging` (production-shaped, sandbox Meta app, synthetic tenants) →
`production`. Details in `deployment-architecture.md`.
