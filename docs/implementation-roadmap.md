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

### Step 9 — payments, and the revenue columns that were waiting for them ✅ _(landed 2026-10-06)_

`FR-DEAL-3`: payments recorded manually, partial payments supported, and payment events on the
timeline for automation and attribution to read.

- **A deal's value and a deal's payments are different numbers, and the product now says so.**
  `value_minor` is what was agreed and `paid_minor` is what arrived; `₹1,15,050 agreed, ₹50,000
received, ₹65,050 outstanding` is the sentence a collections call starts from, and no single
  column answers it.
- **Partial payments are rows.** Three instalments are three rows, each with its own date, method
  and reference, so "when did each one arrive and against which cheque number" has an answer.
  Nothing caps the total at the deal's value: an advance for next year's work and an overpayment
  somebody has to refund are both real, and refusing them would make the system disagree with the
  bank statement. `outstandingMinor` floors at zero, because an overpayment is a refund to arrange
  rather than a negative debt.
- **Every derived figure is recomputed from the ledger, never incremented.** `deals.paid_minor` and
  the three `customers` rollups are summed from `payments` after any write that could change them —
  recording, confirming, failing, refunding, correcting an amount, deleting — inside the same
  transaction and after `SELECT … FOR UPDATE`. Incrementing would need a compensating decrement on
  every one of those paths, and the first one to forget drifts silently and forever with nothing
  left to compare the column against. That is the scoring queue's bug with money in it;
  [ADR-0020](./decisions/ADR-0020-derived-money-is-recomputed.md) has the reasoning and the four
  alternatives rejected.
- **`customers.lifetime_value_minor`, `first_purchase_at` and `last_purchase_at` are real at last.**
  Carried as deliberately absent from step 6 to step 9 for want of a writer — a money column that
  is always zero lies to every report that reads it. A customer's lifetime value is the **union** of
  their own payments and their lead's, exactly like their timeline: conversion re-parents nothing,
  so a deposit taken before the sale closed is still on the lead and still this customer's money.
- **A refund is a status, not a negative row.** `payments_amount_positive` makes a negative payment
  unrepresentable; reversing one sets `refunded_at` and takes it out of every total while leaving
  the record of having received it. A bounced cheque is the same shape and additionally loses the
  date it appeared to arrive on, because it did not.
- **How money arrives is the tenant's own list.** `payment_methods` is a table, not a CHECK, for the
  same reason `lost_reasons` is one: a reconciliation groups by it and the right answers differ per
  business. Seeded with the five an Indian small business actually uses, three of which ask for a
  reference — and a method that has been used cannot be deleted, because deleting it would take the
  record of how that money arrived with it.
- **A receipt is numbered**, from the same locked-counter machinery as a quotation under its own
  `kind` and its own prefix (`RCPT-`), so the number a customer is handed is counted independently.
- **The screens follow the money.** Received and outstanding on the deal's header, a payments panel
  with the amount pre-filled to what is owed, a receipt screen offering only the transitions its
  status allows, a list separating what arrived from what is merely on the filter, lifetime value on
  the customer, and a settings screen for the methods.

**1 276 tests green** (580 unit, 696 integration) — up from 1 210 — including a 30-case payments
suite over real HTTP that attacks the derived figures directly (partial payments, an overpayment, a
pending cheque, a bounce, a refund, a corrected amount, a deleted row, and six payments recorded
concurrently against one deal), 31 new database guarantees asserted against real PostgreSQL, and 7
cross-tenant tests. Then **149 browser checks** against the built app (43 new, 106 existing and
still green), among them the whole chain: a ₹2,00,000 deal, a cheque refused for want of a
reference, ₹50,000 received, the figure corrected to ₹5,000 and the deal following it, an uncleared
payment that counts for nothing until it clears, and a bounce that leaves the total alone.

**Five defects found by running it, not by testing it:**

1. **Two CHECK constraints contradicted each other, and refunding anything was impossible.**
   `payments_succeeded_has_timestamp` as a biconditional on `succeeded`, plus
   `payments_refund_was_received`, are each sensible and together refuse every refund. Neither is
   wrong on its own, so nothing caught it until something exercised the transition. It is a `CASE`
   now: pending and failed have no date, everything else has one.
2. **`payment:read` answered 403 for the owner of a seeded workspace**, five minutes after being
   written. The permission catalogue is read when a workspace is **created**, so a new key reaches
   new workspaces and nothing else. Every step that adds a permission now ends with a data
   migration granting it to the system roles the templates name — and the grant cache's five
   minutes is the rest of the answer.
3. **A refused submission silently lost the chosen payment method.** `state.values` restores a text
   box through `defaultValue` and restores a `<select>` through nothing, so the commonest path
   through the form — pick Cheque, get refused for the missing reference, type the number, submit —
   recorded the payment with **no method at all**. A controlled `value` did not fix it either:
   React re-created the options in the same commit and the DOM kept `selectedIndex: 0`, so the
   screen said "Not recorded" while the component thought otherwise. Re-keying the select on the
   echoed value is what works.
4. **The payment-methods settings list was unreadable.** Seven editable rows rendered as seven
   identical "Name" labels, because every value lived in an input; and the browser check asserting
   that "Cheque" was listed passed off the page's own description sentence. Each row prints its name
   as text above the editor now.
5. **A migration cut by "everything before the first `CREATE TABLE`" deleted two `ADD COLUMN`
   statements** along with Prisma's spurious drops, and failed loudly on `column "paid_minor" does
