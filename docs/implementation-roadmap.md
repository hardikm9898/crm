# Implementation Roadmap — Lead OS

**Rule that governs this document:** a phase is not "done" when the code exists. It is done when its
**exit criteria** pass — tests, docs, lint, typecheck, and the demo script. We do not start a phase
while the previous one is red (brief §69, §62).

Estimates assume one focused full-stack engineer (or an agent working in reviewed increments) and are
_relative sizing_, not commitments. Each phase ends in a working, demoable product — never a
half-integrated layer.

---

## Phase 0 — Architecture ✅ (this deliverable)

**Output:** `docs/README.md`, `product-requirements.md`, `system-architecture.md`,
`database-design.md`, `api-architecture.md`, `frontend-architecture.md`,
`queue-event-architecture.md`, `integration-architecture.md`, `security.md`,
`deployment-architecture.md`, `implementation-roadmap.md`, `glossary.md`, `open-questions.md`,
`decisions/ADR-0001..0010`.

**Exit criteria (all met):** every brief section maps to a numbered requirement; every requirement
maps to a phase; module boundaries, tenancy model, event model and security model are mutually
consistent; no unresolved contradiction between documents; open decisions are recorded rather than
silently assumed.

---

## Phase 1 — Foundation _(largest single phase; everything later rests on it)_

### Step 1 — workspace, schema, tenant isolation ✅ _(landed 2026-09-27)_

Delivered and verified against a real PostgreSQL 16 + Redis:

- pnpm + Turborepo monorepo, ESM throughout, TS 6 strict, ESLint 10, Prettier, CI workflow, docker compose dev stack, `scripts/dev-bootstrap.sh`.
- `@leados/shared`: UUIDv7 ids, E.164 phone normalization, integer money, timezone/DST-safe time helpers, the tenant context (ALS), the RBAC permission catalogue + system role templates, the error contract.
- `@leados/db`: 24-model Phase 1 schema (platform, organization, identity, access, working time, subscription/entitlement/usage, audit, outbox), 4 migrations including hand-written hardening SQL, the tenant-scoping Prisma extension, the tenant-model registry + drift check, the audit-purge path, an idempotent two-tenant seed.
- `@leados/api`: NestJS 12 on Fastify, boot-time config validation with a production safety net, the tenant-scoped database service, request context + request id, the global response envelope, the global exception filter, `live`/`ready`/`deep` health probes including outbox lag.
- **98 tests green** — 63 unit, 35 integration (27 of them the tenant-isolation suite) — plus lint, typecheck, format and build. The built artifact was booted and its endpoints exercised by hand.

Two Phase 0 assumptions were corrected by contact with reality and are recorded as
[ADR-0011](./decisions/ADR-0011-esm-and-toolchain-pins.md) (ESM-only NestJS 12, Prisma 7's
config/adapter model, the TypeScript 6 ceiling) and
[ADR-0012](./decisions/ADR-0012-global-identity-tenant-membership.md) (global `users`, with
`memberships` as the tenant anchor for every person-reference).

### Remaining steps

