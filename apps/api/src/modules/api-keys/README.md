# modules/api-keys

The developer platform's credential, and the record of what it did.

| Method  | Path                                      | Permission       |
| ------- | ----------------------------------------- | ---------------- |
| `GET`   | `/api-keys` · `/api-keys/:id`             | `api_key:manage` |
| `POST`  | `/api-keys` · `:id/rotate` · `:id/revoke` | `api_key:manage` |
| `PATCH` | `/api-keys/:id`                           | `api_key:manage` |
| `GET`   | `/api-logs` · `/api-logs/usage`           | `api_key:manage` |

The keys lived in `modules/ingestion` while the public lead endpoint was the only surface they could
reach. Step 4 moved them here, which is what that module's own note said to do once a key started
carrying scopes for the authenticated REST surface: a key is now a credential for the whole product.

## Two credentials, one surface

`AuthGuard` accepts an access token **or** a key, told apart by shape — a key id begins `pk_`, which
a JWT cannot. Everything after the guard works from the `TenantPrincipal` and cannot tell which
credential produced it, which is what makes the whole product's routes available to an integration
without a second implementation of any of them.

```
Authorization: Bearer pk_live_….sk_live_…
```

One header. The ingestion endpoint signs each request with an HMAC because a capture is a replayable
write from a position we do not trust and the **body** is what must be bound to the signature; a
general REST API is not that, and a signature that did not also cover the method and the path would
let a captured `GET` be replayed as a `DELETE` inside the tolerance window. See
[ADR-0032](../../../../../docs/decisions/ADR-0032-a-key-acts-as-the-member-who-created-it.md).

## What a key may do

Its `scopes` are **permission keys**, enforced by the guard every route already declares. The
grantable list is `API_GRANTABLE_PERMISSIONS` in `@leados/shared`, and what it leaves out is the
decision: a key can never manage roles, members, billing, other keys, webhooks or privacy requests,
and cannot export personal details.

**A key acts as the member who created it, narrowed to its scopes.** Its creator's _current_ grants
are resolved on every request through `PrincipalService` — the same path the import and export
processors take — and the key's permissions are the intersection, each at the scope the creator
holds. The principal's `actorId` is that **person** — so `created_by_id` and every other
person-reference is correct without a single writer knowing a key was involved — and `apiKeyId` says
which credential, which is what the audit row's label carries. Three consequences, all intended:

- a branch-scoped manager cannot mint an organization-wide credential;
- narrowing somebody's role narrows every key they made, on the next request;
- deactivating them stops their keys, with a refusal that says so.

The creation-time check (you cannot grant a permission you do not hold) is the early, clear error;
the intersection at request time is the enforcement.

## The request log

One row per request a **key** made, in `api_logs`, partitioned by **day** and kept for thirty.

- Written from a Fastify `onResponse` hook, not an interceptor: a 401 from the guard, a 403 from the
  permission guard and a 429 from the rate limiter never reach an interceptor, and those are the
  three rows an integrator most needs. The hook is installed by `ApiLogHookInstaller` on application
  bootstrap rather than from `main.ts`, because a hook registered in one bootstrap path is absent
  from every other application built from these modules — including the test harness's.
- **Buffered**, flushed every second or every hundred rows, and incapable of failing a request: a
  recorder of what happened must not be able to change what happened. The cost is honest — a
  `SIGKILL` loses up to a second of rows, and a full buffer drops rows and says how many.
- **No bodies, and no query string.** `logPath` drops it: the filter DSL carries names and phone
  numbers, and this log is read by whoever holds `api_key:manage` rather than `lead:read`.
- **Session traffic is not here.** It would be a hundred times the rows for the one caller that
  already has a request log.
- A request whose key id resolves to no workspace is **not** recorded, because `organization_id` is
  NOT NULL and there is no workspace to file it under (ADR-0030's reasoning). Every refusal a real
  key earns is recorded, because the authenticator marks the request as soon as the key resolves.

`maintenance.api-log-partitions` keeps a week of days ahead and drops the days past retention. A
drop, not a `DELETE`: that is the reason the table is partitioned by day at all.

## Failure modes

| What happens                           | What the caller sees                                               |
| -------------------------------------- | ------------------------------------------------------------------ |
| No credential, or a malformed one      | `401 INVALID_API_KEY`, with the documented header form             |
| Unknown, revoked or expired key        | `401 INVALID_API_KEY` — one indistinguishable answer for all three |
| Wrong secret                           | `401 INVALID_API_KEY`, after the rate limit is counted             |
| Address off the allowlist              | `403 FORBIDDEN`                                                    |
| Key holds no REST scopes               | `403 PERMISSION_DENIED`, saying it can still post leads            |
| Creator inactive, or no longer granted | `403 PERMISSION_DENIED`, naming what to do                         |
| Over the key's per-minute limit        | `429 RATE_LIMITED` with `retryAfterSeconds`                        |
| Secret cannot be decrypted             | `500 INTERNAL_ERROR` — ours, logged, never "wrong secret"          |
| The log cannot be written              | Nothing. The request is already answered; the loss is logged       |

## Security notes

- The secret is **encrypted**, not hashed, with the key's own id as AAD — an HMAC needs it, and so
  does a constant-time comparison. `api_keys_secret_is_encrypted` refuses anything that is not an
  envelope.
- The rate limit is counted **before** the secret is compared, so grinding secrets costs requests.
  It is a separate allowance from the ingestion limiter: an integration posting leads should not be
  throttled by its own dashboard polling.
- The comparison is length-checked first, because `timingSafeEqual` throws on a length mismatch and
  a thrown comparison would become a 500 where the honest answer is 401.
- `api_key:manage` is not grantable to a key, so no key can read the log or mint another key.
- A key carries a real person's id, so routes **about that person** are marked `@SessionOnly()` and
  refused to a key: `/auth/me` would otherwise hand a workspace-scoped credential its creator's
  profile, sessions and the list of other workspaces they belong to. The guard checks it above the
  permission exemption, because those routes are exactly the ones that declare
  `@NoPermissionRequired`.
