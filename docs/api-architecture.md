# API Architecture — Lead OS

**Style:** REST over HTTPS, JSON · **Versioning:** URL prefix (`/api/v1`) ·
Traces to: `FR-API-*`, `FR-CAP-6`, `NFR-PERF-3`, `NFR-SEC-*`

---

## 1. Surfaces

| Surface          | Base path                | Auth                                            | Audience                                  | Notes                                                       |
| ---------------- | ------------------------ | ----------------------------------------------- | ----------------------------------------- | ----------------------------------------------------------- |
| Tenant API       | `/api/v1/*`              | Bearer JWT **or** API key                       | Web app + tenant integrations             | The product's main API                                      |
| Public ingestion | `/api/public/v1/*`       | Tenant public key (+ HMAC for server-to-server) | Customer websites, third parties          | Write-mostly, heavily rate limited, CORS-open per allowlist |
| Platform admin   | `/api/admin/v1/*`        | Platform JWT (MFA required)                     | Super Admin console                       | Never reachable with a tenant token                         |
| Collector        | `/t/*`, `/wh/*`          | Signature / site key                            | Browsers, Meta, Google, payment providers | Ack-fast, no business logic                                 |
| Realtime         | `/socket.io`             | JWT handshake                                   | Web app                                   | Rooms are org-scoped                                        |
| Docs             | `/docs`, `/openapi.json` | Public spec, auth'd "try it"                    | Developers                                | Generated from code (`FR-API-3`)                            |

> **Amendment, 2026-10-18 (implementation, Phase 4 step 4).** The tenant API's "Bearer JWT **or**
> API key" is built. A key is presented as one header — `Authorization: Bearer <key id>.<secret>` —
> and is told apart from an access token by the key id's `pk_` prefix, by shape rather than by
> trying one and falling back to the other, so a mistyped key is refused as a bad key and not as an
> expired session. Nothing about a route changes: the permission guard checks a key's principal the
> way it checks a person's, so the whole surface is reachable by an integration without a second
> implementation of any of it.
>
> **Requests are not signed on this surface**, and that is deliberate rather than an omission. The
> public ingestion endpoint signs an HMAC over the raw body because a capture is a replayable write
> from a position we do not trust; a signature that covers only the timestamp and the body does not
> bind the method or the path, so on a general REST surface a captured `GET` signature could be
> replayed as a `DELETE` within the tolerance window. Making that safe needs a _second_ signing
> construction, which every client library then implements by hand, for a property TLS already
> gives ([ADR-0032](./decisions/ADR-0032-a-key-acts-as-the-member-who-created-it.md)).
>
> **A key acts as the member who created it, narrowed to its scopes**, with that member's _current_
> grants and data scopes resolved per request. Its scopes are permission keys from a curated list
> that deliberately excludes everything administering access, money, credentials or privacy. The
> `/docs` row remains unbuilt: OpenAPI and the published docs are `FR-API-3` and the next step.

---

## 2. Response envelope

Success:

```json
{
  "success": true,
  "data": {},
  "message": "Lead created successfully",
  "meta": { "requestId": "req_01J…" }
}
```

Collections:

```json
{
  "success": true,
  "data": [{}],
  "meta": {
    "requestId": "req_01J…",
    "pagination": {
      "limit": 25,
      "nextCursor": "eyJpZCI6…",
      "prevCursor": null,
      "hasMore": true,
      "total": 1423,
      "totalIsEstimate": false
    }
  }
}
```

Error:

```json
{
  "success": false,
  "error": {
    "code": "LEAD_NOT_FOUND",
    "message": "Lead not found",
    "details": [
      {
        "field": "phone",
        "code": "INVALID_PHONE",
        "message": "Not a valid phone number for country IN"
      }
    ],
    "requestId": "req_01J…"
  }
}
```

Rules: HTTP status is always meaningful **and** `error.code` is always present (clients branch on the
code, never on the message). `message` is user-displayable and localizable. `details` is only for
field-level validation. Stack traces and provider payloads never appear in responses.

### Error code catalogue (extract)

| HTTP    | Code                                                                                                             | Meaning                                                                          |
| ------- | ---------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| 400     | `VALIDATION_FAILED`                                                                                              | Body/query failed schema validation                                              |
| 400     | `INVALID_PHONE`, `INVALID_CUSTOM_FIELD`, `UNKNOWN_FIELD`                                                         | Ingestion/field-specific                                                         |
| 401     | `UNAUTHENTICATED`, `TOKEN_EXPIRED`, `TOKEN_REUSED`                                                               | Refresh-reuse revokes the family                                                 |
| 403     | `FORBIDDEN`, `PERMISSION_DENIED`, `OUT_OF_DATA_SCOPE`, `ORG_SUSPENDED`, `TRIAL_EXPIRED`, `SUBSCRIPTION_INACTIVE` | Distinct so the UI can show the right screen                                     |
| 403     | `FEATURE_NOT_IN_PLAN`, `LIMIT_EXCEEDED`                                                                          | Carries `details.feature`, `details.limit`, `details.used`, `details.upgradeUrl` |
| 404     | `NOT_FOUND`, `LEAD_NOT_FOUND`, …                                                                                 | Cross-tenant access returns 404, never 403, to avoid existence disclosure        |
| 409     | `CONFLICT`, `DUPLICATE_LEAD`, `STALE_VERSION`, `IDEMPOTENT_REPLAY_MISMATCH`                                      | `DUPLICATE_LEAD` includes the existing lead id when the caller may see it        |
| 422     | `BUSINESS_RULE_VIOLATION`                                                                                        | e.g. stage requires fields that are empty; `details.requiredFields`              |
| 429     | `RATE_LIMITED`                                                                                                   | `Retry-After` + `X-RateLimit-*` headers                                          |
| 502/503 | `INTEGRATION_UNAVAILABLE`, `PROVIDER_ERROR`                                                                      | Includes `details.provider`, retry guidance                                      |
| 500     | `INTERNAL_ERROR`                                                                                                 | Opaque; `requestId` is the support handle                                        |

---

## 3. Conventions

- **Methods:** `GET` read · `POST` create/action · `PATCH` partial update (the default for updates) · `PUT` full replace (rare) · `DELETE` soft-delete. Non-CRUD operations are explicit sub-resources: `POST /leads/{id}/assign`, `POST /leads/{id}/merge`, `POST /tasks/{id}/reschedule`, `POST /conversations/{id}/transfer`. No RPC verbs in query strings.
- **Casing:** `camelCase` in JSON, `snake_case` in the database; mapping happens in the module's mapper layer.
- **Time:** all timestamps ISO-8601 with offset (`2026-09-27T10:30:00+05:30`); the API also returns `organizationTimezone` on the session so the client groups "today" correctly.
- **Money:** `{ "amountMinor": 500000000, "currency": "INR" }`. Never a float.
- **Ids:** UUIDv7 strings. Public-facing ids are the real ids (UUIDs are not enumerable).
- **Pagination:** cursor-based by default (`?limit=25&cursor=…`), keyset on `(created_at, id)` or the sorted column + id. Offset pagination (`?page=`) is allowed only where a UI needs page numbers, capped at 10 000 rows. `total` is exact under 10 000 rows and an estimate above (flagged by `totalIsEstimate`). Hard max `limit` 100 (1 000 for API-key export cursors) — `NFR-PERF-3`.
- **Sparse fieldsets / expansion:** `?fields=id,fullName,stage` and `?include=assignedUser,stage,tags` with a bounded allowlist per endpoint (no arbitrary graph expansion, no N+1).
- **Concurrency:** detail reads return `ETag`; `PATCH` accepts `If-Match` and returns 409 `STALE_VERSION` on mismatch. Kanban drag uses this to avoid lost updates.
- **Idempotency:** all `POST` that create or send accept `Idempotency-Key`; the first response is stored and replayed for 24 h; a different body under the same key is 409 `IDEMPOTENT_REPLAY_MISMATCH` (`FR-API-5`).
- **Partial success:** bulk endpoints return 207-style bodies: `{ succeeded: [...], failed: [{ id, code, message }] }`, and above a configurable threshold return `202 Accepted` with a job id instead (`FR-LEAD-9`).
- **Deprecation:** `Deprecation`, `Sunset`, `Link: <…>; rel="deprecation"` headers; minimum 6-month overlap for breaking changes; additive changes never bump the version.

---

## 4. Filtering & sorting DSL

One parser shared by list endpoints, saved views, segments and automation conditions — the same
expression can be saved as a view, reused as a segment and evaluated in a workflow condition.

Simple (query string, for humans and simple clients):

```
GET /api/v1/leads
  ?status=open,contacted
  &source=facebook
  &assignedUserId=me
  &createdAt[gte]=2026-09-01&createdAt[lt]=2026-10-01
  &nextActionAt[lte]=now
  &scoreBand=hot
  &cf.budget[gte]=5000000          # custom field
  &tags[all]=vip,referral
  &q=9876                          # free text / partial phone
  &sort=-score,nextActionAt
  &limit=25&cursor=…
```

Complex (JSON body on `POST /leads/search`, identical semantics):

```json
{
  "filter": {
    "op": "and",
    "conditions": [
      { "field": "stage.id", "op": "in", "value": ["…", "…"] },
      { "field": "cf.propertyType", "op": "eq", "value": "Apartment" },
      {
        "op": "or",
        "conditions": [
          { "field": "nextActionAt", "op": "lte", "value": "now" },
          { "field": "nextActionAt", "op": "is_null" }
        ]
      }
    ]
  },
  "sort": [{ "field": "score", "dir": "desc" }],
  "limit": 50
}
```

Operators: `eq, neq, in, nin, gt, gte, lt, lte, between, contains, starts_with, ends_with, is_null,
is_not_null, all, any, none, changed, changed_to` (the last two only in automation contexts).
Relative time tokens: `now`, `today`, `tomorrow`, `start_of_week`, `-7d`, `+3d`, resolved in the
organization's timezone.

Safety: fields are resolved against a per-entity allowlist built from the schema plus that org's
**active custom-field definitions** — an unknown or non-filterable field is a 400, never
interpolated. Values are always bound parameters. Sorting is restricted to indexed columns and
`is_indexed` custom fields (otherwise 400 with a hint), so a saved view cannot table-scan.

---

## 5. Endpoint map (tenant API)

Abbreviated: `C`reate `R`ead `L`ist `U`pdate `D`elete. Every route declares its permission and its
data-scope behaviour in code; the table names the primary permission.

### Auth & session

```
POST   /auth/register                        create org + owner (public, rate limited)
POST   /auth/login                           → access + refresh (httpOnly cookie for web)
POST   /auth/refresh                         rotation + reuse detection
POST   /auth/logout | /auth/logout-all
POST   /auth/forgot-password | /auth/reset-password
POST   /auth/verify-email | /auth/resend-verification
POST   /auth/mfa/setup | /verify | /disable | /recovery-codes
GET    /auth/me                              user, orgs, active org, permissions, entitlements, flags
POST   /auth/switch-org
GET    /auth/sessions        DELETE /auth/sessions/{id}
POST   /invitations/accept
```

### Organization & settings · `organization:*`

