# Security & Privacy Architecture — Lead OS

Traces to: `NFR-SEC-*`, `FR-TEN-3/4/7`, `FR-IAM-*`, `FR-AUD-*`, `FR-PRV-*`, Rules 9–14

> **Threat model in one line:** the highest-severity risk in this product is one tenant reading
> another tenant's leads or WhatsApp conversations; the second is a leaked Meta access token; the
> third is an insider exporting a customer database. Everything below is prioritized accordingly.

---

## 1. Threat model

| Asset                                                            | Threat                                                                           | Primary controls                                                                                         |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Tenant lead/customer PII                                         | Cross-tenant read via a missing `organization_id` filter, IDOR, broken cache key | 4-layer isolation (§3), composite FKs, generated tenancy test suite, org-prefixed cache keys             |
| WhatsApp conversations                                           | Same as above; also an agent reading conversations outside their scope           | Data scopes, conversation ownership, audit                                                               |
| Integration credentials (Meta tokens, ad accounts, payment keys) | Exfiltration via API response, logs, audit diffs, backups                        | Envelope encryption, never-returned rule, log redaction, encrypted backups                               |
| Auth tokens                                                      | Theft via XSS, token leakage in storage/URLs, refresh replay                     | httpOnly cookies, short access TTL, refresh rotation + reuse detection, CSP                              |
| Public ingestion endpoints                                       | Lead spam/injection, enumeration of tenants, DoS                                 | Key + HMAC, rate limits, honeypot/CAPTCHA, origin allowlist, no tenant enumeration                       |
| Inbound webhooks                                                 | Forged WhatsApp/payment events                                                   | Constant-time signature verification over raw body, connection↔payload cross-check, replay window        |
| Exports & reports                                                | Insider mass exfiltration                                                        | Permission-gated, audited, rate-limited, watermarked filenames, admin-visible export log                 |
| Platform admin plane                                             | Privilege escalation from a tenant, impersonation abuse                          | Separate auth realm, mandatory MFA, no tenant-token path to `/api/admin/*`, impersonation audit + banner |
| Availability of capture                                          | Volumetric attack losing leads                                                   | Separate collector tier, ack-fast design, raw-payload durability, per-key limits                         |
| Uploaded files                                                   | Malware distribution, stored XSS                                                 | Type/size validation, magic-byte sniffing, quarantine + scan, no inline serving from an app origin       |

---

## 2. Authentication

| Control              | Decision                                                                                                                                                                                                                                                                                                                                                                                                                      |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Password hashing     | **Argon2id** (m=64 MiB, t=3, p=1, tuned to ~250 ms), per-password salt, transparent rehash on login when params change                                                                                                                                                                                                                                                                                                        |
| Password policy      | ≥ 10 chars, zxcvbn strength floor, breach-list check (k-anonymity HIBP), no forced rotation, no composition puzzles                                                                                                                                                                                                                                                                                                           |
| Access token         | JWT (**HS256**, see [ADR-0013](./decisions/ADR-0013-hs256-access-tokens.md) — RS256 once a second party must verify without minting), TTL **15 min**, claims `{ sub, org, sid, jti, iss, aud, exp }` — identity only. Permissions are **not** embedded: they are resolved per request from a version-keyed Redis cache, so revoking a role applies on the next request rather than at token expiry                            |
| Refresh token        | Opaque 256-bit, hashed at rest, TTL 30 d, **rotated on every use**, family-tracked; reuse of a rotated token revokes the whole family and alerts the user (`TOKEN_REUSED`)                                                                                                                                                                                                                                                    |
| Web transport        | Refresh in an httpOnly `Secure` `SameSite=Lax` cookie; access token kept in memory only — never `localStorage`                                                                                                                                                                                                                                                                                                                |
| MFA                  | TOTP + single-use recovery codes, hashed/encrypted at rest; **two-step enrolment** (a valid code must be proven before MFA is enabled, so a mistyped setup cannot lock anyone out); disabling requires re-authentication; enforceable per org policy; **mandatory** for platform staff                                                                                                                                        |
| Brute force          | Independent **per-account and per-IP** counters (15-minute windows) — the attacks differ: grinding one password vs. spraying many accounts. Temporary lockout, never permanent (a permanent lock is itself a denial of service against the real user). **Fails closed** when Redis is unavailable. Generic messages, plus a dummy Argon2 verification when the account does not exist so response timing does not disclose it |
| Sessions             | Listed per device with IP/UA/last-seen, individually and bulk revocable (`FR-IAM-2`)                                                                                                                                                                                                                                                                                                                                          |
| Invitations / resets | Single-use, hashed tokens, 72 h / 1 h expiry, invalidated on use and on password change. **Minted in the worker at send time**, never in the request — so no usable credential is written to `outbox_events` or a queue payload, and the request does not wait on a mail provider                                                                                                                                             |
| Machine auth         | API key = `pk_live_<id>.<secret>`; only the hash stored, prefix shown; optional HMAC request signing with a 5-minute timestamp window for replay resistance; scopes + IP allowlist + expiry + rotation                                                                                                                                                                                                                        |
| Public ingestion     | Org public key identifies the tenant; HMAC secret authenticates server-to-server; browser origin restricted by allowlist; a public key alone never grants read access                                                                                                                                                                                                                                                         |

