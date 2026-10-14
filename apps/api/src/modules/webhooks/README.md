# modules/webhooks

Inbound webhooks from providers. One today: the email delivery webhook.

| Route                         | Provider | Verification                      |
| ----------------------------- | -------- | --------------------------------- |
| `POST /api/v1/webhooks/email` | Postmark | `x-webhook-secret`, constant-time |

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
