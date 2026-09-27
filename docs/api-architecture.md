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
GET  /tasks                                  ?bucket=due_now|today|overdue|upcoming|completed
GET  /tasks/summary                          the Today counters (FR-TSK-7)
CRUD /tasks
POST /tasks/{id}/complete                    { outcomeId?, note?, nextFollowUp? }
POST /tasks/{id}/reschedule                  { dueAt, reasonId, note? }   ← reason REQUIRED
POST /tasks/{id}/cancel
GET  /my/today                               executive workspace payload in ONE request
GET  /my/leads | /my/conversations
GET  /sla/board                              at-risk + breached (manager)  `sla:read`
```

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

### Capture, integrations, developer platform

```
CRUD /forms | /forms/{id}/fields    GET /forms/{id}/embed-code
GET  /forms/{id}/submissions
CRUD /api-keys                      POST /api-keys/{id}/rotate | /revoke
GET  /api-logs                      GET /ingestion/payloads | /ingestion/errors
POST /ingestion/errors/{id}/replay
CRUD /webhooks (endpoints)          POST /webhooks/{id}/test
GET  /webhooks/{id}/deliveries      POST /webhooks/deliveries/{id}/retry
CRUD /integrations                  POST /integrations/{provider}/connect | /disconnect | /test
GET  /integrations/health
CRUD /imports (upload → map → validate → run)  GET /imports/{id} | /imports/{id}/errors.csv
POST /exports                       GET /exports/{id}
```

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

**Test tooling per tenant (`FR-CAP-6`):** `POST /api/v1/ingestion/test` replays a sample payload
against the live pipeline in dry-run mode and returns each step's decision (normalized values,
duplicate verdict, chosen assignee, created follow-up) without persisting — the "why did my lead
not appear" answer, self-serve.

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

---

## 12. Testing the API

Per endpoint, CI requires: a happy-path integration test against a real Postgres+Redis; a validation
test; a permission test (allowed role passes, disallowed role 403); a **tenancy test** (Org B token on
Org A resource ⇒ 404/403, empty body); a pagination test (no unbounded response); and, for mutations,
an idempotency/replay test. The tenancy suite is generated from the OpenAPI document so a new route
without a test is a build failure (`NFR-SEC-1`, `NFR-MNT-3`).