---

## 3. Tenant isolation — defence in depth (the most important section)

Four independent layers; a single mistake in any one must not leak data (`FR-TEN-3`).

**Layer 1 — Context.** `TenantContext` in `AsyncLocalStorage`, populated only by the auth guard from
the verified principal. Never from a header, query param or body — a request cannot ask to be another
tenant. Jobs carry `organizationId` in the payload and re-establish the same context.

**Layer 2 — Scoped data access.** A Prisma client extension wraps every operation on tenant-scoped
models: injects `organization_id` into `where`, sets it on `create`, and **throws** when no context
exists. `withPlatformScope()` is the only bypass: explicit, greppable, permission-checked and logged.
Repositories are the sole callers of Prisma; a raw `prisma.*` call outside a repository fails lint.

**Layer 3 — Database constraints.** `UNIQUE (organization_id, id)` on every tenant table plus
composite FKs `(organization_id, parent_id)` on every child. A missing filter then yields zero rows
or an FK violation instead of another tenant's data. This layer is what makes a logic bug an error
rather than a breach.

**Layer 4 — Row Level Security (Phase 12).** Tenant traffic on a non-owner role with
`FORCE ROW LEVEL SECURITY`; policies compare `organization_id` with
`current_setting('app.current_org', true)`, set by `SET LOCAL` inside the request transaction
(safe under PgBouncer transaction pooling). Deliberately _not_ the only control, and validated under
load before enabling.

**Adjacent leak paths, explicitly closed:** cache keys are built by a helper that requires an org id;
Socket.IO rooms are org-prefixed and authorized on join; queue jobs without an org id throw; full-text
search always includes the org predicate; file object keys are `org/{orgId}/…` and served only via
short-lived signed URLs; exports are generated per org and access-checked on download; error messages
never echo another tenant's data; cross-tenant access returns **404** (not 403) so existence is not
disclosed.

**Verification.** A test suite generated from the OpenAPI document attempts every route with Org B's
credentials against Org A's resources and asserts 403/404 with an empty body; a second suite does the
same for jobs and socket rooms. A new route without tenancy coverage fails CI (`NFR-SEC-1`).

---

## 4. Authorization

Permission strings are `resource:action` (`lead:read`, `lead:assign`, `whatsapp:send`,
`settings:manage`, `billing:manage`, `export:leads`). Roles are rows; **code never branches on a role
name** (`FR-IAM-3`). Each grant carries a **data scope**: `own | team | branch | organization`.

```ts
@Permission('lead:read', { scopeParam: 'id' })
async findOne(@Param('id') id: string) { … }   // guard narrows the query, then the repo filters
```