- **Step 2 — auth ✅ _(landed 2026-09-27)_:** Argon2id hashing with transparent rehash and a real password policy; registration that provisions a complete organization; login with timing-equalised failures; refresh rotation with reuse detection (family revocation); logout and sign-out-everywhere; email verification; password reset that revokes all sessions; TOTP MFA with two-step enrolment, encrypted secrets and single-use recovery codes; session listing and revocation; organization switching; invitation acceptance including multi-org membership; per-account and per-IP sign-in throttling. Supporting infrastructure: Redis, AES-256-GCM encryption service, audit writer, outbox writer, mailer port, Zod request validation, global deny-by-default `AuthGuard`. Readiness now probes Redis as well as PostgreSQL. **185 tests green** (100 unit, 85 integration). New decision recorded as [ADR-0013](./decisions/ADR-0013-hs256-access-tokens.md).
- **Step 3 — authorization ✅ _(landed 2026-09-27)_:** permission guard with `@RequirePermission`/`@NoPermissionRequired`, declared per route and **deny-by-default at boot** — `RouteAuditService` refuses to start the process if any route declares nothing; data-scope resolution (`own`/`team`/`branch`/`organization`) as a composable query predicate plus single-row authority checks; entitlement service over plan features and per-organization overrides; usage counters with atomic increments; restricted mode after a trial or subscription lapses (reads and billing stay open, writes refused, **nothing deleted**); first consumers in a members module (scoped listing, seat-limited invitations). The **generated route-authorization suite** reads the live routing table and asserts that every route is declared, every write outside `/auth` is permission-gated, every declared permission exists in the catalogue, and no route answers another organization's caller. **244 tests green** (128 unit, 116 integration).
- **Step 4 — outbox runtime:** dispatcher worker, BullMQ wiring, scheduler, DLQ mirror, audit-log writer service.
- **Step 5 — surface:** organizations/branches/teams/users/roles endpoints, onboarding state, notification skeleton, web app shell + login + org switcher.

### Original scope (for reference)

**Scope:** monorepo + tooling + CI; Docker compose dev stack; Prisma schema for platform/org/identity;
tenant-context + scoped repository layer; auth (register, login, refresh rotation, logout, verify,
reset, MFA, sessions); organizations, branches, teams, memberships, invitations; data-driven RBAC with
data scopes; plans/features/entitlements/usage counters; subscription + 7-day trial lifecycle;
transactional outbox + BullMQ wiring + scheduler + DLQ plumbing; audit log; notification skeleton
(in-app + email); working hours/holidays/availability; app shell, login, org switcher, settings
skeleton, user management UI; health endpoints; logging/tracing/metrics baseline; `.env.example`.

**Exit criteria**

- The **tenancy test suite exists and runs in CI** (even with few routes) and fails the build on a leak.
- A tenant-scoped query without a tenant context **throws**, proven by test.
- Refresh-token reuse revokes the family, proven by test.
- Permission + data-scope resolution unit-tested across all four scopes.
- Trial → active → past_due → grace → suspended transitions tested, with data preserved at every step.
- Outbox: event committed with the entity and dispatched exactly once under a simulated crash.
- `pnpm lint && pnpm typecheck && pnpm test && pnpm build` green; compose stack boots from a clean clone.
- Docs updated: module READMEs for every Phase 1 module.

**Why first:** tenancy, RBAC and the outbox are structural. Retrofitting any of them after the CRM
exists means touching every query, every route and every write path.

---

## Phase 2 — CRM core

**Scope:** custom-field engine (definitions, options, sections, JSONB values, runtime validation,
indexing job); leads CRUD + soft delete + recycle bin; statuses, sources, lost reasons, tags;
pipelines + stages; **lead timeline** (`activities`, partitioned, with the renderer registry);
touchpoints; duplicate rules + detection + merge/unmerge; assignment engine (all strategies, working
hours, capacity, round-robin state, fallback + rule tester); scoring engine + bands + explainability;
filter DSL + saved views; global search (tsvector + trgm); customers + conversion; deals + quotations

- payments (manual); import wizard + export jobs; bulk actions; lead list/detail/kanban UI; industry
  templates + onboarding wizard.

**Exit criteria**

- Creating a custom field of every supported type requires **no migration and no deploy**, and that
  field is immediately filterable, importable, exportable and usable in a view.
- Duplicate rules verified: same phone from 3 channels ⇒ 1 lead, 3 touchpoints, 3 timeline entries.
- Merge unions timelines/tasks/conversations/touchpoints and is reversible; audited.
- Assignment: round-robin fairness, capacity cap, outside-working-hours fallback, unassigned-pool
  notification — all tested; the rule tester explains its choice.
- Kanban never loads more than one page per column; 100 k-lead tenant fixture stays within latency budget.
- Timeline shows every Phase 2 event type; a lead's full journey is readable in one screen.
- Import of 10 000 rows applies duplicate rules, reports per-row errors, and produces a failed-rows file.
- Tenancy + permission tests extended to every new route.