```
GET/PATCH /organization                      profile, timezone, currency, defaults
GET/PATCH /organization/settings             feature-level preferences
CRUD      /branches | /teams | /teams/{id}/members
CRUD      /users                             (invite, disable, re-enable)
CRUD      /roles                             + GET /permissions (catalogue)
CRUD      /working-hours | /holidays | /availability
GET       /organization/onboarding  PATCH /organization/onboarding/{step}
POST      /organization/apply-template/{code}
GET       /audit-logs                        filter by actor/action/resource/date (read-only)
```

### Leads · `lead:*`

```
GET    /leads                                filter DSL, saved view via ?viewId=
POST   /leads/search                         complex filter
POST   /leads
GET    /leads/{id}                           + ?include=
PATCH  /leads/{id}
DELETE /leads/{id}                           soft; POST /leads/{id}/restore
POST   /leads/{id}/assign                    { userId | teamId | strategy:'auto' }
POST   /leads/{id}/stage                     { stageId }  → validates required fields
POST   /leads/{id}/status                    { statusId, lostReasonId?, note? }
POST   /leads/{id}/score/recalculate
GET    /leads/{id}/score-breakdown           explainability (FR-SCR-2)
GET    /leads/{id}/timeline                  cursor, ?types=
GET    /leads/{id}/touchpoints | /journey    attribution + visual journey
GET    /leads/{id}/duplicates
POST   /leads/{id}/merge                     { intoLeadId, fieldChoices }
POST   /leads/merges/{id}/undo
CRUD   /leads/{id}/notes | /documents | /tasks | /calls
GET    /leads/{id}/conversations | /website-activity | /automation-runs
POST   /leads/bulk/{assign|stage|status|tag|priority|delete|export}
GET    /leads/recycle-bin
GET    /customers … (same shape)             `customer:*`
```

### Configuration · `settings:*`

```
CRUD /custom-fields | /custom-field-sections | /custom-fields/{id}/options
POST /custom-fields/{id}/reindex             sets is_indexed, runs index job
CRUD /lead-statuses | /lead-sources | /lost-reasons | /tags | /task-types
CRUD /reschedule-reasons | /call-outcomes | /score-bands
CRUD /pipelines | /pipelines/{id}/stages     + POST /stages/reorder
CRUD /assignment-rules | /assignment-rules/{id}/conditions | /pool-members
POST /assignment-rules/{id}/test             dry-run against a sample lead (returns chosen user + why)
CRUD /scoring-rules   POST /scoring-rules/preview
CRUD /duplicate-rules POST /duplicate-rules/test
CRUD /sla-policies    CRUD /saved-views
```

### Tasks & work · `task:*`

```
GET  /tasks                                  ?bucket=overdue|due_now|due_today|upcoming|completed|cancelled
GET  /tasks/summary                          the Today counters (FR-TSK-7)
GET  /tasks/config                           types + outcomes + reasons, for the form
CRUD /tasks
GET  /tasks/{id}/reschedules                 the history behind reschedule_count (FR-TSK-5)
POST /tasks/{id}/complete                    { outcomeId, note?, nextFollowUp? }  ← outcome REQUIRED
POST /tasks/{id}/reschedule                  { dueAt, reasonId, note? }   ← reason REQUIRED
POST /tasks/{id}/cancel
CRUD /settings/task-types | /settings/task-outcomes | /settings/reschedule-reasons
GET  /my/today                               executive workspace payload in ONE request
GET  /my/leads | /my/conversations
GET  /sla/board                              at-risk + breached (manager)  `sla:read`
```

### Calls & telephony · `call:*`

```
GET  /calls                                  ?leadId=&mine=&open=&linked=&category=&from=&to=
GET  /calls/config                           outcomes + what the dial button will actually do
GET  /calls/{id}
POST /calls                                  log one that happened  { status, outcomeId, … }  ← outcome REQUIRED
POST /calls/dial                             click-to-call; answers how it is being placed
POST /calls/{id}/outcome                     what happened on a call the product dialled
PATCH/DELETE /calls/{id}                     attribute an unknown number · correct a note · remove
CRUD /settings/call-outcomes                 the tenant's own list  `settings:manage` to write
```

> **Amendment, 2026-10-14 (implementation, Phase 3 step 6).** The sketch above had
> `CRUD /leads/{id}/calls`. Calls are a **top-level** collection filtered by `?leadId=`, exactly as
> tasks settled in step 1 and for the same two reasons: a call does not have to belong to a lead at
> all (an inbound call from a number nobody recognises is the call most worth keeping), and the log
> is a screen of its own that a manager reads across leads. Five further points:
>
> - **`POST /calls/dial` needs `call:log`, not `call:read`** — which is the whole reason the two
>   permissions are separate. A workspace can let somebody read what the team did on the phone
>   without letting them ring a customer from the product; the auditor template holds `call:read`
>   alone.
> - **It answers how the call is being placed**, not that it was:
>   `{ mode: 'device', href: 'tel:…' }` or `{ mode: 'provider', provider, providerCallId }`. The
>   client opens the link in the first case and does nothing in the second, so a response that
>   pretended they were the same would force every caller to guess
>   ([ADR-0027](./decisions/ADR-0027-calls-sit-behind-a-port-and-an-attempt-is-not-a-contact.md)).
> - **`POST /calls/{id}/outcome` is its own endpoint**, not a `status` on the PATCH — the same
>   arrangement completion, reschedule and cancel have on a task. It marks the lead contacted,
>   satisfies a first-response promise and emits the event scoring reads; a PATCH that happened to
>   carry a status could check none of them. The PATCH is for attributing an unknown number and
>   fixing a note.
> - **`POST /calls` takes an optional `finishFollowUp`** and answers `{ call, followUpCompleted }`,
>   because completing a follow-up and logging the call that finished it are one action to the person
>   doing them (`FR-TSK-6`). The flag is in the response so the screen never claims more than
>   happened.
> - **`GET /calls` returns `meta.totalTalkTimeSeconds` and `meta.connected`** over the whole filter,
>   never the page — a panel that summed the twenty rows it loaded would tell a manager their team
>   spent a fifth of the time on the phone that it did. `?open=` and `?linked=` keep `undefined` as
>   `undefined`, because absent means "both".
>
> `GET /calls/config` is readable with `call:read` rather than `settings:manage`, like
> `GET /tasks/config`: the outcome dropdown is part of logging a call, and a sales executive has no
> business holding a settings permission to do their job.

> **Amendment, 2026-10-06 (implementation, Phase 3 step 1).** Everything above except `/my/*` and
> `/sla/*` is built. Four corrections to what this section said:
>
> - **`?bucket=` takes six values, not five**, and `today` is spelled `due_today`. The buckets are
>   defined once in `taskBucket()` (`@leados/shared`) and once as a `where` clause beside it, which
>   is what lets `/tasks/summary` aggregate over the whole filter rather than tally the loaded
>   page — and `cancelled` is its own bucket because "we decided not to" is not "done".
> - **`outcomeId` is required on `complete`**, not optional. `FR-TSK-6` says the completion prompts
>   for an outcome, and a prompt that can be dismissed leaves "what happened on those forty calls"
>   unanswerable a month later. `tasks_completed_has_outcome` enforces it in the database too.
> - **`GET /tasks/config` is new**, and readable with `task:read` rather than `settings:manage`: the
>   task form needs three dropdowns, and a sales executive has no business holding a settings
>   permission to plan a call. The three `/settings/*` collections behind it are
>   `settings:manage` to write, `task:read` to read, like `/settings/payment-methods`.
> - **`PATCH /tasks/{id}` cannot change `status` or `dueAt`.** Completing, rescheduling and
>   cancelling each have their own preconditions, their own timeline entry on up to three subjects
>   and their own effect on the lead's next action; a PATCH that happened to carry a status could
>   check none of them. The same reasoning as `/payments/{id}`.
>
> `/tasks/summary` also returns **`noNextAction`** — open leads with nothing planned, the "silent
> leads" half of `FR-TSK-4`. It belongs beside the other counters because an empty Today list
> means nothing if forty leads have nobody owing them anything.

> **Amendment, 2026-10-07 (implementation, Phase 3 step 2).** `GET /sla/board` is built, and so are
> `GET /sla/clocks`, `GET /sla/escalations`, `POST /sla/escalations/{id}/acknowledge` and CRUD on
> `/sla/policies`. Three notes:
>
> - **It is `/sla/board`, not under `/my/`**, and it is read with `sla:read` through
>   `DataScopeService` — an executive sees their own clocks at `own` scope and a branch manager
>   their branch, from the same endpoint. A separate "manager" route would have been a second
>   implementation of the same predicate.
> - **There is no endpoint that starts or satisfies a clock**, by design. Both happen inside the
>   transaction of the write that caused them — a capture, a completed follow-up, a terminal status.
>   An endpoint that let a client mark its own SLA met would make the measurement worthless.
> - **`PATCH /sla/policies/{id}` affects new clocks only**, and says so in its own `message`.
>   Retargeting a running clock would let a breach un-breach itself because somebody relaxed the
>   policy afterwards.
>
> `/sla/board` returns five counts — `breached`, `at_risk`, `running`, `met` and `answered_late` —
> each an aggregate over the whole filter. `answered_late` is separate from `breached` because a
> clock somebody eventually got to is a different management problem from one still sitting there.

> **Amendment, 2026-10-13 (implementation, Phase 3 step 3).** `GET /my/today` is built. `/my/leads`
> and `/my/conversations` are not, and are not planned as separate endpoints: the first is
> `GET /leads?assignedUserId=`, which already data-scopes, and the second arrives with the inbox.
>
> - **It takes no parameters.** Not `mine`, not `assignedUserId`, not `limit`. Today is not a
>   question somebody asks — it is the answer, for the person holding the phone, and a screen whose
>   contents depend on a query string is one two colleagues describe differently while helping each
>   other over a call. It also leaves exactly one shape to measure, so the `p95 < 400 ms` exit
>   criterion means something. A manager wanting somebody else's queue has `/tasks?assignedUserId=`
>   and `/sla/board`.
> - **One response, five sections, nine counts.** Each section is `{ count, items, truncated,
available }`: `count` is an aggregate over the whole set, `items` is capped (twenty for the
>   three queue sections, ten for the two lists under them), and `available` is `false` when the
>   caller's role withholds the permission that section reads. `task:read` gates the route;
>   `lead:read` and `sla:read` gate their sections and **degrade** rather than refuse, because a
>   role with the follow-up queue and nothing else is a configuration the catalogue has always
>   offered and must not make the landing page unreachable.
> - **"Mine" includes whatever nobody has claimed.** A workspace with no assignment rule leaves
>   captured leads unassigned, and a Today that is strictly "mine" shows those to nobody. The data
>   scope narrows it: somebody scoped to their own rows cannot read an unclaimed row at all.
> - **Nothing on it writes.** The screen's actions are `POST /tasks/{id}/complete` and
>   `POST /tasks/{id}/reschedule`, which already carry the preconditions, the timeline entries and
>   the effect on the lead's next action.
>
> `GET /leads` gained no new flag for "nobody has called them". The question is a **filter field**
> instead — `firstContactedAt` joined the catalogue beside `lastContactedAt`, so
> `firstContactedAt is_null` works in the filter DSL, in a saved view, and as the link out of
> Today's capped section. A fourth two-way boolean beside `unassigned` and `noNextAction` would have
> been a second way to ask one question.