not exist`. Recovered by dropping what the half-applied migration created and deleting its
   unfinished `_prisma_migrations` row — not by resetting a database.

**Deferred, and why:** **a payment provider adapter** is a later phase; `provider` and
`provider_payment_id` exist with the partial unique index that makes its webhook idempotent, because
adding that later would be a migration over live money. **Partial refunds are not representable** —
`refunded` is all-or-nothing, and a half refund is a credit note with its own number, which belongs
with the GST surface rather than the ledger. **`attributed_touchpoint_id` is still absent**: nothing
writes it until Phase 9, and attribution reaches a payment's touchpoints through its lead or
customer, one join away. **Conversion does not recompute a customer's rollups** — the figures are
derived and are recomputed on write, so a pre-conversion deposit lands in the lifetime value at the
next payment write; making conversion recompute would mean two modules owning the same four columns.

### Step 10 — industry templates and the onboarding wizard ✅ _(landed 2026-10-06)_

`FR-ONB-1`, `FR-ONB-2` and `FR-ONB-3`: the ten industry templates, a resumable wizard that includes
choosing one, and a finish state with three things to do.

- **A new workspace is provisioned industry-neutral, and a template replaces that.** The Phase 0
  sketch said a workspace is seeded "from the chosen industry template"; it cannot be, because the
  industry is chosen in the wizard and the product has to work on first login — a lead needs a
  default status to go into. So provisioning seeds the generic set and
  `POST /organization/industry-template` **replaces** the statuses, lead pipeline stages, sources,
  lost reasons, tags and custom fields with the industry's. Merging would leave twelve statuses, two
  of which mean the same thing and none of which anybody chose; an industry "mode" the product reads
  would break rule 4 and turn ten rows of content into ten code paths. The reasoning and the five
  alternatives rejected are
  [ADR-0021](./decisions/ADR-0021-industry-templates-replace.md).
- **The refusal is the safety property, not a limitation.** Applying a template is refused once the
  workspace holds a lead, a customer, a deal or a quotation, and the refusal names what it found
  ("This workspace already has 1 lead… add what you need in Settings instead"). `leads.status_id` is
  `Restrict`, so deleting a status a lead sits in would fail at the database anyway — refusing up
  front is the honest version of the same guarantee, and that window is exactly onboarding.
- **Two sources survive the replacement.** `Manual entry` and `API` are not a tenant's marketing
  channels — the capture paths look them up by name — and a template that deleted them would break
  lead creation immediately after onboarding.
- **The ten are content, and the tests treat them as content.** Thirteen unit assertions hold what
  must be true for any workspace to function: exactly one default status, one won stage at 100 % and
  one lost stage at 0 %, open stages in increasing probability order, no repeated name in any list,
  options on every select and none on anything else, snake_case field keys, six-digit colours, and
  every saved view filtering on a status the template actually installs. Then an e2e test applies
  **all ten** and creates a lead in each, which is where a typo in any of them would surface.
- **Nothing in the product branches on the chosen template.** `industry` and
  `industry_template_key` are recorded so a screen can say what was installed and a support
  conversation can start from "you chose Real estate"; every row a template writes is an ordinary
  editable row. That is rule 4, and it is what makes a template allowed to be wrong about an
  industry — the business renames two statuses and carries on.
- **The catalogue is a code constant _and_ a reference table.** `INDUSTRY_TEMPLATES` in
  `@leados/shared` is the definition, read by the seeder, the picker and the tests;
  `industry_templates` exists so an organization can reference what it applied and so the Super
  Admin console has a table to manage without a deploy (`FR-SA`). The API reads the constant, not the
  row's JSON, so there is one place the ten are defined.
- **The wizard gained the industry step, and a finish state worth reaching.** Seven steps now, still
  resumable from the organization's own onboarding state; the picker shows how many statuses, stages
  and sources each industry installs and names the questions it adds, and warns that it replaces
  **before** the click. Finishing shows "Your CRM is ready" with three links to screens that exist —
  add a lead, import the list you already have, invite the people who will use it — because a
  congratulations screen with nothing to click is where a trial goes to die (`FR-ONB-3`).

**1 316 tests green** (595 unit, 721 integration) — up from 1 276 — including the 13 catalogue
assertions, a 17-case template suite over real HTTP, 8 new database guarantees, and a new guard that
asserts every activity type a Phase 2 module writes has a timeline describer (with the eleven that
nothing writes yet listed explicitly, each against the phase that will). Then **194 browser checks**
against the built app (26 new, 168 existing and still green): the picker offering all ten, the
warning before the click, the statuses and the lead's questions actually changing, a lead created in
the templated workspace landing in the industry's first status, the refusal once that lead exists,
and the finish state's three links all loading.

**Three defects found by running it, not by testing it:**

1. **The catalogue endpoint answered `data: { items: [...] }`.** The envelope interceptor lifts
   `items` only when `pagination` is present, so a list returning `{ items }` alone is passed
   through as the whole `data` object — green in a test that checks the status code, broken in every
   client.
2. **A test hard-coded the length of the wizard.** `['done','done','current','todo']` against a
   four-step list failed the moment the list grew to seven, with nothing about the function having
   changed. Rewritten against `ONBOARDING_STEPS.length`.
3. **`prisma migrate dev` refused to run at all**, because an earlier migration had been edited
   after being applied (the payments constraint fix) and its stored checksum no longer matched. The
   repair is to re-record the checksum in every database that has the row — not to reset one.

**Deferred, and why:** **task types, starter automations and WhatsApp template drafts are not
seeded** by a template, because `task_types`, the automation tables and the WhatsApp template table
arrive in Phases 3, 6 and 5. The template shape is per concern precisely so that adding `taskTypes`
to the ten definitions is then a content change rather than a redesign. **Switching industry after
the workspace has records is refused rather than merged**: the relaxation somebody will eventually
want is a diff-and-confirm screen, which is a feature rather than a loosened constraint.

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

> **Exit criteria reviewed, 2026-10-06, after step 10.** Phase 2's scope is built. Six of the eight
> criteria are met; two are met only in part, and saying which is the point of reviewing them.
>
> 1. **A custom field of every supported type needs no migration and no deploy, and is immediately
>    filterable, importable, exportable and usable in a view — _met at the API, not on the web_.**
>    The registry, the filter catalogue, the import mapper, the export columns and saved views all
>    work against any field a tenant defines, and the industry templates create fields of seven
>    types without a migration. **There is no settings screen for fields**: they are created through
>    the API or by applying a template, and the lead screen shows them read-only. That is the one
>    piece of Phase 2's UI that is missing, and it is named here rather than ticked.
> 2. **Duplicate rules verified — met.** `duplicates-assignment.e2e-spec.ts` asserts the exact
>    sentence: the same phone arriving from three channels produces one lead, three touchpoints in
>    order with the first intact, and three timeline entries.
> 3. **Merge unions timelines, tasks, conversations and touchpoints, is reversible and audited —
>    met**, with the caveat the requirement itself implies: there are no tasks or conversations yet
>    (Phases 3 and 5), so what is unioned today is timelines and touchpoints, and the unmerge path is
>    tested.
> 4. **Assignment: round-robin fairness, capacity cap, outside-working-hours fallback,
>    unassigned-pool notification, and a rule tester that explains its choice — met.**
> 5. **Kanban loads one page per column — met. The 100 k-lead latency budget — _not verified at
>    100 k_.** Both boards return one page per column with per-column aggregates, and the index work
>    in step 4 (`leads_duplicate_of`, `leads_merged_into`) came out of a large fixture where deletion
>    had gone quadratic. The largest workspace exercised since is ~9 700 leads; nothing has been
>    measured against a budget at 100 000, and no budget is written down. Both of those belong with
>    the Phase 12 performance work, and this line should not read as a tick until then.
> 6. **The timeline shows every Phase 2 event type — met, and now guarded.** A unit test asserts that
>    every activity type in a module Phase 2 writes has a describer, with the eleven that nothing
>    writes yet (tasks, SLA, mentions, documents, consent) listed explicitly against the phase that
>    will write them. A type with no describer renders as a bare row, which is how `deal.won` once
>    reached a screen without its amount.
> 7. **Import of 10 000 rows applies duplicate rules, reports per-row errors and produces a
>    failed-rows file — _the behaviour is met, the volume is not_.** Every part works and is tested:
>    the dry run through the mapper, per-row errors, the failed-rows CSV, resumption from recorded
>    rows, and the duplicate rules applied per row because the import goes through the domain service
>    (ADR-0016). The largest file actually imported in a test is in the hundreds of rows.
> 8. **Tenancy and permission tests extended to every new route — met.** The generated sweep asserts
>    zero unmapped parameterised routes and drives every one of them as a second tenant; it has grown
>    with each step and currently covers the deal, quotation, payment and template routes.

---

## Phase 3 — Tasks, follow-ups, SLA and the executive workspace

**Scope:** tasks + types + outcomes; reminders; reschedule with mandatory reason + reason config;
complete-with-next-follow-up; "no next action" detection; overdue sweeps; SLA policies, clocks
(working-hours aware), escalation; manager SLA board; notification center with preferences + quiet
hours; **Today workspace (mobile-first)**; manager oversight views; leaderboard; call logging +
click-to-call abstraction; email sending adapter + bounce→suppression.

**Exit criteria**

- `GET /my/today` returns the entire executive screen in one request, p95 < 400 ms on the 100 k fixture.
  ✅ _(110 ms p95, step 3)_
- Reschedule **cannot** be completed without date, time and reason (API + UI tested). ✅ _(step 1)_
- SLA clocks respect working hours and holidays across timezones (DST case included in tests).
  ✅ _(step 8: four Europe/Berlin cases as arithmetic, five more as stored `due_at` instants)_
- Overdue and near-breach escalate to the manager exactly once (idempotency tested). ✅ _(step 2)_
- Today workspace usable one-handed at 375 px; actions survive a flaky connection (queued + retried).
  ✅ _(step 3)_
- Zero-training usability check: a non-technical tester completes "call the overdue lead, log the
  outcome, schedule tomorrow's follow-up" without help. ✅ _(step 8: a scripted walk-through that
  types no URL after the sign-in link, and found two copy defects)_

### Step 1 — tasks and follow-ups ✅ _(landed 2026-10-07)_

The product's answer to "what do I do next", and `FR-TSK-4`'s other half: making the leads nobody
owes anything to visible.

**Six tenant tables.** `tasks` (a thing somebody has to do, about a lead, a customer or a deal),
`task_types`, `task_outcomes`, `reschedule_reasons`, `task_reschedules` and `task_reminders` —
every one of the last three a row the tenant edits, because rule 4 says so and because `FR-TSK-2`
and `FR-TSK-5` both name lists a business has to be able to change.
`leads.next_action_task_id` was added: §6.2 of the database design had named it and the column did
not exist.

**Three decisions, written down as
[ADR-0022](./decisions/ADR-0022-overdue-is-derived-and-a-reschedule-moves-the-row.md),** because
each has a wrong answer that looks right:

1. **Overdue is derived from the clock, never stored.** A task due at 10:00 is overdue at 10:01,
   not at 10:30 when a sweep next runs. `task_status` therefore has four values and not the six
   `FR-TSK-3` lists. The sweep's job is to _tell_ somebody, which is why it writes
   `overdue_notified_at`, a timeline entry and an event, and changes nothing about what is true.
2. **A reschedule moves the same row.** Closing it and opening a replacement would put two things
   on the Today list for one call and double the lead's open count.
   `rescheduled_from_task_id` became `follows_task_id` and means something else: the follow-up
   created at completion pointing back at the task it came out of — the chain a manager reads as
   "five calls over three weeks".
3. **A reminder is a row, not a delayed job.** A delayed BullMQ job would have to be cancelled on
   every reschedule, completion and delete, and job removal is best-effort, so a reminder nobody is
   waiting for would still fire. A one-minute sweep over a partial index is an indexed read of
   nothing on almost every tick, and deleting a row is how a reminder is cancelled.

**Completion is the interaction `FR-TSK-6` describes.** The outcome is required — by the schema and
by `tasks_completed_has_outcome` — and an outcome the tenant marked `requires_note` demands one.
"Create the next follow-up" happens on the same form and in the same transaction, so a lead never
passes through a state where nothing is owed to it. Deactivating the **last** active outcome is
refused, because otherwise the workspace reaches a state where no task can ever be completed and
the error names a constraint rather than the setting somebody changed.

**The lead's denormalized next action is recomputed, never incremented** — and the lead's row lock
is taken _before_ the task write. That is not belt and braces: inserting a task takes a
`FOR KEY SHARE` lock on its lead, so asking for `FOR UPDATE` afterwards made two simultaneous
creates on one lead deadlock, and both callers got a 500. Found by a concurrency test, not by
reading the code.

**Two schedules on `maintenance`:** `task.reminder-dispatch` every minute and
`task.overdue-sweep` every thirty. Both read across tenants and write inside each tenant's own
context, because `TimelineService` takes the organization from the context by design — the trap the
quotation expiry sweep paid for. `task.overdue` leaves through the outbox and
`notify.task-overdue` tells the assignee and whoever holds `task:manage_others`; the other four
task events are recorded with no subscribers so a typo reads as "unsubscribed" rather than as
silence.

**`task:manage_others` is enforced for the first time.** It has been in the permission catalogue
since Phase 1 with nothing reading it. `task:manage` plus its data scope decides which tasks a
caller can touch; this decides whether they may finish somebody else's work for them.

**Screens.** `/tasks` is the queue — sections in the order somebody works them, each counter a
separate aggregate over the whole filter rather than a tally of the loaded page, and `noNextAction`
beside them. The follow-up panel on the lead detail screen is where a follow-up is actually
planned. `/settings/follow-ups` edits the three lists, each row printing its name as text above its
editor. `?taskId=` is a deep link that loads the task **by id** rather than finding it in the
current page — the panel otherwise failed to open for a colleague's follow-up, silently, which is
exactly where a reminder notification sends somebody.

**Verified.** 1 427 tests green (632 unit, 795 integration) plus 223 browser checks. The reminder
and overdue chains were also exercised live: the real scheduler fired both jobs, the real worker
consumed the outbox event, and the notifications arrived with one copy per recipient per task.

**Carried forward, named rather than assumed:** `/today` and the SLA machinery are the next steps;
neither sweep is quiet-hours aware (that needs `notification_preferences` to carry quiet hours, in
the notification-centre step); the queue's actions are server actions and round trips, not the
optimistic-and-queued ones the frontend design describes for `/today`; `automation_run_id` on
`tasks` waits for Phase 6 to create the table it would reference.

### Step 2 — the SLA policy and the business-hours clock ✅ _(landed 2026-10-07)_

`FR-TSK-8`, and the two exit criteria that are the whole difficulty: a clock that respects working
hours and holidays across timezones **with a DST case**, and escalation that happens **exactly
once**.

**Three tenant tables.** `sla_policies` (the promise, its conditions, its targets, and who hears
about a breach — by **permission**, not by role name), `sla_clocks` (one promise about one record,
with the instant it comes due) and `escalations` (somebody was told). `sla:read` was added to the
permission catalogue, with a data migration granting it to the 205 `is_system` roles that already
existed — the trap `payment:read` paid for.

**The business calendar is a pure function with 26 tests of its own.** `addBusinessMinutes`,
`businessMinutesBetween`, `nextBusinessStart` and `isWithinBusinessHours` in `@leados/shared` walk
the workspace's own local days rather than adding milliseconds, because a working window is a pair
of **wall-clock minutes on a local day** and that is what makes "09:00–18:00" survive a clock
change. A four-case clock-change block crosses a boundary in both directions; one asserts that
`businessMinutesBetween` is the exact inverse of `addBusinessMinutes`, which is what makes a breach
report trustworthy. (Step 8 adds the level this cannot reach: the same arithmetic asserted as a
**stored** `due_at`, through real `working_hours` rows and `SlaCalendarService`.)

Two bugs the arithmetic had, both found by running it rather than by reading it:

- the walk truncated the start to the whole minute, so a sixty-minute promise came due in
  fifty-nine — a business under-delivering against its own SLA, reaching a manager as a breach that
  arrived too soon. Found by an end-to-end assertion on an always-open policy;
- `escalations_notified_somebody` shipped as `array_length(notified_user_ids, 1) >= 1`, which is
  **NULL** for an empty array — and a CHECK evaluating to NULL is _satisfied_, so a row claiming
  somebody was told when nobody was went straight in. Corrected forward to `cardinality` in its own
  migration rather than by editing an applied one.

**Three decisions, written down as
[ADR-0023](./decisions/ADR-0023-sla-clocks-are-stored-and-escalation-is-a-unique-key.md):**

1. **`due_at` and `warn_at` are walked at capture and stored.** The sweep needs one indexed query
   across every tenant, and a promise recomputed later against a calendar somebody has since edited
   would move a deadline that was already communicated. Editing a policy therefore affects new
   clocks only, and `target_minutes` on the row is why a report can still say what each old one
   promised.
2. **Escalating once is `UNIQUE (organization_id, clock_id, level)`.** The sweep inserts and reads
   the collision; a read-then-write would let two sweeps both notify. Asserted by running two
   sweeps concurrently and counting rows.
3. **`breached` is stored, but "is it late" is read from the clock.** The opposite of a task's
   derived `overdue`, and for the opposite reason: a breach is an _event_ escalated to named people
   at a named moment. `slaHealth()` still reports a running clock past its due instant as breached,
   so no screen is ever a cron tick behind the truth.

**Two columns that had no writer now have one.** `working_hours` has been read since Phase 1 only
as "is this person on shift"; a workspace now has rows of its own (`user_id IS NULL`), backfilled
into existing workspaces, because without them the clock falls back to always-open and runs through
the night — wrong, and invisibly so. And `leads.first_contacted_at` / `last_contacted_at`, which
have existed since Phase 2 step 1 with nothing writing them at all, are written by a completed
follow-up — which is also what satisfies the first-response clock.

**Screens.** `/sla` is the breach board: five counts, each an aggregate over the whole filter, with
"answered late" separate from "missed" because a clock somebody eventually got to is a different
management problem. `/settings/sla` edits the policies, each row printing its promise as text.
The lead detail screen carries the promise in "At a glance", because a board a manager reads is no
use to the person who could still answer in time.

**Verified.** 1 544 tests green (691 unit, 853 integration) plus 253 browser checks. Thirty of them
are new and drive the board, the settings screen and the lead's own promise — including **waiting
for the real five-minute `sla.sweep` tick**, so the escalation the check asserts was produced by the
product rather than by the test.

**Carried forward, named rather than assumed:** `/today` is the next step; `next_response` is stored
on a policy but no clock starts for it until the Phase 5 inbox exists; `sla_clocks.paused_ms` has no
writer for the same reason; neither the SLA sweep nor the task reminder dispatcher is quiet-hours
aware, which needs `notification_preferences` to carry quiet hours (the notification-centre step);
and nothing has been measured against the `p95 < 400 ms` the `/my/today` exit criterion sets, which
belongs with that screen.

### Step 3 — `/today`, the executive workspace ✅ _(landed 2026-10-13)_

`FR-TSK-7`, and the two exit criteria nothing in the product had met: **one request under 400 ms on
the 100 k fixture**, and a screen **usable one-handed at 375 px whose actions survive a flaky
connection**. Everything it reads already existed — the task buckets, `leads.next_action_task_id`,
the SLA clocks. What did not exist was a screen that is a **queue rather than a list**.

**One endpoint, no parameters.** `GET /my/today` answers with five sections, nine counts and the
workspace's timezone. It accepts no query string at all — not `mine`, not `assignedUserId`, not
`limit` — because Today is not a question somebody asks but the answer, for the person holding the
phone, and because it leaves exactly one shape to measure. `task:read` gates the route; `lead:read`
and `sla:read` gate their own sections and **degrade** rather than refuse, since a role with the
follow-up queue and nothing else must not make the landing page unreachable. A section the caller
may not read says so (`available: false`): an empty list and a forbidden one look identical on a
screen, and must not.

**Measured, not asserted.** On `leads-100k.sql` + the new `work-100k.sql` — 109 716 leads, 10 862
follow-ups, 21 600 clocks, 31 413 leads nobody has called — **p95 = 60 ms** (p50 47 ms, max 63 ms,
payload 47 kB) against the 400 ms budget, as an executive and as the owner. Fifteen queries: the
workspace's timezone first, then fourteen in parallel. The one index it needed is
`leads_awaiting_first_contact`, a hand-written partial index for "which of the leads I can see has
nobody spoken to yet": **3.4 ms** with it against **10.7 ms** without, and the gap widens with every
lead somebody calls. It is registered in `schema-objects.int-spec.ts`, without which Prisma's next
diff drops it silently.

Its key is `(organization_id, created_at)` and **not** the assignee the query also filters on,
which is the third thing this step got wrong before measuring it: the screen asks for "mine _or_
unclaimed", an `OR` cannot be a range scan, and against the obvious index — keyed on the assignee —
the planner ignored it and read eight thousand rows through a filter instead. Both indexes are
correct; only one is used.

**Three things found by running it rather than reading it** (the third is the index above):

- **A lead nobody has been assigned appeared on nobody's Today.** The first implementation was
  strictly "mine"; a workspace with no assignment rule leaves every captured lead unassigned, so
  the new leads — and the first-response promises running out on them — were hidden from everybody.
  The rule is now "mine, plus anything nobody has claimed", and the **data scope** finishes it
  without a second rule: somebody scoped to their own rows cannot read an unclaimed row anyway, so
  the branch cannot widen what they see. Found by the browser check, which is the only test that
  had not been handed an assignee.
- **"1 missed promises."** The summary sentence is assembled from four clauses and one of them had
  been written without a plural helper. A screen that cannot count to one reads as machine output,
  which is the one thing that sentence exists to avoid.

**The taps are queued in the browser**, which is the part of `frontend-architecture.md` §5.1 that
step 1 had listed as not shipped. A tap is recorded before the request leaves, retried at
0 s / 1 s / 2 s / 4 s, persisted in `localStorage` across a reload, and shown as failed with a
"Try again" button once it has run out of attempts. The queue decides the thing no form ever does:
**whether trying again could possibly help** — a refusal (no outcome, a reason that needs a note, a
follow-up somebody else already finished) is never retried, because sending it again buries the one
sentence that explains it. It does not guarantee delivery; nothing in a browser tab can. It
guarantees the tap is never lost _silently_.

**Screens.** `/today`: a greeting, a sentence that omits what is zero, four tiles (two columns at
375 px, each a link to the list behind its number), then `Overdue` — first, red, never collapsed —
`Next up`, `Later today`, `Promises running out` and `New leads, nobody has called`. The promises sit
above the new leads because a clock running out is a commitment the business has already made.
`[Call]` and `[WhatsApp]` are `tel:` and `wa.me` hand-offs to the device, shown only for an E.164
number and only where the lead consented — not the click-to-call abstraction that _logs_ the call,
which still arrives with the channels. `Done` is a sheet with the outcome required and "plan the
next follow-up" pre-ticked; `Move` requires a date, a time and a reason.

**Landing is now resolved once, by permission.** `/` sends anybody holding `task:read` to `/today`
and everybody else to `/dashboard`. The design doc had said "executive → /today", which rule 4
forbids — roles are rows a tenant edits. Sign-in, invitation acceptance and the workspace switcher
all redirect to `/` rather than each carrying a copy of the rule; the switcher has to, because
permissions differ per workspace.

**Two definitions became one.** `taskBucketWhere` moved from `tasks.service.ts` into
`@leados/shared` beside `taskBucket`, because `/tasks` and `/today` now both count buckets and three
sections of one screen disagreeing about "overdue" is the exact failure that function exists to
prevent. A new spec evaluates the where-clause against the same tasks `taskBucket` labels and
asserts each row is selected by exactly the one bucket it reports. `firstContactedAt` also joined
the filter catalogue beside `lastContactedAt`, whose absence had been an oversight — so "nobody has
called them" is a saved view and the link out of Today's capped section, rather than a fourth
two-way boolean on `GET /leads`.

Decisions in
[ADR-0024](./decisions/ADR-0024-today-is-one-request-and-its-taps-are-queued.md).

**Verified.** 1 603 tests green (729 unit, 874 integration) — 20 of them a new `/my/today` e2e
suite — plus **39 browser checks** for this screen alone, at 375 px, which assert the latency-shaped
things no unit test can: no sideways scroll, every action at least 44 px tall, the tiles in two
columns, and the queue surviving a connection aborted once (it retries itself) and aborted four
times (it fails loudly, keeps the tap in storage, and sends it when "Try again" is pressed).

**Carried forward, named rather than assumed:** the **unread WhatsApp** section of the mock-up
arrives with the inbox, as an addition to this payload rather than a second request; `⌘K` and the
keyboard paths of `frontend-architecture.md` §4 are still unbuilt; the queue is per-viewer browser
storage, so a tap made on a phone that never regains signal is lost when the tab closes (a service
worker would fix it and belongs with the PWA, not with this screen); and neither sweep is
quiet-hours aware, which still waits on `notification_preferences`.

### Step 4 — the notification centre, and quiet hours ✅ _(landed 2026-10-13)_

`FR-NOT-1..3`, and the item the last two steps both carried forward. `notification_preferences` has
existed since the very first migration, with `channels` and `quiet_hours` columns, and **nothing
has ever read it**: every notification this product sends went out whatever the hour and whatever
the person had asked for.

**The gate is one method, not five.** Five producers write notifications and every one of them
calls `NotificationsService.create`, so that is where preferences and quiet hours are enforced. It
has three answers: write and deliver, write and **hold**, or do not write at all. A type somebody
switched off leaves **no row** — a notification nobody will ever see is not a record worth keeping,
and leaving one would make the unread badge and the inbox disagree about what "off" means. The
sixth producer somebody adds next month gets all of this without knowing it exists.

**Quiet hours moved off the per-type row.** `docs/database-design.md` §13 put `quiet_hours` and
`digest` on `notification_preferences`, whose key is `(organization_id, user_id, type)` — one copy
of the person's quiet hours per notification type, and copies can disagree. The two facts are now
split by their real cardinality: `notification_settings` is one row per person per workspace (the
window, and the zone to read it in), and `notification_preferences` keeps what is genuinely
per-type. Per **workspace** on purpose: somebody consulting for two businesses in different
timezones has two sets of working hours and two sets of quiet ones.

**The release is the hard half, and it is the half that makes this worth having.** Holding a
notification is arithmetic; the question holding one creates is what to do at 07:00 with a warning
written at 21:40 about a follow-up somebody finished at 08:15. Delivering it is worse than never
holding it — it reads as the product being a day behind. So every held notification is re-checked
against its subject at the moment it is released, by the kind of check its type declares:

- `task_still_open` — a reminder or an overdue notice is dropped if the follow-up is finished,
  cancelled or gone;
- `clock_still_running` — a near-breach warning is dropped if the promise has since been answered;
- `never` — delivered as written. **The breach notice is `never`**, because a missed promise is a
  fact about the past and the morning after is exactly when somebody should hear about it.

A type with no registry entry is never stale either: a producer added without one should deliver and
be noticed, not disappear. A dropped notification is marked `superseded_at` rather than deleted, so
"was I ever told?" has an answer — "no, it was held until 07:00, and by then you had already done
it".

**Both DST nights are tested.** `quietHoursHold` returns the end of the window **in the person's own
zone**, not `now + n hours`: adding a duration delivers at 06:00 on the spring-forward morning and
08:00 on the autumn one, and the second is an hour late on the day somebody has an extra hour to
read it. The same storage decision the working-hours calendar made, and the second consumer of it —
`nextDateKey` moved into `time.ts` so the two walk local days through one definition.

**Visibility is the sweep's write, not the passage of time**, and the cost is named rather than
hidden: with no worker running, held notifications are not released. That is the failure the product
already has for reminders, overdue sweeps and outgoing mail, and it is why the release cron runs
every minute. Showing a row the moment its instant passed would make it visible before anything had
checked whether it still mattered.

**Only `in_app` is offered**, and the screen says why. The email adapter and the WhatsApp sender are
later steps; a tick box for a channel that silently drops every message is worse than one that says
the channel is not here yet, because somebody would turn the in-app notification off in favour of
an email that never arrives. `digest` is **not** implemented and no column was added for it: a
digest is an email feature, and a daily summary of an inbox somebody is already looking at is not
one.

**The screen.** `/notifications` is now the centre: the inbox, the quiet-hours form, then a switch
per type under "Your work", "Leads" and "The workspace". One form per switch rather than seven
checkboxes and a Save button — a screen where somebody flips a switch, walks away and is woken at
midnight by the one they thought they had turned off is worse than one that costs a tap per change.
Each row prints its state as text beside its button, because a settings row whose value lives only
inside a control is one nothing can read back. A held notification says so in the list, or a 21:40
timestamp read at nine in the morning looks like the product being a night behind. `trial.expired`
shows as "Always on" with the reason: it is the one notice `FR-NOT-3` exempts, and somebody who had
switched it off would experience an expired trial as the product breaking with the only message
that explains it suppressed by their own setting.

Decisions in
[ADR-0025](./decisions/ADR-0025-quiet-hours-hold-a-notification-and-the-release-re-checks-it.md).

**Two things the tooling caught, rather than a human:**

- Prisma generated **fifteen** spurious statements above the first real one — two three-column
  composite FKs and thirteen GIN, trigram and partial indexes. All fifteen were deleted by hand;
  `schema-objects.int-spec.ts` is what makes that safe to get wrong once.
- The **generated route-authorization suite** failed on `PATCH /notifications/preferences` the
  moment it existed, because it is a write that declares no permission. That is exactly its job: the
  reviewed set of self-scoped writes must never grow silently, and quiet hours belong in it — a
  person whose employer can stop them silencing midnight notifications has no setting at all.

**Verified.** 1 673 tests green (764 unit, 909 integration), of which 70 are new: 24 for the quiet-
hours arithmetic and the type registry in `@leados/shared` (both DST nights, a midnight-crossing
window from both halves, and a `parseMinuteOfDay` that refuses what `Number()` accepts), 24 e2e over
HTTP, 11 in the web vocabulary spec, and 11 in the tenant-isolation and schema-object suites. Plus
**33 browser checks** which drive the screen and then the whole loop through the **real per-minute
crons**: `task.reminder-dispatch` writes the notification, the gate holds it, and
`notifications.release` delivers one and drops the other. Nothing in that section calls a service
method.

**Carried forward, named rather than assumed:** `digest` and the email and WhatsApp channels arrive
with the email adapter and the WhatsApp sender; six of the thirteen types `FR-NOT-2` lists do not
exist yet, because the modules behind them do not (listing them would give the screen six switches
that control nothing); the release cron is the only deliverer, so a worker that is down holds
notifications indefinitely; and there is no digest or "mark everything from before X read" for
somebody who comes back from a fortnight's leave to four hundred rows.

### Step 5 — manager oversight, and a leaderboard that ranks nothing ✅ _(landed 2026-10-13)_

Brief §4's "Which leads are being missed?" and `docs/frontend-architecture.md` §5.4's manager
dashboard: "SLA board, overdue by executive, unassigned queue, no-next-action list, leaderboard,
response times", with the rule the whole screen rests on — "every number has a drill-through to the
filtered list behind it (a metric you cannot click is a dead end)".

Everything it reads already existed. **The risk in this step was the word "leaderboard"**, and the
decision is the step:

**No rank, no score, no total column, and nothing that counts activity.** A single number hides
which dimension somebody is behind on — "Priya: 63" says nothing a manager can act on, while
"11 overdue, 2 never called, 92 % answered on time" is three different conversations and only one of
them is a problem — and the moment a score exists it gets optimised. Every column is an **outcome**
(answered on time, median reply, converted) or a **cost** (overdue, moved, never called, nothing
planned). A leaderboard ranked by calls logged teaches everybody to log calls, and this product
already writes every touch to the timeline automatically, so an activity count would have measured
the diligence of somebody's data entry and called it performance. `reschedule_count` is there
because `FR-TSK-5` asks for it, framed as one cost among others rather than as a headline.

**A rate computed from nothing is `null`.** Somebody who answered no promises in the period is not
at 0 % and not at 100 %; the screen shows "—". A hundred per cent is the more dangerous of the two,
because it reads as excellent.

**A median, not a mean** — one lead answered three days late drags a mean across a team of ten into
uselessness. That is the module's one piece of raw SQL (`percentile_cont`, which Prisma has no
aggregate for), with `organization_id` passed explicitly because raw SQL does not pass through the
tenant-scoping extension.

**One endpoint, scoped, not one per role.** `GET /oversight` read with `report:read` through
`DataScopeService`: a branch manager sees their branch and the owner the workspace, from the same
route. `docs/api-architecture.md` had sketched `GET /dashboard/{owner|manager|executive|…}`; a path
named after a role is what rule 4 forbids. `report:read` was **already** in the catalogue and
already granted to the manager, marketing-manager and auditor templates, so this is the first step
in a while that needed no permission and no data migration — and no schema change either: the three
tables are already indexed on `(organization_id, assigned_user_id, …)` by the steps that built them.

**The people come from the member list, not from the work.** Somebody nobody has given anything to
has no tasks, no leads and no clocks, and would be invisible on the one screen whose job is to
notice that. For the same reason the **unassigned** backlog is a tile of its own: a lead with no
owner is in nobody's row, which makes it the number a manager would otherwise never see.

**Every number is a link, and the link is defined beside the number.** Each column in
`lib/oversight.ts` carries its label, its hint, its kind and a function producing its destination, so
a figure and the list behind it cannot drift; a spec asserts every column produces a link carrying
that person's own id. The lead links are filter-DSL URLs, because `/leads` has no query-parameter
filters at all — the trap `/today` paid for two steps ago. `/tasks` and `/sla` gained an
`assignedUserId` parameter on the **web** side so "Priya: 7 overdue" has somewhere to land.

**One real bug, found by measuring rather than by reading.** The headline median had no person
filter while every count beside it was data-scoped, so a branch manager would have read their
branch's counts next to the whole workspace's median — a number on a filtered screen that was not
filtered, which is this codebase's recurring failure one layer at a time. Caught on the 100 k
fixture by noticing the headline disagree with every row under it.

Measured there too: **p95 = 110 ms** at thirty days and 111 ms at ninety (109 716 leads, 10 719
follow-ups, 21 411 clocks), with fourteen grouped aggregates — one `groupBy` per question rather
than one query per person, so the shape does not change when the team doubles — plus one percentile
query per person who answered anything. The work fixture now also marks a fifth of its clocks
**answered**, because a workspace where nothing was ever answered exercises neither the on-time rate
nor the median, which are the two numbers on this screen that cost anything to compute.

Decisions in [ADR-0026](./decisions/ADR-0026-oversight-has-no-single-score.md).

**Verified.** 1 704 tests green (779 unit, 925 integration), 46 of them new: 16 e2e over HTTP
(including a branch-scoped manager seeing one row where the owner sees three, a count of 25 that is
not 20, and an on-time rate that is `null` rather than zero) and 15 in the web vocabulary spec
(every column produces a link, no column named rank/score/total, and no lead link that uses a query
parameter the screen ignores). Plus **30 browser checks** which drive the screen and then click the
numbers: "2 overdue" lands on exactly those two follow-ups and nobody else's, "never called" on her
one uncontacted lead, and the unassigned tile on the lead nobody owns.

**Carried forward, named rather than assumed:** these cards read live aggregates and §5.4 says they
will read rollups — that is Phase 10, and inventing the rollups now would mean two definitions of
every number here; teams are not a dimension yet (rows are people, the scope narrows by branch);
the table cannot answer "who is best", and will be asked to — the honest answer is that it shows the
five things somebody could be best at; and the other two things the brief lists for this role are
the pipeline board (built, at `/pipeline`) and conversation oversight (with the inbox).

### Step 6 — the call log, and click-to-call that works before anybody buys telephony ✅ _(landed 2026-10-14)_

`FR-CALL-1..3`. The step several landed ones were waiting on: `/today` handed a phone number to the
device with `tel:` and recorded nothing, so "what happened on those forty calls" — the question the
call log exists to answer — was unanswerable.

Two facts about the world shaped every decision here. **No workspace has a telephony provider on
day one, and most never will**: Indian small businesses ring customers from the phone in their hand,
and a feature that needs a plan before it does anything is a feature nobody uses in the first six
months. And **the phone is where the work happens**: everything else in the CRM is a consequence of
a conversation somebody had, which makes the call log the only record of the work itself.

**A status and an outcome are different questions, and both are recorded.** `status` is what the
telephony saw — it rang, the line was busy, we spoke for four minutes. `outcome_id` is what the
conversation meant, and it is the tenant's own list (rule 4), because "not interested" is a
different list in a school from a car dealership. Collapsing them loses one or the other: a
connected call with no useful outcome and a no-answer with "asked to call back" are both ordinary.
The outcome's **category** is code, not configuration, because the product has to know that "Hot —
spoke to them" means somebody was reached and no amount of reading the name tells it that.

With the manual driver there is no telephony at all, so the person is the only source of both
answers — and asking them twice ("did it connect?" and "what happened?") is one question in two
vocabularies, one of them a developer's. The screen asks once and derives the status
(`statusForCategory`); a spec proves the derivation can never produce the request the API refuses.

**An attempt and a result are two different facts, and two timeline entries.** `call.attempted`
when the product dials, `call.logged` when the call is over. The pair exists because the manual
driver _cannot_ know the result — so a dialled call is left `dialing`, for ever if nobody says
otherwise. That is not an unfinished state machine; it is the truth, and a sweep that guessed
"probably no answer" would replace a fact with a fiction that reads identically.

**What the sweep does instead is ask**, and that is the load-bearing part. `call.outcome-sweep`
sends one notification fifteen minutes on, recorded in `calls.outcome_prompted_at` so it never asks
twice (the shape `tasks.overdue_notified_at` settled), stops looking after a day, and declares
staleness `call_still_open` so a nudge held through quiet hours is dropped if the outcome arrived
meanwhile. Without it the feature is a honeypot: click-to-call is one tap and recording the outcome
is a form.

**A call that reached somebody is a contact — and `isContact` decides which ones did.**
`leads.first_contacted_at`, `last_contacted_at` and the `first_response` promise are now written by
**one** service, `LeadContactService`, which a completed follow-up and a logged call both call: a
second copy inside the calls module is the `telHref` trap with a worse consequence, since a lead
could be marked contacted by one channel with the promise left running by another. Two of the six
categories are easy to get wrong in opposite directions — **`not_interested` is a contact** (a
business that rang and was turned down has answered the enquiry, and counting it as "never
responded" holds its own SLA against it for doing the job), and **`wrong_number` is not** (somebody
answered, but not this person). And "spoke to them" on a call that did not connect is refused,
because that pair decides both.

Found while writing the tests: `first_contacted_at` was being written only where it was null, so
logging Monday's call on Wednesday could not correct it — and every "time to first response" figure
would have said the business took two days longer than it did. The two columns now move in opposite
directions: the first never forwards, the last never backwards.

**The port says how the call is being placed, not that it was.** `dial()` answers
`{ mode: 'device', href: 'tel:…' }` or `{ mode: 'provider', provider, providerCallId }`, because a
cloud provider rings both parties and the manual driver hands the number to a phone — genuinely
different outcomes the UI must treat differently. `placesCalls` is read by `GET /calls/config`, so
the sentence under the button says "this opens your phone" today and changes itself the day a
provider is connected. Recordings, transcripts and a hangup are deliberately **not** on the port:
the first three arrive as webhooks on a call that already exists (an update to a row), and nothing
here can end a call it did not place — a port method one driver must throw from is a lie in the
contract.

**`call_outcomes.score_delta` from the Phase 0 sketch is deliberately not implemented.** Scoring is
`scoring_rules`, and `ScoringSubject.event` already carries `outcomeCategory`, so "+15 when we speak
to them" is a rule like every other rule; a second per-outcome delta would be a second scoring
engine with no answer to whether it decays, respects `max_applications` or appears in the
breakdown. `docs/database-design.md` §7 is amended to say so rather than left to look forgotten.

**The event's subject is the lead, not the call**, because a processor reads its subject from
`payload.aggregateId`. It follows that an unlinked inbound call emits nothing — there is no lead to
score — and `call.logged` is emitted when such a call is **attributed**, which is also the first
moment it is true of a lead. `calls.lead_id` is nullable on purpose: a call from a number nobody
recognises is the one most worth keeping, and `calls_unlinked` is the partial index behind the queue
of them.

**`finishFollowUp` is not in the call's transaction.** Completing a follow-up and logging the call
that finished it are one action to the person doing them (`FR-TSK-6`), so `POST /calls` takes it —
applied _after_ the call commits, because the call row is the record of what happened and must not
be lost, a task left open is visible on every queue screen, and making them atomic would mean
reimplementing task completion inside this module. The response says which happened.

**The screens.** The calls panel sits on the lead between the follow-ups and the custom fields —
what is owed, what was said, who this is — with the unrecorded attempt first, in amber, its form
already open; `/calls` leads with the calls that still owe an answer and only then the history; and
`/settings/calls` holds the outcome vocabulary, beside the follow-up vocabulary and for the same
reason. Nine CHECK constraints, each written so no sub-expression can be NULL while the row is
accepted, and a partial unique index on `(organization_id, provider, provider_call_id)` that is the
idempotency gate the Phase 4 webhook will need.

Decisions in
[ADR-0027](./decisions/ADR-0027-calls-sit-behind-a-port-and-an-attempt-is-not-a-contact.md).

**Verified.** 1 811 tests green (812 unit, 999 integration), 107 of them new: a 43-case calls suite
over real HTTP (the contact columns and the SLA clock, "spoke to them" on a call that did not
connect, a second outcome on one call, the nudge asking exactly once however often the sweep runs,
and a follow-up closed by a call), 12 new cross-tenant and constraint guarantees against real
PostgreSQL, 5 new database objects registered in `schema-objects.int-spec.ts`, and the shared and
web vocabularies reconciled against each other. Then **45 HTTP checks** against a running API and
worker, **42 browser checks** driving the screens in Chromium, and **9 more as an auditor** — whose
`call:read` without `call:log` is the configuration the two permissions exist for: they read the log
and are offered no dial button, and the API answers 403 either way.

The nudge was also watched through the real cron, with the scheduler, the worker and the API all
running: a call dialled and backdated twenty minutes produced, on the next ten-minute tick, exactly
one `call.outcome_missing` notification — "What happened with Anjali Rao? You dialled from the
product and the call has no outcome recorded yet" — linking to the lead, with
`calls.outcome_prompted_at` written.

Four of those HTTP checks are the ones that make `FR-CALL-3`'s "outcomes feed scoring" a tested
claim rather than an asserted one: a rule on `call.logged` whose only condition is
`event.outcomeCategory eq connected` scored a conversation 15 and left a no-answer at 0, and the
lead's score breakdown names the rule that did it. That is the whole reason there is no second
per-outcome score delta.

Three defects were found only by that verification: the panel's summary read "no time on the call on
the phone" (a sentence nobody wrote, assembled from clauses that each have a case where they are
wrong), `data-dial` passed to `<Button>` was silently dropped because TypeScript allows any `data-*`
on JSX and the component does not spread it, and the settings screen could not say which categories
count as having reached somebody because only `/calls/config` derived it.

**Carried forward, named rather than assumed:** `recording_url`, `recording_document_id`, `provider`
and `provider_call_id` exist with no writer — they are the columns the Phase 4 provider webhook will
fill, and the index that makes it idempotent, said plainly here because a column with no writer is
otherwise indistinguishable from a feature somebody forgot. An unlinked call can be attributed over
the API but has no screen for it, because nothing creates one yet: the manual driver only logs
outbound calls against a lead. `call.missed` is in the activity registry with no describer and no
writer, on the timeline registry's deferred list, because only a provider can report an inbound call
nobody answered. And a worker that stays down holds every nudge, so the attempts accumulate
unrecorded — the same failure reminders and held notifications already have.

### Step 7 — the email sending adapter, and a bounce that stops the next send ✅ _(landed 2026-10-14)_

`FR-PRV-2`, `FR-NOT-2`, `FR-NOT-3`. The last item in Phase 3's scope, and the one three landed
steps were visibly waiting on: `notification_preferences` offered an `email` channel the deliverable
set refused, and the preferences screen rendered that half greyed out with a sentence saying why.

Until this step the product had never sent an email. One driver existed — the development logger,
which writes the message to the log, refuses to run in production, and returned nothing — and the
four things that send (verification, reset, security notice, invitation) each called `MAILER.send`
directly and threw the result away.

**A bounce is a fact about a mailbox, not about a relationship**, which is the decision the whole
step turns on. `docs/database-design.md` §13 sketched `suppressions` keyed on
`(organization_id, channel, identifier)`; that answers a different question. A hard bounce says the
address is dead whoever is sending, and the thing a suppression list protects — the sending domain's
reputation — is shared by every workspace on the platform. So `email_suppressions` is keyed on the
address alone, with no organization at all, and the §13 table is named as the **other half** of
`FR-PRV-2`: a workspace's own opt-outs, per channel, which arrives with marketing in Phase 9 because
nothing would write one before then. A table with no writer is indistinguishable from a feature
somebody forgot, which is why both halves are now written down.

**A nullable `organization_id` was the obvious middle path and is the trap.** `findRegistryDrift`
requires any model carrying the column to be in `TENANT_MODELS`, where the scoping extension filters
`organization_id = :current` — hiding exactly the rows that have no workspace, which is a password
reset's delivery record and a bounced mailbox. Both tables are platform, and the registry's refusal
to model "half a tenant table" turns out to be right: such a table is two tables whose guarantees
differ.

**How much a suppression stops depends on why it exists.** A bounce stops everything: the mailbox
does not exist, so there is no message important enough to be worth sending to it. A **complaint**
stops everything _else_ — somebody clicking "spam" is asking to stop being contacted, not asking to
be denied the password reset they request thirty seconds later, and treating the click as consent to
that is the kind of literal-mindedness that loses a customer who was only annoyed. So
`email_verification`, `password_reset` and `security_notice` go out anyway, which is the same
principle `FR-NOT-3` states one layer up. `suppressionStops` is the one decider, and an unknown
reason takes the gentler branch.

**One path, and a refusal is a recorded row.** Nothing calls `MAILER.send` any more:
`EmailSenderService` checks the list, writes the log row, asks the provider, and records the outcome,
because a second call site is a second place to forget one of those. A suppressed send answers
`status: 'suppressed'` with a row naming the suppression that stopped it — the caller has already
committed, so an exception would make a queue retry it for ever, and the row is the answer to "the
invitation never arrived". A provider failure _is_ thrown, after the row is written, because that is
what the retry is for.

**The port answers with the provider's message id**, which it did not before — and a `void` send
makes a bounce unattributable, which makes a suppression list that can never be filled.
`parseEvent` is on the port too, because the vocabulary is the provider's: Postmark says `HardBounce`
and `SpamComplaint`, SES says `Bounce` with a `bounceType`, and above the port there are four words.
The distinction that matters is hard versus soft — a full mailbox is `failed` and suppresses nothing.
**Postmark** is the first real driver, chosen for its shape rather than its features: one JSON POST,
so there is no SDK inside the thing that sends password resets. The development driver still returns
an id, which is what makes the whole bounce path exercisable with no provider account.

**The webhook is the only writer of the list, and is authenticated as such.**
`POST /webhooks/email` is `@Public()` — a provider has no session — and presents
`EMAIL_WEBHOOK_SECRET`, which the configuration schema makes mandatory the moment a real driver is
set, so there is no deployment in which it is both reachable and unauthenticated. An open one lets
anybody stop a workspace's mail by posting a bounce for its owner's address. It answers **200 to an
event it does not understand**, because a 4xx teaches a provider to retry and then disable the
endpoint — and that would silently stop the list being filled. It is the first public write outside
`/auth`, so the route-authorization suite gained a second reviewed set for it.

**Email is a delivery of a notification, not a second notification.** `DELIVERABLE_CHANNELS` gains
`email`, the preferences screen's greyed-out half becomes a tick box per channel per type, and the
email carries the notification's own title, body and link. It is enqueued, never inline. And a
**held** notification is not emailed until it is released: `deferred_until` means the inbox is
deliberately hiding the row, so an email at 21:40 about it would break the only promise quiet hours
make. The release sweep enqueues the ones it lets through, re-reading the channel choice as it does.

**One thing a workspace is told.** A member whose address is suppressed is marked on
`/settings/members`, with the reason as a sentence and the date. The alternative is silence: a
colleague whose address hard-bounced stops receiving every notification they chose email for, and
nothing anywhere would say so.

Decisions in
[ADR-0028](./decisions/ADR-0028-email-sits-behind-a-port-and-a-bounce-is-a-fact-about-a-mailbox.md).

**Verified.** 1 860 tests green (829 unit, 1 031 integration), 49 of them new: a 22-case email suite
over real HTTP (a bounce that stops the next send, a complaint that still lets somebody reset their
own password, a refusal recorded as a row naming the suppression, a webhook that is idempotent and
answers 200 to an event it does not understand, and a soft bounce that suppresses nothing), 8 new
database guarantees asserted against real PostgreSQL, 17 in the shared vocabulary spec, and a second
reviewed set in the route-authorization sweep for the first public write outside `/auth`. Then **20
HTTP checks** against a running API, worker and scheduler, and **20 browser checks** driving the two
screens that changed.

**The delivery log found a real bug on its first run.** `AuthService.register` emitted
`user.registered` inside the transaction that creates the user — which is right, and the whole point
of the outbox — and then called `requestEmailVerification`, which emits the same event again. So
**every new user had been receiving two verification emails**, the second link superseding the
first, for four phases. Nothing noticed because nothing recorded that a send had happened. The
redundant call is gone, `requestEmailVerification` remains for the `resend-verification` endpoint
that is its purpose, and a test asserts one event per registration.

Two unrelated tests were also fixed rather than worked around: `today` and `oversight` each asserted
that a freshly captured lead was unassigned, which is true only outside the workspace's working
hours — they had been passing because the suite usually ran before 09:00 IST, and failed the first
time it ran at midday. Both now _make_ an unclaimed lead through the real endpoint.

**Carried forward, named rather than assumed:** `digest` is still not implemented and still has no
column — a daily roll-up is a different feature from a channel, and `FR-NOT-3` asks for both. The
tenant-scoped `suppressions` table waits for marketing, and `notification_deliveries` waits for a
second channel, because inventing either now would be two definitions of one fact. Nothing releases
a suppression through a screen: `EmailSuppressionService.release` exists, is called by no route, and
belongs to the Phase 10 operator console. And the platform list is shared, so one workspace's bounce
stops another's send to the same dead mailbox — the intent, and a behaviour to revisit if the product
ever sends from per-workspace domains.

### Step 8 — the phase gate: the clock across a clock change, and the journey a tester walks ✅ _(landed 2026-10-14)_

Not a feature. Phase 3's scope was finished by step 7; this step is the **two exit criteria that
were not met**, done rather than declared — and both found something.

**The DST criterion was half true, and the roadmap said so wrongly.** The previous entry claimed
"the arithmetic … converts each window boundary on its own local day, but no test crosses one". The
first half is right and the second was not: `packages/shared/src/business-hours.spec.ts` has had a
`describe('a clock change')` block with four Europe/Berlin cases since step 2. What had never been
exercised was everything _between_ the arithmetic and the database — the workspace's own
`working_hours` rows, `SlaCalendarService` turning them into a calendar, the holiday date-key
conversion, and the instant that ends up stored in `sla_clocks.due_at`. A calendar-level test cannot
see any of it. So `sla.e2e-spec.ts` gained five cases that each build a real workspace in a named
timezone, write real hours, start a real clock through `SlaService.startForLead`, and assert the
stored instant to the minute:

- **Spring forward.** A promise made at 17:30 CET on Friday 27 March 2026 — 30 working minutes
  before closing — comes due at 09:30 on Monday the 30th, which is `07:30Z` because the clocks moved
  that weekend. An offset read once, on the start day, would be an hour out.
- **Autumn back.** The same shape on 23 October, landing at `08:30Z`.
- **Two timezones, one promise.** 10:00 local in Asia/Kolkata and in America/New_York, both due at
  11:00 local, which is `05:30Z` and `15:00Z`. One calendar definition, two instants.
- **A holiday on the day the workspace means.** `holidays.date` is a `date` column whose instant is
  midnight **UTC**; read in New York's zone that key is the day before. A Friday declared closed has
  to close the Friday, so a Thursday-evening promise lands on Monday.
- **A weekend arrival.** Sunday 11:00 CEST comes due at 10:00 on Monday: the clock starts when the
  business opens, not when the lead arrives.

Writing them found the trap now in `CLAUDE.md`: driving `startForLead` through the e2e harness's
**unscoped** client made it read every workspace's SLA policies and match somebody else's, which
`sla_clocks_policy_same_org_fk` refused. The composite FK caught what a missing tenant scope would
otherwise have written — the first time one of those FKs has fired in anger.

**The zero-training criterion, done as a scripted walk-through.** "A non-technical tester completes
_call the overdue lead, log the outcome, schedule tomorrow's follow-up_ without help" cannot be
asserted by a test that navigates by URL: that proves the endpoints work and says nothing about
whether anybody could find them. So the walk-through types **nothing but the sign-in link** — every
step after it is a tap on something the previous screen offered, on a 375 px phone, and every
assertion is about what the screen _says_. 38 checks, all passing: the first sentence on Today names
the overdue work; the card carries the person, the number and "2 days late"; the actions are `Call`,
`Done`, `Move`; `[Call]` is wired to that lead's own number; the finish form asks one question in
the workspace's own words; saving too early is refused in a sentence rather than a code; the next
follow-up is offered on the same form, already ticked, already filled with tomorrow at 10:00, so
nothing has to be typed; and the same tap both completes the call and plans the next one, to the
minute. Then the second route to the same journey — the menu, the list, the person's name, the dial
button that hands the number to the phone _and_ records the attempt, the amber row that asks what
happened before being asked, and the follow-up planned from the lead's own card.

**It found two copy defects, which is what the criterion is for.** Today's summary sentence read
**"0 follow-ups left today · 1 overdue · 1 new lead to call"** — a nought beside a contradiction, on
a screen with a late follow-up plainly on it. And the sentence's one piece of advice, "a good moment
to call the leads nobody has reached", was shown under the condition "no other clause is true" —
but the uncalled-lead clause _is_ one of those clauses, so the suggestion appeared **only** on days
when there were none of them to call. Both were invisible to the existing browser check, whose
"omits what is zero" assertion tested `/ 0 /` against a string whose zero was the first character:
a sentence assembled from clauses needs a test per shape, not per clause. `describeDay` now leads
with the late work when nothing is due today, offers the advice only when somebody can take it, and
says "Nothing is owed today, and every new lead has been called." when that is the truth.

**Verified.** 1 868 tests green (832 unit, 1 036 integration), 8 of them new: the five clock cases
above and three `describeDay` shapes. Then the **38-check walk-through** against a running API,
worker, scheduler and web app, and the Today browser check (39 checks) re-run unchanged to confirm
the new copy. The walk-through also paid for a harness trap worth the note in `CLAUDE.md`: tapping a
`tel:` link in headless Chromium aborts the navigation and leaves the tab permanently inert — no
click runs a React handler again, not after a reload, not after a fresh `goto` — while a second tab
in the same context is fine. That is the harness, not the screen, and it is also the honest stand-in
for putting the phone down.

**Phase 3 is complete**: every item of scope built, and all six exit criteria met and tested.

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

### Step 1 — capture forms, and the page a stranger fills in ✅ _(landed 2026-10-14)_

`FR-CAP-1`, `FR-CAP-2`, `FR-CAP-3`, `FR-CAP-4`, `FR-CAP-5`. The first capture channel that does not
belong to a signed-in person: a form rendered on somebody else's website, filled in by somebody
who has never seen this product, landing as a lead with its first-response promise already running.

**Three tenant tables**, plus two columns §6.2 had already named and which did not exist. `forms`,
`form_fields` and `form_submissions`; `leads.form_id` and `lead_touchpoints.form_id`, both with
composite FKs and `RESTRICT`, because "which form brought this lead" and "which form brought them
back" are questions attribution has to be able to answer a year later.

**The identifier was the first decision, and the specification had it wrong.** §8 gave `forms` a
`slug UQ per org` — right for the workspace to read, wrong for a public URL, because
`/f/contact-us` would belong to every workspace that ever named a form that. So `forms.public_key`:
24 random bytes as base64url, unique across the platform, rotatable in one click, and floored at 16
characters by a **database** constraint, because that value is the authentication — it decides which
workspace a stranger's submission lands in. The slug stays as the workspace's own name for the form,
unique among its **live** forms only (a partial index, so a deleted "contact-us" can be made again).
An inactive form answers 404, exactly as a key that never existed does: any other answer makes the
key an oracle. All of it is
[ADR-0029](./decisions/ADR-0029-a-public-form-is-identified-by-its-own-key.md).

**One ingestion path, as `FR-CAP-4` asks.** A submission goes through `LeadsService.create` — the
same method the lead form and the import use — so duplicate detection, scoring, assignment, the SLA
clock, the timeline and the outbox events all happen exactly as they do everywhere else. The lookup
crosses tenants under `withPlatformScope` (there is no session to scope by) and every write then
happens inside `tenantContext.run(systemPrincipal(...))`. What the channel knows and a client must
not claim — `formId`, `formName`, `formAnswers`, `sessionId` — travels as an internal
`CaptureContext` that is deliberately **not** part of `createLeadSchema`: a caller who could set
`formId` could fabricate a form submission and the attribution a marketing report is built on.

**The submission row is written before the capture is attempted**, as `received` — an amendment to
§8, which listed only the four outcomes. A row written once an outcome is known is precisely the row
that is missing when the capture failed. **It paid for itself on the first run:** the first capture
in a cold process took 5.8 s, Prisma aborted the transaction at its five-second default, and a lead
was lost with a 500 — visible only because the payload had already been stored. Both capture
transactions now carry a 20 s ceiling with the reasoning written beside them, and the trap is in
`CLAUDE.md`.

**What a form may ask for is a short, fixed list** (`FORM_STANDARD_FIELDS`), plus the workspace's own
lead fields. No status, stage, pipeline, owner, tags or score: a public form offering them would let
a stranger set the workspace's own decisions, and a spec asserts that none of them is ever on the
list. A consent tick writes the `consent_*` columns. A free-text message has no column in this
phase, so every answer is recorded as a `lead.form_submitted` timeline entry carrying label and
value, in the capture's own transaction — "I need possession by March" is the reason for the call,
and a form that captured the number and dropped the sentence would have thrown it away.

**The defences are a honeypot, two counters and a hash.** A bot is **thanked**, not told: a 400
teaches a spam tool to leave the hidden field alone, so the refusal is recorded and the thank-you is
returned. The rate limit counts per form and per address, like the login throttle, and fails closed.
`ip_hash` is an HMAC under the deployment's master key — enough to count submissions from one place,
not a record of where a member of the public was sitting. CAPTCHA is a settings flag with no
provider behind it, said plainly rather than implied.

**Two screens and a page.** `/forms` lists the forms **and the submissions that became nothing**,
because a form whose required question nobody can answer looks exactly like a quiet week.
`/forms/[id]` puts the link and the iframe snippet first — the next thing anybody wants after
building a form is to put it on their website — then the question builder, which holds the list as
state, saves it in one call, does not offer a question already on the form, and refuses to save a
form that cannot reach anybody with the sentence under the list rather than after a press of Save.
`/f/[key]` is outside the authenticated shell: no navigation, no session, multi-step, honeypot
off-screen rather than `display: none`, answers held in React state so a refusal loses nothing, and
a switched-off form rendering the same sentence a made-up key does.

**Verified.** 1 950 tests green (850 unit, 1 100 integration), 84 of them new: a 27-case forms suite
over real HTTP (what a form may ask for, what the public definition gives away, a capture through
the shared path, the timeline entry carrying the answers, a repeat capture attached to the existing
lead, a refusal recorded as a row, a bot thanked, and four cross-tenant checks), 12 cross-tenant
database guarantees, 22 new objects in the schema-objects guard, 20 shared-vocabulary cases, 18 in
the web app's reconciliation spec, and 3 for the new timeline describer. Then **50 HTTP checks**
against a live API, worker and scheduler, and **30 browser checks** driving both sides — including a
visitor filling in a two-step form at 375 px with no session at all.

**Two defects the browser found.** The submissions list read "Which service: interiors" back to the
person who had written that dropdown — the stored value rather than the choice, the same mistake as
a timeline reading "Changed billingLine1". And the builder's own labels are **input values**, not
page text, so the check that read them as text passed through a card that was rendering perfectly;
both are now asserted the way the screen actually holds them.

**Carried forward, named rather than assumed:** the embed is a copyable `<iframe>` rather than a
hosted loader — a one-line script that renders inside the host page's CSS belongs with the website
builder in Phase 9. `FR-CAP-5`'s one-click "create a custom field from this unmapped answer" waits
for the public lead API, where the same surfacing is needed for a payload nobody mapped at all;
unmapped answers are kept whole and logged today. `inbound_payloads`, `ingestion_errors`, the
`api_keys` family and the webhook tables remain unbuilt and are the next steps' work. And
`form_submissions` grows with traffic the tenant does not control, refusals included: it is indexed
for the two questions anybody asks and will need the retention treatment Phase 10 writes down.

### Step 2 — the public lead API: a credential, a signature, and nothing lost ✅ _(landed 2026-10-14)_

`FR-CAP-3`, `FR-CAP-4`, `FR-CAP-5`, `FR-CAP-6`, `FR-CAP-7`, `FR-API-2`, `FR-API-5`. A capture form
is a page a person fills in; this is the door a **program** comes through — a website's server, a
Zapier step, an agency's integration. It has no session, so everything about it is credentials,
idempotency and the promise that nothing is lost. **Three of Phase 4's six exit criteria are this
step**, and all three are now met and tested.

**Four tenant tables.** `api_keys` (one credential pair), `inbound_payloads` (**the never-lose
store**, partitioned monthly by arrival like `activities`), `ingestion_errors` (why a payload did
not become a lead, naming the stage) and `idempotency_keys` (the first **response** to a key). The
migration arrived with **15 spurious `DROP`s** at the top — every composite FK, partial index and
trigger the earlier migrations added by hand — which were removed, and all 24 new objects are in
`schema-objects.int-spec.ts`. Prisma cannot create a partitioned table, so the `CREATE TABLE` was
edited by hand and `ensure_inbound_payload_partition` creates months ahead beside the activities
one.

**The secret is encrypted, not hashed** — the decision this step turned on, and the first draft had
it wrong. Verifying an HMAC needs the shared secret, so a digest is useless: `sha256(secret)` by
analogy with a password could not have worked. AES-256-GCM under the deployment's master key with
the key's own id as AAD, a CHECK that refuses anything that is not an envelope (and refuses a value
beginning `sk_`, which is what the mistake looks like), and the trade-off stated rather than hidden:
somebody with the database **and** the master key can read it, which is what rotation is for. All of
it is [ADR-0030](./decisions/ADR-0030-the-public-lead-api-verifies-a-signature-and-never-loses-a-payload.md).

**The order of the checks is deliberate**: workspace public key (404), API key (401 — identical for
unknown, revoked, expired and another workspace's), IP allowlist (403), scope (403), workspace
standing (403), rate limit (429), signature (401). The rate limit is counted **before** the
signature, so grinding signatures costs an attacker requests. The signature is over `"<unix>.<raw
body>"` with a five-minute tolerance, verified against the **bytes as sent** — `{"a":1}` and
`{ "a": 1 }` are the same object and different bytes, and a verifier that re-serialised would reject
every client whose JSON writer disagrees with ours.