---

## Phase 3 — Tasks, follow-ups, SLA and the executive workspace

**Scope:** tasks + types + outcomes; reminders; reschedule with mandatory reason + reason config;
complete-with-next-follow-up; "no next action" detection; overdue sweeps; SLA policies, clocks
(working-hours aware), escalation; manager SLA board; notification center with preferences + quiet
hours; **Today workspace (mobile-first)**; manager oversight views; leaderboard; call logging +
click-to-call abstraction; email sending adapter + bounce→suppression.

**Exit criteria**

- `GET /my/today` returns the entire executive screen in one request, p95 < 400 ms on the 100 k fixture.
- Reschedule **cannot** be completed without date, time and reason (API + UI tested).
- SLA clocks respect working hours and holidays across timezones (DST case included in tests).
- Overdue and near-breach escalate to the manager exactly once (idempotency tested).
- Today workspace usable one-handed at 375 px; actions survive a flaky connection (queued + retried).
- Zero-training usability check: a non-technical tester completes "call the overdue lead, log the
  outcome, schedule tomorrow's follow-up" without help.

---

## Phase 4 — Capture & developer platform

**Scope:** dynamic forms + form builder + embed + public form rendering; public lead API with public
key/HMAC/idempotency + raw-payload store + ingestion errors + replay + **self-serve test tool**; API
keys with scopes/rotation/IP allowlist; api logs; outbound webhooks (signing, retries, delivery log,
manual retry, auto-disable); OpenAPI + published docs; **integration framework** (provider registry,
credential vault, health checks, generic mapping templates); Meta Lead Ads; Google Ads lead forms.

**Exit criteria**

- A lead posted to the public API with unknown extra fields is created, its raw payload stored, and the
  unmapped fields surfaced with a one-click "create custom field".
- Duplicate `Idempotency-Key` returns the first response and creates nothing new.
- Killing the worker mid-ingestion loses **no** lead: the payload replays to completion.
- Outbound webhook retried per schedule, logged per attempt, auto-disabled after 15 failures, manually
  retryable; SSRF protections tested against private addresses.
- Meta Lead Ads: duplicate webhook delivery ⇒ one lead; token revocation surfaces as a reconnect prompt.
- OpenAPI diff check active; published docs include working copy-paste examples.

---

## Phase 5 — WhatsApp

**Scope:** Cloud API adapter; WABA/number connection + health; webhook verify + inbound pipeline with
`provider_events` dedupe; conversations + messages + media to S3 + status tracking; **shared inbox**
(assignment, ownership lock, transfer, close/reopen, notes, mentions, tags, canned replies, search,
filters, realtime); 24-hour window enforcement; templates (submit, sync, variables, preview, test
send); outbound queue with per-number rate limiting; consent + suppression at send time; WhatsApp
usage metering; conversation events on the lead timeline.

**Exit criteria**

- Meta's duplicate/retried webhook deliveries produce exactly one message, one activity, one automation
  trigger — the headline test of this phase (`FR-WA-6`).
- Out-of-window free-form send is blocked with a clear reason; template send succeeds.
- Two agents opening the same conversation see the ownership lock; transfer is audited.
- A failed send shows the provider reason to the agent and appears on the timeline; nothing fails silently.
- Media round-trip (inbound download, outbound upload) with type/size validation and signed-URL delivery.
- Opt-out keyword suppresses marketing sends immediately, verified end to end.
- Inbox p95 < 500 ms with 100 k messages in the tenant fixture.

---

## Phase 6 — Automation

**Scope:** registry (triggers/conditions/actions with JSON Schemas); workflow + versioning + publish;
durable step executor (conditions, branches, delays with working-hours awareness, resume + reconcile
sweep); guardrails (re-entry, caps, loop detection, kill switch, per-org concurrency); run/step logging