### Pipeline & deals

```
GET  /pipelines/{id}/board                   per-stage first page + counts + value totals
POST /pipelines/{id}/move                    { leadId, toStageId, position } (If-Match)
CRUD /deals | /deals/{id}/items | /quotations | /quotations/{id}/send | /payments
GET  /deals/{id}/pdf
```

### Conversations & WhatsApp · `conversation:*`, `whatsapp:*`

```
GET  /conversations                          ?status=&assigned=me|unassigned&channel=&tag=&unread=
GET  /conversations/{id}                     + lead context block (FR-WA-8)
GET  /conversations/{id}/messages            cursor, newest-first
POST /conversations/{id}/messages            text/media/template (queued; 202 + message id)
POST /conversations/{id}/{assign|transfer|close|reopen|snooze|read|tags}
POST /conversations/{id}/notes               internal note + @mentions
GET  /conversations/search                   message body search
CRUD /canned-replies
GET/POST /whatsapp/accounts | /numbers       connect, verify, health
GET  /whatsapp/templates                     POST (submit) · POST /sync · GET /{id}/preview
POST /whatsapp/templates/{id}/test-send
GET  /whatsapp/usage                         messages by category/period
POST /whatsapp/campaigns                     consent-checked bulk (FR-WA-10)
```

> **Amendment, 2026-10-19 (implementation, Phase 5 step 1 — WhatsApp inbound).** Five of these are
> built; the rest wait for the steps that can honestly answer them, because a route that accepted a
> message nothing could deliver would be worse than its absence.
>
> ```
> GET  /conversations            ?status=&assigned=me|unassigned&unread=true|false&numberId=&leadId=&q=
> GET  /conversations/{id}       + the lead context block (FR-WA-8)
> GET  /conversations/{id}/messages   cursor, newest first, `?before=<messageId>`
> POST /conversations/{id}/read       marks it read; nothing is sent
> GET  /whatsapp/accounts             the WABAs and their numbers
> POST /whatsapp/accounts             { connectionId } — discovers the numbers, idempotent
> PATCH /whatsapp/numbers/{id}        { userId | null } — who answers it by default
> ```
>
> - **Search is a query parameter, not `/conversations/search`.** `?q=` matches a message body
>   (through the GIN index) or the contact's number, and it composes with the other filters — a
>   separate endpoint would be a second list with its own scoping to get wrong.
> - **`?channel=` and `?tag=` are absent** because `whatsapp` is the only channel and nothing writes
>   a tag yet. `?numberId=` and `?leadId=` are here instead, which are the two filters an inbox
>   needs on day one.
> - **`meta.unread` and `meta.open` are aggregates over the whole filter**, not the page. A badge
>   that counted the rows it loaded would tell an agent their inbox is a fraction of its real size.
> - **`POST /conversations/{id}/read` takes `conversation:read`**, not a write permission: reading is
>   what it records, and an agent who may open a conversation may say they have read it.
> - **`/whatsapp/numbers` is a PATCH on one number, not a collection.** Numbers are discovered from
>   Meta rather than created by hand — a number somebody mistyped would silently receive nothing —
>   so the only thing a person does to one is say who answers it.

> **Amendment, 2026-10-19 (implementation, Phase 5 step 2 — sending).** Seven more, and the rest
> still wait for the steps that can honestly answer them:
>
> ```
> POST  /conversations/{id}/messages                  { kind: 'text', body } | { kind: 'template', templateId, variables? }
> POST  /conversations/{id}/messages/{messageId}/retry a failed message, on the same row
> GET   /whatsapp/templates                            ?status=&accountId=&limit=
> POST  /whatsapp/templates                            a draft, validated against Meta's own rules
> GET   /whatsapp/templates/{id} · PATCH · DELETE      read, edit a draft, archive
> GET   /whatsapp/templates/{id}/preview               ?leadId= — what this person will read
> POST  /whatsapp/templates/{id}/submit                sends it to Meta for review
> POST  /whatsapp/templates/sync                       { accountId } — reconciles against Meta
> ```
>
> - **The send answers `202` with a `queued` message**, not a sent one: the send is a queue hop, so
>   nothing has reached Meta when the request answers
>   ([ADR-0037](./decisions/ADR-0037-a-send-is-a-queued-write-whose-status-only-moves-forward.md)).
>   The body is a **discriminated union** on `kind`, because the two kinds are refused for different
>   reasons and a `{ body?, templateId? }` with both set has no honest meaning.
> - **Outside the 24-hour window a free-form send is `422 BUSINESS_RULE_VIOLATION`** with the
>   sentence that names the way through. The same function the composer greys its text box with
>   decides it, so the screen and the write path cannot disagree.
> - **A template that is not approved is refused with Meta's own standing** ("WhatsApp is still
>   reviewing this template"), and a variable nothing can fill is a `400` naming the variable —
>   never a message Meta would happily deliver reading "Hi  , your order…".
> - **A marketing template needs the recipient's WhatsApp consent**; `utility` and
>   `authentication` do not, because those are things the customer asked for.
> - **`PATCH` works on a draft only.** Meta has no edit for a submitted template, so the honest
>   options are "submit a new one" or "a local copy that disagrees with what is sent".
> - **`/whatsapp/templates/{id}/preview` is a `GET`.** Rendering a page must never run a mutation,
>   and a preview that was a POST would be a state transition driven by the browser's reload button.
> - **`/whatsapp/templates` is behind `whatsapp:manage`, and sending behind `conversation:reply`.**
>   A template is the business's own wording, submitted for review, and changing one changes what
>   every agent sends; sending one is a reply.

> **Amendment, 2026-10-20 (implementation, Phase 5 step 3 — media).** Two more:
>
> ```
> POST  /conversations/{id}/attachments                  ?fileName=&caption= — the body IS the file
> GET   /conversations/{id}/messages/{messageId}/media   the bytes, inline or as a download
> ```
>
> - **The body is the bytes, and the name is in the query.** One file and nothing else, so multipart
>   would add a parser and a second body limit for no second part — the CSV import's shape, for the
>   same reason. `fileName` is required rather than optional: WhatsApp shows it to the person
>   receiving a document, and `blob` is the difference between a file somebody opens and one they do
>   not.
> - **It answers `202` with a `queued` message**, like a text send, and the file is already stored by
>   **us** before Meta has it — which is what makes a media send retryable
>   ([ADR-0038](./decisions/ADR-0038-an-attachment-is-served-by-this-product-not-by-a-signed-url.md)).
> - **The conversation is checked before the body.** A missing or empty body refused first would
>   answer `400` for another workspace's conversation and `404` for a real one, and the shape of an
>   id must not become an oracle.
> - **A file the product will not take is `400 VALIDATION_FAILED`** with a field error on `file`
>   naming the limit in a sentence ("That is 40 MB, and the limit for an image is 5 MB"), not a code
>   a screen has to translate.
> - **The download is not an envelope.** `@Res()` straight through the reply, as the export and the
>   import error file already are: `inline` for an image, video or audio and `attachment` for
>   anything else, with `x-content-type-options: nosniff` and `cache-control: no-store` on both — a
>   file a stranger sent us must never be interpreted as HTML on our own origin.
> - **A file that has not arrived is `422` with the row's own sentence**, never an empty `200`: a
>   browser renders an empty image as broken, with no explanation, which is worse than being told.
> - **The content types that may carry a file are refused on every other path, with `415`, before a
>   byte is read.** A Fastify content-type parser is global and the body is parsed before any guard
>   runs, so the 16 MB limit this route needs would otherwise be an unauthenticated sink on
>   `/auth/login` — the `text/csv` lesson, in a second place.

> **Amendment, 2026-10-20 (implementation, Phase 5 step 4 — the shared inbox).** Eight more, which
> completes `FR-WA-7` apart from tags, canned replies and realtime:
>
> ```
> POST   /conversations/{id}/claim      take or refresh the soft lock · DELETE to let go
> POST   /conversations/{id}/assign     { assignedUserId: uuid | null, reason? }
> POST   /conversations/{id}/transfer   { toUserId, note } — both required
> POST   /conversations/{id}/close      { note? } · POST /{id}/reopen
> POST   /conversations/{id}/snooze     { until }
> GET    /conversations/{id}/notes      · POST with { body, mentionedUserIds? }
> ```
>
> - **An unclaimed conversation is readable and answerable by anybody who holds the permission**
>   ([ADR-0039](./decisions/ADR-0039-a-conversation-lock-is-advisory-and-an-unclaimed-conversation-is-everybodys.md)).
>   A conversation has no branch or team column, so every narrower scope resolved to "assigned to
>   me" — which made a *shared* inbox unreadable by the own-scoped executives it is for, in the
>   common case where nothing assigns conversations at all. One decider,
>   `conversationScopeWhere`, used by all four services that touch a conversation.
> - **`POST …/claim` answers 200 with the conversation, not 409.** The lock is advisory: taking one
>   a colleague holds is allowed, the override is audited, and the answer carries
>   `lock: { held, mine, expiresAt, message }` so the screen says the right sentence from the
>   viewer's own side. `DELETE` releases **only your own** — a colleague's lock is left alone,
>   because releasing it would be a lie.
> - **`assignedUserId` is `.nullable()`, not `.optional()`.** "Nobody — back in the pool" is a real
>   answer, and folding an absent key to a default is the `?flag=true` mistake in a body. Assigning
>   somebody the conversation they already have answers **200** rather than 422: pressing a button
>   twice is not a mistake, and the screen's state may simply be stale.
> - **A transfer requires both halves.** The recipient, because a transfer to nobody is an
>   unassignment with its own endpoint; the note, because "transfer is audited" is this phase's exit
>   criterion and an audit row with no reason answers nothing three weeks later.
> - **`snooze` takes an instant, not a duration**, and refuses the past (400, naming `until`) and
>   anything over 30 days. The screen offers "in 3 hours", "tomorrow morning" and "next week" and
>   sends what those mean, resolved at render time.
> - **`POST …/notes` takes ids, not `@names`.** Parsing a name out of the text is ambiguous the
>   moment a workspace has two Ashas, and wrong in the quiet direction. Every id is checked against
>   `Membership` and an unknown one is a **400** naming the field — an array column cannot carry a
>   foreign key, so this is the check that replaces one.
> - **Notes are behind `conversation:read` to list and `conversation:reply` to write.** A note is
>   something somebody adds to the record, and the permission that lets you write to a conversation
>   is the one that should let you write about it.
> - **`conversation:assign` guards assign and transfer**, and has been in the catalogue since
>   Phase 1 — granted in every existing workspace, verified with
>   `SELECT count(*) FROM role_permissions WHERE permission_key = 'conversation:assign'` (489 rows)
>   rather than assumed. **No backfill migration**, because a verified no-op migration is worse than
>   none.

