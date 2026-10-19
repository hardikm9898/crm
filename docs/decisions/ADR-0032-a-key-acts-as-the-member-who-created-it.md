# ADR-0032 — A key acts as the member who created it, and its requests are logged by the day

**Status:** Accepted · **Date:** 2026-10-18 · **Phase 4, step 4** · Traces to `FR-API-1`, `FR-SA-4`

## Context

`FR-API-1` asks for a versioned REST API over the product's resources "with a consistent response
envelope", and §1 of `api-architecture.md` says the tenant API is reached with a "Bearer JWT **or**
API key". The envelope, the routes, the permissions and the data scopes have existed since Phase 1;
what did not exist was the second credential. A key could reach exactly one endpoint — the public
lead capture — and its scopes were two tokens (`ingest:write`, `ingest:read`) that no permission in
the catalogue corresponded to.

Three questions had to be answered before a key could reach the rest of the product, and each has a
plausible wrong answer that is hard to take back once integrations depend on it.

- **How is a key presented, and is each request signed?** The capture endpoint signs an HMAC over
  the raw body. Reusing that everywhere is the consistent-looking choice.
- **What may a key do?** The obvious answer is a set of coarse scopes (`leads:read`,
  `leads:write`), expanded to permissions by a table in code.
- **Whose authority does a key carry?** A key is not a person, and every permission check in this
  product asks what a _principal_ may do, at what data scope.

There was also a fourth, from `FR-SA-4`: `api_logs` has been specified since Phase 0 — method,
path, status, duration, bytes, partitioned daily, short retention — and nothing had been written
into it.

## Decision

### 1. A key is presented as one bearer header, and nothing is signed

```
Authorization: Bearer <key id>.<secret>
```

The two halves are the key's public id (the lookup) and its secret, separated by the first dot. The
guard tells a credential from an access token by the `pk_` prefix — by **shape**, not by trying one
and falling back to the other, so a mistyped key is refused as a bad key rather than as an expired
session.

Per-request signing stays where it belongs, on the public capture endpoint. It is there because a
capture is a replayable write arriving from a position we do not trust and because the **body** is
the thing that must be bound to the signature. A general REST surface is different: a signature that
covers only the timestamp and the body does not bind the method or the path, so a captured `GET`
signature can be replayed as a `DELETE` inside the five-minute window. Making it safe would mean a
**second** signing construction, which every client library then has to implement by hand, for a
property TLS already provides. The secret is 24 random bytes, not a password, and is compared in
constant time after being decrypted.

### 2. A key's scopes are permission keys from the catalogue, from a curated list

`api_keys.scopes` holds the two ingestion scopes and otherwise **permission keys**
(`API_GRANTABLE_PERMISSIONS`). A key reaching `GET /leads` is checked against `lead:read` by the
same guard that checks a person, so a route added next year is covered without touching the key
code, and there is no mapping table to drift from the catalogue.

The list is curated rather than "everything": a key cannot manage roles, members, billing, other
keys, webhooks, the workspace's identity or privacy requests, and cannot export personal details. A
key lives in a configuration file on somebody else's server; one that can mint roles is a privilege
escalation left lying about, and "the integration needed it" is how that gets granted.

### 3. A key acts as the member who created it, narrowed to its scopes

On every request, the creator's **current** grants are resolved through `PrincipalService`, and the
key's permissions are the intersection of those grants with its own scopes, each at the data scope
the creator holds.

The principal says both things: `actorType` is `api_key`, and **`actorId` is the person** — with
`apiKeyId` carrying which credential it was. `actorId` has to be the person, because every
person-reference in this product is written from it: `created_by_id`, `changed_by_id`,
`assigned_by_id`, a saved view's owner. It was the key's own id in the first draft of this step, and
three leads were written claiming to have been created by a member who does not exist; no
constraint objected, because some of those columns carry a composite FK into `Membership` and some
carry none at all. An audit row still says a credential did it, through `actor_label`.

One consequence is not obvious and had to be closed: a key now carries a real person's id, so a
route **about that person** — `/auth/me`, their sessions, their MFA, the other workspaces they
belong to — would answer a credential scoped to one workspace with all of it. `@SessionOnly()` marks
those routes and the permission guard refuses a key on them, **above** the permission exemption,
because a route about the caller is exactly the kind that declares `@NoPermissionRequired`.