- per-lead run view + retry-from-failed-step; dry-run; registry-driven editor UI; starter workflow
  templates per industry.

**Exit criteria**

- Adding a new action type requires **no engine change and no frontend release** (proven by adding one).
- Editing a live workflow does not alter in-flight runs (version pinning tested).
- A deliberately dropped delayed job is recovered by the reconciliation sweep.
- Loop detection stops a self-triggering workflow; daily action cap enforced; kill switch stops sends
  within seconds.
- The brief's two reference flows work end to end: new-lead nurture (template → wait → task → branch on
  reply) and abandoned checkout (wait 30 m → reminder → wait 24 h → second reminder → stop on payment).
- Every automation decision, including "skipped because", is on the lead timeline.

---

## Phase 7 — Websites & landing pages

**Scope:** website/page model + versioning + draft/publish/rollback; block-based editor; ≥6 industry
templates at launch quality; theme (logo/colours/fonts); SEO (meta, OG, sitemap, robots, structured
data, redirects); custom domain verification + TLS; WhatsApp CTA; **automatic CRM form wiring**; ISR
publishing + CDN.

**Exit criteria** — a non-technical user builds and publishes a site in under 15 minutes; a form
submission on it creates a lead with source=website, page, referrer, UTM, campaign, session and device
captured, assigned by rule, with a follow-up task, and zero manual integration (`FR-WEB-6`); Lighthouse
≥ 90 on performance/SEO/a11y for a published template; rollback restores the previous version exactly;
custom domain issues TLS automatically.

---

## Phase 8 — Website & product analytics

**Scope:** `tracker.js` (< 4 KB gz, sendBeacon, batching, SPA support, consent-aware); collector
ingest with dedupe + bot filtering; visitors/sessions/events; **identity stitching** to leads; rollup
workers (website, funnel, source, user, org) + backfill; analytics dashboards (overview, funnel,
sources, pages, realtime); ecommerce funnel + revenue; website activity on the lead timeline; scoring
signals from behaviour; retention by plan.

**Exit criteria** — 1 M events ingested in a load test with zero duplicates and no dashboard slowdown
(dashboards read rollups only, verified by query inspection); late-arriving events corrected by
same-day re-aggregation; an anonymous visitor who submits a form has their prior page views attached to
the lead timeline; funnel numbers reconcile with raw counts within tolerance; the tracker is
consent-aware and ships no precise location data.

---

## Phase 9 — Marketing & attribution

**Scope:** campaign registry; Meta Ads + Google Ads connectors (campaigns, ad entities, daily
spend/impressions/clicks); GA4 + Search Console read; touchpoint-based attribution with configurable
models; marketing dashboard (spend → leads → CPL → qualified → customers → CAC → revenue → ROAS);
customer journey visualization; segments + re-engagement; SEO module (keywords, rankings, reporting);
service packages + service subscriptions billing.

**Exit criteria** — revenue on every marketing report is derived from `payments`/won deals, never from
lead counts (`FR-ATT-4`); switching the attribution model visibly changes attributed revenue and the
model is **labelled on every number**; the journey view renders the brief's full ad→payment path for a
real lead; ad-spend sync is cursor-resumable and idempotent; CPL/CAC/ROAS verified against a
hand-calculated fixture.

---

## Phase 10 — Super Admin platform

**Scope:** platform dashboard (all `FR-SA-2` cards + charts); organization management (create, suspend,
activate, extend trial, change plan, entitlement overrides, soft delete/restore); plans/features/
pricing/coupons; industry + website template management; service package management; usage, storage and
API views; system health, queue and DLQ management with retry; webhook and integration health;
audit + impersonation logs; feature flags; support tickets; tenant health scores + churn signals;
platform alerting; impersonation with banner + audit.

**Exit criteria** — every routine platform operation in the brief's Super Admin list is possible
**without a developer or a DB console** (`FR-SA-7`), demonstrated by a scripted walkthrough; a DLQ job
can be inspected and retried from the UI; impersonation is banner-visible, time-boxed, fully audited,
and cannot perform billing mutations; suspending an org blocks access while preserving all data;
platform metrics reconcile with tenant-level data.