Scope resolution happens in one place (`DataScopeService`) and returns a predicate the repository
applies — so "manager sees their branch" is enforced in SQL, not in a controller `if`. Object-level
checks are mandatory for every single-resource route (no "if you know the id you may read it").
Field-level control: `is_pii` fields and salary-like custom fields respect field visibility rules;
export of PII requires `export:pii`. Mutation of another user's task/conversation requires an
explicit `*:manage_others` permission. Platform permissions live in a separate namespace
(`platform:*`) and are unreachable from a tenant token.

Every route declares its authorization, and **a route that declares nothing fails startup**
(`RouteAuditService`) rather than quietly becoming reachable by any authenticated user of any
tenant (Rule 11). The three declarations are `@Public()`, `@RequirePermission(permission, { minimumScope })`
and `@NoPermissionRequired(reason)`; the reason on the last one makes each exemption reviewable.
A route may additionally declare `@RequireFeature(key)` for a plan feature.

Scope resolution lives in `DataScopeService`, which returns a query predicate rather than a
boolean, so "a manager sees their branch" is enforced in SQL. Two behaviours are deliberate: an
unsatisfiable scope (branch-scoped user with no branch) **narrows** to own rather than widening,
and `own` scope on an entity with no ownership column returns an empty result rather than
everything — silent widening is the failure mode that matters.

Grants are resolved per request from a version-keyed cache, not embedded in the token, so
revoking a role applies on the next request. Any code changing roles, grants, team membership or
branch assignment must bump that version.

A **generated suite** reads the live routing table and asserts, for every route: that it is
declared; that writes outside `/auth` are permission-gated; that the named permission exists in
the catalogue; and that a validly-authenticated caller from another organization is refused and
sees none of the other tenant's identifiers. Routes excluded from the cross-tenant sweep because
they act only on the caller must appear in a reviewed allowlist, so the exclusion set cannot grow
silently.

---

## 5. Input validation & injection defence

Zod/class-validator DTOs at every boundary with `whitelist: true, forbidNonWhitelisted: true`;
unknown keys stripped or rejected. Body size caps per route (default 256 KB, uploads separate).
Parameterized queries only — Prisma by default, and raw SQL exclusively through tagged templates with
bound parameters (a lint rule blocks string-concatenated SQL). The filter DSL resolves field names
against an allowlist derived from the schema + that org's active custom-field definitions, and sorting
is limited to indexed columns — user input never becomes an identifier. JSONB writes are validated
against stored field definitions (type, range, options) before persistence.

Output: React escapes by default; `dangerouslySetInnerHTML` is banned by lint except in the website
renderer, where tenant-authored HTML is sanitized server-side (DOMPurify-equivalent, strict allowlist)
and published sites are served from a **separate origin** so a tenant's content cannot script the app.
CSV export injection neutralized by prefixing `=+-@\t\r` cells. WhatsApp/email template rendering
escapes variables and hard-fails on unknown paths.

---

## 6. Transport, headers, browser controls

TLS 1.2+ only (prefer 1.3), HSTS with preload, HTTP→HTTPS redirect. Headers: strict CSP
(`default-src 'self'`, no `unsafe-inline` for scripts — nonce-based, `frame-ancestors 'none'` on the
app), `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`,
`Permissions-Policy` minimal, `X-Frame-Options: DENY`, `Cross-Origin-Opener-Policy: same-origin`.
CORS: the app origin is a strict allowlist with credentials; the public ingestion API uses a
per-tenant origin allowlist; the tracker endpoint is open but write-only and rate limited. CSRF: the
refresh cookie is `SameSite=Lax` and refresh requires a custom header (not a form-postable request);
state-changing requests use bearer tokens, not ambient cookies. Cookie flags: `Secure`, `HttpOnly`,
`SameSite`, host-only, `__Host-` prefix where applicable.

---

## 7. Webhook security