> **Amendment, 2026-10-20 (implementation, Phase 5 step 5 — tags, replies, the meter).** Six more,
> which completes `FR-WA-7` apart from typing state and realtime, and gives `FR-BIL-4` its first
> reader:
>
> ```
> PUT    /conversations/{id}/tags     { tags: string[] } — the whole set, normalised on the way in
> GET    /canned-replies              · POST { shortcut, body, visibility? }
> PATCH  /canned-replies/{id}         · DELETE (archives; the row stays)
> GET    /whatsapp/usage              ?from=&to= — counts, never cost
> ```
>
> - **`GET /conversations` is pageable at last.** It answered `nextCursor: null, hasMore: false` on
>   every page, so a workspace with 4 000 conversations was told its inbox held 50 — with `total`
>   sitting beside the lie saying 4 000. It now issues a keyset cursor over
>   `(last_message_at, id)`, **both** halves because `last_message_at` ties, and refuses a cursor it
>   did not issue (400) rather than paging through a shape a client invented. `hasMore` is read from
>   `limit + 1` rows rather than inferred from a full page, which is wrong exactly when the total is
>   a multiple of the limit. Found by measuring against the 100 k-message fixture
>   ([ADR-0040](./decisions/ADR-0040-the-usage-meter-counts-and-does-not-price.md)); with one
>   conversation the old response was correct.
> - **`?tag=` is a new filter on the same endpoint.** One tag, because a filter chip is one tag.
> - **Tags are `PUT`, not add-one/remove-one.** Two endpoints for one field is how a screen and an
>   API end up disagreeing about what is on a row. The values are lower-cased, hyphenated and
>   de-duplicated on the way in, so a filter on `site-visit` cannot miss a conversation somebody
>   typed `Site Visit` on — and a submission that cleans to **nothing** is a **400** rather than a
>   silent save of a filter that will never match.
> - **Canned replies are behind `conversation:reply`, not `whatsapp:manage`.** A canned reply is an
>   agent's shorthand; a template is the business's reviewed wording, which is why templates need
>   the manage permission. A **shared** reply can be edited by anybody who may reply, because a typo
>   in the wording everybody sends should not be something only one person can correct; a
>   **private** one answers 404 to anybody else.
> - **`DELETE /canned-replies/{id}` archives.** `messages.canned_reply_id` is `Restrict`, so a reply
>   that has been sent has history pointing at it. The shortcut is then free again, which the
>   partial unique is what makes possible.
> - **`GET /whatsapp/usage` is behind `billing:read`** — an invoice question, and the person who
>   reconciles an invoice is not necessarily the one who connects a number. It answers **counts by
>   category and no cost at all**, with the reason in the payload: Meta's prices are per-country and
>   change, and a rate card here would be wrong within a quarter and wrong silently on somebody's
>   bill. Defaults to this month, which is the period an invoice covers.

### Capture, integrations, developer platform

```
CRUD /forms | PUT /forms/{id}/fields   POST /forms/{id}/rotate-key
GET  /forms/submissions?formId=       GET /forms/builder-options
CRUD /api-keys                      POST /api-keys/{id}/rotate | /revoke
GET  /api-logs | /api-logs/usage    GET /ingestion/payloads | /ingestion/errors | /ingestion/unmapped
POST /ingestion/payloads/{id}/replay   POST /ingestion/test   (dry run, 200, persists nothing)
CRUD /webhooks (endpoints)          POST /webhooks/{id}/test | /{id}/rotate-secret
GET  /webhooks/{id}/deliveries      POST /webhooks/deliveries/{id}/retry
GET  /webhooks/deliveries           (the workspace's whole recent log)
CRUD /integrations                  POST /integrations/{provider}/connect | /disconnect | /test
GET  /integrations/health
CRUD /imports (upload → map → validate → run)  GET /imports/{id} | /imports/{id}/errors.csv
POST /exports                       GET /exports/{id}
```

> **Amendment, 2026-10-19 (implementation, Phase 4 step 6).** The integration surface as built:
>
> ```
> GET  /integrations/providers        the catalogue, with each provider's own connect form
> GET  /integrations                  the live connections (?disconnected=true for the history)
> GET  /integrations/{id}             one, with its last ten health checks
> POST /integrations                  connect: { provider, name, credential?, settings, fieldMappings? }
> PATCH /integrations/{id}            rename, re-settle, paste a new credential
> POST /integrations/{id}/check       probe it now (422 for a provider there is nothing to ask)
> POST /integrations/{id}/preview     what a payload would become, through the mapping and the
>                                     capture's own normalisation; persists nothing
> POST /integrations/{id}/rotate-secret   a new inbound secret (shared-secret providers only)
> POST /integrations/{id}/disconnect  soft, and keeps everything it brought in
> GET  /integrations/health           every probe, newest first
> ```
>
> Four deviations from the sketch above, each deliberate:
>
> - **`POST /integrations` rather than `POST /integrations/{provider}/connect`.** The provider is a
>   field of the thing being created, not a path segment: `CRUD /integrations` and a connect route
>   under a provider prefix are two spellings of one create, and the second would make
>   `/integrations/{id}` and `/integrations/{provider}/…` ambiguous to the global UUID pipe.
> - **There is no `DELETE`.** A disconnect is soft, because `inbound_payloads` references the
>   connection that brought each lead in; a hard delete would orphan that history or make a mistyped
>   connection permanent.
> - **`/test` is two endpoints, because it was two questions.** `/check` probes the credential;
>   `/preview` runs a payload through the field mapping. Naming both "test" would mean one endpoint
>   that did different things per provider, and for `generic_webhook` — which has nothing to probe —
>   the honest answer to "test this" is the preview.
> - **All of it behind `integration:manage`, with no read-only view.** A connection holds a
>   credential and its mapping decides where every lead it brings in lands; somebody who may read
>   those may change them. It is not in `API_GRANTABLE_PERMISSIONS`, so **a key cannot manage
>   integrations** — a credential that can mint credentials is a privilege escalation left in
>   somebody else's config file.

> **Amendment, 2026-10-19 (implementation, Phase 4 step 7).** Two changes to the surface above
> ([ADR-0035](./decisions/ADR-0035-a-provider-event-is-deduplicated-on-the-providers-own-id.md)):
>
> ```
> GET  /integrations/events           what each provider has told us, and what became of it
> ```
>
> - **`credential` became `credentials`**, a record keyed by the names a provider's
>   `credentialFields` declare. Meta Lead Ads needs two doing two jobs — an app secret to verify a
>   delivery and a page token to fetch the lead it refers to — and a single `credential` would have
>   forced the second into `settings`, which are rendered on the screen, echoed back on a refusal
>   and written to the audit log. It is **all-or-nothing** on a `PATCH`: a set where one secret is
>   fresh and another is whatever was there before is the half-reconnection that looks fine and
>   fails on the next delivery. This is a breaking change to an endpoint shipped one step earlier,
>   and the OpenAPI classifier flagged it — which is the check working rather than a reason not to
>   make it.
> - **`GET /integrations/events` is the delivery ledger**, which is what somebody reads when a lead
>   did not appear: the provider said something, and either it became a lead or here is their own
>   reason. `meta.unresolved` counts the failures across the **whole** set rather than the page,
>   because a figure beside a filtered list that is not itself filtered is the recurring bug in this
>   codebase.

> **Amendment, 2026-10-05 (implementation).** The import and export surface as built:
>
> ```
> GET  /imports/catalogue             the importable fields (incl. custom) and the modes
> POST /imports?fileName=…            the body IS the file (content-type: text/csv)
> GET  /imports | /imports/{id}       the jobs, and one job's state and counters
> GET  /imports/{id}/preview          header, sample rows, proposed mapping, ambiguities
> PUT  /imports/{id}/mapping          { mapping, mode }
> GET  /imports/{id}/check            the dry run, read-only
> POST /imports/{id}/validate         the dry run as a step (records `validated`)
> POST /imports/{id}/start | /cancel
> GET  /imports/{id}/rows             per-row outcomes, filterable by status
> GET  /imports/{id}/errors.csv       the failed rows as a file
> GET  /exports/catalogue             the columns, each flagged `pii`
> POST /exports | GET /exports | /exports/{id} | /exports/{id}/download
> ```
>
> Three deviations from the sketch above, each deliberate:
>
> - **The upload is a raw body, not multipart.** An import is one file and nothing else;
>   `@fastify/multipart` would add a dependency, a streaming-to-disk story and a second body-limit
>   setting to carry a payload with no other parts. The file's name travels as a query parameter,
>   where it is visible in the access log. Body limits are **per content type**, so
>   `application/json` keeps its 256 KiB while a CSV may have `UPLOAD_MAX_BYTES` — and an
>   `onRequest` hook refuses CSV content types outside these paths, because Fastify parses a body
>   before any guard runs.
> - **The dry run is two endpoints, not one.** `GET …/check` reads; `POST …/validate` is the step a
>   person takes. A screen that showed the report by POSTing re-ran a state transition on every
>   refresh.
> - **`errors.csv` and `download` bypass the response envelope** and set
>   `content-disposition: attachment` plus `x-content-type-options: nosniff` — a CSV wrapped in
>   `{ success, data }` is not a download, and a CSV a browser decides is HTML is a stored XSS
>   vector.

> **Amendment, 2026-10-06 (implementation).** Customers and conversion:
>
> ```
> POST /leads/{id}/convert           on the LEAD: a transition that produces a customer
> GET  /customers                    ?search= ?converted= ?deleted= ?cursor= ?sort= ?direction=
> POST /customers                    somebody who was never a lead
> GET  /customers/{id}               with its origin panel and its custom-field definitions
> GET  /customers/{id}/timeline      the union of the lead's history and the customer's
> PATCH /customers/{id}              blank clears a field; the display name is always derived
> DELETE /customers/{id}             soft, reversible
> POST /customers/{id}/restore
> ```
>
> Two conventions this step established for the whole API:
>
> - **A non-UUID `:id` is a 404, from a global pipe.** It used to reach Prisma and come back as a
>   **500** — on every `:id` route in the product. 404 rather than 400, because a malformed id and
>   another tenant's id must be indistinguishable from outside; 400 would make the shape of an id an
>   oracle. Registered globally rather than on seventy-two call sites, so a route added next week is
>   covered without anybody remembering.
> - **A `?flag=true` query parameter keeps `undefined` as `undefined`.** A query string carries
>   strings, and the earlier `z.enum(['true','false']).transform(v => v === 'true')` folded an absent
>   parameter to `false` — which is right for `deleted` and wrong for any three-way filter, where
>   absent means "both".

