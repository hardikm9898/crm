# The public lead API — somebody else's server, posting into this workspace

`FR-CAP-1`, `FR-CAP-3`, `FR-CAP-4`, `FR-CAP-5`, `FR-CAP-6`, `FR-CAP-7`, `FR-API-2`, `FR-API-5`.
A capture form is a page a person fills in; this is the door a **program** comes through — a
website's server, a Zapier step, an agency's integration. It has no session, so everything about it
is credentials, idempotency and the promise that nothing is lost.

## Tables

| Table              | What it holds                                                                     |
| ------------------ | --------------------------------------------------------------------------------- |
| `api_keys`         | One credential pair: a public `pk_live_…` id, an encrypted secret, scopes, limits |
| `inbound_payloads` | **The never-lose store.** Every body as sent, partitioned monthly by arrival      |
| `ingestion_errors` | Why a payload did not become a lead, naming the stage of the pipeline             |
| `idempotency_keys` | The first response to a key, so a client's retry gets the answer it missed        |

## Endpoints

| Method  | Path                                            | Authentication                  |
| ------- | ----------------------------------------------- | ------------------------------- |
| `POST`  | `/public/leads/{organizationPublicKey}`         | **public key + API key + HMAC** |
| `GET`   | `/api-keys` · `/api-keys/:id`                   | `api_key:manage`                |
| `POST`  | `/api-keys` · `:id/rotate` · `:id/revoke`       | `api_key:manage`                |
| `PATCH` | `/api-keys/:id`                                 | `api_key:manage`                |
| `GET`   | `/ingestion/payloads` · `/errors` · `/unmapped` | `api_key:manage`                |
| `POST`  | `/ingestion/test` · `/payloads/:id/replay`      | `api_key:manage`                |

## Sending a lead

```http
POST /api/v1/public/leads/{organizationPublicKey}
Content-Type: application/json
X-Api-Key: pk_live_7f3c…
X-Signature: t=1759000000,v1=9f86d0…        # HMAC-SHA256 of "<t>.<raw body>", hex
Idempotency-Key: website-form-8f21a4         # optional; derived from the body when absent

{ "name": "Rohit Kulkarni", "phone": "98450 12345", "email": "rohit@example.com",
  "source": "Website", "message": "Need a 3BHK before Diwali",
  "customFields": { "budget_band": "A" },
  "utm": { "utm_source": "google", "utm_medium": "cpc" },
  "propertyType": "Apartment" }
```

```json
{
  "success": true,
  "data": {
    "status": "created",
    "leadId": "01J8…",
    "duplicateOf": null,
    "unmappedFields": ["propertyType"],
    "payloadId": "01J8…"
  },
  "message": "Lead received"
}
```

`201` for a lead that was created · `200` with `status: "duplicate_attached"` when a duplicate rule
matched, or `"replayed"` for a retry · `400` with per-field details · `401 INVALID_API_KEY` (no key,
unknown key, another workspace's key, or any signature failure) · `403` (no `ingest:write`, an
address outside the allowlist, a suspended workspace) · `404` when the workspace key names nothing ·
`409 IDEMPOTENT_REPLAY_MISMATCH` · `429 RATE_LIMITED`.

## The two screens

| Screen               | What it is for                                                               |
| -------------------- | ---------------------------------------------------------------------------- |
| `/settings/api-keys` | Create a key (secret shown **once**), rotate, revoke, allowlist, the request |
| `/ingestion`         | The test tool, the payloads that are not leads, the unmapped fields, the log |

Both behind `api_key:manage`. The keys screen prints the signed `curl` with this workspace's own
public key in it and reads both halves of the credential from shell variables — a snippet with a
secret pasted into it is a secret in a browser's history. A _replay_ reports its success from the
re-rendered server tree (the payload's own row says "Tried again just now — it became a lead"),
because a successful replay takes the row out of the "did not become leads" list and unmounts the
form that would have shown the message.

## The decisions

- **The secret is encrypted, not hashed**
  ([ADR-0030](../../../../../docs/decisions/ADR-0030-the-public-lead-api-verifies-a-signature-and-never-loses-a-payload.md)).
  Verifying an HMAC needs the shared secret, so a digest is useless — the first draft of this step
  stored one and could not have worked. AES-256-GCM under the deployment's master key, with the
  key's own id as AAD, and a CHECK that refuses anything that is not an envelope (or that looks
  like a plaintext `sk_…`). The trade-off is stated rather than hidden: somebody with the database
  **and** the master key can read it, which is what rotation exists for.
