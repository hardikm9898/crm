# ADR-0028 — Email sits behind a port, and a bounce is a fact about a mailbox

**Status:** Accepted · **Date:** 2026-10-14 · **Phase 3, step 7** · Traces to `FR-PRV-2`,
`FR-NOT-2`, `FR-NOT-3`, `NFR-REL-3`

## Context

Phase 3's scope ends with "email sending adapter + bounce→suppression", and three landed steps were
visibly waiting on it: `notification_preferences` offered an `email` channel the deliverable set
refused, the preferences screen rendered that half greyed out with a sentence saying why, and
`digest` has no column at all.

Until now there was one driver, `LoggingMailer`, which writes the message to the log and sends
nothing. It refuses to run in production, so the product has never sent an email — and the four
things that do send (verification, password reset, security notice, invitation) each called
`MAILER.send` directly and threw the result away.

`docs/database-design.md` §13 sketched a `suppressions` table: `org, channel, identifier, reason`,
`UNIQUE (organization_id, channel, identifier)`, "checked at send time". That shape turns out to
answer a different question from the one this step has to answer, which is the first decision below.

## Decision

### 1. A bounce is a fact about a **mailbox**, so the deliverability list is platform-wide

`email_suppressions` is keyed on the address alone and has **no `organization_id`**.

A hard bounce or a complaint is not a property of one workspace's relationship with an address; it
is a property of the address. And the thing a suppression list protects — the sending domain's
reputation — is shared by every workspace on the platform. A per-workspace list would let workspace
B spend the shared domain's reputation on an address workspace A already knows is dead.

The §13 table is the **other half** of `FR-PRV-2`: a workspace's own opt-outs, per channel, for the
marketing sends of Phase 9. It is not built here, because nothing would write one — and a table with
no writer is indistinguishable from a feature somebody forgot. The contract is amended to say which
half exists and why.

`email_messages` is platform for the same shape of reason: a verification, a reset and a security
notice are about a **user**, who may belong to several workspaces or to none at all, and an
invitation's own row already records which workspace it was for.

A **nullable** `organization_id` on either was the obvious middle path and is the trap. The registry
check (`findRegistryDrift`) requires any model carrying `organizationId` to be in `TENANT_MODELS`,
where the scoping extension filters `organization_id = :current` — which would hide exactly the rows
that have no workspace. The registry does not model "a table with both tenant and platform rows",
and that is right: such a table is two tables whose guarantees differ.

### 2. How much a suppression stops depends on why it exists

| Reason                | Stops                            |
| --------------------- | -------------------------------- |
| `bounce`, `invalid`   | everything                       |
| `complaint`, `manual` | everything except account emails |

**A bounce stops everything** because the mailbox does not exist. There is no message important
enough to be worth sending to an address that cannot receive it: the send fails _and_ the sending
domain pays for it.

**A complaint stops everything else.** Somebody clicking "spam" is asking to stop being _contacted_
— not asking to be locked out of the account whose password they request a reset for thirty seconds
later. Treating the click as consent to that is the kind of literal-mindedness that loses a customer
who was only annoyed. So `email_verification`, `password_reset` and `security_notice` go out
anyway, which is the same principle `FR-NOT-3` states one layer up: "system/security notices are not
opt-out".

`suppressionStops` in `@leados/shared` is the one place that decides, and an **unknown** reason
takes the gentler branch — the same default the timeline and notification registries take, for the
same reason: a thing nobody classified should be noticed, not disappear.

### 3. One path, and a refusal is a recorded row

Nothing calls `MAILER.send` any more. `EmailSenderService` does three things in one order — check
the list, write the log row, ask the provider — and a second call site would be a second place to
forget one of them.

**A refusal is recorded, not thrown.** A suppressed send answers `status: 'suppressed'` with a row
naming the suppression that stopped it. The caller has already committed to sending (the invitation
exists, the reset token is minted), so an exception would make a queue retry it for ever; and the
row is the answer to "the invitation never arrived", which is a much better answer than silence.
`email_messages_suppressed_is_explained` makes a `suppressed` row that names no suppression — or
that also claims to have been sent — unrepresentable.

**A provider failure _is_ thrown**, after the row is written, because that is what the queue's retry
is for.

**The address is normalised once**, in the sender, and the database enforces the same shape. A list
that misses `Priya@Example.com` after bouncing `priya@example.com` does nothing. Canonicalisation
stops at lower-casing: stripping dots or a `+tag` is a trick that works at exactly one provider and
would elsewhere suppress addresses nobody complained about.