> **Amendment, 2026-10-06 (implementation).** Deals, line items and the product catalogue:
>
> ```
> GET   /deals                 ?search= ?leadId= ?customerId= ?ownerUserId= ?pipelineId=
>                              ?stageId= ?outcome=open|won|lost|any ?closingBefore= ?deleted=
>                              ?limit= ?cursor= ?sort=created_at|updated_at|value|expected_close_date
>                              → meta.totalValueMinor is the WHOLE filter's value, not the page's
> GET   /deals/board           ?pipelineId= ?limit=  (per column; each column carries its own
>                              count, valueMinor and weightedMinor over the whole column)
> POST  /deals                 a lead, a customer, or both; items optional
> GET   /deals/{id}            with its items, its stage, its party and its custom-field definitions
> GET   /deals/{id}/timeline   ?limit= ?cursor=
> PATCH /deals/{id}            refuses valueMinor when the deal has items
> PUT   /deals/{id}/items      replaces the whole set and recomputes the header in one transaction
> POST  /deals/{id}/stage      { stageId, pipelineId? }
> POST  /deals/{id}/win        { wonAt?, note? }
> POST  /deals/{id}/lose       { lostReasonId?, lostAt?, note? }
> POST  /deals/{id}/reopen
> DELETE /deals/{id}           soft, reversible
> POST  /deals/{id}/restore
>
> GET    /products             ?search= ?category= ?active= ?limit= ?cursor=
> POST   /products             settings:manage — a price list is configuration
> GET    /products/{id}
> PATCH  /products/{id}        settings:manage
> DELETE /products/{id}        settings:manage; refused once the product has been sold
>
> GET    /crm-config/pipelines ?entityType=deal   (the same resource, a second entity type)
> ```
>
> Three conventions this step establishes:
>
> - **Money crosses the wire as integer minor units, and only as minor units.** `valueMinor`,
>   `unitPriceMinor`, `discountMinor`, `taxMinor`, `priceMinor`. The only place a rupee becomes paise
>   is the screen a person types into; a JSON number of rupees would reintroduce the floating-point
>   problem that [ADR-0018](./decisions/ADR-0018-money-arithmetic-in-one-place.md) exists to remove.
>   `quantity` is the one fractional field, three decimal places.
> - **A per-line validation failure is reported at its line.** `items.2.quantity`, not one sentence
>   about "a line item" — a twelve-line quotation has to say which line is wrong.
> - **A list whose rows carry money reports the set's total in `meta`.** The envelope merges a
>   handler's `meta` (it discards any other sibling of `items`), which is what makes a figure about
>   the whole filter expressible at all. A screen that sums the page it was given misreports the
>   pipeline by whatever fraction the page is.

> **Amendment, 2026-10-06 (implementation).** Quotations, their versions, their PDFs and the number
> series:
>
> ```
> GET    /quotations              ?dealId= ?leadId= ?customerId= ?ownerUserId= ?number=
>                                 ?status=draft|sent|accepted|rejected|expired
>                                 ?versions=current|all  (current is the default)
>                                 ?deleted= ?limit= ?cursor= ?sort=created_at|total|valid_until
>                                 → meta.totalMinor is the WHOLE filter's value
> POST   /quotations              { dealId | leadId | customerId, title?, terms?, validUntil?,
>                                   items? }  — omitting items copies the deal's lines
> GET    /quotations/{id}         with its lines and every version of its number
> GET    /quotations/{id}/pdf     the document itself; `inline`, not an envelope
> PATCH  /quotations/{id}         draft only
> PUT    /quotations/{id}/items   draft only; replaces the set and recomputes the header
> POST   /quotations/{id}/send    { via: email|whatsapp|link|manual, to?, sentAt? } — freezes it
> POST   /quotations/{id}/accept  { note? } — writes the figure onto the deal if it is still open
> POST   /quotations/{id}/reject  { reasonId?, note? } — the tenant's own lost_reasons
> POST   /quotations/{id}/revise  { items?, title?, terms?, validUntil? } → 201, a new version
> DELETE /quotations/{id}         draft only; a sent quotation has left the building
>
> GET    /settings/number-series/quotation      settings:manage
> PATCH  /settings/number-series/quotation      { prefix, padding, nextValue? } — forward only
> ```
>
> Three conventions this step establishes:
>
> - **A lifecycle move is a POST to its own path, never a `status` field on a PATCH.** Each has its
>   own preconditions, its own timeline entries on two subjects and its own event; a general PATCH
>   that happened to carry `status` could check none of them. The same reason a lead's status move
>   is a POST.
> - **`send`, `accept` and `reject` are idempotent on the state they produce.** A second `accept`
>   answers 200 with the same record rather than refusing, because a double-click must not produce
>   a different answer. A move from the _wrong_ state is a 422 that says what to do instead.
> - **A refusal's sentence is part of the contract.** The web app now prefers the API's own message
>   for `BUSINESS_RULE_VIOLATION`, `CONFLICT`, `VALIDATION_FAILED` and `NOT_FOUND` and keeps its own
>   copy only for session and access codes — so "The counter is already at 3. It can be moved
>   forward, but not back" reaches the screen instead of "That is not allowed." Write these messages
>   as the thing a person should read.

> **Amendment, 2026-10-06 (implementation).** Payments, and the methods a workspace accepts:
>
> ```
> GET    /payments                 ?dealId= ?quotationId= ?leadId= ?customerId= ?methodId=
>                                  ?status=pending|succeeded|failed|refunded
>                                  ?receivedFrom= ?receivedTo= ?deleted= ?limit= ?cursor=
>                                  ?sort=paid_at|amount|created_at ?direction=
>                                  → meta.totalMinor is the filter's sum;
>                                    meta.receivedMinor is the succeeded sum
> POST   /payments                 { dealId | quotationId | leadId | customerId, amountMinor,
>                                    methodId?, reference?, status=succeeded|pending, paidAt?, note? }
> GET    /payments/{id}
> PATCH  /payments/{id}            corrects an amount, method or reference — never the status
> POST   /payments/{id}/confirm    pending → succeeded (the cheque cleared)
> POST   /payments/{id}/fail       pending → failed (it bounced); clears paidAt
> POST   /payments/{id}/refund     succeeded → refunded; keeps paidAt
> DELETE /payments/{id}            soft; leaves every total, keeps the row
>
> GET    /settings/payment-methods ?includeInactive=true   payment:read
> POST   /settings/payment-methods settings:manage
> PATCH  /settings/payment-methods/{id}
> DELETE /settings/payment-methods/{id}   refused once the method has been used
> ```
>
> `deals` gained `paidMinor` and `outstandingMinor` on every response; `customers` gained
> `lifetimeValueMinor`, `firstPurchaseAt` and `lastPurchaseAt`. All four are derived from the ledger
> ([ADR-0020](./decisions/ADR-0020-derived-money-is-recomputed.md)).
>
> Three conventions this step establishes:
>
> - **A list whose rows carry money reports two totals.** The filter's sum answers "what is on this
>   list"; a second figure answers "how much of it is real". A payments screen showing only the first
>   would count a bounced cheque as revenue.
> - **A new permission ships with a data migration that grants it.** The permission catalogue is
>   read when a workspace is **created**, so a new key reaches new workspaces and nothing else —
>   `payment:read` answered 403 for the owner of a seeded workspace. The migration inserts the grant
>   for roles still marked `is_system`, with the scope the template specifies, only where it is
>   absent. Grants are then cached for five minutes, which is the rest of the answer.
> - **A per-tenant list that gates another field belongs under `settings/`, readable with the
>   feature's read permission.** `payment:read` can list the methods so a form can offer the
>   dropdown; `settings:manage` is needed to change them. The same split a price list uses.

> **Amendment, 2026-10-06 (implementation).** Industry templates (`FR-ONB-2`):
>
> ```
> GET  /organization/industry-templates   organization:read, allowed in restricted mode
>                                         → ten summaries: name, description, how many statuses,
>                                           stages, sources and fields each installs, the field
>                                           labels, and which one this workspace applied
> POST /organization/industry-template    organization:manage, allowed in restricted mode
>                                         { key } — REPLACES the statuses, lead pipeline stages,
>                                         sources, lost reasons, tags and custom fields;
>                                         422 once the workspace holds a lead, customer, deal or
>                                         quotation, naming what it found
> ```
>
> Two conventions this step establishes:
>
> - **Onboarding routes are allowed in restricted mode.** A tenant whose trial lapsed mid-setup must
>   still be able to finish setting up; blocking the wizard traps them on a screen with no way out.
> - **The wizard's steps belong to the frontend, so the API never advances them.** Applying a
>   template is one server action calling two endpoints — the template, then `PATCH
organization/onboarding` — and it advances the step **only if the template landed**. An API that
>   advanced the wizard would be deciding what the steps are, which `PATCH
organization/onboarding` deliberately does not.

### Automation, websites, analytics, marketing

```
CRUD /workflows | /workflows/{id}/versions | /steps
POST /workflows/{id}/{publish|activate|deactivate|kill}   POST /workflows/{id}/test-run
GET  /workflows/{id}/runs   GET /automation-runs/{id}   POST /automation-runs/{id}/retry
GET  /automation/registry                 available triggers/conditions/actions + JSON schemas
CRUD /websites | /websites/{id}/pages | /domains
POST /websites/{id}/{publish|rollback}    GET /websites/{id}/versions
GET  /analytics/overview | /funnel | /sources | /pages | /events   (rollup-backed, date range)
GET  /analytics/realtime                  last 30 min, Redis-backed
CRUD /campaigns | /ad-accounts            POST /ad-accounts/{id}/sync
GET  /marketing/performance               spend→leads→customers→revenue, ?model=first_touch
GET/PATCH /attribution-settings
CRUD /segments  POST /segments/{id}/recompute
CRUD /seo/keywords  GET /seo/rankings
```

> **Amendment, 2026-10-25 (implementation, Phase 6 step 1).** The registry, workflows, versions and
> publish are built, all behind `automation:manage`. The paths differ from the sketch above and the
> differences are decisions, not drift:
>
> | Built                                      | Sketched                      | Why                                                                                          |
> | ------------------------------------------ | ----------------------------- | -------------------------------------------------------------------------------------------- |
> | `GET /automation/catalogue`                | `GET /automation/registry`    | It is what the editor renders from, not a list of what exists                                 |
> | `/automation/workflows…`                   | `/workflows…`                 | One prefix for the module, beside `/automation/catalogue`                                     |
> | `PUT /automation/workflows/{id}/definition` | `CRUD /steps`                 | A graph is edited as one thing; a `PATCH` on part of a tree is a merge nobody can predict      |
> | `PATCH /automation/workflows/{id}`          | `POST .../{activate\|deactivate\|kill}` | Status and the kill switch are fields, so there is one writer and one audit trail             |
>
> - **`GET /automation/catalogue`** answers the triggers, condition fields, actions, operators,
>   reference kinds **with the endpoint behind each one**, the statuses, the re-entry policies and
>   the step limits. The source paths are in the response because a declaration the screen cannot
>   act on is half a feature: the picker would render and be empty, which looks exactly like a
>   workspace with no statuses. `automation.e2e-spec.ts` calls every one of them.
> - **`PUT :id/definition` saves an incomplete draft** and answers the problem list beside it;
>   `POST :id/publish` is where that list becomes a **400** with the problems as field errors
>   (`[{ field, code, message }]`). A validation refusal is 400; the 422s here are the business
>   rules — "nothing to publish", "publish it before switching it on", "that workflow is archived".
> - **`POST :id/publish`** stamps the draft, points the workflow at it, and rewrites the dispatch
>   index in the same transaction. A workflow published for the first time becomes `active`; a
>   **paused** one stays paused, because publishing is not a way to restart something somebody
>   deliberately stopped.
> - **`GET :id/versions/{versionId}`** is how a run's pinned version stays readable after the
>   workflow has moved on (`FR-AUT-5`).
> - `/workflows/{id}/runs`, `/automation-runs/{id}`, `POST :id/test-run` and
>   `POST :id/{retry|kill}` remain unbuilt: there is no executor yet.
>
> **Amendment, 2026-10-26 (implementation, Phase 6 step 2).** The engine is built, and with it:
>
> | Built                                      | Sketched                           | Why                                                                                     |
> | ------------------------------------------ | ---------------------------------- | --------------------------------------------------------------------------------------- |
> | `GET /automation/runs?leadId=&workflowId=` | `GET /workflows/{id}/runs`         | One list, filtered — the per-lead read is the one that matters and deserves no second route |
> | `GET /automation/runs/{id}`                | `GET /automation-runs/{id}`        | One prefix for the module                                                                |
> | `POST /automation/workflows/{id}/start`    | (the `manual` trigger had no door) | A person starting a workflow on one lead, through the same guards an event goes through  |
>
> All three behind `automation:manage` rather than `lead:read`: a run's step log carries the
> parameters a workflow was configured with, which is workspace configuration rather than a fact
> about the lead. What somebody with `lead:read` reads is the **timeline**, where every automation
> decision lands with its reason (`FR-AUT-7`).
>
> `POST :id/start` answers **202**: the first step may send a WhatsApp template, and a button must
> not wait for a provider. It is not a way around the guardrails — the re-entry policy, the daily
> cap and the loop ceiling all apply, because it goes through the same dispatcher.
>
> Still unbuilt, and named rather than implied: `POST :id/test-run` (a dry run) and
> `POST /automation/runs/{id}/retry` (retry from the failed step). `automation_run_steps.attempt`
> exists for the second one.


