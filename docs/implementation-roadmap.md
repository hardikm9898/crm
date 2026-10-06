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
- **Step 4 — outbox runtime ✅ _(landed 2026-09-27)_:** the outbox dispatcher (claims with `FOR UPDATE SKIP LOCKED`, woken by `LISTEN/NOTIFY`, enqueues **then** marks published so a crash re-enqueues rather than losing the event, with event-derived job ids so a re-dispatch is one effect); BullMQ queues `notifications` and `maintenance` with per-queue retry policy; `worker` and `scheduler` process roles booting as application contexts; tenant context restored per job from the payload; dead-letter mirror into `job_failures` with payloads redacted; scheduled trial lifecycle, invitation expiry, session pruning and an outbox reaper; scheduler heartbeat; `/health/deep` now reports queue depth, dead-lettered count and heartbeat age. Email delivery moved out of the request path entirely — invitation, verification, reset and security-notice mails are queued, and their **single-use tokens are minted in the worker**, so no usable credential is written to the outbox or a queue payload. **281 tests green** (142 unit, 139 integration).
- **Step 5 — surface ✅ _(landed 2026-09-27)_:** the tenant-administration API — organization profile and onboarding state, branches and teams (with team membership resolved through `Membership`), roles and grants as data (`PUT` semantics: a permissions screen submits the intended final set), per-person role and status changes with three lockout guards, and a notification inbox filled by outbox consumers rather than by the request that caused them. Plus the **web app**: Next.js 16 App Router on server components, httpOnly cookies for both tokens so no token is ever readable by JavaScript, server actions for every mutation (and deliberately no `/api/proxy/*` catch-all), silent access-token renewal in `proxy.ts`, a permission-filtered shell with an organization switcher and a notification badge, and screens for sign-in, invitation acceptance, dashboard, notifications, organization settings, people, roles and own security. **52 routes** (13 public, 13 exempt with stated reasons, 26 permission-gated). **333 tests green** (166 unit, 167 integration). The generated route suite grew two teeth: an asserted list of the self-scoped writes that legitimately need no permission, and cross-tenant coverage of all twelve new parameterised routes.

  Verified by driving the **built** web app with Playwright against a real API, worker and database — sign-in and cookie flags, the permission-filtered shell, organization save surviving a reload, the onboarding wizard, invite and revoke, the roles matrix, session listing, the notification badge clearing, accepting an invitation, a spent token being refused, switching between two tenants, and silent renewal after the access cookie is dropped. A sales executive, a branch manager and a second tenant's owner were driven through the same screens: hiding a link is presentation, and the API refuses the URL either way. Details and the departures from the Phase 0 frontend plan are in [frontend-architecture.md §10](./frontend-architecture.md#10-as-built--phase-1-step-5).

  Two defects found and fixed on the way, both invisible until something real exercised them: the dev seed referenced an undefined `DEV_PASSWORD_PLACEHOLDER` and had been failing at `pnpm db:seed` since the platform-catalogue refactor (it now hashes a documented `SEED_PASSWORD` with Argon2id and prints it); and the invitation email pointed at `WEB_ORIGIN/accept-invitation`, a page that did not exist — an invitation nobody could accept.

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

### Exit criteria — reviewed 2026-09-27

| Criterion                                                                                      | Status                                                                                                                                                                                                                                                                                                                                             |
| ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The tenancy test suite exists and runs in CI, and fails the build on a leak                    | **Partly.** The suite exists (27 tests in `@leados/db`, plus the generated route sweep in `@leados/api`) and the CI workflow runs it. **The workflow has never executed on GitHub** — it triggers on `main` and on pull requests, and no pull request has been opened. Until one runs, "runs in CI" is a claim about a file, not an observed fact. |
| A tenant-scoped query without a tenant context **throws**                                      | **Met**, proven by test against real PostgreSQL.                                                                                                                                                                                                                                                                                                   |
| Refresh-token reuse revokes the family                                                         | **Met**, proven by test.                                                                                                                                                                                                                                                                                                                           |
| Permission + data-scope resolution unit-tested across all four scopes                          | **Met** (`data-scope.service.spec.ts`, plus end-to-end coverage per scope in `authorization.e2e-spec.ts`).                                                                                                                                                                                                                                         |
| Trial → active → past_due → grace → suspended transitions tested, data preserved at every step | **Met**, including the assertion that restricted mode refuses writes and deletes nothing.                                                                                                                                                                                                                                                          |
| Outbox: event committed with the entity, dispatched exactly once under a simulated crash       | **Met** (`outbox-runtime.e2e-spec.ts`).                                                                                                                                                                                                                                                                                                            |
| `pnpm lint && typecheck && test && build` green                                                | **Met.** 333 tests (166 unit, 167 integration).                                                                                                                                                                                                                                                                                                    |
| The compose stack boots from a clean clone                                                     | **Not verified.** `infra/docker/compose.yml` exists and `scripts/dev-bootstrap.sh` drives it, but the development container this was built in has no Docker daemon; PostgreSQL and Redis were run natively. This needs one run on a machine with Docker before Phase 1 can be called closed.                                                       |
| Module READMEs for every Phase 1 module                                                        | **Met.** Every directory under `apps/api/src/modules` and `apps/api/src/infra` has one, plus `apps/web`, `packages/db` and `packages/shared`.                                                                                                                                                                                                      |

**Two criteria therefore remain open**, both about verification rather than code: a CI run, and a
compose boot on a machine with Docker. They are the first items in Phase 2's opening step rather than
a reason to hold the phase, because neither can be satisfied from inside this environment.

Known limitations carried forward, stated rather than discovered later:

- **Two-factor sign-in cannot be completed in the browser.** The API supports it end to end; the login
  form says so instead of failing mysteriously. Arrives with the account-settings screens.
- **Mail is a development logger.** It refuses to run in production, so this is a missing feature and
  not a silent failure. A provider adapter arrives with Phase 4.
- **`UsageService` has no route consumer yet.** Counters and limits are tested, but nothing increments
  them until messaging and imports exist (Phases 4–5).
- **Roles and grants are read-only in the UI.** The API is complete and tested; the editor arrives with
  the CRM permissions work.
- **A `dump.rdb` blob remains in pushed history** at `83ca4ab`. Its contents were cached grants, no
  secrets; removing it would require a history rewrite, which is not worth it for a private repository.