**Inbound:** verify the provider signature over the **raw** body before parsing (constant-time
compare); reject stale timestamps (5-minute window) where the provider supplies them; resolve the
tenant from the URL's connection id **and** cross-check the payload's account/phone id — a valid
signature for tenant A must not be processable as tenant B; dedupe via `provider_events`; count and
alert on signature failures per connection (a spike means a leaked URL or an attack); never echo
payload contents in errors.

**Outbound:** sign `HMAC-SHA256("{timestamp}.{rawBody}")` with a per-endpoint secret, send timestamp +
signature + event id headers, document verification for customers; block private/link-local/loopback
destinations and validate the resolved IP at request time (SSRF defence), HTTPS only, 10 s timeout, no
redirects followed; response bodies are truncated and stored redacted.

---

## 8. File upload security

Client-side type hint, server-side **magic-byte** verification (extension and declared MIME are not
trusted), per-type size caps, image re-encoding to strip metadata/EXIF-GPS, randomized object keys
under `org/{orgId}/…`, uploads land in a quarantine prefix with `scan_status='pending'` and are
malware-scanned before becoming downloadable, downloads only via short-lived signed URLs with
`Content-Disposition: attachment` from a non-app origin, SVG and HTML uploads rejected (or sanitized
and served as attachments only), and a hard block on executable types. Storage is private by default;
no public buckets anywhere.

---

## 9. Secrets & configuration

All secrets from the environment/secret manager; nothing committed (gitleaks in CI + a pre-commit
hook). `.env.example` documents every variable with no real values. Config validated at boot by a Zod
schema — the process refuses to start on a missing or malformed secret, rather than failing at 3 a.m.
on the first Meta call. Integration credentials use envelope encryption (`integration-architecture.md`
§5) with `key_version` rotation. Log redaction list covers `authorization`, `cookie`, `password`,
`token`, `secret`, `access_token`, `credentials`, `signature`, `otp`, plus PII keys (`phone`, `email`,
`phone_e164`) which are hashed or masked in logs. Rotation policy: JWT signing keys quarterly (with
overlap via `kid`), data keys yearly or on incident, API keys tenant-controlled, provider tokens on
provider expiry.

---

## 10. Audit logging (`FR-AUD-*`)

Logged: authentication events (success, failure, MFA, lockout), session revocation, permission/role
changes, user invite/disable, organization settings changes, integration connect/disconnect/credential
rotation, API key create/rotate/revoke, webhook endpoint changes, lead/customer delete/restore/merge,
bulk operations, exports (with the filter used and the row count), imports, data-scope-widening
actions, privacy actions (consent change, DSR, retention change), subscription/plan/limit changes,
impersonation start/end and every action performed while impersonating, workflow publish/activate/kill,
and every `withPlatformScope()` use.

Record: actor (type + id), organization, action, resource type/id, `before`/`after` (PII-redacted per
field policy), IP, user agent, request id, timestamp. Append-only is enforced **in the database by a
trigger**, not only by grants: UPDATE is always rejected, and DELETE succeeds only inside a
transaction that explicitly sets `app.audit_purge='on'` — which only the retention/DSR purge path
(`withAuditPurge()`) does, and which is itself audited. The organization foreign key is `RESTRICT`,
so deleting an organization cannot cascade the trail away. No UI exposes mutation (`FR-AUD-2`).
This resolves the tension with erasure rights (`FR-PRV-3`): history cannot be rewritten, but it can
be purged by a deliberate, reviewable operation. Tenant admins see
their org's log (read + filter + export); platform staff see the platform log. Retention is
policy-driven and outlives business-data retention.

---

## 11. Rate limiting & abuse

