# infra/mail

A port, two drivers, and the one service every outbound email goes through.

| File                           | What it is                                                               |
| ------------------------------ | ------------------------------------------------------------------------ |
| `mailer.port.ts`               | `MAILER`, `OutboundEmail`, `SentEmail`, `ParsedEmailEvent`               |
| `logging.mailer.ts`            | Development driver: logs the message, sends nothing, still returns an id |
| `postmark.mailer.ts`           | The real driver — one JSON POST, no SDK                                  |
| `email-sender.service.ts`      | Suppression check → delivery log → provider → outcome                    |
| `email-suppression.service.ts` | The addresses the platform will not email, and why                       |

## Tables

| Table                | What it holds                                                              |
| -------------------- | -------------------------------------------------------------------------- |
| `email_messages`     | Every email sent, or deliberately not sent, with the provider's message id |
| `email_suppressions` | One row per mailbox the platform will not write to, and why                |

Both are **platform** tables with no `organization_id`. That is a decision, not an omission
([ADR-0028](../../../../../docs/decisions/ADR-0028-email-sits-behind-a-port-and-a-bounce-is-a-fact-about-a-mailbox.md)):
a verification, a reset and a security notice are about a _user_, who may belong to several
workspaces or to none, and a bounce is a fact about a **mailbox** rather than about one workspace's
relationship with it. A nullable organization would have put both half inside the tenant registry,
where the scoping extension hides exactly the rows that have no workspace.

## Business logic worth knowing

- **Nothing calls `MAILER.send` directly.** The suppression check, the delivery log and the provider
  call are three things that must happen in one order, and a second call site is a second place to
  forget one of them.
- **A refusal is recorded, not thrown.** A suppressed send answers `status: 'suppressed'` with a row
  naming the suppression that stopped it, because the caller has already committed — the invitation
  exists, the token is minted — and an exception would make a queue retry it for ever. A **provider
  failure** is thrown, after the row is written: that is what the retry is for.
- **How much a suppression stops depends on why it exists.** `bounce` and `invalid` stop everything
  (the mailbox is gone; there is no message important enough to send to an address that cannot
  receive it). `complaint` and `manual` stop everything **except** the kinds somebody asked for about
  their own account — verification, password reset, security notice. Treating a spam click as consent
  to be locked out of your own account is the kind of literal-mindedness that loses a customer who
  was only annoyed. `suppressionStops` in `@leados/shared` is the one place that decides.
- **The address is normalised once, in the sender**, and the database enforces the same shape
  (`email_messages_to_normalised`, `email_suppressions_identifier_normalised`). A list that misses
  `Priya@Example.com` after bouncing `priya@example.com` is a list that does nothing.
  Canonicalisation stops at lower-casing: stripping dots or a `+tag` would suppress addresses no
  provider ever complained about.
- **A soft bounce suppresses nothing.** A full mailbox or a greylisting is `failed`; only
  `HardBounce` and `BadEmailAddress` mean the mailbox is gone. An unsubscribe arrives as a _bounce
  type_ in Postmark's vocabulary and is a complaint, not a failure.
- **The development driver returns a message id.** That is what makes the whole bounce path
  exercisable locally: post a webhook naming that id and watch the address land on the list. A driver
  answering `null` would make the one mechanism worth testing untestable without a provider account.

## Configuration

| Variable                | Meaning                                                        |
| ----------------------- | -------------------------------------------------------------- |
| `EMAIL_DRIVER`          | `log` (default, refuses production) or `postmark`              |
| `EMAIL_FROM`            | `Name <address>` — the domain whose reputation the list guards |
| `EMAIL_REPLY_TO`        | Optional                                                       |
| `POSTMARK_SERVER_TOKEN` | Required when the driver is `postmark`; checked at boot        |
| `EMAIL_WEBHOOK_SECRET`  | Required with any real driver; the webhook writes the list     |

Both requirements are enforced by `configSchema.superRefine`, so a deployment that cannot send mail
fails to **start** rather than failing silently three hours later on somebody's password reset.

## The webhook

`POST /api/v1/webhooks/email` lives in `modules/webhooks`, because a public HTTP route is a product
surface: it has an authentication story, an idempotency story and a contract with somebody else's
system. It is the **only writer of the suppression list**, which is why the secret is mandatory with
any real driver and compared in constant time — an open endpoint there lets anybody stop a
workspace's mail by posting a bounce for its owner's address.

It answers 200 to an event it does not understand. A 4xx teaches a provider to retry and then
disable the endpoint, which would silently stop the list being filled.

## What a workspace sees

One thing, and deliberately only one: a member whose address is suppressed is marked on
`/settings/members`, with the reason and the date. The alternative is silence — a colleague whose
address hard-bounced stops receiving every notification they chose email for, and nothing anywhere
would say so. It is the only tenant-facing read of the platform list, narrowed to the addresses of
that workspace's own members, which the caller can already see.