- **RLS is deferred to Phase 12** by design ([ADR-0001](./decisions/ADR-0001-multi-tenancy-model.md)):
  it is the fourth layer, added once the query surface has stopped moving.

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

### Step 1 — the lead model ✅ _(landed 2026-09-27)_

The foundation the rest of Phase 2 is built on: the things a tenant shapes, the lead itself, and the
timeline every later feature writes to.

- **The custom-field engine.** Definitions, sections and options, with one registry in
  `@leados/shared` describing each of the 17 types: its stored shape, whether it takes options, which
  validation rules it honours, which filter operators it supports, whether it feeds search. The API
  validates against that registry, the client renders from it (it travels with each definition as
  `capabilities`), and `validateCustomValues` — pure, no database — is tested against **every type in
  it**, so a type cannot be declared and left unimplemented. `key`, `type` and `entityType` are
  immutable and a deleted key is never reusable, because all three appear in stored JSONB, saved views
  and import mappings. Deleting a field keeps its values; retiring an option keeps the choices already
  recorded while stopping new ones.
- **The tenant's vocabulary as rows** (rule 4): statuses with a `category` code branches on instead of
  a name, sources with a cost model, lost reasons that can demand a note, pipelines, stages with
  required fields, and tags. Configuration still in use cannot be deleted — the refusal carries the
  count and points at deactivation, because attribution and loss reports read _historical_
  configuration. One default status and one default pipeline are enforced by partial unique indexes
  rather than by a read-then-write.
- **Leads.** CRUD, soft delete with a recycle bin, E.164 normalization that keeps what was typed,
  transitions as endpoints rather than fields (each with its own permission, preconditions and history
  table), manual assignment, tags, and full-text plus trigram search that finds a lead by the last four
  digits of a number or a misspelt name. Reads are scoped twice: by grant for the list, and by
  `canAct` on the row — knowing an id is never authority, and both answer 404 rather than 403.
- **The append-only timeline** ([ADR-0009](./decisions/ADR-0009-append-only-timeline.md)),
  monthly-partitioned, with the type registry as a code constant so a new event type needs no
  migration. Every lead mutation writes its entry inside the same transaction as the change, so a lead
  that moved with nothing knowing why is not a reachable state (rule 6).
- **Every new organization is provisioned with a working vocabulary**, from the same definition the
  development seed uses — a workspace with no default status is one where lead creation fails, which is
  the half-provisioned state rule 18 forbids.
- **15 new tables**, 26 new composite foreign keys, and hand-written SQL Prisma cannot express:
  the partitioned `activities` table with an idempotent partition-creation function, a trigger-maintained
  `search_vector`, trigram and `jsonb_path_ops` GIN indexes, partial indexes for "unassigned" and "no
  next action", and a composite FK that makes **a lead in a stage of a different pipeline
  unrepresentable** — the kind of corruption that surfaces as a kanban rendering a lead in a column
  that is not on its board.

**430 tests green** (210 unit, 220 integration). The isolation suite grew from 27 to 37, adding the CRM's
own composite foreign keys; the generated route sweep now covers all 26 new parameterised routes
cross-tenant; **95 routes** (13 public, 13 exempt, 69 permission-gated). Fifteen database guarantees were
verified directly against PostgreSQL before any application code was written on top of them, and the
whole surface was then exercised over HTTP against the built artifact (78 checks).

Two Phase 0 statements were corrected by contact with PostgreSQL and are recorded where they were made:
[ADR-0009](./decisions/ADR-0009-append-only-timeline.md#amendment-2026-09-27-implementation) (a unique
constraint on a partitioned table must contain the partition key, so the idempotency key is
`(organization_id, source_event_id, occurred_at)` and `occurred_at` must come from the event) and
[§6.1](./database-design.md) (`full_name` is application-maintained, not a generated column, for the
same reason `updated_at` is not a trigger).

**Deferred, and why:** duplicate detection and merge, the assignment engine, scoring, the filter DSL and
saved views, import/export, bulk actions, customers, deals and the lead UI are later steps. Columns whose
tables do not exist yet (`customer_id`, `campaign_id`, `next_action_task_id`, the SLA columns…) are
**absent** rather than present as unconstrained uuids — a nullable id with no foreign key is a column
nothing can trust. The expression-index job behind `is_indexed` is not built; filterable-but-unindexed
fields work through the GIN index today and it arrives with the filter DSL.

### Step 2 — duplicates and assignment ✅ _(landed 2026-09-28)_

Two decisions a business would otherwise make by hand on every lead: is this somebody we already
know, and whose is it.

- **Duplicate rules as a list of field sets.** `[["phoneE164"], ["email", "lastName"]]` reads "the
  same phone, **or** the same email and surname" — how a business states it out loud, and each set
  maps to one indexed lookup. `validateMatchOn` refuses a set that could not discriminate
  (`["city"]`, `["firstName", "city"]`): such a rule passes any schema check and then quietly groups
  strangers, which is the one duplicate failure a business cannot undo. The phone columns are
  **aliases of each other** in the field registry, so a number that arrives as WhatsApp matches a
  lead whose form capture put it in `phone_e164` — without which every WhatsApp conversation in
  Phase 5 would create a second record for a person already in the database.
- **Detection is two stages that must agree**: a narrow identifier-only candidate query (indexed
  columns plus the lookback, capped at 50) and then exact comparison in memory through the _same
  pure matcher the rule tester uses_. Rules run in priority order and the first match decides, not
  the strongest — a business that puts `reject` above `attach_to_existing` meant it.
- **Four actions, of which one cannot lose information.** `attach_to_existing` (the provisioned
  default) appends a touchpoint, enriches blanks **without ever overwriting an answer**, widens
  consent but never narrows it, and writes two timeline entries; `create_and_link` queues the pair
  for a person; `reject` refuses with `409` and names the existing lead; `create_new` records the
  detection and does nothing else.
- **Merge is undoable, and that is a schema property.** A merge moves activities by their full
  composite key, renumbers touchpoints onto the survivor's sequence, drops what would become
  redundant, soft-deletes the absorbed lead and snapshots every survivor column it overwrote.
  `lead_merges_one_standing_per_merged_lead` is a **partial** unique index (`WHERE undone_at IS
NULL`), so a lead can be merged, restored and merged again — a plain unique index would have made
  the second merge impossible, which nobody discovers until a user tries it.