**The payload row is written before anything is attempted**, in status `received`. A row written once
the outcome is known is precisely the row that is missing when it did not happen, which is what
`FR-CAP-3` asks for and what makes "killing the worker mid-ingestion loses no lead" true: such a
payload is finished by `POST /ingestion/payloads/:id/replay`, tested in the suite and driven from the
screen. Idempotency is a stored **response** in a non-partitioned table — a unique on a partitioned
table must contain the partition key, which makes it a race guard rather than a point read — and a
replay of the same key with a different body is a 409 rather than a lie.

**`FR-CAP-5` is a round trip, not a button.** Unknown fields are kept whole, named in the response,
and counted across stored payloads with a sample of each. The one click on `/ingestion` creates the
field through `POST /custom-fields` — the same endpoint the field builder uses — and the **mapper
matches an integration's top-level key through the same derivation** (`customFieldKeyFor`), so
`propertyType` lands in the `property_type` somebody just made. Without that second half the click
creates a field nothing ever writes to: a feature that looks built. The value is validated against
the definition first, so making it a `number` field while the integration keeps sending words leaves
the key unmapped with a note rather than turning a capture that worked yesterday into a 400.

**The test tool runs the step it previews.** It answers `wouldCreate`, the phone as it would be
**stored** beside the phone as sent, and notes naming what matched nothing — through
`normalizeContactNumbers` and `buildDisplayName`, the two functions the write path itself uses. Its
first version echoed the number as sent, which is the import's dry-run lie in a new place.

