# ADR-0030 — The public lead API verifies a signature, and never loses a payload

**Status:** Accepted · **Date:** 2026-10-14 · **Phase 4, step 2** · Traces to `FR-CAP-1`,
`FR-CAP-3`, `FR-CAP-4`, `FR-CAP-5`, `FR-CAP-6`, `FR-CAP-7`, `FR-API-2`, `FR-API-5`

## Context

Step 1 opened the product to a **person** on somebody else's web page. This step opens it to
somebody else's **program**: a website's server, an agency's integration, a Zapier step. Three
things change with that.

- A program can hold a secret, so this endpoint can be authenticated properly rather than by a
  URL. `docs/api-architecture.md` §6 promises a public key, an API key and an HMAC signature.
- A program retries. `FR-API-5` requires `Idempotency-Key` on mutating endpoints, and `FR-CAP-6`
  requires idempotency "on a client-supplied or derived key".
- A program's traffic is not something the tenant controls, and `FR-CAP-3` requires the raw payload
  to persist "independent of whether lead creation succeeded".

## Decision

### 1. The secret is stored **encrypted**, because an HMAC cannot be verified against a hash

The first draft of this step stored `sha256(secret)`, by analogy with a password. It could not have
worked: verifying an HMAC means recomputing it, which needs the secret itself. A receiver of signed
requests holds the shared secret — that is what "shared" means.

So `api_keys.secret_encrypted` holds an AES-256-GCM envelope under the deployment's master key,
with the key's own id as the AAD so a ciphertext cannot be moved into another row and decrypted
there. `api_keys_secret_is_encrypted` refuses anything that is not an envelope, and refuses
anything beginning `sk_` — which is exactly what the mistake looks like.

**The trade-off is stated rather than hidden:** somebody with both the database and the master key
can read the secret. The master key is not in the database, no endpoint answers a secret after
creation, and rotation (`POST /api-keys/:id/rotate`, which changes the public id too) is the answer
to "it may have leaked". A key is also revocable, and a revoked key cannot be rotated back into
service.

**Rejected:** a bearer secret compared against a hash. It is simpler and it is what `FR-CAP-6`'s
"public key + secret/HMAC" allows as an alternative, but it puts the secret in a header on every
request, where proxies and logs can keep it, and it gives no protection against a replayed or
modified body. The HMAC's timestamp window (five minutes each way) and body binding are the two
things a bearer token cannot do.

### 2. The signature covers the **raw bytes**, and the order of the checks is part of the design

`X-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<raw body>">`. The body parser keeps the
bytes on the request; nothing re-serialises them, because `{"a":1}` and `{ "a": 1 }` are the same
object and a signature over one does not verify over the other.

The checks run: workspace public key (**404**, as a workspace that never existed answers), API key
(**401** — unknown, revoked, expired and _belonging to another workspace_ are deliberately
indistinguishable), IP allowlist (**403**), scope (**403**), workspace standing (**403** for
suspended: a lead accepted into a workspace nobody can read is a lead lost politely), rate limit
(**429**), signature (**401**, with a message that says what to send). The rate limit is counted
before the signature so that grinding signatures costs an attacker requests rather than being free.

### 3. The payload row is written **before** the capture is attempted

`inbound_payloads` is the never-lose store: `status` starts at `received`, the outcome is an
update, and the body is kept exactly as sent. A row written once the outcome is known is precisely
the row that is missing when the capture failed — which step 1 paid for when a cold process blew
Prisma's five-second transaction limit and lost a lead that only the form's submission row proved
had existed.

It is **partitioned monthly by `received_at`**, like `activities`, because it grows with traffic the
tenant does not control and is pruned by month. `organization_id` is NOT NULL: a request whose key
resolves to no workspace is refused before a row is written, so there are no unattributed rows for
the scoping extension to hide — the trap `email_messages` paid for in the other direction — and
nobody can fill a tenant's table by posting nonsense.

A payload left in `received` by a crash is what `POST /ingestion/payloads/:id/replay` finishes.
That is the phase's "killing the worker mid-ingestion loses **no** lead" criterion, and it is
tested by writing exactly the row a crash would leave and replaying it to completion.

### 4. Idempotency is a stored **response**, not a stored key

`idempotency_keys` holds the first response body and status against
`(organization_id, endpoint, key)`. A replay answers that response — including the lead id, because
a client that retried never saw the answer and is owed it rather than being told "duplicate". A
replay of the same key with a **different** body answers `409 IDEMPOTENT_REPLAY_MISMATCH`: quietly
returning the first lead would leave the client believing its second one exists. When no key is
sent, one is derived from a hash of the body and prefixed `derived_`, so a collapsed pair of
deliberate submissions is explainable.

The window is 48 hours, swept hourly by `maintenance.idempotency-prune`. Without the sweep the
guarantee stays correct and the table grows forever, which is the quiet kind of failure.

### 5. Unknown fields are kept, named, and counted

`FR-CAP-5` asks that ingestion accept extra fields and surface them. The payload schema is
`.passthrough()` — the only permissive schema in this codebase — the whole body is stored, the
response lists what was not understood, and `GET /ingestion/unmapped` counts those keys across
stored payloads **with a sample value**, because `propertyType` alone does not tell somebody
whether they want a text field or a dropdown.

### 6. The keys live in the ingestion module, and `api_logs` does not exist yet

`api_keys` exists _for_ this endpoint today: the scopes are `ingest:*`, the only authenticator is
here, and a module of its own would be two places to look for one feature. When the authenticated
REST surface arrives and keys carry read scopes, that is the moment to split them out.

`api_logs` (partitioned daily, short retention) waits for the same step. For the one endpoint that
exists, `inbound_payloads` _is_ the request log, and `api_keys.last_used_at` / `last_used_ip`
answer "is this key still in use" before somebody revokes it.

## Consequences

- An integrator can be given a working example: the README's `curl` is the whole contract, and the
  signature helper (`signRequest`) is exported from `@leados/shared` so our own tests compute it
  exactly as a client would.
- Every channel added after this one inherits the whole pipeline by calling `LeadsService.create`,
  and the never-lose store by writing an `inbound_payloads` row first. Meta and Google lead ads are
  that shape.
- `inbound_payloads` holds request bodies, which are personal data: the retention policy Phase 10
  writes down has to cover it, and the partitions are what make that a `DROP TABLE` per month
  rather than a delete.
- A third public write now exists. The route-authorization sweep keeps a reviewed set per shape
  (provider webhook, public capture), so a fourth cannot appear without somebody looking at it.