- **An assignment engine that shows its working.** Six strategies; conditions that are AND within a
  group and OR across groups; eligibility with four **named** reasons (not a member, outside working
  hours or a branch holiday, on leave or away, at the capacity cap) evaluated in the organization's
  timezone. `decide()` returns the rule, every candidate with its reason, a verdict per rule
  evaluated and one sentence a person can read; `POST /assignment/test` renders that decision and
  writes nothing, with `at` overriding the clock so out-of-hours behaviour is checkable at 11am.
- **Round-robin fairness is durable and does not punish absence.** The cursor lives in
  `round_robin_state` and is written inside the assigning transaction, so the row lock serialises
  two simultaneous captures. The rotation runs over the pool **as configured** rather than the
  eligible subset, so a skipped member keeps their turn for when they come back.
- **The 9pm lead has somewhere to go.** Every rule carries a fallback; a fallback to a named person
  deliberately ignores working hours (one that could fall back to nobody defeats the point); ending
  up unassigned **always** notifies, through the outbox, to whoever holds `lead:assign` — resolved by
  permission, never by role name. `maintenance.lead-recycle` returns an untouched lead to the pool
  rather than reassigning it, because the engine decides who gets it, and an absent
  `settings.leadRecycleDays` means no recycling rather than a silent default.
- **7 new tables**, 11 new composite foreign keys including two self-referential ones on `leads`,
  and one to `memberships(organization_id, user_id)` so a pool member's _membership_, not merely
  their user row, is the thing referenced.

**584 tests green** (272 unit, 312 integration). **116 routes**, up from 95 (13 public, 13 exempt,
90 permission-gated); the generated cross-tenant sweep covers all 21 new routes, including the six
parameterised paths, aiming at a duplicate pair, a merge and rules that really exist. The surface was then
exercised over HTTP against the built artifact — 122 checks across four scripts, including a
three-person rotation splitting nine leads exactly 3/3/3 in pool order, a 3:1 weighting producing
6-vs-2, and a stranded lead producing a real `lead.unassigned_pool` notification through the outbox.

**One regression was found and fixed in the process, and it matters more than the features.**
`prisma migrate diff` generated this step's migration with six `DROP` statements at the top of it —
the composite FK that makes "a lead in another pipeline's stage" unrepresentable, its supporting
unique index, and the four GIN and trigram indexes behind lead search. Prisma cannot express any of
them in `schema.prisma`, so it sees them in the database, does not see them in the schema, and
removes them. They were applied. Nothing failed: search still returned rows (sequentially), and the
corruption the FK prevents simply became possible again. `schema-objects.int-spec.ts` now asserts
every hand-written index, constraint, function and trigger exists, so the next generated migration
that proposes one of these deletions fails a test instead of landing.

**Deferred, and why:** scoring, the filter DSL and saved views, import/export, bulk actions,
customers, deals and the lead UI remain later steps. The duplicates and assignment **screens** are
not built — both surfaces are complete and tested over HTTP, and the UI arrives with the lead
list and detail work, since a merge screen without a lead detail page has nowhere to live.

### Step 3 — scoring and saved views ✅ _(landed 2026-09-30)_

The two things that turn a list of leads into a day's work: which ones are worth calling, and the
saved question that puts them on one screen.

- **A lead's score is the sum of its score events** ([ADR-0015](./decisions/ADR-0015-score-as-event-sum.md)).
  `leads.score` caches `sum(lead_score_events.delta)`, so `FR-SCR-2`'s explainability is exact rather
  than approximate: the breakdown a manager reads _is_ the arithmetic that produced the number, and the
  API returns `addsUp` rather than asserting it. Repair is a re-sum that writes no event — recording
  the drift as one would break the invariant it restores. Idempotency is a unique index on
  `(lead, rule, source_event)`, so an at-least-once redelivery scores once.
- **A dormant trigger is refused, not stored.** `FR-SCR-1` names website behaviour, WhatsApp and email
  engagement as scoring inputs, and none of those events exist before Phases 5, 8 and 9. A rule on one
  would sit inert while the business believed their scoring covered engagement, so `SCORING_TRIGGERS`
  marks each trigger live or not and creation is refused with the phase it arrives in.
- **Bands are a partition of 0–1000, enforced twice.** Validated as a contiguous cover with no gap,
  and `score_bands_no_overlap` is a Postgres **exclusion constraint** — an overlap is unrepresentable
  rather than merely refused. Editing the set re-bands every lead in the same request: leaving it to a
  job means a business renames a band and their "Hot leads" view is empty until the job runs, which
  reads as data loss.
- **Decay is a function of elapsed time, not of how often the sweep ran.** "After 14 days, five points
  a week, never below the floor" is computed as _what should be gone by now, minus what already is_,
  so a missed night catches up and a second run the same night takes nothing. No "last swept" column
  to get wrong. A lead with no recorded activity is new, not stale, and decays by nothing.
- **The filter DSL is data, validated before it is stored** (`FR-VIEW-2`). The same flat
  AND-within-group / OR-across-groups shape the assignment and scoring rules use — one vocabulary,
  three features. Date conditions carry a **named window** (`{ window: 'today' }`) rather than a
  timestamp, resolved in the organization's timezone at read time, which is what stops "Today's
  follow-ups" meaning last Tuesday forever.
- **The compiler emits Prisma predicates, never SQL.** Not squeamishness: the tenant-scoping extension
  works by rewriting Prisma's `where`, so a filter assembled as raw SQL would bypass the layer that
  makes one tenant unable to read another's leads. Data scoping is combined with `AND` _after_ the
  filter compiles, so a filter can only narrow what a caller may see.
- **Computed fields are rewritten into something indexable.** "Older than 30 days" becomes a bound on
  `created_at` rather than a subtraction per row; tags become a join. The inversion matters — older
  means an _earlier_ timestamp, and getting it backwards silently shows a manager the wrong half of
  their pipeline.
- **Saved views, private, team or workspace** (`FR-VIEW-3`), with column selection, sort, and a landing
  view per role. Visibility is enforced on read and a private view answers **404**, because confirming
  it exists is itself a leak of somebody's work. Provisioning seeds the five views from §17 plus
  Unassigned, shared with the workspace.
- **4 new tables**, 5 new composite foreign keys, a new `scoring` queue (concurrency 10) fed by six
  lead events through the outbox, and the nightly `score.decay-sweep` at 01:07.

