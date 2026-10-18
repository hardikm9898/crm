# ADR-0031 — An outbound webhook is retried from its own row, and never follows a redirect

**Status:** Accepted · **Date:** 2026-10-18 · **Phase 4, step 3** · Traces to `FR-API-4`

## Context

Step 2 let somebody else's program post **into** this product. This step posts **out** of it: when a
lead arrives, a deal is won or a payment lands, we make an HTTP request to a URL the workspace
chose. That inverts two things.

- **The tenant now chooses where our server connects to.** That is the textbook server-side request
  forgery primitive: `http://169.254.169.254/latest/meta-data/` hands over cloud credentials,
  `http://localhost:5432` is the database, and a request from inside the network is one every
  internal service trusts.
- **The failure is somebody else's and lasts for days.** `docs/api-architecture.md` §8 promises
  retries at 10 s, 1 m, 5 m, 30 m, 2 h, 6 h and 24 h, a per-attempt delivery log, auto-disable after
  fifteen consecutive failures, and manual retry. A customer's endpoint can be down for a day and a
  half inside one delivery's life.

Everything else about the mechanism was already decided: events leave through the outbox (ADR-0006),
the signature is the construction step 2 already uses, and the secret is encrypted rather than
hashed for the reason ADR-0030 gives.

## Decision

### 1. The schedule lives in the delivery row, not in the queue

`webhook_deliveries.next_attempt_at` is the record of when the next attempt is due, and a
once-a-minute sweep (`maintenance.webhook-retry`) turns it into work. BullMQ's own retry is switched
**off** for this queue (`attempts: 1`).

The alternative — a delayed job per retry — fails three ways. A 24-hour delay is a promise held in
Redis, and this product's Redis is a cache rather than a durable store; two retry mechanisms over one
row would deliver the same event three times for every failure and make `attempt_count` a number
nobody could explain; and a delayed job is invisible to the delivery log, which is the thing
`FR-API-4` actually asks for. The sweep costs one indexed read a minute (`webhook_deliveries_due`,
keyed on `next_attempt_at` alone because the status predicate is an `IN` over two values and an `IN`
cannot be the leading column of a range scan).

The cost is stated: with no worker running, nothing is retried. That is the same failure reminders,
notification release and mail already have, and the reason this sweep runs every minute rather than
every five.

### 2. The delivery row is written **before** the first attempt

The fan-out writes one row per subscribed endpoint, carrying the exact body that will be signed, and
only then queues the attempt. A worker killed mid-send therefore leaves a row the sweep finishes —
the same argument `inbound_payloads` makes inbound, where a payload stored only after the outcome is
precisely the payload that is missing when it failed.

It also makes a retry honest: the same bytes are sent again, so a consumer that compares two
deliveries of one event sees one payload rather than two snapshots of a changing record.

### 3. A redirect is not an acknowledgement, and is never followed

`redirect: 'manual'`, and `isDeliveredStatus` counts only 2xx. Following a 3xx would send a signed
payload to an address the SSRF classification never saw — the simplest possible bypass of decision 4,
offered by the endpoint itself.

### 4. The URL is classified twice: when it is saved, and before every attempt

The **static** half is in `@leados/shared` and runs at save time, so a bad URL is a 400 naming the
field rather than a delivery that silently never works: `https` only (any port in a development
deployment, 443 in production), no credentials in the URL, and no literal address inside a private,
loopback, link-local, CGNAT or multicast range — including `::ffff:127.0.0.1`, which is how a
v4-only check is bypassed.

The **resolved** half runs in the API before each attempt, and refuses if **any** address the
hostname resolves to is blocked. A hostname is not a promise: `hooks.example.com` can resolve
publicly when it is saved and to `127.0.0.1` ten minutes later, which is DNS rebinding, and a name
that resolves to one public and one private address is one the HTTP client may reach either way.

`allowInsecure` (anything but production) is a **deployment** setting rather than a per-endpoint
field, because a tenant who could tick it could ask us to post a signed payload over the open
internet in clear — or at our own database.

### 5. Auto-disable is loud, and `410 Gone` is immediate

Fifteen **consecutive** failures switch an endpoint off, write the reason onto the row, and notify
everybody holding `webhook:manage` through a notification type that is **not** opt-out: an endpoint
we have stopped sending to means the workspace's integration has silently stopped receiving
everything, and the one message that explains it must not be suppressible by the person who would
have to fix it.

One success resets the count, because a flaky endpoint is not a gone one; switching an endpoint back
on clears it, or a fixed endpoint would disable itself again on the next bad afternoon. `410 Gone`
disables at once, because it is the only status that means "stop, permanently" — a 404 is a
deployment that has not finished and a 500 is a bad afternoon.

## Consequences

- An event that nobody is subscribed to costs one indexed read and writes nothing. An event with
  three subscribed endpoints is three delivery rows, three jobs and three logs — which is why
  `webhook_deliveries` is partitioned monthly and pruned at 90 days.
- A delivery's retries span about 33 hours and then stop at `exhausted`; after that only a person
  can send it again. That is deliberate: an endpoint down for a day and a half needs somebody's
  attention, not more attempts.
- Delivery is **at-least-once**, and the documentation and the screen both say so: the delivery id
  distinguishes a retry from a second event, and a consumer deduplicates on `X-LeadOS-Event-Id`.
- A workspace whose endpoint is slow pays for it alone: the queue's concurrency is 20 and its
  timeout is 10 s, so one dead endpoint cannot hold up another workspace's deliveries — but a
  workspace with a thousand pending deliveries and one dead endpoint will see its own queue grow.
  Per-endpoint fairness is a Phase 10 concern, named rather than pretended.
- The signature is the same construction as the inbound one, so a customer implementing both
  directions implements it once. The verification code is printed **on the screen**, because the one
  thing that makes a receiving endpoint unsafe is trusting a payload without checking it.