---

## Phase 11 — AI layer (optional, additive)

**Scope:** provider adapter + per-org opt-in + PII exclusion + budget caps; lead summary; conversation
summary; suggested reply (human-sent); next best action with stated reasoning; AI-assisted
classification; cost/usage metering; feedback capture (accepted/edited/rejected).

**Exit criteria** — with AI disabled or the provider down, **every core flow is unaffected** (tested by
running the full E2E suite with the AI provider hard-failing); all output is labelled AI-generated and
editable; nothing is auto-sent by default; no AI output silently mutates CRM state; per-org budget cap
stops spend; prompts exclude fields marked PII when the org opts out.

---

## Phase 12 — Production hardening

**Scope:** security review + the Phase 12 security gate (`security.md` §13); full tenant-isolation
sweep; RLS enablement with load validation; load and soak tests (3× peak, 1 M-job queue soak);
webhook retry and DLQ drills; permission matrix verification; backup **restore** drill; rollback
rehearsal; partition/retention verification; mobile + browser matrix; a11y audit; runbook completeness;
on-call rotation and alert wiring; performance budget enforcement; legal/privacy pages and
sub-processor list.

**Exit criteria** — the "definition of production-ready" checklist in `deployment-architecture.md` §10
is fully green, with evidence (test reports, load-test graphs, restore timing, audit findings closed).

---

## Sequencing rationale

- **Tenancy, RBAC and the outbox before features** — retrofitting them touches every file written afterwards.
- **Timeline before channels** — WhatsApp, calls and website events all write to it; building it late means rewriting each channel.
- **Custom fields before forms/import/automation** — four consumers depend on that metadata; hardcoded fields would leak into all of them.
- **Tasks/SLA before automation** — automation's most valuable actions create tasks; without SLA, "missed leads" is unmeasurable.
- **Capture/API before WhatsApp** — WhatsApp inbound reuses the capture pipeline for unknown numbers.
- **WhatsApp before automation** — the highest-value automation actions are WhatsApp sends; building the engine first would mean mocking its main effect.
- **Analytics before marketing** — attribution needs touchpoints and behavioural events to attribute.
- **Super Admin after tenant features** — it administers things that must exist; the pieces needed earlier (plans, trials, suspension) are already in Phase 1.
- **AI last** — it is an optional layer over a stable deterministic core (`FR-AI-1`), and an unstable core would make AI output untrustworthy anyway.

---

## Cross-cutting work in every phase (not optional, not deferred)

For each module shipped: tenancy tests, permission tests, critical-path unit + integration tests,
module `README.md` (purpose, tables, endpoints, permissions, business logic, events, jobs, failure
modes, security notes, example payloads — brief §68), OpenAPI annotations, audit logging for
significant actions, timeline activities for lead-relevant events, notification types where a human
should be told, entitlement/usage checks where a limit applies, designed empty/loading/error states,
mobile verification for executive surfaces, and updates to these architecture docs when reality
diverges from them.

---

## Reporting format after each implementation step (brief §70)

**Completed** · **Files changed** · **Database changes** (migrations/models) · **API changes**
(endpoints) · **UI changes** (pages/components) · **Tests** (what ran, what passed) · **Issues**
(unresolved, with severity) · **Next step** (single recommended action).

Nothing is reported as complete that is not complete. A phase that partially lands is reported as
partially landed, with the specific gaps named.

---

## Immediate next step

**Phase 1, step 1:** scaffold the monorepo (pnpm + Turborepo + shared tsconfig/eslint/prettier),
`docker compose` dev stack, the `packages/db` Prisma skeleton for platform/organization/identity
tables, the `TenantContext` + scoped-Prisma extension with its failing-by-default test, and the CI
workflow — i.e. the smallest change set that makes the tenancy guarantee testable before any business
feature exists.