**An address that is not an address is `failed`, not suppressed.** The list holds mailboxes — which
is what `email_suppressions_identifier_is_an_address` says out loud — and the sender refuses a
malformed one every time anyway, which is a stronger guarantee than a row an operator could release.
That constraint and the first draft of the sender disagreed, and the e2e suite is what noticed.

### 4. The port answers with the provider's message id, and parses the provider's events

```ts
interface MailerPort {
  readonly driver: string;
  readonly sends: boolean;
  send(email: OutboundEmail): Promise<{ providerMessageId: string | null }>;
  parseEvent(body: unknown): readonly ParsedEmailEvent[];
}
```

`send` returning `void` — which it did until this step — makes a bounce **unattributable**, and an
unattributable bounce is a suppression list that can never be filled from the one source that knows.

`parseEvent` is on the port because the vocabulary differs per provider: Postmark says `HardBounce`
and `SpamComplaint`, SES says `Bounce` with a `bounceType`. Everything above the port sees four
words — `delivered`, `bounced`, `complained`, `failed` — and the distinction that matters is **hard
versus soft**: a full mailbox or a greylisting is `failed` and suppresses nothing, because the
address is fine and the next send will probably work.

Deliberately not on the port: templates (a provider's template store is a second place for the copy
to live), scheduled sends (the queue already does that, and better), and anything that reads back
from the provider. A port method one driver has to throw from is a lie in the contract — the same
rule ADR-0027 applied to a telephony hangup.

**Postmark is the first real driver** for two reasons that have nothing to do with the provider's
marketing: its send is one JSON POST, so there is no SDK inside the thing that sends password
resets; and its webhook carries the message id it was given.

**The development driver still returns an id.** That is what makes the whole bounce path exercisable
locally — post a webhook naming that id and watch the address land on the list. A driver answering
`null` would make the one mechanism worth testing untestable without a provider account.

### 5. The webhook is the only writer of the list, and is authenticated as such

`POST /api/v1/webhooks/email` is `@Public()` — a provider has no session — and presents
`EMAIL_WEBHOOK_SECRET`, compared in constant time. The configuration schema makes that secret
**mandatory the moment a real driver is set**, so there is no deployment in which the endpoint is
both reachable and unauthenticated. An open one would let anybody stop a workspace's mail by posting
a bounce for its owner's address.

It answers **200 to an event it does not understand**. A 4xx teaches a provider to retry and then
disable the endpoint, which would silently stop the list being filled — the expensive failure rather
than the loud one.

It is idempotent because every write under it is a transition or an upsert on a unique key, which is
what a provider's at-least-once delivery requires. And an event for a message the platform does not
remember sending **still suppresses**: a bounce is a fact about the mailbox, and forgetting the send
does not make the mailbox work.

### 6. Email is a delivery of a notification, not a second notification

`DELIVERABLE_CHANNELS` gains `email`, so the preferences screen's greyed-out half becomes a real
tick box per type. The email carries the notification's own title, body and link, because a second
vocabulary for one event is how an email and an app end up telling somebody different things.

**It is enqueued, never sent inline**: a notification must not wait for a provider, and a provider
outage must not fail the write that caused it.

**A held notification is not emailed until it is released.** `deferred_until` means the inbox is
deliberately hiding the row; an email about it at 21:40 would break the only promise quiet hours
make. So the release sweep enqueues the ones it lets through — and the ones it supersedes get
nothing, which is the whole point of re-checking them (ADR-0025). The channel choice is read again
**at release**, because somebody who switched email off while a notification sat in their quiet
window has switched it off.

### 7. One thing a workspace is told

A member whose address is suppressed is marked on `/settings/members`, with the reason in a sentence
and the date.

The alternative is silence: a colleague whose address hard-bounced stops receiving every
notification they chose email for, and nothing anywhere would say so. It is the only tenant-facing
read of the platform list, narrowed to the addresses of that workspace's own members — which the
caller can already see.

## Consequences

- The product can say **why** an email never arrived, for every email it has ever tried to send.
- `MAILER.send` has one caller. A fifth producer gets the suppression check for free, and cannot not
  get it.
- Two suppression lists exist in a Postmark deployment: theirs protects the shared sending IP and
  answers with an opaque 406; ours is what lets the product explain itself.
- The platform list is shared, so one workspace's bounce stops another's send to the same address.
  That is the intent — it is the same dead mailbox — and it is a behaviour to revisit if the product
  ever sends from per-workspace domains.
- `digest` is still not implemented and still has no column. It is a real gap and remains named as
  one: a daily roll-up is a different feature from a channel.
- Nothing yet releases a suppression through a screen. `EmailSuppressionService.release` exists and
  is called by no route; the operator console that needs it is Phase 10.