**718 tests green** (336 unit, 382 integration). **133 routes**, up from 116 (13 public, 13 exempt,
107 permission-gated). Eighteen database guarantees were verified directly against PostgreSQL before
any application code was built on them, and the surface was then exercised over HTTP against the built
artifact — 84 further checks across two scripts.

**Three bugs the HTTP runs found that the unit tests could not.** All three were silent:

1. **A lost update under real concurrency.** Three captures of one person arrive within milliseconds;
   two scoring jobs read `score = 0` and both wrote `15`. The lead ended with two score events worth
   30 points under a cached score of 15 — a breakdown that did not add up, which is the one thing that
   would make the number untrustworthy. Every path that changes a score now takes
   `SELECT … FOR UPDATE` on the lead and reads the score, band, per-rule counts and decay-so-far
   _after_ the lock. The same race let two jobs both pass a cap of one.
2. **A currency custom field compared as an object.** `custom.budget >= 5000000` matched nothing,
   because a currency value is stored as `{ currency, amountMinor }` and the filter compared the whole
   object with a number. The comparable sub-path is now declared in the custom-field type registry —
   the file that decides how a type is stored — rather than guessed by the compiler.
3. **The response envelope silently dropped a handler's extra keys.** `POST /leads/search` echoes which
   view ran and which conditions applied, and none of it reached the client: a paginated payload's
   `items` become `data` and every sibling key was discarded. A handler can now contribute `meta`.

Also fixed, because it would have bitten the web app next: **a POST with no body was a 400.** Fastify
rejects an empty body when `content-type: application/json` is set, which every client that sets a
default content-type does — so `/leads/:id/restore`, `/leads/:id/recompute-score` and
`/duplicates/:id/dismiss` all required a literal `{}`. An empty body now parses as `{}` and the route's
own schema decides.

**Deferred, and why:** the lead list, detail and kanban screens, import/export, bulk actions, customers
and deals remain later steps — the filter and scoring surfaces are complete and tested over HTTP, and
they are what the list UI will be built from. Global search across conversations, deals and tasks
(`FR-VIEW-1`) waits for those entities to exist; lead search itself landed in step 1.
`lead_score_events` will want the monthly partitioning `activities` has once Phase 5 starts scoring
WhatsApp engagement, which is the point at which it becomes one of the larger tables.

### Step 4 — the lead screens ✅ _(landed 2026-10-05)_

The first screens a business actually works in: the list they filter, the record they open, and the
board they drag.

- **The lead list** (`FR-LEAD`, `FR-VIEW-2/3`) with the saved views as chips, a filter bar built
  entirely from the catalogue the API publishes, sorting, cursor pagination, and bulk assign, tag and
  delete. **All of it is URL state** — `?view=`, `?f=`, `?sort=`, `?cursor=` — so a filtered list is
  shareable, survives a reload, and the back button undoes a filter. `?f=city:eq:Pune~priority:in:high,urgent`
  is the whole filter, readable in the address bar and round-trip tested.
- **A saved view runs through the API's own `viewId`**, not through its expanded filter: the API
  resolves it, checks its visibility and applies its sort. Reimplementing that in the browser is how
  the two drift. The view's conditions are still rendered as chips, so "why am I seeing these rows"
  is answerable without opening the view's definition.
- **Lead detail** in three regions — identity, a tabbed centre, a controls rail — stacked on a phone
  in that order, because at 375 px the first thing wanted is who this is and how to reach them.
  Status, stage, owner and tags are each their own form posting to their own action, because each is
  its own transition on the API with its own permission and preconditions. Tabs are URL state too.
- **The timeline is a renderer registry** (`FR-TL-1`): `activity.type → a sentence`. A type this
  build has never heard of degrades to a readable line rather than a blank row, which is what lets
  the API ship new activity types ahead of the frontend — asserted against _every_ type in the
  shared registry, including the phases not yet built.
- **The score explains itself on the lead**: the band, and a "Why?" disclosure listing each rule's
  contribution. If the breakdown ever stops adding up, the panel says so and offers to recalculate
  rather than quietly showing a number nobody can check.
- **The kanban board loads one page per column** (`NFR-PERF-4`), each column growing on its own
  through the URL. Moving a lead is available two ways deliberately — dragging, and a picker on each
  card for a keyboard, a screen reader or a phone — and both post to the same endpoint, so a stage
  that requires fields refuses either way.
- **Nothing here is a second source of truth.** No client data cache: every list must be correct at
  first paint and re-read after a mutation, and a cache would buy a loading state, a hydration
  boundary and a stale copy in exchange for nothing until infinite scroll exists. The prediction in
  [frontend-architecture §10](./frontend-architecture.md) that the lead list would be where TanStack
  Query earned its place did not hold: URL state and server actions covered it, and the dependency
  is still unused.

**794 tests green** (410 unit, 384 integration). The screens were then driven in a real browser
against the built app, a real API and a real worker: **81 checks** across five suites — the list and
its filters, create and refusal, the detail screen and its transitions, the board and bulk actions, a
375 px viewport, a permission run as an executive, and a **100 000-lead tenant** for the latency
budget.

**The 100 k-lead exit criterion, measured rather than asserted.** `packages/db/perf` builds the
fixture in ~18 seconds and removes it again, so the budget is reproducible instead of being a claim:

| On 100 007 leads                          | median | p95    |
| ----------------------------------------- | ------ | ------ |
| Unfiltered list page                      | 13 ms  | 16 ms  |
| Two-condition filter (city + priority)    | 62 ms  | 68 ms  |
| Score-band view ("Hot leads")             | 11 ms  | 26 ms  |
| Computed ageing filter (`idleDays >= 30`) | 30 ms  | 33 ms  |
| All seven kanban columns, in parallel     | 46 ms  | 53 ms  |
| `/leads` rendered end to end              | 96 ms  | 126 ms |
| `/pipeline` rendered end to end           | 88 ms  | 103 ms |

The board's first column held 14 285 leads and returned ten.

**Four defects the browser and the fixture found, none of which a unit test would have:**

1. **Every Zod default message was reaching users.** Typing a two-digit phone number answered "Too
   small: expected string to have >=4 characters" under the field. The validation pipe maps
   `issue.message` onto the field-error contract, so this was every form in the product, not one
   field. Fixed with a global Zod error map (`installValidationCopy`) that supplies human sentences
   while leaving any message an endpoint wrote in place.
2. **A refused form emptied itself.** A server action re-renders the tree, the client form remounts,
   and eight fields had to be retyped. The submission is now echoed back in `ActionState.values`.
