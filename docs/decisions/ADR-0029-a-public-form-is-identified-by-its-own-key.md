# ADR-0029 — A public form is identified by its own key, and every capture goes through the one path

**Status:** Accepted · **Date:** 2026-10-14 · **Phase 4, step 1** · Traces to `FR-CAP-1`,
`FR-CAP-2`, `FR-CAP-3`, `FR-CAP-4`, `FR-CAP-5`

## Context

Phase 4 opens the product to traffic it does not control. A capture form is rendered on somebody
else's website and filled in by somebody with no account, so for the first time the API has a write
endpoint with **no session to resolve the tenant from** — and the tenant has to be resolved, because
the lead has to land in exactly one workspace.

`docs/database-design.md` §8 specified `forms` with `slug UQ per org`. A slug unique _per
organization_ is the right thing for the workspace to read and the wrong thing to put in a public
URL: `/f/contact-us` would belong to every workspace that ever named a form "Contact us".

Three further pressures shaped this step:

- `FR-CAP-4` requires **one** ingestion pipeline for every channel. There is already one, in
  `LeadsService.create`: duplicate detection, normalization, touchpoints, scoring, assignment, the
  first-response clock, the timeline and the outbox events.
- `FR-CAP-3` requires every capture to persist its raw payload "independent of whether lead creation
  succeeded".
- `FR-CAP-5` requires unknown fields to be accepted and surfaced rather than refused.

## Decision

### 1. The tenant comes from a random `public_key` on the form, not from its slug

`forms.public_key` is 24 random bytes as base64url — 32 characters — unique across the platform,
rotatable, and the only identifier the two public endpoints accept.
`forms_public_key_long_enough` puts the floor (16 characters) in the database rather than in
whichever service happens to mint it, because this value _is_ the authentication: it decides which
workspace a stranger's submission lands in.

The slug stays, as the workspace's own name for the form, and is unique among its **live** forms
only — a partial unique index, so a business that deleted "contact-us" can make another one. A
plain `@@unique` would have covered soft-deleted rows and made that impossible.

An inactive or deleted form answers **404**, exactly as a key that never existed does. Any other
answer turns the key into an oracle for "which workspaces exist and which of their forms are
switched off" — the same reasoning as `UuidParamPipe` answering 404 for a malformed id.

**Rejected:** `/f/{orgSlug}/{formSlug}`, which leaks the workspace's naming and makes every form URL
enumerable from one guessed workspace. **Rejected:** an HMAC signature over the submission, which is
right for the server-to-server public lead API (next step) and wrong here — a form in a browser
cannot hold a secret.

### 2. A public capture goes through `LeadsService.create`, with an internal `CaptureContext`

The submit endpoint maps answers onto the same input a manual lead creation uses and calls the same
method. What a form knows and a client must not claim — `formId`, `formName`, `formAnswers`,
`sessionId`, `visitorId` — travels as a separate `CaptureContext` argument that is deliberately
**not** part of `createLeadSchema`. `POST /leads` is reachable by any authenticated client, and one
that could set `formId` could fabricate a form submission and the attribution a marketing report is
built on.

The lookup runs under `withPlatformScope` (there is no session to scope by) and every write then
happens inside `tenantContext.run(systemPrincipal(organizationId, …))`, because `TimelineService`
and the scoping extension take the organization from the context — the trap the quotation expiry
sweep paid for.

### 3. The submission row is written **before** the capture is attempted

`form_submissions.status` starts at `received` — an amendment to §8, which listed only `processed`,
`duplicate`, `rejected` and `error` — and the outcome is an update. A row written after a successful
capture is exactly the row that is missing when the capture failed, which is the one case
`FR-CAP-3` exists for. It paid for itself immediately: the first capture in a cold process took
5.8 s, Prisma aborted the transaction at its 5 s default, and the submission row was the only
evidence of a lead that had been lost. The capture transaction now has a 20 s ceiling of its own.

### 4. What a form may ask for is a short list, and the answers that are not columns have homes

`FORM_STANDARD_FIELDS` in `@leados/shared` is the only standard vocabulary the API accepts, and it
is deliberately shorter than `IMPORTABLE_LEAD_FIELDS`: no status, no stage, no pipeline, no owner,
no tags, no score. A public form that offered any of them would let a stranger set the workspace's
own decisions. Consent ticks map to the three `consent_*` columns. A free-text message has no column
in this schema, so it is written to the lead's **timeline** as a `lead.form_submitted` entry
carrying every answer as label and value — in the capture's own transaction, because the answers are
what whoever rings them actually needs.

Unknown answers are kept whole in `raw_payload` and logged, never refused (`FR-CAP-5`). The
one-click "create a custom field from this" arrives with the public lead API, where the same
surfacing is needed for a payload nobody mapped at all.

### 5. The defences are a honeypot, two rate-limit counters and a hash instead of an address

A hidden `website_url` field — a fixed name, so the renderer and the endpoint cannot disagree — is
recorded as a refusal and answered with the thank-you. Telling a bot it was caught is how a spam
tool learns to stop filling the field. Rate limiting counts per form and per address hash, because
one form being hammered and one address trying every form are different attacks; it fails closed.
`ip_hash` is an HMAC under the deployment's master key: enough to count, not a record of where a
member of the public was sitting.

CAPTCHA is a settings flag with no provider behind it, stated as unbuilt rather than implied.

## Consequences

- A form's URL can be revoked in one click, and the revocation is immediate. That is the honest
  answer to "somebody is spamming our form" and it is also the only way to retire a URL that has
  been copied somewhere nobody remembers.
- Every capture channel added after this one inherits the whole pipeline by calling the same
  method — which is the point of `FR-CAP-4`, and the reason the public lead API in the next step is
  a thin authenticated shell around the same call.
- `form_submissions` grows with traffic the tenant does not control, including refusals. It is
  indexed for the two questions anybody asks (one form's submissions, and everything unresolved)
  and will need the same retention treatment as `api_logs` when Phase 10 writes the retention
  policy down.
- The platform now has two public write endpoints: this one and the email delivery webhook. The
  route-authorization sweep keeps a separate reviewed set for each, so a third cannot appear
  without somebody looking at it.