### Dashboards, billing, notifications

```
GET  /dashboard/{owner|manager|executive|marketing|whatsapp}   role-shaped, cached
GET  /reports/{leads|sources|campaigns|users|pipeline|sla|conversion}  + ?format=csv (→ export job)
GET  /billing/subscription | /plans | /invoices | /usage | /entitlements
POST /billing/{upgrade|downgrade|cancel|reactivate}
CRUD /service-subscriptions
GET  /notifications  POST /notifications/{id}/read  POST /notifications/read-all
GET/PATCH /notification-preferences
GET  /search?q=                           global search (FR-VIEW-1)
GET/POST /privacy/{consents|suppressions|dsr-requests|retention-policies}
POST /ai/{summarize-lead|summarize-conversation|suggest-reply|next-best-action}   (optional layer)
```

> **Amendment, 2026-10-13 (implementation, Phase 3 step 4).** The notification preference routes are
> built, at `/notifications/preferences` rather than `/notification-preferences`: they are the
> settings behind the inbox and belong beside it, and a second top-level noun for the same subject
> is a second place to look.
>
> - **`GET /notifications/preferences`** returns the person's quiet window, the zone it is read in
>   (and the workspace's, so a screen can say which it is falling back to), the channels that can
>   actually be delivered today, and every notification type the product sends — each with its
>   label, its sentence, whether it can be switched off, and both the stored and the effective
>   channel list. `channels: null` means "never touched", which is how the screen can say "default"
>   rather than inventing a state.
> - **`PATCH`, not `PUT`.** An absent key means "unchanged", `quietHours: null` clears the window.
>   A whole-screen `PUT` would let a tab open on the quiet-hours half overwrite a type somebody
>   switched off on their phone five minutes earlier.
> - **Neither route takes a permission**, and both are scoped to the caller. There is deliberately
>   no route by which a manager reads or writes somebody else's: a preference somebody else can
>   change is not a preference. The generated route-authorization suite lists the `PATCH` among its
>   reviewed self-scoped writes — which is how it caught the route on the commit that added it.
> - **Refusals are sentences.** A window whose ends are equal ("never quiet" or "always quiet"?), a
>   time that is not one (`9:00`, `24:00`, `21:60`), a zone the runtime does not know, a type the
>   product does not send, a channel nothing can deliver on, and switching off a notice `FR-NOT-3`
>   exempts — each is refused with the reason, not with a constraint name.
>
> Only `in_app` is deliverable. `digest` is **not** implemented: a digest is an email feature, and a
> daily summary of an inbox somebody is already looking at is not one.
>
> There is no endpoint that holds or releases a notification. Holding is decided inside
> `NotificationsService.create`, which every producer already goes through, and releasing is the
> per-minute `notifications.release` sweep — see
> [ADR-0025](./decisions/ADR-0025-quiet-hours-hold-a-notification-and-the-release-re-checks-it.md).

> **Amendment, 2026-10-13 (implementation, Phase 3 step 5).** The manager's dashboard is built as
> **`GET /oversight`**, not as `GET /dashboard/manager`. A path named after a role is what rule 4
> forbids — roles are rows a tenant edits — and the breadth of the answer is already a predicate
> `DataScopeService` owns: `report:read` at branch scope answers for a branch and at organization
> scope for the workspace, from the same route. The arrangement `/sla/board` settled in step 2.
>
> `GET /dashboard/{owner|executive|marketing|whatsapp}` remain unbuilt. `/today` is the executive's
> and arrived in step 3; the marketing and WhatsApp ones arrive with their modules. The owner's is
> the same question as the manager's with a wider scope, which this route already answers.
>
> - **`?days=` takes 7, 30 or 90 and nothing else.** A period _is_ a question a manager asks, unlike
>   anything on `/my/today` — but every figure is a live aggregate, and an arbitrary range is how
>   somebody asks for two years of aggregation by accident. Free ranges arrive with the rollups.
> - **One response**: the backlog nobody owns, the promises over the period, and a row per person in
>   scope. The people come from the **member list**, so somebody who has been given nothing is a row
>   of zeroes rather than an absence.
> - **A rate computed from nothing is `null`**, not 0 and not 100 — the screen shows "—". And the
>   response-time figure is a **median** (`percentile_cont`, the one piece of raw SQL in the module),
>   because one answer three days late drags a mean across a team into uselessness.
> - **`report:read` was already in the catalogue and already granted** to the manager,
>   marketing-manager and auditor templates, so this route needed no permission and no data
>   migration — worth saying, because every previous step that added one needed both.
>
> `GET /tasks` and `GET /sla/board` already took `assignedUserId`; the **web** pages for both now
> read it too, because every number on the oversight screen has to click through to the rows behind
> it. Decisions in
> [ADR-0026](./decisions/ADR-0026-oversight-has-no-single-score.md).

### Platform admin (`/api/admin/v1`)

```
GET  /dashboard                              FR-SA-2 cards + charts
CRUD /organizations                          + /{id}/{suspend|activate|extend-trial|change-plan|impersonate}
CRUD /plans | /features | /coupons | /industry-templates | /website-templates | /service-packages
GET  /organizations/{id}/{usage|health|audit-logs|integrations}
GET  /system/{health|queues|failed-jobs|webhook-health|integration-health|api-usage|storage}
POST /system/failed-jobs/{id}/retry          POST /system/queues/{name}/{pause|resume}
CRUD /platform-settings | /feature-flags | /notification-templates
CRUD /support-tickets
GET  /platform/metrics                       MRR/ARR/churn/trial-conversion series
GET  /platform/audit-logs | /impersonation-logs
```

---

## 6. Public ingestion API

```http
POST /api/public/v1/leads/{organizationPublicKey}
Content-Type: application/json
X-Api-Key: pk_live_7f3c…                     # required for server-to-server
X-Signature: t=1759000000,v1=9f86d0…         # HMAC-SHA256 over "t.rawBody" with the secret
Idempotency-Key: website-form-8f21a4         # optional but recommended
```

```json
{
  "name": "John",
  "phone": "9999999999",
  "email": "john@example.com",
  "source": "website",
  "formSlug": "contact-us",
  "customFields": { "budget": "5000000", "propertyType": "Apartment" },
  "utm": { "source": "google", "medium": "cpc", "campaign": "summer-sale", "gclid": "Cj0KC…" },
  "pageUrl": "https://client.com/contact",
  "referrer": "https://google.com",
  "visitorId": "v_01J8…",
  "consent": { "whatsapp": true, "text": "I agree to be contacted on WhatsApp" },
  "metadata": { "anythingElse": "is kept in raw payload" }
}
```

```json
{
  "success": true,
  "data": {
    "leadId": "01J8…",
    "status": "created",
    "duplicateOf": null,
    "assignedTo": { "id": "01J8…", "name": "Rahul" }
  },
  "message": "Lead received"
}
```

Behaviour: `201` created · `200` with `status: "duplicate_attached"` and the existing lead id when a
duplicate rule matched · `202` when validation passed but downstream processing is queued ·
`400 VALIDATION_FAILED` with per-field details · `401 INVALID_API_KEY` · `403 ORG_SUSPENDED` ·
`429 RATE_LIMITED` · `409 IDEMPOTENT_REPLAY_MISMATCH`.

Guarantees: **the raw body is persisted before any processing**, so a 5xx never means a lost lead;
unknown fields never cause a rejection (`FR-CAP-5`); `name` is split into first/last when
`firstName`/`lastName` are absent; phone is normalized to E.164 using the org's default country;
browser-origin calls use the public key without HMAC but are restricted to an origin allowlist,
rate-limited per IP + per key, honeypot/CAPTCHA-aware.

Other public endpoints: `POST /api/public/v1/forms/{formSlug}/submit`,
`GET /api/public/v1/forms/{formSlug}/schema` (renders dynamic fields client-side),
`POST /api/public/v1/events` (tracker fallback), `GET /api/public/v1/health`.

> **Amendment, 2026-10-14 (implementation, Phase 4 step 1 — capture forms).** The two form
> endpoints are built, with three changes
> ([ADR-0029](./decisions/ADR-0029-a-public-form-is-identified-by-its-own-key.md)):
>
> - **They live under `/api/v1/public/forms/{key}`, not `/api/public/v1/...`.** One prefix, one
>   envelope, one exception filter, one route-authorization sweep — and the sweep is what keeps a
>   public write honest. A second mount point would be a second set of all of those, and the first
>   thing to drift would be the error shape. `/api/public/v1` remains the plan for the
>   server-to-server ingestion API, whose authentication (HMAC) and rate limits really are
>   different; this amendment is not a decision about that.
> - **The identifier is a random `public_key`, not the form's slug.** A slug is unique per
>   workspace, so `/forms/contact-us` would belong to every workspace that chose that name. The key
>   is 32 characters, globally unique and rotatable, and it is the authentication as well as the
>   tenant resolution.
> - **`GET /…/{key}` _is_ the schema endpoint**, and answers only what a renderer needs: the
>   business's name, the form's own copy, and the fields with their labels, kinds, options and
>   steps. No ids, no counts, nothing about the pipeline, the source or the assignment rule — this
>   response is readable by anybody with the URL, and an e2e assertion fails if any of those
>   appears in it. `POST /…/{key}/submissions` is the submit, named for the thing it creates.
>
> The workspace-side CRUD is as sketched, with `PUT /forms/{id}/fields` replacing the whole ordered
> set in one call rather than per-field writes (a builder edits a list), `POST /forms/{id}/rotate-key`
> for a URL that has to be revoked, and **no** `GET /forms/{id}/embed-code`: the snippet is one
> `<iframe>` line built from the key, so an endpoint for it would be a round trip to assemble a
> string the client already has. `GET /forms/submissions?formId=` is top-level and filtered, like
> calls and tasks before it, because the refusals are read across forms.

> **Amendment, 2026-10-14 (implementation, Phase 4 step 2 — the public lead API).** The endpoint in
> §6 is built, at `POST /api/v1/public/leads/{organizationPublicKey}` — the same prefix decision the
> form endpoints took, for the same reason: one envelope, one exception filter, one
> route-authorization sweep. Everything else in §6 holds, with three clarifications
> ([ADR-0030](./decisions/ADR-0030-the-public-lead-api-verifies-a-signature-and-never-loses-a-payload.md)):
>
> - **The signature is required, not optional.** §6 marked `X-Api-Key` "required for
>   server-to-server" and left the signature implicit; both are required here, and every way a
>   signature can be wrong — absent, malformed, outside the five-minute window, over a modified
>   body, from the wrong secret — answers `401` with a message that says what to send. The
>   browser-origin case §6 describes (public key, no HMAC, origin allowlist) is served by the
>   **form** endpoints from step 1, which is where a browser belongs.
> - **`status` is `created` | `duplicate_attached` | `replayed`**, with `201` for the first and
>   `200` for the other two. `replayed` is the one §6 did not name: a client that retried is owed
>   the answer it missed, including the lead id, rather than being told "duplicate". A replay of the
>   same key with a different body is `409 IDEMPOTENT_REPLAY_MISMATCH`, as §6 promised.
> - **`202` is not used.** §6 reserved it for "validation passed but processing is queued"; the
>   capture is synchronous, so a `202` would be a lie about work that has already happened. The
>   never-lose store plus `POST /ingestion/payloads/:id/replay` is what covers a crash instead.
>
> The operator's half is built as sketched: `GET /ingestion/payloads`, `/ingestion/errors`,
> `POST /ingestion/errors`-adjacent replay as `POST /ingestion/payloads/{id}/replay` (the payload is
> the unit a person replays, not the error), the self-serve test tool as `POST /ingestion/test`
> (a POST that answers **200**, because it persists nothing), and `GET /ingestion/unmapped` for
> `FR-CAP-5`'s surfacing. All of it behind `api_key:manage`. `GET /api-logs` arrived with the
> authenticated REST surface in step 4, which is the first thing with a request volume worth logging
> per endpoint — and it logs this endpoint too, under `surface: public_ingest`.
>
> **The dry run answers a verdict, not only a preview.** `POST /ingestion/test` returns
> `wouldCreate`, `normalized` (including `phone` as it would be **stored** and `phoneAsSent` beside
> it), `unmappedFields` and `notes`. The normalize step is genuinely performed, through the same
> `normalizeContactNumbers` and `buildDisplayName` the write path uses — §6's sketch said "each
> step's decision", and a preview that re-checked the schema instead would be the import's
> dry-run lie in a new place. The duplicate verdict and the chosen assignee are **not** answered:
> both depend on rows this call deliberately does not create, and the honest ones would require
> running the duplicate rules and the assignment engine against a lead that does not exist. That
> remains sketched rather than built, and is named here rather than implied.
>
> **`GET /ingestion/unmapped` is counted over the stored payloads**, not from a column maintained
> beside them, and each field carries up to three sample values with `meta.payloadsScanned` saying
> what the count is over. The web app's one click then calls `POST /custom-fields` — there is no
> second creation endpoint for a field, and the mapper matches an integration's top-level key
> through the same derivation the button fills its key box with, so the field somebody makes is the
> field the next payload fills in.

**Test tooling per tenant (`FR-CAP-6`):** `POST /api/v1/ingestion/test` replays a sample payload
against the live pipeline in dry-run mode and returns each step's decision (normalized values,
duplicate verdict, chosen assignee, created follow-up) without persisting — the "why did my lead
not appear" answer, self-serve. _(As built: the normalized values, the unmapped fields, the notes
and a `wouldCreate` verdict. The duplicate verdict and the assignee are not answered — see the
amendment above.)_

