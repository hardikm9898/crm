# modules/webhooks

Webhooks in **both** directions.

**Inbound** — somebody else's provider posting to us (§7 of `docs/api-architecture.md`):

| Route                         | Provider | Verification                      |
| ----------------------------- | -------- | --------------------------------- |
| `POST /api/v1/webhooks/email` | Postmark | `x-webhook-secret`, constant-time |

**Outbound** — us posting to somebody else's server (`FR-API-4`, §8). All behind `webhook:manage`:

| Method  | Path                                                       |
| ------- | ---------------------------------------------------------- |
| `GET`   | `/webhooks` · `/webhooks/:id` · `/webhooks/:id/deliveries` |
| `GET`   | `/webhooks/deliveries` (the whole workspace's recent log)  |
| `POST`  | `/webhooks` · `:id/rotate-secret` · `:id/test`             |
| `POST`  | `/webhooks/deliveries/:id/retry`                           |
| `PATCH` | `/webhooks/:id` (address, events, on/off)                  |

They share a module because they share a vocabulary — a signature over a raw body, an idempotency
story, a contract with a system we do not control. They do not share a prefix by accident:
`POST /webhooks/email` is a literal segment and every outbound route takes a UUID, which the global
`UuidParamPipe` keeps unambiguous. (The first draft of the outbound half **replaced** this module's
file and silently removed the email route; the route-authorization suite caught it on the next run,
which is the one job that suite has.)

## Outbound: the tables

| Table                | What it holds                                                                 |
| -------------------- | ----------------------------------------------------------------------------- |
| `webhook_endpoints`  | A URL, its events, its encrypted signing secret, its consecutive-failure count |
| `webhook_deliveries` | One event aimed at one endpoint, with the body as signed. Partitioned monthly  |
| `webhook_attempts`   | One row per attempt: status code, duration, response body or the error         |

## Outbound: the decisions

- **The delivery row is written before the first attempt**, carrying the exact body that will be
  signed. A worker that dies mid-send leaves a row the sweep finishes rather than an event nobody
  was told about — the same argument `inbound_payloads` makes in the other direction (`FR-CAP-3`).
- **Retries are the schedule in that row, not BullMQ's.** `next_attempt_at` plus a one-minute sweep
  ([ADR-0031](../../../../../docs/decisions/ADR-0031-an-outbound-webhook-is-retried-from-its-own-row-and-never-follows-a-redirect.md)):
  the schedule reaches 24 hours, a delayed job is a promise held in Redis, and two retry mechanisms
  over one row would deliver the same event three times for every failure.
- **A redirect is never followed** (`redirect: 'manual'`, and a 3xx is not success). Following one
  sends a signed payload to an address the SSRF check never saw.
- **The URL is checked twice**: its text when it is saved (scheme, credentials, port, a literal
  private address) and its **resolved addresses** before every attempt. A hostname is not a promise —
  it can resolve publicly today and to 127.0.0.1 tomorrow, which is DNS rebinding.
- **The secret is encrypted, not hashed**, because signing needs it (ADR-0030's lesson in the other
  direction), shown to the workspace exactly once, and `webhook_endpoints_secret_is_encrypted`
  refuses a value that still looks like the `whsec_…` it was generated as.
- **`410 Gone` disables immediately; fifteen consecutive failures disable with a notification.** A
  404 is a deployment that has not finished and a 500 is a bad afternoon — disabling on either would
  cost a workspace its integration over a blip. The count is **consecutive**: one success resets it,
  and switching an endpoint back on clears it, or a fixed endpoint would disable itself again at
  once.
- **Fan-out is idempotent on `(endpoint, event)`.** The outbox is at-least-once, so a re-dispatched
  event must not become a second delivery; the unique constraint carries `created_at` (a partitioned
  table's unique must contain the partition key), so it is a guard within the month and the lookup
  is the point read before it.
- **The test ping is a real delivery** of the reserved `webhook.test` type: signed, logged and
  retried like everything else, because a test that took a different path would test the wrong thing.
- **Deleting an endpoint takes its log with it.** The log is a record of what we sent *that*
  endpoint; keeping it would leave rows nothing can be read against, and refusing the delete would
  make a mistyped URL permanent.

## Outbound: what is not here yet

- **No per-endpoint event filtering beyond the type** (no "only leads from this source"). A filter
  language on the way out is the automation engine's job, and inventing a second one here would be
  two places to express one idea.
- **No bulk retry.** One delivery at a time, by id, for the reason the ingestion replay gives: a
  thousand retries whose cause has not been fixed is a thousand more failures.
- **`conversation.*`, `message.*`, `automation.failed` and `integration.failed`** are in §8's list
  and not in `WEBHOOK_EVENT_TYPES`, because nothing emits them yet. A tick box for an event that
  cannot happen is an endpoint that looks subscribed and receives nothing.

## Why this is a module and not infrastructure

A public HTTP route has an authentication story, an idempotency story and a contract with somebody
else's system — which makes it a product surface. The adapter it drives lives in `infra/mail`, which
is the right way round: the provider's vocabulary is translated at the port
(`MailerPort.parseEvent`), and this controller only authenticates, dispatches and counts.

The telephony and WhatsApp webhooks (Phases 4–5) belong here too, for the same reasons.

## The one thing to know

**This endpoint is the only writer of the email suppression list.** An open one lets anybody stop a
workspace's mail by posting a bounce for its owner's address. So:

- `EMAIL_WEBHOOK_SECRET` is **required by the configuration schema** the moment a real driver is
  set, and the process refuses to start without it. With the development driver and no secret the
  endpoint is open deliberately — that is how the bounce path is exercised locally, and
  `EMAIL_DRIVER=log` already refuses to run in production.
- A failure answers **404, not 401**: an endpoint that distinguishes a missing secret from a wrong
  one is an oracle for guessing it.
- It answers **200 to an event it does not understand**. A 4xx teaches a provider to retry and then
  disable the endpoint, which would silently stop the suppression list being filled — the expensive
  failure rather than the loud one.
- It is **idempotent**, because every write underneath is a transition or an upsert on a unique key.
  A provider promises at-least-once; this costs nothing when it delivers twice.
- An event for a message the platform does not remember sending **still suppresses**. A bounce is a
  fact about the mailbox, and forgetting the send does not make the mailbox work.

The response is the provider's receipt and the operator's: `{ received, matched, suppressed }` —
"we got three events, two matched a message we remember" is the first thing to check when a bounce
does not stick.

It is not under `/wh/{provider}/{connectionId}` as `docs/api-architecture.md` §7 sketches, because
there is no per-tenant connection: email sends from one platform account. Connection ids arrive with
the integration framework in Phase 4.