**Two screens** (§10.8 of `frontend-architecture.md`): `/settings/api-keys`, where the secret is
shown once and travels in `ActionState.data` because no endpoint will ever answer it again, and
`/ingestion`, which leads with the test tool and the payloads that are not leads and puts the log
last. The printed `curl` carries this workspace's own public key and reads both halves of the
credential from shell variables.

**Three defects worth the note.** A payload row inserted by raw SQL carries **microsecond**
`received_at`, which a JavaScript `Date` cannot write back, so an update keyed on `(id, received_at)`
failed on a row sitting in front of it — and Postgres refuses to alter the type of a partition key
column, so the status updates are keyed on the id alone. `recordFailure`'s own write then threw and
**replaced the 400 that said what was wrong with a 404 about the payload**: a recorder of failures
may not fail the request. And the replay button's success message could never be seen, because a
successful replay removes its row from the screen — the confirmation is rendered from the server tree
instead. All three are in `CLAUDE.md`.

**Verified.** 2 105 tests green — 930 unit and 1 175 integration — with about 120 of them new: a
**33-case** public API suite over real HTTP (every refusal above, the idempotent replay, the
never-lose criterion, the one-click round trip in both directions, the dry run's two verdicts), 24
new objects in the schema-objects guard, 12 cross-tenant database guarantees, 25 shared-vocabulary
cases and 29 in the web app's reconciliation spec. Then **57 HTTP checks** against a live API,
worker and scheduler, and **63 browser checks** driving both screens end to end with real
signatures. The schema guard also caught the hash→encrypt rename it was still asserting the old name
for, which is the one job that suite has.

**Carried forward, named rather than assumed:** `api_logs` (`FR-SA-4`) arrives with the authenticated
REST surface, where there is a request volume worth logging per endpoint — today `inbound_payloads`
is the log for the one endpoint that exists. Scopes stay at `ingest:write` / `ingest:read` rather
than inventing the read scopes of a surface that does not exist. Bulk replay is deliberately absent:
a thousand failures whose cause has not been fixed would be a thousand more. Outbound webhooks,
OpenAPI, the integration framework, Meta Lead Ads and Google Ads lead forms are the rest of this
phase.

---

### Step 3 — outbound webhooks: signed, retried from their own row, and never following a redirect ✅ _(landed 2026-10-18)_

`FR-API-4`. Step 2 built the door a program comes in through; this is the one the product goes out
of. It is the phase's fourth exit criterion in full — signed deliveries, a log per attempt, retries
on a schedule, auto-disable after fifteen consecutive failures, manual retry, and SSRF protection
tested against private addresses **and** against redirects to them — which makes **four of Phase 4's
six exit criteria** met and tested.

**Three tenant tables.** `webhook_endpoints` (one row per place a workspace wants events, with the
signing secret encrypted and the event types it subscribed to), `webhook_deliveries` (one row per
event per endpoint, **partitioned monthly** by `created_at` like `activities` and `inbound_payloads`,
and the thing the retry schedule lives on) and `webhook_attempts` (what happened on each try: the
code, the duration, the error). The migration arrived with **15 spurious `DROP`s** — two three-column
composite FKs and thirteen GIN, trigram and partial indexes the earlier steps added by hand — which
were removed, and all
seventeen hand-written objects — twelve CHECKs, three composite FKs, the retry sweep's partial index
and `ensure_webhook_delivery_partition` — are in `schema-objects.int-spec.ts`, which is the only
thing that catches the ones Prisma's next diff would drop. `docs/database-design.md` §8 says what
each CHECK is for.

**The retry schedule is the row, not BullMQ**, and that is the decision this step turned on
([ADR-0031](./decisions/ADR-0031-an-outbound-webhook-is-retried-from-its-own-row-and-never-follows-a-redirect.md)).
Seven gaps — 10 s, 1 m, 5 m, 30 m, 2 h, 6 h, 24 h, each with ±20 % jitter — reach about 33 hours, and a
delayed BullMQ job that far out lives in Redis: losing Redis would lose a day of deliveries
silently, while a row survives a restart and is visible to the workspace. So the queue is
`attempts: 1`, a failed attempt writes `next_attempt_at` and the job **succeeds**, and
`maintenance.webhook-retry` enqueues what is due every minute — per-minute because the first gap is
ten seconds, and cheap because `webhook_deliveries_due` is a partial index over nothing on almost
every tick. Jitter is per delivery, so an endpoint that was down for an hour is not hit by
everything it missed in the same second.

**SSRF is checked twice, because once is not enough.** The static classification in
`@leados/shared` refuses a non-`https` scheme in production, credentials in the URL, a port that is
not 443, and any literal loopback, link-local, private, CGNAT, multicast or cloud-metadata address —
each with its own sentence, so the screen can say which rule refused it. Then **every attempt
re-resolves the hostname and checks the addresses it actually got**, because a name that resolved
publicly when the endpoint was saved can resolve to `169.254.169.254` an hour later. `redirect:
'manual'` on top of that: a 301 to a private address is not followed, it is recorded as the refusal
it is, and the e2e proves both halves.

**Fan-out found that the event registry had drifted.** `EVENT_SUBSCRIPTIONS` is keyed by event name
and an unkeyed event reaches nobody, so `customer.created`, `lead.converted`, every `deal.*`,
`quotation.*` and `payment.*` event and `onboarding.industry_template_applied` were being written to
the outbox, marked published, and read by nothing — invisible, because an event with no subscribers
looks exactly like one whose subscribers all succeeded. All 25 types the product emits are now
registered, and the spec asserts the correspondence **in both directions**: an emitted event with no
entry fails, and so does an entry for an event nobody emits.

**Delivery is at-least-once and says so on the screen.** The payload carries the event id, so a
receiver deduplicates on it; `X-LeadOS-Timestamp` and `X-LeadOS-Signature` are the same HMAC
construction the inbound API verifies (`"<unix>.<raw body>"` over the bytes as sent); a 2xx stops
the retries, `410 Gone` disables the endpoint immediately, and fifteen consecutive failures disables
it with a `webhook.disabled` notification that **cannot be opted out of** — an integration switched
off silently is one nobody can diagnose. `webhook.test` is a 26th event type that only the [Send
test] button emits, so an endpoint can be proven before anything real depends on it.

**One screen** (§10.9 of `frontend-architecture.md`): `/settings/webhooks`, behind `webhook:manage` —
a permission in the catalogue since Phase 1 with nothing reading it until now. The endpoints, then
what has been sent with each attempt folded inside its row, then the verification code the receiving
server needs, on the page rather than in a document, because the one thing that makes a receiver
unsafe is trusting a body without checking its signature. The secret travels in `ActionState.data`
and is gone after a refresh, like the API key's.

**Three defects worth the note.** The first version of
`webhook_deliveries_pending_is_untried` was written as a biconditional, which made an honest state
unrepresentable: a delivery whose endpoint is switched off between the fan-out and the attempt is
abandoned having never been sent, so the mirror of a true constraint was false and the service would
have had to lie. Writing the outbound module into `modules/webhooks/` **silently deleted
`POST /webhooks/email`**, the inbound email webhook that has lived there since Phase 3 step 7 — no
error, no failing unit test, caught only by the route-authorization sweep, which enumerates every
declared route. And a browser check reading a delivery's signed body found an empty string, because
a closed `<details>` has no `innerText`. All three are in `CLAUDE.md`.

**Verified.** 2 235 tests green — 1 001 unit and 1 234 integration — with
about 140 of them new: a **29-case** webhook suite over real HTTP against an in-process receiver
whose answer is switchable mid-test (signature verified by hand, every refused URL, the retry
schedule, the manual retry, `410 Gone`, the fifteenth failure, a redirect to a private address), 44
shared-vocabulary cases, 24 in the web app's reconciliation spec, seventeen new objects in the
schema-objects guard, 13 cross-tenant database guarantees, and the subscription registry's
both-directions correspondence. Then **39 HTTP checks** against a live API, worker and scheduler with an
in-process receiver that can be switched between answering 200, 500, a redirect to a private address
and `410 Gone`, and **40 browser checks** driving the screen end to end — an endpoint created and
its secret read out of the card, four refused URLs each naming their own rule, a test delivery whose
signature the check verifies by hand, a real lead capture fanning out only to the endpoint that
subscribed to it, a 500 producing a failed row with the next attempt stated, [Send again] delivering
it once the receiver recovers, and `410 Gone` switching the endpoint off with its reason on the
screen.

**Carried forward, named rather than assumed:** there is no circuit breaker, deliberately — with the
schedule on the row a dead endpoint's deliveries are already spread over about 33 hours and fifteen
failures disables it, and a breaker would be a second piece of state that can disagree with
`failure_count`. `webhook.reap-exhausted` (hourly, in §5 of `queue-event-architecture.md`) is not
built and is not missing: the endpoint is disabled by the attempt that earns it, inside that
attempt's transaction. There is no per-endpoint delivery replay of everything it missed while it was
off, for the same reason bulk replay was left out of step 2. Deliveries are retained by the monthly
partitions and pruned with them; a response body is truncated at 2 000 characters, because a server
that answers an HTML error page should not fill a tenant's table with it. `api_logs`, OpenAPI with a
diff check, the integration framework and the two ad-platform connectors are the rest of this phase.

---

### Step 4 — the API a program can call, and the log that says what it did ✅ _(landed 2026-10-18)_

`FR-API-1`, `FR-SA-4`. Steps 2 and 3 built one door in and one door out. This step makes the
**whole product** reachable by a program: the same routes the web app calls, answered to a caller
that sends a key instead of signing in, with a request log an integrator can debug from outside.

**There is no second API, and that is the point.** `AuthGuard` accepts an access token **or**
`Authorization: Bearer <key id>.<secret>`, told apart by the key id's `pk_` prefix — by shape, not
by trying one and falling back to the other, so a mistyped key is refused as a bad key rather than
as an expired session. Everything after the guard works from the `TenantPrincipal`: the permission
guard, the data scope, the tenant-scoped client. A route added next year is reachable by an
integration without a line of key-specific code, and no permission is checked twice in two places.

**A key acts as the member who created it, narrowed to its scopes**
([ADR-0032](./decisions/ADR-0032-a-key-acts-as-the-member-who-created-it.md)). Its creator's
**current** grants are resolved on every request through `PrincipalService` — the path the import
and export processors already take — and the key's permissions are the intersection, each at the
data scope the creator holds. The two alternatives are both escalations performed with a button: an
organization-wide scope would let a branch manager mint a credential that reads the whole workspace,
and freezing the creator's grants into the row would leave a key working with permissions its
creator lost months ago. The cost is stated rather than hidden: narrowing somebody's role narrows
their keys, and deactivating them stops them, with a refusal that says which.

**A key's scopes are permission keys**, from a curated list, and what the list leaves out is the
decision: no key can manage roles, members, billing, other keys, webhooks, the workspace's identity
or privacy requests, and none can export personal details. A key lives in a config file on somebody
else's server. The creation-time check ("you cannot grant a permission you do not hold") is the
early, clear error; the intersection at request time is the enforcement. And **nothing is signed on
this surface** — the capture endpoint signs an HMAC because a capture is a replayable write and the
_body_ is what must be bound; a signature that covers only the timestamp and the body would let a
captured `GET` be replayed as a `DELETE`, so a signed REST surface needs a second construction every
client library then implements by hand, for a property TLS already gives.

**`api_logs`, specified since Phase 0, is built** — and partitioned by **day**, the first table here
that is: retention is thirty days, so a month-sized partition would be the whole table and "drop the
oldest" would mean dropping everything or nothing. One row per request a key made: method, path,
status, error code, duration, bytes, request id, address. Five CHECKs, and the last is
one-directional for the reason step 3 paid for — an answer below 400 carried no error code, while
the mirror ("every refusal has one") is false, because a 404 from a path Fastify never routed has no
envelope. The 15 spurious `DROP`s Prisma generated again
were removed, and everything hand-written here is in the schema guard: the six constraints, the
`PARTITION BY RANGE`, the default partition and `ensure_api_log_partition` — which the guard also
calls twice, because the maintenance job, the harness and a backfill all call it without checking
first.

**It is the integration's log, not an access log**, and four things follow. No bodies and **no query
string** (the filter DSL carries names and numbers, and this screen sits behind `api_key:manage`
rather than `lead:read`); no session traffic (a hundred times the rows for the one caller that can
already see everything); nothing for a key id that resolves to no workspace, because
`organization_id` is NOT NULL and there would be nothing to file it under; and every refusal a
_real_ key earns, because the authenticator marks the request the moment the key resolves — before
the allowlist, the rate limit, the secret and the scopes. It is written from Fastify's `onResponse`
hook, because the 401, 403 and 429 an integrator most needs never reach a Nest interceptor, and
**buffered** (a hundred rows or a second), because a recorder of what happened must not be able to
change what happened.

**One screen and two changes** (§10.10 of `frontend-architecture.md`): `/settings/api-activity`
leads with the refusals, carries three figures that total the filter rather than the page, and says
in a card what is deliberately not on it. `/settings/api-keys` grew a grouped scope picker that
offers only what the person looking at it holds — a tick box certain to be refused is worse than one
that is not there — and now says what each key has been doing.

**A key carries its creator's id, which closed one hole and opened another.** Every
person-reference in this product is written from `principal.actorId` — `created_by_id`,
`changed_by_id`, a saved view's owner — so the person has to be the actor, with `apiKeyId` beside
it for provenance and the audit label. The first draft used the key's own id and wrote three leads
claiming a member who does not exist, which no constraint objected to. The other direction then
needed closing: a key carrying a real person's id would be answered by `/auth/me` with that
person's profile, sessions and **the other workspaces they belong to**. `@SessionOnly()` marks those
routes, and the permission guard refuses a key on them **above** the permission exemption — the
first placement was below it and did nothing, because a route about the caller is exactly the kind
that declares `@NoPermissionRequired`.

**Three defects worth the note, two of them found by this step's own verification.** The log
recorded nothing in the e2e suite while the product recorded everything, because the hook was
installed from `main.ts`: **a hook registered in one bootstrap path is absent from every other
application built from the same modules**, including the harness's, and the feature would have
looked built and been untested. The IP allowlist passed its first assertion for the wrong reason:
the harness does not set `trustProxy`, so `request.ip` is the socket address — the client's address
now comes from the request context, which is where this product reads the proxy chain. And
**registration itself was failing with a 500 on a cold process**: provisioning writes a whole
workspace catalogue in one transaction and took 5.04 s against Prisma's five-second default, so a
sign-up created nothing and said "Something went wrong" — the capture-transaction defect again, in
the one place where the cost is a customer who cannot get in at all. It now has an explicit 30 s
timeout with the reason beside it.

**Verified.** 2 297 tests green — 1 028 unit and 1 269 integration — with about 90 of them new: a
**23-case** suite driving real product routes (`/leads`, `/tasks`, `/deals`) with a credential
instead of a token, 17 shared-vocabulary cases, 10 in the web app's reconciliation spec, 8 new
assertions in the schema-objects guard and 4 cross-tenant database guarantees. Then **43 HTTP checks**
against a live API, worker and scheduler, and **39 browser checks** driving both screens.

**Carried forward, named rather than assumed:** OpenAPI and the published docs (`FR-API-3`) are the
next step, and the `/docs` row of §1 stays unbuilt until then. There is no cursor pagination on
`GET /api-logs` — it is a bounded window with a limit, because a request log is read by filtering
rather than by walking. The log has no per-endpoint rollup, so "which endpoint is slowest" is a
question somebody answers by filtering; a rollup belongs with the platform console's usage views.
`industry-templates.service.ts` writes a similar catalogue in one transaction and has not been seen
to exceed five seconds, so it was left alone and is named here as the next place to look if a
template application ever answers a 500.

---

### Step 5 — the published contract, generated from the validators that run ✅ _(landed 2026-10-19)_

`FR-API-3`. Step 4 made the whole product reachable with a key. This publishes what is reachable:
an OpenAPI 3.1 document, a reference and an errors page a developer can read without signing in,
and a committed copy that **fails the build** when the API changes under it. It is the phase's
sixth exit criterion, and five of six are now met.

**Nothing is annotated.** The document is generated from the routing table — the same enumeration
that fails startup when a route declares no authorization — and the request and query schemas are
read off each route's own `ZodBody` **pipes**
([ADR-0033](./decisions/ADR-0033-the-published-contract-is-generated-from-the-validators-that-run.md)).
Two properties follow, and they are the whole argument: **every one of the 289 routes is in it**,
whether or not anybody remembered, and the schema a client reads **is** the object that refuses its
bad request. The sketch in §11 called for `@nestjs/swagger` decorators; 289 routes × three
decorators is a second description of every endpoint maintained beside the first, and this codebase
has learned twice which of the two is wrong — the one nothing executes. The authorization model
travels as extensions (`x-leados-permission`, `x-leados-feature`, `x-leados-session-only`), so a
reader is told which permission an endpoint needs, which plan feature gates it, and whether a key
may use it at all.

**What the generator cannot know, it does not invent.** A summary is the handler's name said as a
sentence. A body example carries the schema's **required** fields with placeholder values, because
a fabricated example with plausible names in it reads as real data and gets copied into production.
Each endpoint's `curl` reads the credential from shell variables, as every snippet in this product
does.

**`/docs` is rendered on the server — no Scalar, no Redoc, no CDN, no JavaScript.** A docs page
that needs an external request is blank on exactly the deployment whose operator most needs to read
it, and a spinner is a poor first impression of an API. It is one function over the document the API
just built: endpoints grouped by resource, what each needs in words, its parameters and body fields
with types, and the request to copy. `/docs/errors` lists every code with its status, what it means,
what to do and whether to retry — from `ERROR_CATALOGUE`, a `Record<ErrorCode, …>`, so a code
cannot be added to the union without describing it. All three are **public** and sit outside the
version: a spec behind a credential is a spec nobody evaluating the product can read, and it
discloses nothing a caller could not learn by trying every path.

**The committed `docs/openapi.json` is the check, not the source.** The server always builds from
the live routing table; the artifact is what `openapi.e2e-spec.ts` compares against, and when they
differ the failure is a **classified** diff rather than a byte diff: a removed operation, a changed
permission, a newly required field or plan feature, a route closed to keys, a success status no
longer answered — breaking. A new path, a new operation, a new optional parameter — additive. The
classifier is conservative on purpose: a false alarm is a sentence in a commit message, and a missed
one is somebody's integration failing on a release that was green. `pnpm --filter @leados/api
openapi:write` regenerates it.

**Two defects, both found by driving the page in a browser rather than by reading the CSS.** At
375 px the reference took **91 px of sideways scroll**, because a table cannot reflow — each one now
scrolls inside its own box, and long paths wrap. And the page made the browser fetch a
`/favicon.ico` this API does not have: a 404 in the console of the first page a developer reads, and
a 404 in our own request log. Both are now asserted in the page's spec.

**Verified.** 2 335 tests green — 1 055 unit and 1 280 integration — with 38 of them new: an
**11-case** suite that asserts the document against the routing table itself (every route present,
every permission real, a body wherever a route validates one, a query schema rendered as the
strings a client actually sends, a `curl` per endpoint and no secret in any of them), the committed
artifact compared and the three URLs served; **11 cases** over the breaking-change classifier,
where "the diff is small" and "the change is safe" come apart; **11** over the rendered pages; and
**5** over the error catalogue. Then **30 HTTP checks** that read something out of `/openapi.json` and
then call the endpoint it describes — the permission it names, the status it promises, the key it
says may or may not be used, the parameter it does not list being refused, and a real refusal
matching the published error schema — and **22 browser checks** reading the reference from the app's
own link, jumping to a section, copying a request, looking a code up on the errors page, and reading
it at phone width.

**Carried forward, named rather than assumed:** the "try it" sandbox and the generated TypeScript
client in `packages/contracts` (§11) are **not** built. A client generated from a document that
changes every release is a package to version, publish and consume, and the web app does not need
one — it calls the API through its own typed loaders with a spec reconciling its vocabulary against
`@leados/shared`. There is no hand-written prose per endpoint, by design: the document says what an
endpoint needs and accepts, and the module READMEs say why it exists. And the document describes
this application only — the platform admin surface (`/api/admin/v1`) is a Phase 10 application and
is deliberately absent rather than listed as unimplemented.

### Step 6 — the integration framework: a registry entry, an adapter, and a vault ✅ _(landed 2026-10-19)_

Phase 4's scope line, in its own words: **provider registry, credential vault, health checks,
generic mapping templates**. It is the layer the two ad connectors sit on, and it comes before them
deliberately — both need a stored credential, a health check that surfaces a revoked token as a
reconnect prompt rather than as silence, a cursor that resumes, and a mapping from somebody else's
field names onto ours. Building the first connector without that framework is how the second one
becomes a copy of the first.

**A provider is a catalogue entry plus an adapter, and the two are reconciled at boot.**
`INTEGRATION_PROVIDERS` carries the label, the sentence somebody reads before connecting it, the
auth kind, the settings its form asks for and its probe cadence;
`IntegrationRegistryService.onApplicationBootstrap` **throws** if an entry has no adapter, an adapter
has no entry, or a provider declares a cadence its adapter cannot serve
([ADR-0034](./decisions/ADR-0034-a-provider-is-a-registry-entry-and-an-adapter.md)). Same stance as
"every route declares its authorization or the app does not start", and for the same reason: the
alternative is a connect button that answers 500 the first time somebody presses it, or a sweep that
looks scheduled and does nothing. §8 specified `provider` as a nine-value enum; it is `TEXT` checked
against the registry, because a provider arrives with an adapter and an enum would make every
connector a migration. **A new provider needs no migration and no new screen.**

**`probe` is optional, and the provider that cannot be asked says so by not having it.**
`generic_webhook`'s credential is a secret _we_ generated — the sender holds it and signs with it, so
there is no endpoint of theirs to call, and "is this healthy" means "has anything arrived". A probe
returning `ok` without asking anything would be a green tick this product had not earned; one that
threw would be the lie in the contract `mailer.port.ts` warns about. `POST /integrations/:id/check`
refuses for such a provider and names the mapping preview as the thing to use instead.

**Four standings, one transition table, and `unauthorized` has no grace period.** `nextStatus` is
the only thing that moves a connection, because three callers would otherwise each decide and the
screen would disagree with itself. A refused credential is `revoked` immediately — no number of
retries fixes a token somebody deleted — and notifies **on the transition only**, because a deleted
credential probed every ten minutes would otherwise produce six notices an hour, which is the shape
of alert people mute and then stop reading. `unreachable` ("nothing answered", no latency) and
`degraded` ("answered and refused", timed) escalate identically: one is `degraded`, a second in a
row is `error`. The notification type is not opt-out, like `webhook.disabled` and `trial.expired`,
and it declares the new `connection_still_broken` staleness check so a notice held by quiet hours is
dropped if somebody reconnected at 22:00.

**The credential never leaves the vault.** `IntegrationVaultService` is one function that takes the
connection's id, because the AAD is the thing worth protecting from a call site: `integration:<id>`,
the same construction as `api_key:<id>` and `webhook:<id>`.
`integration_connections_credentials_encrypted` refuses a value that is not an envelope **and**
refuses one still beginning `sk_` or `whsec_` — which is exactly what storing the token as the
provider gave it looks like. The presenter's `select` does not include the ciphertext at all, so it
cannot reach a response by somebody extending the presenter later. The one secret answered is the
one we mint, exactly once; a provider's own token is never echoed back, and a caller who supplies a
secret for a `shared_secret` provider is **refused** rather than ignored.

**The inbound door is the public lead API's authentication, minus the key.**
`POST /wh/{provider}/{connectionId}` — the shape `api-architecture.md` §7 has specified since Phase
0 and the webhooks module's note has promised since step 3. Same HMAC construction, same
five-minute window, same refusal sentences, so an integrator who has wired one has wired the other.
The id in the path is not a credential: an unsigned request is a 401 whatever id it carries, and a
wrong id, a disconnected connection and a provider with no inbound door all answer the same 404.
Because the route is `@Public()` the lookup is `withPlatformScope` — the first draft used the scoped
client and made **every** inbound request a 500 before any signature was checked.

**The mapping is applied inside the capture pipeline, not before it.** Two reasons, both
load-bearing: the never-lose store must hold what arrived rather than our interpretation of it, and
the mapped result then goes through the same `publicLeadSchema`, the same mapper, the same duplicate
rules, the same SLA clock and the same timeline as every other capture. The keys no entry named are
**kept** under the mapped values, so `FR-CAP-5`'s one-click custom field is still reachable for a
mapped provider. And the preview runs the step it is previewing — the mapping _and_ the capture's own
normalisation, answering the phone as it would be stored beside the phone as sent.

**A disconnect is soft, and a reconnect is a new row**, because `inbound_payloads` references the
connection that brought each lead in. The partial unique
`integration_connections_live_provider (organization_id, provider) WHERE disconnected_at IS NULL` is
what makes "one live connection per provider, and as many disconnected ones as a workspace has had"
expressible at all — a plain unique would stop a workspace ever reconnecting something they had
switched off, which is the commonest thing anybody does to an integration.

**No permission backfill, for the first time in this phase.** `integration:manage` has been in the
catalogue since Phase 1 with nothing reading it, so every existing workspace already holds it — the
trap `payment:read`, `sla:read`, `call:read`, `call:log`, `form:read` and `form:manage` each paid for
did not apply, and the migration written for it was deleted once that was checked rather than left
as a no-op whose comment claimed otherwise.

**Two defects found by running it rather than by reading it.** The inbound route answered 500 on
every request, including unsigned ones, because its lookup used the tenant-scoped client on a
`@Public()` route — found by the e2e suite's first run, and invisible to a unit test. And the
mapping editor showed only "That field mapping cannot be used", discarding the API's own sentence
about the row that was wrong — found in a browser, fixed by printing each refusal against its row
and echoing the whole mapping back as JSON, because this form submits `mapSource` once per row and
`submittedValues` keeps one value per name.

**Verified.** **2 422 tests green** — 1 087 unit (597 shared, 318 web, 168 api, 4 db) and 1 335
integration (759 api e2e, 576 across the schema-object and tenant-isolation suites) — with 61 of
them new: **17 cases** over the shared vocabulary (the registry's own shape, the mapping engine's
dot paths and six transforms, every transition in the status table including the one that escalates
a provider which answers and refuses, and `custom.<key>` targets), **15 cases** over the web lib
reconciling its hand-written copy against `@leados/shared` field for field and sentence for
sentence, and a **29-case** e2e suite with a real in-process Postmark: a token refused with 401
becoming `revoked` with a notification carrying the connection id, a 500 becoming `degraded` then
`error`, a fresh token clearing it, the ciphertext never equal to the token, the secret answered
once and never again, a signed payload becoming a lead with the connection on its stored payload
and the sender's own field names still in it, a replay answered rather than duplicated, a mapped
value the schema refuses recorded at the `validate` stage, the sweep skipping a connection checked a
moment ago and probing one aged past its cadence, and the inbound door answering 404 for another
workspace's id. The schema-object guard gained 15 constraints and 3 indexes, and the isolation suite
a third layer for the three new tables. Then **50 HTTP checks** against a live API, worker and
scheduler — the whole lifecycle over real sockets, because an injector cannot prove that the bytes a
signature was computed over are the bytes Fastify received — and **38 browser checks** driving the
screen from the navigation to a disconnect.

**Carried forward, named rather than assumed:** `sync_cursors` is built and **unused** — neither
provider here syncs on a cursor, and the table ships now because its composite FK and unique belong
with this migration rather than a later one. There is **no OAuth**: nothing performs an
authorization-code exchange, so `INTEGRATION_AUTH_KINDS` has two values and an `oauth` kind no
adapter implements would be a promise the connect screen made on our behalf. `provider_events`
stays specified and unbuilt — it is the ledger for a provider that sends its own event ids, which
neither of these does and both ad connectors will. A connection's `scopes` column is written empty,
because inventing values for a provider that does not report them is a column nobody could trust.
And the health history is pruned by nothing yet: it grows with one row per connection per ten
minutes, which is the retention sweep's job in Phase 9.

---

### Step 7 — Meta Lead Ads and Google Ads lead forms, and the ledger that makes a retry harmless ✅ _(landed 2026-10-19)_

Phase 4's **fifth exit criterion**, in its own words: "Meta Lead Ads: duplicate webhook delivery ⇒
one lead; token revocation surfaces as a reconnect prompt." Both halves are now tested, and with
them the phase's scope line is complete.

Step 6's framework held: **both connectors are a registry entry and an adapter**, no domain module
changed, and §8 of `integration-architecture.md` ends with exactly that test. What the two of them
added was to the framework rather than to themselves — four optional port methods and one table —
and both are now there for the third connector, which is the point of having built them in this
order.

**`provider_events` is the guarantee, and it is a constraint rather than a code path.**
`UNIQUE (organization_id, provider, external_event_id)`, keyed on **the provider's own id** for the
event, on a table that is deliberately **not** partitioned
([ADR-0035](./decisions/ADR-0035-a-provider-event-is-deduplicated-on-the-providers-own-id.md)). That
last part is the whole difference between it and `inbound_payloads`: a unique on a partitioned table
has to contain the partition key, which makes it a race guard — the same event id next month would
be allowed — and the question here is "have we **ever** seen this id". The service treats the
violation as the normal case, counts it, and answers 200. Meta's retry carries a different `time`,
so a hash of the body would have made it a new event; `leadgen_id` is what Meta promises to repeat.

**A provider with no event id of its own does not touch the ledger.** The generic webhook has
nothing to deduplicate on, and a key *we* invented would make every distinct lead look like a
replay — so that door keeps `Idempotency-Key` and `idempotency_keys`, stays synchronous, and answers
the lead id. One table per guarantee, rather than one table pretending to offer both.

**The provider is acknowledged before the work, not after it.** Insert, enqueue, 200 — which is §7
of `api-architecture.md`'s "enqueue → 200 in under a second", and which matters because a provider
that waits for us is a provider that **retries**: a two-second capture would become a second
delivery and the ledger would be absorbing a problem we had created.
`maintenance.integration-retry` re-queues what the row still owes, three attempts at most, because a
lead Meta will not hand over is a credential problem and re-asking forever earns a rate limit.

**The port grew by four optional methods, and the registry reconciles each against the provider's
own declaration at boot.** `verifyInbound` is three shapes because three real providers verify
differently — an HMAC over the raw body in a header (ours and Meta's `X-Hub-Signature-256`), or a key
**inside** the body (Google Ads, which signs nothing at all). `challenge` exists because Meta will
not deliver anything until the callback URL echoes a `hub.challenge`, answered as **plain text**
outside the envelope: `{"success":true,"data":"1158201444"}` would never confirm the subscription.
`parseDelivery` exists because one request is zero or more events. `fetchLead` is the first method in
this product that reads **from** a provider: Meta sends an id and the answers are a second request,
with a *different* credential from the one that signed the delivery. A provider that claims a shape
its adapter cannot honour now fails startup, which is the same stance as "every route declares its
authorization".

**A connection holds a set of secrets, in one envelope.** Meta needs two doing two jobs, and the
alternative was worse in both directions: a second column makes "the app secret was rotated and the
page token was not" a state the schema allows and nothing checks, and putting an app secret in
`settings` puts a secret somewhere that is rendered on the screen, echoed back on a refusal and
written into the audit log. So `credentialFields` is a list on the provider, `credentials` is a
record on the API, and a `PATCH` takes all of them or none. That is a **breaking change to an
endpoint shipped one step earlier** — the OpenAPI classifier flagged it, which is the check working
— and it needs no migration, because the column already held an opaque envelope and the vault reads
a plaintext that does not begin `{` as the old single-secret format.

**Both connectors work the moment they are connected.** Each registry entry carries a
`defaultMapping` of the provider's own standard questions, and the adapter flattens the provider's
array into exactly those keys first: Meta sends `[{ name: 'full_name', values: [...] }]` and Google
sends `[{ column_id: 'FULL_NAME', string_value: ... }]`, neither addressable by a dot path, and
mapping them by index would be an index that moves the day somebody reorders the form's questions. A
question answered twice keeps **both** answers, comma-joined, because taking the first discards
something a person said; a Google column is keyed by `column_id` rather than `column_name`, because
the name is the question's wording and changes when the form is edited.

**A `is_test` delivery is recorded and acknowledged but never captured.** A provider that gets a 4xx
from its own test disables the endpoint, and a test lead in somebody's pipeline is worse than no
test at all. Meta's unsubscribed `page` changes are dropped and acknowledged for the same reason.

**Two defects found by running it.** The first draft's "does this provider have an inbound door"
read `authKind === 'shared_secret'`, which was right for the two providers that existed and would
have answered **404 on Meta's own callback URL** — Meta holds a token we send *and* posts to us, so
the question is `inboundVerification`, not the auth kind. And the health service's import of
`sharedSecretField` from the main service closed an ESM cycle that fails as a `ReferenceError` at
boot rather than a type error; the constants moved to `adapters/secret-names.ts`, which is where the
underlying bug was hiding anyway — the service mints a generated secret and the adapter verifies
with it, so two literals in two files is the shape where rotating works and verifying does not.

**Verified.** **2 463 tests green** — 1 095 unit (603 shared, 320 web, 168 api, 4 db) and 1 368
integration (779 api e2e, 589 across the schema-object and tenant-isolation suites) — with 41 new:
**6 cases** over the two providers' own payload shapes in `@leados/shared` (every source in each
default mapping being a key the flattener actually produces, every answer to a doubly-answered
question kept, a Google column keyed by id and a custom one by name), **2** over the web lib's
reconciliation of the credential fields and the per-provider instructions, a **20-case** e2e suite
with a real in-process Graph API, and **13** schema-object and tenant-isolation cases over the
new table — the unique refusing a second delivery per workspace and per provider, an event pointed
at another workspace's connection refused by its composite FK, and both CHECK directions including
the honest state each mirror would have forbidden. Then **49 HTTP checks** against a live API,
**worker** and scheduler — the whole lifecycle through a real queue hop, with nothing driving a
processor by hand — and **34 browser checks** connecting both providers from the screen and watching
one delivery become one lead.

**Carried forward, named rather than assumed:** there is still **no OAuth**. Both connectors take a
long-lived credential somebody pastes, which is what a Meta Page token and a Google webhook key
actually are; an app that connects a Page in two clicks needs an authorization-code exchange and a
refresh sweep, and `INTEGRATION_AUTH_KINDS` therefore still has two values. The **ads insight
syncs** — campaign and metric pulls, which are what `sync_cursors` exists for — are Phase 9 and
remain unbuilt, so that table still has no user. Google Ads deliveries are **replayable by anybody
who has ever seen one**: there is no signature over the bytes and no timestamp to bound, so the
ledger's unique is the only thing between a captured payload and a duplicate lead — Google's design,
not ours, and the reason this connector could not have been built before step 6. And
`provider_events` is pruned by nothing until Phase 9's retention sweep.

---

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

### Step 1 — a connected number, and the messages it receives ✅ _(landed 2026-10-19)_

Phase 5's **headline exit criterion**, in its own words: "Meta's duplicate/retried webhook
deliveries produce exactly one message, one activity, one automation trigger (`FR-WA-6`)." The first
two are now tested end to end; the third has nothing to trigger until Phase 6, and is named here
rather than claimed.

**The framework held again.** WhatsApp Cloud is a registry entry and an adapter — `verifyInbound`,
`challenge`, `parseDelivery`, `probe`, `listNumbers` — on the door step 6 built and the ledger step 7
built. No existing module changed except to route by capability: `IntegrationInboundService.jobFor`
reads `capabilities.includes('messaging')` and queues `whatsapp.ingest-message` instead of
`integration.ingest-event`, so the third messaging provider needs no change to the code that routes
it.

**What the provider broke, twice, was a capability derived from a near-synonym.** WhatsApp holds a
token we send **and** posts to us, so `authKind === 'shared_secret'` was the wrong test for "has an
inbound door" — found in step 7 and fixed there. It also sends the message in full **and** names its
own events, so `deliveryIsAReference` was the wrong test for which pipeline a delivery goes down:
a status receipt about a message we sent fell through to the single-lead path and answered **400**,
which is precisely how Meta learns to disable an endpoint and stop delivering the messages a
business is paying for. `deliveryShape` (`events | single_lead | none`) is now declared per provider
and reconciled against the adapter at boot, beside `inboundVerification`.

**Four tables, and one of them is partitioned.** `whatsapp_accounts`, `whatsapp_numbers`,
`conversations` and `messages` — the last partitioned monthly by `created_at`, which makes its
primary key `(id, created_at)`, its paging cursor both halves of that key, and its
`provider_message_id` unique a **partial** index containing the partition key. That makes the unique
a race guard rather than the idempotency gate, exactly as `inbound_payloads` is: the replay
guarantee stays in `provider_events`, which is not partitioned. Nine CHECK constraints, each written
so no sub-expression can be NULL while the row is accepted, and `messages_inbound_has_no_sender` is
the one that makes a colleague's name on a customer's words unrepresentable.

**`phone_number_id` is unique _globally_**, with no `organization_id` — one of a handful of such
columns in this schema, because an inbound delivery names a number and nothing else, so it is the
only thing that can resolve which workspace a message belongs to. Two consequences, both real: the
lookup is explicitly `withPlatformScope`, and a second workspace connecting the same number is a
**422 with a sentence** — which it was not at first, because the collision check read through the
tenant-scoped client, could not see the row that would collide, and let the insert come back as a
raw unique violation.

**A message becomes a lead through the capture path**
([ADR-0036](./decisions/ADR-0036-an-inbound-message-becomes-a-lead-through-the-capture-path.md)):
`LeadsService.create` with `createdVia: 'whatsapp'`, so the workspace's own duplicate rules, the
assignment engine, the SLA clock and the outbox events apply to a WhatsApp enquiry exactly as they
do to a form submission. A refusal is **not** fatal to the message — the conversation is stored with
no lead and a warning logged, because losing a customer's words because our own rules refused to
make a record is the worse outcome by a long way. A conversation is keyed on
`(channel_account_id, contact_e164)`: one person messaging two of a business's numbers is two
conversations, and a lead with two numbers is still one lead.

**Two instants, and the difference is a bug that was in the code.** `created_at` is ours — when the
delivery arrived — because it is the partition key and the inbox's sort order; `sent_at` is Meta's.
Meta's timestamp is in **whole seconds**, so writing it into `created_at` made two messages in one
second tie and "the latest message" became whichever row the planner returned, which a test caught
by sending two messages inside one second. The 24-hour window is measured from `sent_at`, because
Meta's clock is the one that closes it and a window computed from a later instant would let an agent
write a free-form reply Meta then refuses.

**Two screens** (`frontend-architecture.md` §10.13): `/inbox` — list, thread, lead context, window
sentence, search, mark-read, all URL state — and `/settings/whatsapp` — the WABA, its numbers with
their quality rating and send tier, and who answers each by default. The credential stays on
`/settings/integrations`, which already stores, rotates, probes and prints the callback URL for it.
The open conversation is **fetched by id**, never found in the loaded list, because `/inbox?c=<id>`
is the link a notification sends and the filter it lands on may exclude that row.

**Verified.** **2 540 tests green** — 1 119 unit (617 shared, 330 web, 168 api, 4 db) and 1 421 integration
(801 api e2e, 620 across the schema-object and tenant-isolation suites) — with **77 new**:

- **14 in `@leados/shared`**, over the delivery parser against Meta's real envelope shapes, the
  window arithmetic, `wa_id` → E.164, and the sentence that stands in for a body a media message
  does not have. One of them found a real bug while being written: a reaction lost its
  `replyToProviderId`, because the context reader returned early instead of falling through.
- **10 on the web side** — 8 reconciling the hand-written vocabulary against the API's and covering
  the three-way filters, the row's title and an outbound message's standing, plus 2 on the
  `whatsapp.received` describer, which is what keeps the entry from rendering as a bare row.
- **22 api e2e**, against a real in-process Graph API, including the exit criterion itself: three
  deliveries of one message — two byte-identical, one reshaped — producing one message and one
  activity. The suite also found the bug that mattered most, the inbox previewing the **previous**
  message, which is what sent the two instants back to the schema.
- **31 schema-object and tenant-isolation cases** over the four new tables: the partition key on
  `messages`, the partial unique that is a race guard rather than a point read, the four
  hand-written indexes, the nine CHECKs, and six composite FKs refusing a conversation pointed at
  another workspace's number, lead or member.

Then **37 HTTP checks** against a live API, **worker** and scheduler with a fake Graph API on
another port — the whole path through a real queue hop, with nothing driving a processor by hand,
including the retry that produces nothing and the status receipt that is acknowledged and dropped —
and **28 browser checks** in Chromium across both screens and a phone-width viewport.

The route-authorization sweep grew the four new parameterised routes, with a conversation and a
number of org A's own built by its fixture; and `test/setup.ts` now points `META_GRAPH_URL` at a
closed loopback port, because connecting a provider probes it and that fixture was calling Meta's
real API from the test run.

**Carried forward, named rather than assumed:** nothing **sends** yet — no
`POST /conversations/{id}/messages`, no templates, no media download, no opt-out keyword, no usage
metering — and `conversations.lock_user_id`, `lock_expires_at`, `priority`, `snoozed_until`,
`first_response_at` and `customer_id` are columns with no writer, which is said plainly because a
column with no writer is otherwise indistinguishable from a feature somebody forgot. There is still
**no OAuth**: a WABA is connected with a pasted app secret and access token, so Meta's Embedded
Signup — a third `INTEGRATION_AUTH_KIND` and a `refresh` on the port — remains unbuilt. The inbox
has **no realtime**: it is server-rendered and re-read after a mutation, and the conversation list
does not update until somebody reloads it. And the p95 exit criterion is unmeasured: there is no
100 k-message fixture yet, so the inbox's performance is untested at scale and the index set behind
it is a prediction rather than a measurement.

### Step 2 — sending: the window, the template, and a failure nobody can miss ✅ _(landed 2026-10-19)_

Phase 5's **second and fourth exit criteria**, in their own words: "Out-of-window free-form send is
blocked with a clear reason; template send succeeds" and "A failed send shows the provider reason to
the agent and appears on the timeline; nothing fails silently."

**The window is one function, called twice.** `sendingAllowed({ windowExpiresAt, kind })` decides
the write path's refusal **and** whether the composer renders a text box at all. That is the whole
design: a screen that computes its own answer is how "the button was enabled and the send was
refused" happens, and the refusal names the way through ("only an approved template can reach them
now") rather than only saying no.

**The row is written before the send, and the send is a job**
([ADR-0037](./decisions/ADR-0037-a-send-is-a-queued-write-whose-status-only-moves-forward.md)). A
message somebody typed is never lost to a provider timeout; it exists as `queued` the moment they
press send, appears in the thread immediately, and advances under itself. `accepted` is **not**
`sent`: Meta taking the message means it is queued at Meta, and writing `sent` on acceptance would
make every message look delivered to an agent whose customer has a flat battery.

**The status is a summary that only moves forward; the timestamps are facts.** Meta's receipts
arrive out of order — `read` before `delivered` is routine — so `messages.status` moves only when
the new status is further along, and it moves through a **conditional `UPDATE … WHERE status IN
(…)`** rather than a read, a decision and a write: the receipt jobs run at the queue's concurrency
and three receipts for one message arrive together, which the read-then-write version lost about one
time in three. Every receipt still writes its own timestamp column and its own
`message_status_events` row, because "it says delivered and she never got it" is answerable only if
the instants are kept.

**A failure is said three times.** Meta's own sentence on the message in the thread with a "try
again" beside it, an entry on the lead's timeline, and a notification to whoever sent it — the only
work notification in this product that quiet hours do **not** hold, because the cost of holding it
is paid by a customer waiting for an answer. A retryable failure (a 429, a 5xx) is not a failure at
all: the message stays `queued` with the attempt counted, and a two-minute sweep re-queues anything
a worker never handed over.

**Templates are authored here, reviewed by Meta and reconciled by a sweep.** A draft is editable;
anything Meta has seen is not, because Meta has no edit and a local copy that disagrees with what is
sent is the quiet divergence this codebase keeps paying for. The variable map is validated when it
is **saved** — a map naming a field nothing can fill is a template that looks complete and refuses
mid-conversation — and the preview resolves against a real lead, because a preview reading `{{1}}`
proves nothing. A template Meta holds that this workspace has never seen is **adopted** rather than
hidden: a template they can send is one the picker should offer.

**Marketing is the one category consent governs.** A `utility` message is something the customer
asked for, and refusing a delivery notification because nobody ticked a marketing box would be the
wrong rule in the other direction.

**Two screens** (`frontend-architecture.md` §10.14): the inbox's composer — text box inside the
window, template picker outside it, each option previewed against this lead, a variable the record
cannot fill becoming a box the agent types into — and `/settings/whatsapp/templates`, where the
variable rows appear as the body is typed and each row carries WhatsApp's standing and its reason.

**Verified.** **2 609 tests green** — 1 141 unit (631 shared, 338 web, 168 api, 4 db) and 1 468 integration
(826 api e2e, 642 across the schema-object and tenant-isolation suites) — with **69 new**:

- **14 in `@leados/shared`**, over the window rule, the template validator (a name, a language and
  a variable gap Meta would refuse hours later), the renderer that refuses a blank rather than
  sending "Hi  ,", the status ordering, and the `statusesBeatenBy` list that makes the ordering an
  atomic `UPDATE`.
- **8 on the web side**, reconciling the template vocabulary with the API's and covering the four
  describers — including the one that reads WhatsApp's own reason for a refusal in red.
- **25 api e2e** in a new suite against a real in-process Graph API: the window refusing free text
  and accepting a template, three receipts arriving out of order, a redelivered receipt that is one
  row, a template submitted and then approved by the sync, a preview resolved against the lead, a
  marketing template refused for want of consent, a failed send carrying Meta's sentence to the
  message, the timeline and a notification, a retry that goes through on the same row, a 429 that
  leaves the message queued, the per-number limiter refusing and recovering, and the sweep that
  re-queues a message a worker never sent.
- **22 schema-object and tenant-isolation cases** over the two new tables and the two new columns:
  the name and language shapes (including the 300-character name the `{3,512}` regex could not
  express), the three `CASE` constraints with the honest state each mirror would have forbidden,
  one receipt per message **and** status, and four composite FKs refusing another workspace's
  template, account or message.

Then **32 HTTP checks** against a live API, **worker** and scheduler with a fake Graph API on
another port — the whole path through a real queue hop — and **23 browser checks** in Chromium
across the composer, the templates screen and a phone-width viewport.

Two of those failures were only visible over real HTTP: the status race (the e2e drives the jobs one
after another, and a worker does not) and `sendAttempts` missing from the list the screen renders
while being present in the send's own answer.

**Carried forward, named rather than assumed:** **media** is still unbuilt in both directions, and
with it `message_media` and the download job — an inbound image keeps its payload and a caption and
nothing else. The **opt-out keyword** (`FR-WA-10`) and bulk sending are the next step's, so consent
is checked at send time but a `STOP` from a customer does nothing yet. **Usage metering**
(`FR-BIL-4`) has no meter: `messages.billable` and `conversation_category` are written from Meta's
receipts and nothing reads them. Rate limiting is a **floor we keep, not a limit we discover** —
Meta's real ceiling depends on the number's messaging tier and is not readable from the API — and
`WHATSAPP_SENDS_PER_SECOND` therefore defaults to ten, far under every tier. The inbox still has
**no realtime**: a reply appears because the server action re-renders the page, and a colleague's
reply appears when somebody reloads. And the p95-with-100 k-messages criterion is still unmeasured.

### Step 3 — media, in both directions ✅ _(landed 2026-10-20)_

`FR-WA-3`: a customer sends a photo of the room they want quoted, and an agent sends the quotation
back. Meta's delivery contains neither — it contains a media **id**, which has to be exchanged for a
URL and then for bytes, with the access token on both requests; an outbound file has to be handed to
Meta before it can be attached to a message.

**The message lands first; the file is a job**
([ADR-0038](./decisions/ADR-0038-an-attachment-is-served-by-this-product-not-by-a-signed-url.md)).
The ingestion writes the message and a `message_media` row in its own transaction, status `pending`,
and queues `whatsapp.download-media` keyed on the message's id. A delivery Meta waits on is a
delivery Meta **retries**, so a four-second CDN fetch inside the request would have turned one photo
into two and undone the ledger. The row existing from the first write is what makes "they sent a
photo and we have not got it yet" a state the screen can show rather than a gap.

**The kind is refused without asking Meta; the size is refused before reading.** `mediaProblem` is
the one decider, called three times with progressively more information: at ingestion with the kind
and the mime type (an `image` whose mime type is `application/x-msdownload` never costs a request),
in the job with Meta's own `file_size` — the one moment a refusal is free — and in the adapter
**while reading**, because a `file_size` is a claim and a provider that under-reports would otherwise
decide how much memory this process uses.

**A refusal is a state with a sentence, not an exception.** `refused` is ours and final, `failed` is
Meta's or the network's and is swept four times, and either way the row carries the words somebody
reads — "That is 40 MB, and the limit for an image is 5 MB." Four statuses rather than three because
"we will not fetch this" and "we could not" are different answers to "where is the photo", and a
screen that conflated them would offer a retry on a file that will never arrive.

**An outbound file is ours before Meta has it.** `POST /conversations/{id}/attachments` stores the
bytes and writes the media row in the same breath as the `queued` message; the **send job** hands
Meta the file and keeps the id it answers with. A provider refusal then costs an attempt rather than
the file, and a retry re-uses `provider_media_id` — proven by a test that makes Meta refuse the send
after taking the file and then asserts one upload across two attempts.

**The bytes are served by this product, and the "signed-URL delivery" in the exit criterion is
deliberately not built.** A signed URL needs a driver that can sign one; `StoragePort` is a
`put`/`get`/`delete` over a key and the local driver is a directory. `GET …/messages/{id}/media` is
behind `conversation:read` through `DataScopeService`, `inline` for an image, video or audio and
`attachment` for anything else, with `nosniff` and `no-store` on both — a file a stranger sent us
must never be interpreted as HTML on our own origin. When the S3 driver lands,
`WhatsAppMediaService.read` is the one place that changes.

**The upload parser is a provider of the WhatsApp module, and it refuses every other path.** A
Fastify content-type parser is global and the body is parsed before any guard runs, so the 16 MB
limit this one route needs would otherwise be an unauthenticated sink on `/auth/login` — the
`text/csv` lesson, in a second place. `MediaUploadInstaller` adds an `onRequest` hook answering 415
for those content types anywhere but the attachment path, and it is registered on
`onApplicationBootstrap` rather than from `main.ts`, because a hook installed in the HTTP bootstrap
is **absent from every application the tests build**.

**One screen** (`frontend-architecture.md` §10.15): the thread shows a photo where it is, anything
else as a named link that saves, and a file that is not here as a **sentence** — the API's own,
through `media.available` rather than this screen reading a status word, because an `<img>` whose
bytes 422 is a broken image with no explanation. The composer gained a second form beside the reply
box, because a file and a typed reply are two messages on WhatsApp.

**Verified.** **2 643 tests green** — 1 154 unit (638 shared, 344 web, 168 api, 4 db) and 1 489
integration (836 api e2e, 653 across the schema-object and tenant-isolation suites) — with **34
new**:

- **7 in `@leados/shared`**, over `mediaProblem`'s three refusals and the sentence each produces
  (including the article: "the limit for a image" is the same class of mistake as "1 missed
  promises"), the per-kind limits, and `readMedia` keyed by the message's own type.
- **6 on the web side**, over the three shapes an attachment renders as, the API's reason winning
  over any local fallback, the relay route's path, and a size described the way `describeBytes`
  does.
- **10 api e2e** in a new suite against a real in-process Graph API serving all three halves of the
  round trip: the message readable before the fetch and the route saying so, the exact bytes coming
  back out, a document as a download under the sender's own name, a 40 MB claim refused without
  reading a byte, a kind refused without asking Meta at all, the same job twice storing one file,
  the sweep re-queuing what a worker never got, an outbound file stored before Meta has it and
  uploaded once across two attempts, an empty body and an unnamed file refused, and a file posted
  to `/auth/login` answering 415.
- **11 schema-object and tenant-isolation cases**: one attachment per message, the parent's own
  instant required by the composite FK, another workspace's message refused, the two `CASE`
  constraints with the honest state each mirror would have forbidden, the scan vocabulary, and the
  partial index.

Then **30 HTTP checks** against a live API, **worker** and **scheduler** with a fake Graph API on
another port — the whole path through a real queue hop, including the PNG magic bytes and the `%PDF-`
header coming back out of our own route — and **15 browser checks** in Chromium, asserting
`naturalWidth > 0` rather than that an `<img>` exists.

Three things were only visible outside the unit tests: the OpenAPI writer dying because a
**standalone** Nest context has `httpAdapter === null` rather than `undefined`; a browser check whose
`waitForFunction` on `body.innerText` matched the composer's own echo of the filename and resolved
before the thread had re-rendered; and **4 px** of sideways scroll at 375 px from a file input's
intrinsic width.

**Carried forward, named rather than assumed:** **no signed URL** (above), and a file is held in
memory — sixteen megabytes is a real ceiling, and streaming into storage is a port change.
`message_media.scan_status` has **no scanner**. The **opt-out keyword** (`FR-WA-10`), bulk sending,
**usage metering** (`FR-BIL-4`), the **ownership lock**, transfer, close/reopen, notes, mentions,
canned replies and **realtime** are all still unbuilt, and the p95-with-100 k-messages criterion is
still unmeasured.

### Step 4 — the shared inbox, and the word that stops a send ✅ _(landed 2026-10-20)_

`FR-WA-7`'s first words are "many agents on one business number", and two of this phase's exit
criteria follow from them: "two agents opening the same conversation see the ownership lock;
transfer is audited", and "opt-out keyword suppresses marketing sends immediately, verified end to
end". Both are now met.

**The bug this step found before it built anything.** A conversation carries no branch and no team
column, so every data scope narrower than the whole workspace resolved to `assigned_user_id = me`.
A seeded **sales executive** holds `conversation:read` and `conversation:reply` at **own** scope,
and a workspace with no assignment rule leaves every incoming conversation unassigned — so a new
customer's first message was visible to nobody but an owner or an admin. A *shared* inbox was
unreadable by the people it is for, and the conversations at the greatest risk of never being
answered were the ones it hid. That is the `/my/today` lesson one module later, and the file's own
comment had claimed the right behaviour while the code did the other thing. `conversationScopeWhere`
is now the one decider for all four services that touch a conversation, and it adds
`OR assigned_user_id IS NULL`: a conversation nobody owns is precisely the one somebody has to be
able to pick up
([ADR-0039](./decisions/ADR-0039-a-conversation-lock-is-advisory-and-an-unclaimed-conversation-is-everybodys.md)).
It was found by an e2e test driving a **second real member**, which is the only way a lock or a
scope can be seen at all.

**The lock is advisory, and separate from ownership.** `assigned_user_id` survives a closed tab,
drives "my conversations" and is audited when it changes; `lock_user_id` with `lock_expires_at` is
five minutes of "I am typing", taken by opening a conversation. One column for both would either
lose ownership when somebody closed a tab or leave a conversation permanently claimed. A reply from
somebody who is not the holder **goes through**: the requirement asks that two agents *see* each
other, which is a sentence on a screen, and refusing the second one means a customer waits while a
colleague is at lunch. Taking over is allowed and written to the audit log — the accountability a
refusal would have bought at the customer's expense.

**The sentence is one function, called from both sides.** `conversationLock` answers
`{ held, mine, expiresAt, message }` from the viewer's own side, and the API returns that rather
than two raw columns. The screen prints it; nothing on the screen compares `lockExpiresAt` to a
clock.

**A lapsed lock is swept although every read already ignores it**, because the **column** would
otherwise lie — a row saying "Nikhil holds this" three days after Nikhil went on holiday is
something a person will read and believe. And a **snooze is delivered rather than expiring**: a
`snoozed_until <= now()` predicate would make a conversation visible before anything had told the
person who asked to come back to it, which is the decision the notification release sweep already
made and why both run every minute. Both writes are conditional on the state the sweep read, so a
conversation somebody closed a second earlier is not dragged back.

**`STOP` is applied in the request that carried it.** `FR-WA-10` says a revocation suppresses
marketing sends *immediately*, and a queue hop is a window in which a campaign reads the old value.
The keyword list is short and matched against the **whole** message — and `no`, `cancel`, `end` and
`quit` are deliberately **off** it, though each appears on somebody's published opt-out list: each
is a word a customer uses mid-conversation, and a false positive silences somebody **invisibly**,
with nothing on any screen to say why. The timeline entry carries the word they actually sent, so
"why did we stop messaging her?" has an answer.

**A note is its own table and a mention is an id.** A note is never sent, so putting one in
`messages` would make every "did we reply?" query and every export carry a predicate it could
forget. Parsing `@Asha` out of the body tells the wrong Asha the moment a workspace has two, in the
quiet direction — so the composer offers a picker, submits ids, and the service checks each against
`Membership`, because an array column cannot carry a foreign key.

**One screen** (`frontend-architecture.md` §10.16): two cards under the thread, five separate forms
because they are five different acts, and "Nobody — back in the pool" as the first option in the
owner picker. Four new timeline describers plus `mention.created` — in the vocabulary since Phase 1
with nothing writing it — and both consent types, which the deferred list had down for Phase 13.

**Verified.** **2 711 tests green** — 1 178 unit (655 shared, 346 web, 173 api, 4 db) and 1 533
integration (866 api e2e, 667 across the schema-object and tenant-isolation suites) — with **63
new**:

- **17 in `@leados/shared`**, over the lock's two readings (including "1 minute ago" rather than
  "1 minutes ago", and "just now" rather than "0 minutes ago"), the snooze bounds, the note's own
  rules, and the keyword matcher — with a test per ambiguous word that is deliberately **not** a
  keyword, because that list is the whole safety of the rule.
- **2 on the web side**, over the state sentence a closed or snoozed conversation reads as, and
  that every snooze choice is in the future when it is rendered.
- **30 api e2e** in a new suite driving **two real members**: each seeing the other's lock from
  their own side, the colleague replying anyway, an override audited rather than refused, releasing
  only your own, a lapsed lock honest on read and swept from the column, an assignment notified and
  on the timeline, the pool as a real answer, a transfer audited with its note, a snooze delivered
  by the sweep and not dragging back a conversation somebody closed, a mention told and on the
  timeline, a note that names nobody writing no mention entry, `STOP` revoking consent in the
  request that carried it, the marketing template then refused with its own sentence, a free reply
  still working, `START` giving it back, a second `STOP` writing nothing, and a sentence containing
  the word leaving consent alone.
- **14 schema-object and tenant-isolation cases**: the lock's biconditional in both directions, the
  snooze CHECK with the honest state its mirror would have forbidden, a lock held by another
  workspace's member refused, a note on another's conversation or from another's member refused, the
  blank-and-too-long body, the `cardinality` ceiling, and the nine new hand-written objects.

Then **24 HTTP checks** against a live API, **worker** and **scheduler** — including a snooze
delivered by the real one-minute cron rather than by calling the processor, which is the only way to
know the schedule is registered at all — and **16 browser checks** in Chromium driving **two
separate browser contexts**, because one profile with two sign-ins is one session and the lock would
be invisible. The exit criterion is asserted there as a sentence on a real screen: "Live Owner
opened this just now — check with them before replying", beside a **Take over** button rather than
a disabled one.

One finding came out of that: the two-agent check first timed out waiting for the banner, because
the conversation had been assigned to the owner and a `sales_executive` holds `conversation:read` at
`own` scope — a 404, which is the scope working. The case the lock exists for is the **unassigned**
conversation both agents can see.

**Carried forward, named rather than assumed:** **tags, canned replies, typing state and realtime**
are unbuilt, and `conversation_participants` and `canned_replies` are the two sketched tables still
waiting. `conversations.priority` and `message_media.scan_status` have **no writer**. **Usage
metering** (`FR-BIL-4`) still has no meter, and **bulk sending** is Phase 6's. The
p95-with-100 k-messages criterion remains **unmeasured** — there is no message fixture at that
size, which is the one outstanding Phase 5 criterion nothing but measurement can close.

### Step 5 — the measurement, and the inbox's last conveniences ✅ _(landed 2026-10-20)_

The step that closes the phase: a message fixture at the size the exit criterion names, the
measurement against it, and the three things `FR-WA-7` and `FR-BIL-4` had left.

**The criterion, measured.** `inbox-100k.sql` builds **4 000 conversations and 100 000 messages**
on one business number, spread across three monthly partitions, a quarter unread, a quarter
unassigned, an eighth closed, a third tagged, with bodies drawn from a vocabulary of nine so the
GIN index has nine posting lists rather than one. Against it, with the API and the worker running:
the list with its two aggregates **p95 56 ms**, the filters 46–58 ms, a message page 20 ms, the
conversation with its lead context 11 ms, and the body search slowest at **p95 100 ms** — against a
**500 ms** budget. **Phase 5's eighth exit criterion is met**, and the numbers are in
`packages/db/perf/README.md` beside the commands that reproduce them.

**And the measurement found a defect four steps of review had not.** `GET /conversations` answered
`nextCursor: null, hasMore: false` on **every** page, beside a `total` of 4 000 — so a real
workspace would have been told its inbox held the fifty rows it had loaded, with the other 3 950
unreachable. With one conversation that response is *correct*, which is exactly why nothing but a
fixture at this size would have shown it. The list now carries a keyset cursor over
`(last_message_at, id)` — **both** halves, because `last_message_at` ties and an instant alone
skips whatever shares it — refuses a cursor it did not issue, and reads `hasMore` from `limit + 1`
rows rather than inferring it from a full page, which is wrong exactly when the total is a multiple
of the limit. Forty pages of a hundred now walk 4 000 distinct conversations with no repeats and no
gaps.

**The fixture had to be made possible before it could be useful.** Its first version added
37-minute steps to each conversation's `created_at`, which for the conversations created "now" put
every message in the **future**: "the latest message" was one that had not happened, and the list's
preview showed it. It also guessed `last_message_at` rather than computing it from the messages it
wrote. A fixture may be artificial; it may not be impossible.

**Tags are normalised on the way in.** `PUT /conversations/:id/tags` takes the whole set — two
endpoints for one field is how a screen and an API end up disagreeing about what is on a row — and
lower-cases, hyphenates and de-duplicates it, because a tag is a **filter chip**: a vocabulary that
keeps `Site Visit`, `site visit` and `site-visit` apart is three chips for one idea and a filter
that finds a third of what it should. A submission that cleans to nothing is a 400, not a silent
save of a filter that will never match. Audited, and deliberately **not** on the timeline: a tag is
how an agent organises their queue, not something a business owner opens a lead to read.

**A canned reply's count is sends, never clicks**
([ADR-0040](./decisions/ADR-0040-the-usage-meter-counts-and-does-not-price.md)). The picker is
ordered by it, so counting clicks would promote whatever is easiest to misclick — and the **body
that is sent is what the agent typed**, because they edit a saved reply before sending more often
than not and substituting the stored wording would put words in their mouth. A private reply is
unique per person and a shared one per workspace, which is one partial unique carrying the owner;
the `WHERE deleted_at IS NULL` is what lets a workspace reuse a shortcut it retired, where a plain
unique would have made that impossible for ever. The shortcut is **cleaned, not demanded**:
`Price List` becomes `/price-list`, because making somebody type punctuation exactly is how a
feature goes unused.

**The meter counts and does not price.** `messages.billable` and `conversation_category` had been
written from Meta's receipts since step 2 and read by **nothing** — two columns with no reader,
which is the same class of defect as a column with no writer and looks exactly like metering that
exists. `GET /whatsapp/usage` counts billable **conversations** (Meta's unit — it bills per
conversation and marks one message in each) grouped by the category it billed under, with
`messagesSent` beside them counting only what reached Meta. **No cost at all**, with the reason in
the payload: Meta's prices are per-country and change, so a rate card here would be wrong within a
quarter and wrong **silently**, on somebody's invoice.

**Two screens and two inbox additions** (`frontend-architecture.md` §10.17): the composer offers a
saved reply while the shortcut is still being typed — and only when the message *is* the shortcut,
the same whole-message rule the opt-out keywords use — `/settings/whatsapp/replies` prints each
shortcut as text above its editor with "sent 4 times" beside it, `/settings/whatsapp/usage` shows
counts and no money, and the conversation card gained a tag box whose saved values are printed
above it.

**Verified.** **2 752 tests green** — 1 189 unit (664 shared, 348 web, 173 api, 4 db) and 1 563
integration (882 api e2e, 681 across the schema-object and tenant-isolation suites) — with **41
new**:

- **9 in `@leados/shared`**, over the tag normaliser (three spellings of one idea becoming one
  chip, and a submission that cleans to nothing), the shortcut cleaner, and the prefix matcher with
  its whole-message rule.
- **2 on the web side**, over the usage category wording and a spec that **reconciles the
  composer's mirrored shortcut rule with the shared one** — the `TASK_BUCKETS` arrangement, because
  a client component may not import `@leados/shared` at runtime.
- **16 api e2e** in a new suite: the cursor that walks every row and the honest "no more", a forged
  cursor refused, tags cleaned and filtered and audited and emptied, a shortcut cleaned, a clash
  refused with whose it is, a send counting once and carrying the agent's own words, two people's
  private `/thanks`, an archive that frees the shortcut, and the meter counting by category,
  counting the unclassified rather than dropping it, honouring its window and excluding what has
  not been sent.
- **14 schema-object and tenant-isolation cases**: the partial unique in both its halves, the
  archive that frees a shortcut, the shortcut shape, the blank body, the visibility vocabulary, a
  reply owned by another workspace's member, a message naming another's reply, and the nine new
  hand-written objects.

Then **21 HTTP checks** against a live API and worker, and browser checks in Chromium.

**Carried forward, named rather than assumed:** **typing state and realtime** are unbuilt, and
`conversation_participants` stays unbuilt **deliberately** — a per-person read cursor is what that
table is really for, and it belongs with the realtime work that would make it meaningful rather
than arriving now as a table with no reader. `conversations.priority` and
`message_media.scan_status` are the two columns left with no writer. **Bulk sending** is Phase 6's.
The usage meter has no retention story: it counts `messages`, which §15 keeps for 24 months, so a
question about three years ago has no answer — a monthly rollup is Phase 8's shape of problem and
should arrive with the rest of them.

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
above. Last reviewed 2026-10-20, after Phase 5 step 5._

**Phase 4 is finished and all six of its exit criteria are met** — the table recording where each
one is tested is in its own section above. **Phase 5 is finished too: all eight of its exit
criteria are met**, each with the test or the measurement that shows it:

| Exit criterion                                                               | Status                                                            |
| ---------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| A retried delivery ⇒ one message, one activity, one automation trigger        | **Message and activity: done** (`whatsapp.e2e-spec.ts`). No automation exists to trigger until Phase 6. |
| Conversation events on the lead timeline                                      | **Done** — `whatsapp.received`, `whatsapp.sent`, `whatsapp.template_sent`, `whatsapp.failed`, each with a describer. |
| Out-of-window free-form send blocked; template send succeeds                  | **Done** — `whatsapp-sending.e2e-spec.ts`, and the browser check that finds the text box disabled. |
| A failed send shows the provider's reason and reaches the timeline            | **Done** — on the message, on the timeline, and as a notification quiet hours do not hold. |
| Two agents see the ownership lock; transfer is audited                        | Not started — the columns exist with no writer.                    |
| Media round-trip with type/size validation and signed-URL delivery            | **Round trip and validation: done** (`whatsapp-media.e2e-spec.ts`, 30 HTTP checks). **No signed URL**, deliberately and for a named reason: `StoragePort` cannot sign one, so the bytes are served behind `conversation:read` ([ADR-0038](./decisions/ADR-0038-an-attachment-is-served-by-this-product-not-by-a-signed-url.md)). |
| Opt-out keyword suppresses marketing sends immediately                        | **Done** — applied in the request that carried the message, not by a job; the marketing template is then refused with its own sentence, and a sentence merely *containing* the word changes nothing. |
| Inbox p95 < 500 ms with 100 k messages                                       | **Done** — `inbox-100k.sql` builds 4 000 conversations and 100 000 messages across three partitions; the list's p95 is **56 ms** and the body search, the slowest, **100 ms**. Numbers and commands in `packages/db/perf/README.md`. |

**Phase 5 is complete.** WhatsApp is connected, receives, replies, carries files both ways, is
shared between agents with an advisory lock and an audited transfer, honours a `STOP`, has tags and
canned replies, and reports what it cost — measured at the size the criterion names. What is
deliberately **not** built, said once rather than implied: typing state and realtime,
`conversation_participants` (a per-person read cursor, which belongs with the realtime work that
would make it meaningful), bulk sending, and a usage rollup for questions older than the 24-month
message retention.

**The next step is Phase 6 — Automation**, whose scope and exit criteria are in its own section
below. Four things from Phase 5 decide how it starts:

- **The outbox is already the trigger source, and nothing consumes it for automation yet.** Every
  write in this product emits its events inside the transaction that made them, which is exactly
  what a durable step executor needs — and the headline Phase 5 criterion ("one message, one
  activity, **one automation trigger**") has been two-thirds tested since step 1 with the third
  part named rather than claimed. Phase 6 is what makes that sentence finishable.
- **The registry pattern has now held three times** — providers, notification types, activity
  describers — and each time the boot check that reconciles a declaration against its
  implementation is what turned a silent gap into a failed startup. The automation registry's
  exit criterion is "adding an action type requires no engine change and no frontend release",
  which is the same shape and should get the same reconciliation.
- **A sweep that re-checks its subject before acting is the pattern for a delayed step.** The
  notification release, the conversation wake and the media retry all read their row again rather
  than trusting what the schedule remembered; Phase 6's "deliberately dropped delayed job is
  recovered by the reconciliation sweep" is that pattern with a workflow's state instead of a
  conversation's.
- **Every automation decision, including "skipped because", goes on the timeline** — which means
  the activity vocabulary and its describers grow with the engine, and the describer-coverage spec
  is what will catch an action type that writes an entry nothing can render.

Carried forward from Phase 4, still true: `sync_cursors` is built and has **no user** (the ads
insight pulls are Phase 9); `integration_health_checks` and `provider_events` are pruned by nothing
until Phase 9's retention sweep; a connection's `scopes` column is written empty; Google Ads
deliveries are replayable by anybody who has seen one, which is Google's design and the reason the
ledger is the only guard; and there is no "try it" sandbox and no generated client package
(`packages/contracts`), both named in §11 of `api-architecture.md` and both deliberately absent —
the web app calls the API through its own typed loaders, reconciled by a spec.