---

## 7. Inbound webhooks (collector)

| Route                                          | Provider          | Verification                                                 |
| ---------------------------------------------- | ----------------- | ------------------------------------------------------------ |
| `GET /wh/whatsapp/{connectionId}`              | Meta              | `hub.verify_token` echo challenge                            |
| `POST /wh/whatsapp/{connectionId}`             | Meta              | `X-Hub-Signature-256` HMAC over the **raw** body (`FR-WA-6`) |
| `POST /wh/meta-leadgen/{connectionId}`         | Meta Lead Ads     | Same; then fetch the lead by `leadgen_id`                    |
| `POST /wh/google-ads/{connectionId}`           | Google lead forms | Shared-secret in payload + allowlist                         |
| `POST /wh/payments/{provider}/{connectionId}`  | Razorpay/Stripe   | Provider signature scheme                                    |
| `POST /wh/telephony/{provider}/{connectionId}` | Telephony         | Provider signature                                           |

Uniform handling: parse raw body → verify signature (constant-time) → resolve tenant from the path's
connection id **and** cross-check the payload's account id → insert `provider_events`
(`UNIQUE org+provider+external_event_id`) → enqueue → `200` in < 1 s. Unknown event types are
persisted and acknowledged, never 4xx'd (providers disable endpoints that error). Signature failures
return `401` and are counted per connection with alerting on spikes.

> **Amendment, 2026-10-14 (implementation, Phase 3 step 7).** The first inbound webhook is built,
> and it is **not** under `/wh/{provider}/{connectionId}`. There is no connection id because there
> is no per-tenant connection: email sends from one platform account, and a bounce is a fact about a
> mailbox rather than about a workspace
> ([ADR-0028](./decisions/ADR-0028-email-sits-behind-a-port-and-a-bounce-is-a-fact-about-a-mailbox.md)).
>
> | Route                         | Provider | Verification                      |
> | ----------------------------- | -------- | --------------------------------- |
> | `POST /api/v1/webhooks/email` | Postmark | `x-webhook-secret`, constant-time |
>
> - **`@Public()`, and declared**: a provider has no session, and a route that forgot to say so
>   fails at boot. It is the one public write outside `/auth`, listed in the route-authorization
>   suite's reviewed set so a second one cannot appear silently.
> - **A shared secret, not an HMAC**, because Postmark does not sign its webhooks — it offers basic
>   auth on the URL instead. `EMAIL_WEBHOOK_SECRET` is **required by the configuration schema** the
>   moment a real driver is set, so there is no deployment in which this is both reachable and
>   unauthenticated. It matters more here than the table above suggests: this endpoint is the only
>   writer of the suppression list, and an open one lets anybody stop a workspace's mail.
> - **A failure is `404`, not `401`.** An endpoint that distinguishes a missing secret from a wrong
>   one is an oracle for guessing it.
> - **Unknown events are acknowledged with `200`** and a count, exactly as the paragraph above
>   requires: an open, a click, or a record type a later release adds is not an error, and a 4xx
>   teaches a provider to disable the endpoint — which would silently stop the suppression list
>   being filled.
> - **No `provider_events` table yet.** Its job here is idempotency, and `email_messages` already
>   carries a partial unique index on `(provider, provider_message_id)` that does it; a second
>   store before a second provider exists would be two records of one fact. It arrives with the
>   integration framework in Phase 4, which is where connection ids come from.

> **Amendment, 2026-10-19 (implementation, Phase 5 step 1).** WhatsApp Cloud's two routes are built,
> and they are the integration framework's own door rather than a pair of their own:
>
> | Route                                     | Provider | Verification                                        |
> | ----------------------------------------- | -------- | --------------------------------------------------- |
> | `GET /api/v1/wh/whatsapp_cloud/{id}`      | Meta     | `hub.verify_token`, answered as **plain text**      |
> | `POST /api/v1/wh/whatsapp_cloud/{id}`     | Meta     | `X-Hub-Signature-256` over the raw body (`FR-WA-6`) |
>
> - **`whatsapp_cloud`, not `whatsapp`**: the path segment is the registry's provider key, so the
>   door is the one every provider uses and a new provider needs no route.
> - **The challenge is answered outside the envelope.** Meta compares the response body to the
>   challenge it sent, so `{"success":true,"data":"1158…"}` would never confirm the subscription.
>   A mismatched verify token answers **403** rather than 404: the connection exists, and a 404
>   sends somebody checking a URL they pasted correctly.
> - **A delivery that names no event of ours is acknowledged**, not refused. WhatsApp posts status
>   receipts about messages we sent and `page` changes nobody subscribed to; a 4xx teaches Meta to
>   disable the endpoint, which stops the deliveries we do want. Which answer a provider gets is
>   decided by its declared `deliveryShape` (`events` | `single_lead` | `none`) rather than by a
>   near-synonym — see the amendment in §4 of `integration-architecture.md`.
> - **The ledger row is written before the work, and `200` is answered before it is done.** A
>   provider that waits for us is a provider that retries. `provider_events` holds the whole
>   delivery; one job is queued per message, keyed on the ledger row's id.

> **Amendment, 2026-10-19 (implementation, Phase 4 step 6 — the integration framework).** The
> `/wh/{provider}/{connectionId}` shape above is now built, with one route and one provider
> ([ADR-0034](./decisions/ADR-0034-a-provider-is-a-registry-entry-and-an-adapter.md)):
>
> | Route                                          | Provider          | Verification                                              |
> | ---------------------------------------------- | ----------------- | --------------------------------------------------------- |
> | `POST /api/v1/wh/generic_webhook/{connectionId}` | Any sender      | `X-Signature: t=…,v1=…` HMAC over the **raw** body, ±5 min |
>
> - **The signature is the whole authentication**, with the secret this workspace generated and was
>   shown once. It is the same construction, the same five-minute window, the same
>   `verifySignature`, and the same refusal sentences as the public lead API (ADR-0030), so an
>   integrator who has wired one has wired the other and reads the same explanation when it is
>   wrong. The connection id in the path is **not** a credential: an unsigned request is a 401
>   whatever id it carries.
> - **The tenant is resolved from the path's connection id**, as the paragraph above requires, and
>   the "cross-check the payload's account id" half does not apply to a provider that sends no
>   account id. The provider segment is part of the lookup rather than decoration: a request posted
>   to the right id under the wrong provider's path answers 404.
> - **A wrong id, a disconnected connection and a provider with no inbound door all answer the same
>   404.** The shape of an id must not become an oracle, which is the rule `UuidParamPipe` exists
>   for.
> - **`201` for a new lead, `200` for a duplicate or a replay**, as §6 promises for the public
>   endpoint, with `Idempotency-Key` honoured in **its own** key space: the same key sent to both
>   doors is two requests, not a replay of one.
> - **Still no `provider_events`.** The idempotency here is `inbound_payloads` and
>   `idempotency_keys`, which `FR-API-5` already specifies and which this door reuses by going
>   through `IngestionService.capture`. `provider_events` is the ledger for a provider that sends
>   its **own** event ids; this one does not, and the two ad connectors will.
> - **The body has no schema**, deliberately: the mapping is what turns `Full Name` into
>   `firstName`, so a schema here would be the feature's opposite. The mapped result is then parsed
>   by `publicLeadSchema` inside the capture pipeline, and a value it refuses is a `400` naming the
>   field with an `ingestion_errors` row at the `validate` stage.