Layered: edge (Nginx, per-IP connection and request caps) → application (Redis token buckets per IP /
user / API key / org / route class) → queue (per-org fairness) → provider (per-provider quotas).
Auth routes get the strictest limits plus account lockout. Public ingestion has per-key and per-IP
limits, a honeypot field, optional CAPTCHA on browser submissions, and payload-size caps. Bot
filtering on analytics ingest (UA heuristics + implausible-timing checks). Anomaly alerts: unusual
export volume, unusual login geography, mass delete, sudden spike in a single org's API usage or
WhatsApp sends → platform notification (`FR-SA-5`), and the org owner is told too.

---

## 12. Privacy controls (`FR-PRV-*`)

**Data inventory.** Every column holding personal data is tagged in the schema metadata
(`is_pii`, plus a category: identity, contact, behavioural, communication content, financial). The tag
drives log redaction, export gating, anonymization, and the DSR export contents — one source of truth
rather than a hand-maintained list.

**Consent.** `consents` records channel, grant/revoke, source, the exact text shown, IP hash and
evidence. Marketing sends check consent **and** the suppression list at send time, not at enrollment
(`FR-PRV-2`). Opt-out keywords write a suppression immediately and exit marketing workflows.

**Data subject rights.** `dsr_requests` supports export (machine-readable bundle of the person's
lead, activities, messages, consents, touchpoints), delete/anonymize (irreversible pseudonymization
that preserves aggregate analytics and legally required audit records), and rectification. Requests
are tracked with verification and completion timestamps, and are auditable.

**Retention.** Per-entity, per-org retention policies with a nightly purge job; analytics retention is
plan-based; raw IPs are never stored beyond the processing window (hashed with a rotating salt);
message media respects the same retention as messages. Legal-hold flags block purges where needed.

**Data residency.** Single-region in v1, documented plainly. The schema (`organizations.region`) and
storage key layout are structured so a second region can be added without a data model change.

**Sub-processors.** Every third party (Meta, Google, payment, email, AI, storage, monitoring) is listed
in a sub-processor page with purpose and data categories; AI processing is **opt-in per org** with a
PII-exclusion option and no training-use of tenant data.

**Compliance posture (`FR-PRV-5`).** The product provides configurable privacy controls that support
obligations under laws such as GDPR and India's DPDP Act. We do **not** claim certification or
automatic legal compliance in UI copy, marketing or docs; the tenant remains the data controller and
we document our processor role.

---

## 13. Secure SDLC

Branch protection, mandatory review, no direct pushes to the default branch. CI gates: lint,
typecheck, unit/integration/E2E tests, the tenancy suite, the permission suite, `pnpm audit` /
Dependabot with a severity budget, gitleaks, CodeQL/Semgrep SAST with rules tuned for this codebase
(raw SQL, unscoped Prisma, missing permission decorator, `dangerouslySetInnerHTML`), container image
scanning (Trivy), and an OpenAPI diff check. Pre-production: DAST (ZAP baseline) against staging, plus
a manual security review for any PR touching auth, tenancy, crypto, uploads or webhooks. Dependencies
are pinned with a lockfile; releases are tagged and reproducible.

**Phase 12 security gate (must pass before production):** cross-tenant isolation test suite green;
authenticated and unauthenticated DAST clean of highs; permission matrix verified per role;
credential-vault rotation exercised; webhook signature negative tests; upload malware test with EICAR;
rate-limit verification; backup **restore** drill completed; incident runbook rehearsed.

---

## 14. Incident response

Severity: **S1** cross-tenant data exposure or credential leak · **S2** auth bypass, mass data loss,
ingestion down · **S3** single-tenant functional breach, integration outage · **S4** low-impact.

Flow: detect (alerts, reports, `security@`) → triage + declare severity → contain (revoke keys/tokens,
disable an endpoint or tenant feature, rotate a data key, pause a queue) → eradicate → recover →
72-hour written post-mortem with action items tracked to completion. Evidence preservation: audit
logs, request logs and the outbox are the forensic trail; they are retained beyond normal business
retention and are immutable from the application. Breach notification obligations are assessed with
counsel; the audit log is designed to answer "exactly whose data, and which fields" — which is the
question that decides notification scope.