- **The raw body is signed, and the raw body is what is verified.** `{"a":1}` and `{ "a": 1 }` are
  the same object and different bytes; a verifier that re-serialised would reject every client
  whose JSON writer disagrees with ours. The bytes come off the request (`WithRawBody`), parsed
  once by the body parser.
- **The order of the checks is deliberate**: workspace key (404), API key (401, indistinguishable
  for unknown / revoked / expired / wrong workspace), IP allowlist (403), scope (403), workspace
  standing (403), rate limit (429), signature (401). The rate limit is counted **before** the
  signature so grinding signatures costs an attacker requests.
- **The payload row is written before anything else.** `FR-CAP-3` asks that the raw payload persist
  "independent of whether lead creation succeeded", and a row written once the outcome is known is
  exactly the row that is missing when it did not. The status starts at `received`; the outcome is
  an update; and a payload left in `received` by a crash is what `POST /payloads/:id/replay`
  finishes — the phase's "killing the worker mid-ingestion loses no lead" criterion, tested.
- **One ingestion path** (`FR-CAP-4`): `LeadsService.create`, the same method the lead form, the
  import and the capture forms use. Duplicate detection, scoring, assignment, the SLA clock, the
  timeline and the outbox all happen exactly as they do everywhere else.
- **A replay answers the first response**, including the lead id, because a client that retried
  never saw the answer and is owed it. A replay of the same key with a _different_ body is a client
  bug and answers 409 — returning the first lead would leave the client believing its second one
  exists.
- **Unknown fields are kept and named** (`FR-CAP-5`). The whole body is in `raw_body`, the response
  lists what this API did not understand, and `GET /ingestion/unmapped` counts them across stored
  payloads with a sample of each — which is what turns `propertyType` into a decision about which
  kind of custom field to make.
- **A failure writes an `ingestion_errors` row naming the stage.** A tenant can act on
  "validate — give at least a name, a phone number or an email address" and can do nothing with a
  stack trace. A refusal nothing can fix by re-running it is marked not replayable.
- **The message goes on the timeline** as `lead.enquiry_received` — its own activity type, not a
  form submission with an invented form name, because "Filled in the public API" is a sentence
  about something that did not happen.
- **An unmapped field becomes a real field in one click, and the next payload fills it in.** The
  button on `/ingestion` calls `POST /custom-fields` (no second creation endpoint: a field is a
  field, however somebody noticed they needed one) with the key derived by `customFieldKeyFor` —
  and the **mapper** matches an integration's top-level key with that same function, so
  `propertyType` reaches the `property_type` somebody just made. Without that half the click
  creates a field nothing ever writes to. The value is validated against the definition _before_ it
  is accepted, so making it a `number` field while the integration keeps sending words leaves the
  key unmapped with a note rather than turning a capture that worked yesterday into a 400.
- **The test tool runs the normalize step for real.** It answers `wouldCreate`, the phone as it
  would be **stored** beside the phone as sent, and a note naming what failed — through
  `normalizeContactNumbers` and `buildDisplayName`, the same two functions the write path uses. The
  import's dry run paid for this: a preview that re-checks a schema reported "5 rows ready to
  import" for a column of `not-a-phone`.
- **A payload's status is updated by id, not by `(id, received_at)`.** The partition key is a
  `timestamptz(6)` and a JavaScript `Date` is milliseconds, so a row written by raw SQL (a
  backfill, a fixture) cannot be addressed by the primary key at all — and Postgres refuses to
  alter the type of a column named in a partition key. `updateMany({ where: { id } })` is the same
  row (`inbound_payload_tenant_key` is unique per workspace) and cannot be defeated by a precision
  the application cannot express.
- **`recordFailure` cannot fail the request.** It did: its own write threw, and the throw replaced
  the 400 that said what was wrong with a 404 about the payload. What a caller needs from it is the
  original error, so the explanation is best-effort and its own failure is logged.

## What is not here yet

- **`api_logs`** (`FR-SA-4`: request log, partitioned daily, short retention) arrives with the
  authenticated REST surface, where there is a request volume worth logging per endpoint. Today
  `inbound_payloads` is the log for the one endpoint that exists, and `api_keys.last_used_at` and
  `last_used_ip` answer "is this key still in use".
- **Scopes beyond `ingest:write` / `ingest:read`.** Inventing the read scopes for a REST surface
  that does not exist would be a list nothing enforces.
- **Replaying in bulk.** One payload at a time, by id, because a bulk replay of a thousand failures
  whose cause has not been fixed is a thousand more failures.