> **Amendment, 2026-10-19 (implementation, Phase 4 step 7 — Meta Lead Ads and Google Ads lead
> forms).** Two more providers, and the first `GET` on this surface:
>
> | Route                                               | Provider          | Verification                                                         |
> | --------------------------------------------------- | ----------------- | -------------------------------------------------------------------- |
> | `GET  /api/v1/wh/meta_lead_ads/{connectionId}`       | Meta Lead Ads     | `hub.verify_token` echo, constant-time, against the connection's own |
> | `POST /api/v1/wh/meta_lead_ads/{connectionId}`       | Meta Lead Ads     | `X-Hub-Signature-256` HMAC over the **raw** body, with the app secret |
> | `POST /api/v1/wh/google_ads_leads/{connectionId}`    | Google lead forms | `google_key` **inside** the body, compared in constant time          |
>
> This is the table §7 sketched, built — and the three differences from the sketch are each the
> provider's doing rather than ours:
>
> - **The verification shape is a property of the provider**, declared in the registry
>   (`inboundVerification`) and reconciled against the adapter at boot. Google Ads does not sign
>   anything: it asks *you* for a webhook key and echoes it in the body, so a framework that had
>   assumed an HMAC header would have been reopened for it. One consequence worth stating: a Google
>   delivery is replayable by anybody who has ever seen one, and `provider_events`' unique on
>   Google's own `lead_id` is the only thing between a captured payload and a duplicate lead.
> - **`hub.verify_token` is answered as plain text**, outside the response envelope: Meta's verifier
>   compares the body to the challenge it sent, and `{"success":true,"data":"1158201444"}` would
>   never confirm the subscription. A mismatch is **403**, not 404 — the connection exists and the
>   handshake was refused, and a 404 would send somebody checking a URL they pasted correctly.
> - **The cross-check of the payload's account id does not apply.** §7 asks for the tenant to be
>   resolved from the path **and** the payload's account id cross-checked; Meta's delivery carries a
>   `page_id` and Google's carries nothing of the sort, and a cross-check against a value the
>   provider only sometimes sends would be a check that passes by absence. What the path's id cannot
>   do on its own is authenticate: an unverified request is a 401 whatever id it carries.
>
> `provider_events` is now built and is the dedupe gate §7 names, with one addition the sketch does
> not have: the insert comes **before** the enqueue and its unique violation is the normal case, so
> a retried delivery is counted and answered 200 rather than raising anything. Unknown event types
> are dropped and acknowledged, exactly as the paragraph above requires — Meta sends `page` changes
> nobody subscribed to, and a 4xx teaches a provider to disable the endpoint.

---

## 8. Outbound webhooks

```http
POST https://customer.example.com/hooks/leados
X-LeadOS-Event: lead.created
X-LeadOS-Event-Id: evt_01J8…
X-LeadOS-Delivery-Id: dlv_01J8…
X-LeadOS-Timestamp: 1759000000
X-LeadOS-Signature: v1=5d41402abc4b2a76…       # HMAC-SHA256("{timestamp}.{rawBody}")
```

```json
{
  "id": "evt_01J8…",
  "type": "lead.created",
  "occurredAt": "2026-09-27T10:30:00Z",
  "organizationId": "01J8…",
  "apiVersion": "v1",
  "data": { "lead": {} }
}
```

Events: `lead.created|updated|assigned|stage_changed|status_changed|converted|merged|deleted`,
`task.created|completed|rescheduled|overdue`, `conversation.created|assigned|closed`,
`message.received|sent|failed`, `deal.won|lost`, `payment.completed`, `form.submitted`,
`automation.failed`, `integration.failed`.

Delivery: at-least-once (consumers must dedupe on `X-LeadOS-Event-Id`); retries at
10 s, 1 m, 5 m, 30 m, 2 h, 6 h, 24 h with jitter; 10 s timeout; 2xx = success; 410 disables the
endpoint immediately; 15 consecutive failures auto-disables with an admin notification; full
delivery log with response status + truncated body and manual retry (`FR-API-4`).

> **Amendment, 2026-10-18 (implementation, Phase 4 step 3).** Built as specified above — the
> headers, the envelope, the schedule, the 10 s timeout, the 410 rule, the fifteen-failure
> auto-disable with its notification, the per-attempt log and the manual retry — with five things
> said plainly rather than left implied
> ([ADR-0031](./decisions/ADR-0031-an-outbound-webhook-is-retried-from-its-own-row-and-never-follows-a-redirect.md)).
>
> - **The event list is what the product emits**, not the list above. `conversation.*`,
>   `message.*`, `automation.failed` and `integration.failed` arrive with the phases that emit them;
>   there is no `payment.completed` (money arrives as `payment.received` and leaves as
>   `payment.refunded`) and no `form.submitted` (a form's capture _is_ a `lead.created`, through the
>   one ingestion path). `quotation.*`, `customer.*` and `call.logged` are offered and were not in
>   the sketch. `WEBHOOK_EVENT_TYPES` in `@leados/shared` is the list, and a spec asserts every type
>   in it has a fan-out subscription — a tick box for an event nothing fans out is an endpoint that
>   looks subscribed and receives nothing.
> - **`data` is the event's own payload, not a rendered resource.** A webhook says something
>   happened; the REST API is the single source of truth for what the thing looks like now — the
>   same argument §10 makes for realtime deltas. Embedding a full lead would also hand every
>   consumer a snapshot that was already stale when it was signed.
> - **A 3xx is not success and is never followed.** `redirect: 'manual'`: following one would send a
>   signed payload to an address the SSRF classification never saw.
> - **The URL is classified twice** — its text when it is saved, its resolved addresses before every
>   attempt, refusing if _any_ resolve into a private, loopback, link-local, CGNAT or multicast
>   range. A hostname that resolves publicly today can resolve to 127.0.0.1 tomorrow.
> - **Retries live in `webhook_deliveries.next_attempt_at`** and a one-minute sweep, not in the
>   queue: the schedule reaches 24 hours, and two retry mechanisms over one row would deliver the
>   same event three times per failure. With no worker running nothing is retried, which is the same
>   failure reminders and mail already have.
>
> The endpoints are as §5 lists them, plus two: `GET /webhooks/deliveries` (the whole workspace's
> recent log — the view somebody debugging opens before they know which endpoint is at fault) and
> `POST /webhooks/:id/test`, which sends a **real** signed delivery of a reserved `webhook.test`
> event rather than a simulated one. All behind `webhook:manage`.
>
> `POST /webhooks/email` (§7's inbound email webhook) keeps its path: it is a literal segment and
> every outbound route takes a UUID, which the global `UuidParamPipe` keeps unambiguous.

---

## 9. Rate limiting

Token buckets in Redis, evaluated most-specific-first; every response carries
`X-RateLimit-Limit/Remaining/Reset`.

| Scope                       | Default                                                                |
| --------------------------- | ---------------------------------------------------------------------- |
| Unauthenticated auth routes | 10/min per IP, 50/hour per IP, progressive lockout per account         |
| Authenticated user          | 300/min                                                                |
| API key                     | plan-based (e.g. 60/min starter → 600/min growth), overridable per key |
| Public ingestion per key    | 60/min, 5 000/day (plan-based)                                         |
| Public ingestion per IP     | 20/min (browser abuse guard)                                           |
| Collector beacons per site  | 600/min per visitor id, bot-filtered                                   |
| Exports / bulk / reports    | 5 concurrent jobs per org                                              |
| WhatsApp sends              | per phone number, provider-tier aligned (queue-level, not HTTP)        |

Limits are **entitlements**, stored per plan, overridable per org — never constants in code
(Rule 7). Exceeding a _plan_ quota returns `403 LIMIT_EXCEEDED` (a business condition); exceeding a
_burst_ limit returns `429 RATE_LIMITED` (a technical condition). The distinction matters to clients.

---

## 10. Realtime

Socket.IO, JWT handshake, Redis adapter for multi-node fanout. Rooms:
`org:{orgId}:user:{userId}` (notifications, task assignments),
`org:{orgId}:conversation:{id}` (messages, typing, read receipts, presence),
`org:{orgId}:inbox:{numberId}` (list-level: new conversation, unread deltas, assignment),
`org:{orgId}:leads` (kanban moves, coarse-grained).
Every room name is prefixed with the org id and membership is authorized on join — a socket can
never subscribe outside its organization. Payloads are deltas with ids; the client refetches through
the REST API for anything it does not already hold (single source of truth, no divergent shapes).
Disconnect/reconnect triggers a `since=<cursor>` catch-up call, so no event is silently missed.

---

## 11. OpenAPI & SDK

`@nestjs/swagger` decorators + Zod-to-JSON-Schema produce **OpenAPI 3.1** at build time; the spec is
committed as an artifact and diffed in CI — an unintended breaking change fails the build. Docs are
served at `/docs` (Scalar/Redoc) with copy-paste `curl`, JS and PHP examples per endpoint, a sandbox
tenant for "try it", and an errors page listing every code. A generated TypeScript client is
published to `packages/contracts` and consumed by the web app, so the frontend cannot drift from the
API (`FR-API-3`).

> **Amendment, 2026-10-19 (implementation, Phase 4 step 5).** Built, with three changes to the
> sketch above
> ([ADR-0033](./decisions/ADR-0033-the-published-contract-is-generated-from-the-validators-that-run.md)):
>
> - **No `@nestjs/swagger` decorators.** The document is generated from the **routing table** —
>   the same enumeration that fails startup when a route declares no authorization — and the
>   request and query schemas are read off each route's own `ZodBody` **pipes**. So every one of
>   the 289 routes is in the document whether or not anybody remembered it, and the schema a client
>   reads is the object that refuses its bad request. Annotating 289 routes by hand would be a
>   second description of every endpoint maintained beside the first, and the one that is wrong is
>   always the one nothing executes. The authorization model travels as extensions:
>   `x-leados-permission`, `x-leados-feature`, `x-leados-session-only`.
> - **`/docs` is rendered on the server — no Scalar, no Redoc, no CDN, no JavaScript.** A docs page
>   that needs an external request is blank on exactly the deployment whose operator most needs to
>   read it. `/docs/errors` lists every code with its status, what it means, what to do and whether
>   to retry, from `ERROR_CATALOGUE` — a `Record<ErrorCode, …>`, so a new code cannot be added
>   without describing it. Both pages and `/openapi.json` are **public** and sit outside the
>   version: a spec behind a credential is a spec nobody evaluating the product can read, and it
>   discloses nothing a caller could not learn by trying every path.
> - **The committed `docs/openapi.json` is the diff check, not the source.** The server always
>   builds the document from the live routing table; the artifact is what an integration test
>   compares against, and it fails with a **classified** diff — a removed operation, a changed
>   permission, a newly required field or plan feature, a route closed to keys are breaking; a new
>   path or optional parameter is additive. Regenerate with
>   `pnpm --filter @leados/api openapi:write`.
>
> The "try it" sandbox and the generated TypeScript client in `packages/contracts` are **not**
> built. A client generated from a document that changes with every release is a package to version,
> publish and consume, and the web app does not need one: it calls the API through its own typed
> loaders, with a spec reconciling its vocabulary against `@leados/shared`. Named as outstanding
> rather than quietly dropped.

---

## 12. Testing the API

Per endpoint, CI requires: a happy-path integration test against a real Postgres+Redis; a validation
test; a permission test (allowed role passes, disallowed role 403); a **tenancy test** (Org B token on
Org A resource ⇒ 404/403, empty body); a pagination test (no unbounded response); and, for mutations,
an idempotency/replay test. The tenancy suite is generated from the OpenAPI document so a new route
without a test is a build failure (`NFR-SEC-1`, `NFR-MNT-3`).