The two alternatives are both escalations:

- **Organization-wide scope for whatever the key was granted** would let a branch-scoped manager
  mint a credential that reads the whole workspace, with a button.
- **Freezing the creator's grants into the row** would leave a key working with permissions its
  creator lost months ago.

This also follows a precedent rather than inventing one: the import and export processors already
rebuild the requester's principal from the database for the same reason, and accept the same cost —
that revoking a person's access breaks work they set up. That cost is the feature. A refusal says
which it was, so the fix is obvious.

### 4. `api_logs` is the integration's log, written from a response hook, partitioned by day

One row per request a **key** made: method, path, status, error code, duration, bytes, request id,
address. Four things follow from "the integration's log" rather than "an access log":

- **The web app's own session traffic is not recorded.** It would be a hundred times the rows for
  the one caller that can already see everything, and it is in the process log.
- **No bodies, and no query string.** The filter DSL carries names, phone numbers and amounts, and
  this log is readable by whoever holds `api_key:manage` rather than `lead:read`. The captured
  payload of a lead stays in `inbound_payloads`, behind the permission to read leads.
- **A request whose key resolves to no workspace is not recorded.** `organization_id` is NOT NULL
  for ADR-0030's reason, and an unknown key id has no workspace to file a row under. Every refusal a
  _real_ key earns is recorded, because the authenticator marks the request the moment the key
  resolves — before the allowlist, the rate limit, the secret and the scopes are checked.
- **It is written from Fastify's `onResponse` hook**, because a 401 from the guard, a 403 from the
  permission guard and a 429 from the rate limiter never reach a Nest interceptor, and those are the
  rows an integrator opens the log to understand. The hook is installed by a provider on application
  bootstrap, not from `main.ts`: a hook registered in one bootstrap path is absent from every other
  application built from the same modules.

Writes are **buffered** — a hundred rows or one second, whichever comes first — and cannot fail a
request. Partitions are **days**, not months, because retention is thirty days: a month-sized
partition would be the whole table, and "drop the oldest partition" would mean dropping everything
or nothing.

## Consequences

- An integration can read and change anything the person who set it up can, through the same routes
  and the same envelope the app uses. There is no second API to keep in step, and no second
  permission model.
- A key's authority is never larger than a person's, and shrinks with theirs. It also **stops** with
  theirs, which will surprise somebody the first time an employee leaves and a nightly sync fails.
  The refusal names the cause, and the fix — a new key, or restoring their access — is in it.
- The secret travels on every request. That is the ordinary bearer-token trade-off, and it means a
  proxy that logs `Authorization` headers leaks a credential; it is also already true of this
  product's access tokens.
- A `SIGKILL` loses up to a second of request-log rows, and a full buffer drops rows (counted and
  logged). A durable queue in front of a thirty-day debugging log would be a second outbox for data
  whose value expires.
- `api_logs` grows with integration traffic, and the retention drop is now the one scheduled
  statement in this product that deletes a lot of rows. It is a partition drop, so it is instant and
  cannot lock a busy table.

## Alternatives rejected

- **HMAC-signing the whole REST surface.** A second signing construction, more to get wrong in every
  client, and the replay window it closes is one TLS already closes. Reconsider if the product ever
  needs to accept requests over a channel it does not trust.
- **Coarse scopes expanded by a table.** Two descriptions of one fact. The table would be read in
  one place and maintained in another, and a permission added without a mapping entry becomes a
  route a key cannot reach for no stated reason.
- **A service-account member per key.** It would make a key's authority independent of any person,
  which is tidier — and it would mean a key whose permissions nobody notices drifting, plus a seat
  to bill for. Worth revisiting when the platform needs machine identities for their own sake.
- **Logging every request, session traffic included.** `api_logs` would become an access log: more
  rows, less signal, and a tempting place to look for data the permission does not cover.
- **Monthly partitions, like every other partitioned table here.** With a thirty-day window, the
  oldest partition is never wholly expired, so nothing could ever be dropped.