3. **Deleting leads was quadratic.** `leads.is_duplicate_of_id` and `leads.merged_into_id` point back
   at `leads` with `ON DELETE RESTRICT`, and Postgres does not index the referencing side of a
   foreign key — so every deletion scanned the whole table twice. Invisible at demo scale; on the
   fixture the statement was still running after three minutes. With the two partial indexes added it
   takes 4.9 seconds.
4. **The dev seed could not top up an existing workspace.** It skipped an organization that already
   existed, so the score bands, scoring rules and saved views written in step 3 never reached the
   demo tenants — and tags had never been seeded at all, leaving the tagging control pointing at an
   empty list. Each configuration seeder is now independently idempotent and `pnpm db:seed` reports
   what it added.

**Deferred, and why:** the import wizard and export jobs landed in step 5 below; customers, deals and
quotations remain later steps. A command palette, prefetch-on-intent and the virtualized long list from
[frontend-architecture §7](./frontend-architecture.md) are not built: at the measured numbers above
nothing in this step needs them, and building them now would be optimising against a budget already
met by a factor of twenty. Today (`FR-TSK-7`) waits for tasks in Phase 3, which is also when the
"next action" column on these screens stops being empty.

### Step 5 — import and export ✅ _(landed 2026-10-05)_

The two jobs every business does on its first day and its worst day: getting a spreadsheet in, and
getting their own data back out.

- **The import wizard** (`FR-IO-1`) is four persisted states — `uploaded` → `mapped` → `validated`
  → `running` — not four steps of a client-side form. Somebody who maps forty columns of a 12 000-row
  file and then closes the tab has not lost their work, `?job=` makes the wizard linkable, and a
  support engineer can see exactly where a stuck import stopped.
- **The mapping proposes itself.** `Mobile No.`, `E-mail ID`, `Pincode`, `Assigned To`,
  `Whatsapp Opt In` all map without being told, through a two-pass index (normalised, then
  space-stripped) over each field's label and aliases — `E-mail ID` normalises to `e mail id`, which
  no sensible alias list contains, but compacted both sides give `emailid`. A field is proposed
  **once**: if two columns both look like the phone number, neither is guessed, because reporting the
  ambiguity beats importing the fax number as the mobile.
- **The delimiter is sniffed** (`,` `;` tab `|`), the BOM is stripped, and `12,50,000` is read as
  ₹12,50,000 while a European `1.234,56` is read as 1234.56 — decided by evidence in the string
  rather than by a locale setting nobody will configure. Dates are day-first, and an ambiguous one is
  flagged rather than silently transposed.
- **Imported leads are created through `LeadsService`** — the tenant's duplicate rules, the
  assignment engine, custom-field validation, the timeline entry and the outbox event, per row.
  That is [ADR-0016](./decisions/ADR-0016-import-through-the-domain-service.md), and it is the whole
  of `FR-IO-2`'s "never blind-create": a bulk insert would be two orders of magnitude faster and
  would produce ten thousand leads with no owner, no timeline, no score and duplicates of each other.
  The measured cost is **~35 rows/second**, which is why an import is a background job with a
  progress bar and a cancel button.
- **The three modes differ only in what they do with a match, never in what a match is.**
  `create_only` lets the tenant's rules decide (`reject` refuses the row, `attach_to_existing`
  appends a touchpoint to the lead they already had); `skip_existing` and `update_existing` ask the
  same `DuplicateDetectionService` first, because they mean "I am re-uploading a list".
- **A row is a record, not a log line.** Every row gets an `import_rows` row — created, updated,
  attached, skipped or failed, with the cells as they arrived — which is what makes a retry
  **resumable** (the rows already recorded are the rows already done, and the counters are recomputed
  from them rather than trusted), what makes the error file reproduce a row exactly, and what answers
  "where did this lead come from" six months later. A row never fails the run; only a fault that
  makes the whole run impossible does.
- **The failed-rows file is the original columns plus `_row` and `_errors`**, in the original
  delimiter. A person fixes the file they recognise and re-imports it with the mapping they already
  chose — which is why `csvCell` and `unguardCell` are an exact pair: the formula guard that stops
  `=cmd|…` executing in Excel has to survive the round trip.
- **Exports are a job, a permission and an expiring file** (`FR-IO-3`). `export:data` lets somebody
  export; the moment a chosen column is personal data, `export:pii` is required too — checked again
  at download, because permissions change and a file of ten thousand phone numbers must stop being
  reachable by somebody whose access was taken away. Which columns count as personal data is
  **declared** per column, not derived from the schema. Every request and every download is audited,
  with `_pii` in the action name.
- **The export is the list on screen.** The same filter DSL, the same saved view (resolved at
  generation time so it reflects the view's current definition), and **the requester's own data
  scope** — a sales manager's unfiltered export returned 5 of the workspace's 14 leads, which is the
  single most important property an export has.
- **Storage is a port with a local driver** (`STORAGE`), following the `MAILER` precedent, and
  `documents` is its tenant-scoped index — so nothing above the port can enumerate a bucket, and a
  storage key never has to be trusted. The hourly sweep drops the bytes of expired files and **keeps
  the row**, because who exported what is audit history.
- **A CSV upload is a raw `text/csv` body**, not multipart: one file, no other parts, and the body
  limit is per content type so `application/json` keeps its 256 KiB while a CSV may have 20 MB. An
  `onRequest` hook refuses CSV content types outside the import paths — Fastify parses a body before
  any guard runs, so without it every route became a 20 MB sink reachable unauthenticated.

**948 tests green** (509 unit, 439 integration), including a 30-case import/export e2e suite and a
20-guarantee database verification run against real PostgreSQL. The wizard was then driven in a real
browser against the built app, a real API and a real worker — **23 checks**: upload, the proposed
mapping, the dry run's real problems, the run, the progress summary, the error-file download and its
contents, an export request, the exports screen, and the downloaded CSV's columns.

**The 10 000-row exit criterion, measured:** upload and propose in **127 ms**, the dry run over every
row in **253 ms**, the import itself in **296 s** — 9 700 created, 300 failed with per-row reasons, a
300-row error file, and 9 769 `lead.created` events dispatched and scored with nothing left waiting.

**Four defects found by running it, not by testing it:**

1. **The dry run lied about phone numbers.** It validated each row with `createLeadSchema`, which
   knows a phone is 4–32 characters and nothing else — normalisation needs the organization's
   country. A column of `not-a-phone` reported "5 rows ready to import" and then failed all five.
   The mapper now normalises, so the preview is a promise the import keeps.
2. **The wizard's screen ran a mutation to render itself.** It showed the dry run by calling
   `POST /imports/:id/validate`, so every refresh re-ran a state transition — a state machine driven
   by the browser's reload button. The dry run now has a read-only twin, `GET /imports/:id/check`.
3. **A grant cache generation keyed by `INCR` started at the wrong number.** `PrincipalService`
   defaulted an absent version key to 1, and `INCR` on a missing key also produces 1 — so the _first_
   role change in a workspace's life wrote the version it was already caching under, and stale grants
   stayed live for the full five-minute TTL. Every later change worked, which is what makes it the
   kind of bug that ships.
4. **Spreadsheet dates with a time on them failed.** `14/02/2026 10:30` did not match the day-first
   pattern and fell through to `new Date()`, which reads a day-first date as invalid — so every dated
   row of a file a spreadsheet had written failed. Found by rendering the export's own timestamps and
   then asking whether they could be re-imported.

**Deferred, and why:** the S3 driver (the local driver cannot serve a replicated API, and that is the
trigger, not a date); virus scanning, which is why `documents.scan_status` exists and reads `pending`
rather than pretending; streaming a generated file into storage, which is a port change — until then
the export ceiling is 100 000 rows because the finished file is held in memory. Customers, deals and
quotations remain later steps.

### Step 6 — customers and conversion ✅ _(landed 2026-10-06)_

The moment a sale closes, and the record that outlives it.

- **Conversion is non-destructive, and that is the whole design.** `FR-DEAL-4` asks for "lead →
  customer, preserving the full timeline and all touchpoints (never a fresh record)", so the lead
  keeps its row, its touchpoints, its score and its history, gains a `converted_at` and a `won`
  status, and the customer points back at it. A customer's timeline is the **union** of the lead's
  entries and the customer's own, computed at read time — nothing is copied, re-parented or
  renumbered, so there is no step at which a touchpoint can go missing. The reasoning, and the three
  designs rejected (one table with a type column, copying the history, re-parenting the activities),
  is [ADR-0017](./decisions/ADR-0017-customer-is-a-second-record.md).
- **A lead converts at most once, enforced by a partial unique index**, so two clicks or a retried
  request cannot produce two customers — while a workspace full of walk-ins, all with a null
  `lead_id`, stays representable. A plain unique index would have allowed exactly one walk-in per
  workspace.
- **The two subjects get different activity types** — `lead.converted` and `customer.created`, at the
  same instant. Both appear in the union, and the same sentence twice reads as a duplicated row
  rather than as a handover. It also keeps the direct-creation case honest: somebody who was never a
  lead did not convert, and their screen shows no origin panel rather than a fictional capture.
- **Consent travels with the person**, copied at conversion and authoritative from then on, with the
  carried-over values written into the timeline — a silent copy of a permission is the thing that
  most needs evidencing.
- **The customer screen is the journey.** The ad, the form, the round-robin assignment, the score
  change, the three follow-ups and the conversion in one list, with the pre-conversion half marked;
  plus an origin panel naming the original lead, its capture date, its source and its score at
  conversion, and a link back to a lead that is still there. A details tab edits the account, where a
  blank box clears a field — which is how a tax id somebody typed wrong gets removed.
- **Custom fields work against the `customer` entity**, which is the first use of the field registry
  for anything but leads: `custom.account_tier` on a customer validates against the tenant's customer
  definitions, with no migration and no deploy.
- **`TimelineReadService` was extracted** so the lead screen and the customer screen share one
  presentation, one actor-name resolution and one cursor — the cursor being the part that bites,
  since `activities` is partitioned and an id alone does not identify a row. Deals and conversations
  will each want the same page over a different predicate.
- **Search mirrors leads exactly** — the same trigger, the same weights, the same digits-only phone
  handling — so "the last four digits" finds a customer as readily as a lead and one search box can
  rank both tables consistently.

**1 005 tests green** (525 unit, 480 integration), including an 18-case conversion suite that tries
to break `FR-DEAL-4` — converting twice, converting another tenant's lead, reading a journey and
finding a half missing, hard-deleting the lead the history hangs from — and 19 database guarantees
verified against real PostgreSQL. Then **28 browser checks** against the built app: converting from
the lead screen, the journey's two halves, the origin panel's link back, an edit appearing on the
timeline, the list filter, a directly-entered customer, delete and restore.

**Four defects found by running it, not by testing it:**

1. **Every `:id` route answered 500 for a malformed id.** `GET /leads/not-a-uuid` reached Prisma and
   came back as `invalid input syntax for type uuid` — across the whole API, so a crawler or a stale
   bookmark filled the log with internal errors and hid the real ones. Fixed with a **global** pipe
   that answers 404 (not 400: the shape of an id must not become an oracle).
2. **The timeline showed developer field names.** An edit read "Changed JobTitle" and "Changed
   billingLine1", because `humanise` split snake_case and dots but not camelCase — and the `fields`
   list carries the API's property names. Found by asserting the sentence a person reads rather than
   the type behind it.
3. **Two timeline entries said the same thing at the same instant.** Both sides of the conversion
   were written as `lead.converted`, so the union showed it twice; and a customer who was never a
   lead was recorded as having converted. Split into `lead.converted` and `customer.created`.
4. **A three-way query filter could only ever answer two ways.** The repository's convention for
   `?flag=true` folds an absent parameter to `false`, which is right for `deleted` and wrong for
   `converted` — where absent means "both" and `false` silently returned half the list.

**Deferred, and why:** `FR-DUP-5` (duplicate detection and merge for customers) is not built —
`customers.merged_into_id` exists so it needs no migration, and lead-level matching already prevents
most duplicate customers because almost every customer arrives through a lead that was deduplicated
on capture. `lifetime_value_minor`, `first_purchase_at` and `last_purchase_at` are deliberately
**absent** until the payments ledger exists to write them: a money column that is always zero lies to
every report that reads it.

### Step 7 — deals, products and line items ✅ _(landed 2026-10-06)_

The money. `FR-DEAL-1` in full: deals with value, currency, expected close and a probability that
comes from the stage; products and line items; won and lost with the tenant's own reasons.

- **Line-item arithmetic lives in exactly one pure function, and the database re-checks it.**
  `lineTotals` / `documentTotals` in `@leados/shared`, over integers in minor units, with
  `deals_totals_add_up`, `deal_items_net_is_gross_less_discount` and
  `deal_items_total_is_net_plus_tax` as the backstop. Five things will eventually compute the same
  money — a deal, a quotation, its PDF, an invoice, a payment reconciliation — and the way a
  quotation ends up saying ₹1,18,000 while the invoice says ₹1,17,999 is never a bug in the
  arithmetic; it is two implementations of it, one rounding the running total and the other each
  line. The reasoning, the floating-point trap, and the three alternatives rejected are
  [ADR-0018](./decisions/ADR-0018-money-arithmetic-in-one-place.md).
- **Quantity is fractional, the arithmetic is not.** `DECIMAL(12,3)` in the database, scaled to
  thousandths and divided back once in the multiply, so 2.5 hours at ₹1,999.99 is exact. Discount
  applies **before** tax, per line; tax is broken down by rate so a document can show what it owes
  at 5 % and what at 18 %; and each line's total is rounded once and the document total is the sum
  of already-rounded lines — not a re-rounding of an unrounded sum, which is how a total stops
  equalling its own rows.
- **A deal with lines will not accept a total.** `PATCH` refuses `valueMinor` with a sentence, and
  `PUT /deals/:id/items` replaces the whole set and recomputes the header **in the same
  transaction** — there is no instant at which the lines and the header disagree. A deal with no
  lines keeps the field, because a single agreed number typed once is a perfectly good deal.
- **The catalogue pre-fills a line and then lets go.** Name, price and tax come from the product
  only when the caller omitted them; once written the line owns its numbers, so re-pricing a product
  never silently re-prices a deal somebody already agreed. A product that has been sold cannot be
  deleted at all — the refusal says "Deactivate it instead" — because deleting it would take the
  history of what was sold with it.
- **A deal is sold to a lead or to a customer, and the outcome is written on both.** `has_subject`
  requires one; a win or a loss writes one timeline entry on the deal **and** one on the party,
  because a business owner opening a lead must see that it was won without opening anything else.
  That is rule 6 of CLAUDE.md applied to a second subject.
- **Board columns total the column, not the page.** Each column carries `count`, `valueMinor` and
  `weightedMinor` over the whole filtered column while returning ten cards; the list reports
  `meta.totalValueMinor` for the whole filter. The board is the default view, because a sales
  manager opening the screen is asking "what is in play and what is it worth" and a table answers
  neither at a glance; `?view=list` is the same data for the questions a board is bad at.
- **Stage probability is the stage's, and it travels.** Moving a deal takes the stage's probability
  with it, a win sets 100, and the weighted forecast rounds once at the end rather than per deal.
  Won and lost are `won_at` / `lost_at` (never both, by constraint) plus a move to the pipeline's own
  won or lost stage by `is_won` / `is_lost` — never by a stage name. A loss reason is a row in the
  tenant's `lost_reasons`, and `reopen` clears the outcome without erasing the history, because it
  happened.
- **Pipelines gained a second entity type.** `?entityType=deal` on the existing resource, so a
  workspace configures a deal board with the same screens, stages and reorder it already has for
  leads; `seedDealPipeline()` gives a new workspace six stages so the board is never empty on day
  one.

**1 095 tests green** (546 unit, 549 integration), including 16 arithmetic tests that attack the
money directly (fractional quantities, discount-before-tax, the per-rate tax breakdown, the total
that must equal the sum of its rounded lines) and a 26-case deals suite over real HTTP. Every
hand-written object in the migration is asserted present in `schema-objects.int-spec.ts`, and five
new cross-tenant tests cover the three-column stage FK, the deal's lead and owner FKs, and the
line-item FKs. Then **31 browser checks** against the built app: picking a product and watching the
price fill, the header total equalling the sum of the lines (₹44,250), the win landing on the lead's
timeline, the board's per-column value, and the list reporting the whole filter's value
(2 deals · ₹1,07,450).

**Three defects found by running it, not by testing it:**

1. **The product settings screen said "No products yet" to every workspace, permanently.**
   `loadProducts` sent `?active=` — an empty string the enum refuses — and its `catch` turned the
   400 into an empty state. A loader whose failure is indistinguishable from an empty result is a
   lie on any screen whose job is to list things; it now has a throwing twin.
2. **A won deal's amount and note never reached the screen.** The activity types were added and the
   timeline describers were not, so `deal.won` rendered as a bare row — the registry's fallback
   hides the payload. Adding an activity type is two edits, and the first one alone passes every
   test.
3. **The deal timeline labelled every entry as the lead's.** `TimelineReadService.stage` had no idea
   deals existed, so a deal's own rows were presented as pre-conversion history.

**Deferred, and why:** **quotations, `quotation_items` and the PDF** are the next step, not this one
— they are a document and a numbering series over arithmetic that now exists in one place, which is
the whole point of having built it first. **`payments`** follows them, and until it exists
`lifetime_value_minor`, `first_purchase_at` and `last_purchase_at` stay absent from `customers`
(step 6's reasoning, unchanged: a money column that is always zero lies to every report that reads
it). Revenue reporting and attribution therefore read won deals, not payments, and nothing in the
product claims otherwise yet.

### Step 8 — quotations, versions and the document ✅ _(landed 2026-10-06)_

`FR-DEAL-2` in full: quotations with line items, taxes, discounts, validity, PDF generation,
versioning, and a record of how each one was sent.

- **A quotation is the only record in this product that leaves the building, and the design is
  built around that.** `number` identifies the quotation and `(number, version)` identifies the
  document; a revision **inserts a new row** and marks the old one superseded, and nothing about a
  sent version is ever updated again. So "what did we actually send them on the 14th?" has an
  answer that can be read out on the phone — which an audit log of `total_minor` changing from
  250000 to 220000 does not. The two designs rejected (edit in place with an audit log; versions in
  a child table, leaving the parent's totals a second copy of a child's) are in
  [ADR-0019](./decisions/ADR-0019-quotation-versions-are-immutable.md).
- **The number comes from a locked counter row.** `number_series`, one row per
  `(organization, kind)`, read with `SELECT … FOR UPDATE` inside the transaction that inserts the
  document. `MAX(number) + 1` is a read-then-write race that hands two people the same number — the
  same trap as the scoring queue's double write, with the same answer — and a Postgres sequence is
  global, so one workspace's quotations would advance another's numbering and leak how much business
  the platform is doing. The prefix and the padding are the tenant's; the counter moves **forward
  only**, because an earlier number is already in somebody's inbox.
- **The lines are the deal's, copied once.** Omitting `items` means "copy the deal's lines", which
  is what raising a quotation from a deal means; after that the deal goes on moving and the document
  does not. Both are priced by one `LineBuilderService` over one `lineTotals()`, extracted from the
  deals service in this step — the other half of
  [ADR-0018](./decisions/ADR-0018-money-arithmetic-in-one-place.md), and the same reason the browser
  table is read by one `parseLineItems()`.
- **The lifecycle is a protocol, so the database holds it.** `draft | sent | accepted | rejected |
expired` as a CHECK (a lead's status is the tenant's vocabulary; a document's lifecycle is not),
  plus four status/timestamp pairs that make a `sent_at` with no send, or an "accepted" with no
  acceptance date, unrepresentable rather than merely unlikely. A sent version refuses `PATCH` and
  `PUT /items` with a sentence that says to raise a revision; only the current version can be
  accepted; a draft is the only thing that can be deleted.
- **Accepting writes the agreed figure onto the deal, while the deal is still open.** A pipeline
  forecast that disagrees with the document the customer signed is worse than no forecast. A won or
  lost deal is left alone — that sale is settled — and the timeline **says which happened**, because
  a refusal nobody can see is indistinguishable from a bug.
- **The PDF is a real document.** A4, the workspace's name, the party's billing address, the lines
  with per-rate tax broken out, the totals and the terms, in DejaVu Sans — a declared dependency
  rather than a path under `/usr/share/fonts`, because the standard PDF fonts have no `₹` and a
  container without that path would render every quotation unreadable with nothing failing until
  somebody opened one. Rendered **synchronously** (milliseconds, so a queue would buy a polling UI
  and nothing else) and cached per version as a `documents` row with no expiry: an export goes
  stale, a quotation is a record. A draft renders fresh and is never stored, which the database also
  refuses.
- **Validity expires on a schedule.** `maintenance.quotation-expiry`, daily at 00:49, because
  `valid_until` is a date and a quotation valid "until the 20th" is valid for all of it. A price from
  April that still reads "sent" is one somebody honours by accident.
- **The screens follow the document.** A list of current versions with the whole filter's value and
  a status filter; a detail screen that is an editor while it is a draft and a frozen record
  afterwards, with every version listed and a link to the PDF; a quotations panel on the deal that
  shows the history and raises the next one; and a settings screen for the numbering, where a rewind
  is refused with the API's own sentence.

**1 210 tests green** (575 unit, 635 integration) — up from 1 095 — including a 40-case quotations
suite over real HTTP that attacks the version rule directly (reprice a sent version, revise a draft,
revise a superseded version, accept a superseded one, accept an expired one, five quotations raised
concurrently to prove the counter), 8 arithmetic tests for the number formatting, 9 for the shared
line-items parser, 43 new database guarantees asserted against real PostgreSQL, and 6 cross-tenant
tests including a version chain that tries to cross workspaces. Then **106 browser checks** against
the built app (47 new, 59 existing and still green), among them the whole money chain: a quotation
raised from a deal at ₹1,15,050, sent, revised, accepted, and the deal's own value following it to
the same figure.

**Four defects found by running it, not by testing it:**

1. **Every refusal in the product read "That is not allowed."** `ERROR_COPY` mapped
   `BUSINESS_RULE_VIOLATION` to that string and `describeError` preferred it over the API's own
   message — so "This deal's value comes from its line items", "Deactivate it instead" and "The
   counter is already at 3. It can be moved forward, but not back" were all discarded in favour of
   four words that tell nobody anything. Split into `ERROR_OVERRIDES` (session and access codes,
   where the API's text is for an integrator) and `ERROR_FALLBACKS` (used **only** when the API sent
   no message).
2. **A deal attached to both a lead and a converted customer wrote its timeline entry twice.** A
   converted person's journey is the union of their lead's entries and their customer's, so a deal
   won against both showed the win twice on the customer's screen — exactly the duplication that
   splitting `lead.converted` from `customer.created` was meant to prevent, reintroduced from the
   other direction. Both the deal and the quotation writers now write one row per **party**, keeping
   the lead row because the union already carries it across.
3. **Accepting a quotation on a closed deal silently did nothing.** The write-back is deliberately
   skipped, but nothing said so, so the only way to notice was to go and look at the deal. The
   timeline now carries `dealClosed` and reads "the deal is already closed, so its value is
   unchanged — reopen it to carry this figure".
4. **The expiry sweep could not write a timeline entry at all.** `withPlatformScope` leaves the
   tenant context unset and `TimelineService` takes the organization from it by design, so the first
   row threw. The sweep reads across tenants and then writes inside each row's own context as a
   system principal.

**Deferred, and why:** **`payments` is not built**, so `customers.lifetime_value_minor`,
`first_purchase_at` and `last_purchase_at` stay absent for a third step — a money column with no
writer lies to every report that reads it — and revenue reporting still derives from won deals
rather than from a ledger. **Delivery is recorded, not performed:** `sent_via` is evidence that
somebody sent the quotation, and the product does not yet email or WhatsApp it (`manual` is the
honest default); the mailer is a development logger until Phase 5 brings the real one. **Per-script
font fallback in the PDF is not built** — the document font covers Latin, `₹` and ordinary
punctuation, so a name in Devanagari or Gujarati prints as empty boxes, and the renderer logs the
code points it could not draw so that this is found in a log rather than by a customer.

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

_This section names the next step only; what each landed step actually did is in the step entries
above. Last reviewed 2026-10-06, after Phase 2 step 8._

**Phase 2, step 9 — payments, and the three customer columns that have been waiting for them.**
`FR-DEAL-3`: `payments` recorded manually (a provider adapter is a later phase), partial payments
against a deal or a quotation, `payment.received` on the deal's and the party's timelines, and the
numbering series reused for receipts. That ledger is the only legitimate writer of
`customers.lifetime_value_minor`, `first_purchase_at` and `last_purchase_at` — deliberately absent
since step 6 — and it is what every revenue and attribution report in Phases 8 and 9 is specified to
read, which they currently cannot. It is the last step of Phase 2's commercial surface; after it the
remaining Phase 2 work is the industry templates and the onboarding wizard.
