# ADR-0036 — An inbound WhatsApp message becomes a lead through the capture path, and its conversation is keyed on the number and the contact

- **Status:** accepted
- **Date:** 2026-10-19
- **Context:** Phase 5 step 1 — WhatsApp: a connected number, and the messages it receives
- **Supersedes:** nothing. Builds on
  [ADR-0034](./ADR-0034-a-provider-is-a-registry-entry-and-an-adapter.md) and
  [ADR-0035](./ADR-0035-a-provider-event-is-deduplicated-on-the-providers-own-id.md).

## Context

A WhatsApp message arrives from a number. Three questions have to be answered before a single row is
written, and each of them has an answer that looks obvious and is wrong.

**Whose message is it?** A Cloud API delivery carries `metadata.phone_number_id` and nothing else
that identifies a business. The URL carries a connection id, but the same workspace may hold one
connection and several numbers, and the number is the thing a conversation belongs to.

**Who is the person?** A number that has never messaged before may already be a lead — captured from
a form, an ad, a spreadsheet or a phone call. A number that is genuinely new is an enquiry the
business has already paid for.

**What is a conversation?** It is tempting to make it one per lead: a lead has a history, and an
inbox that shows one row per person reads well. It is also tempting to make it one per message
thread, since Meta has no notion of a conversation at all beyond the 24-hour billing window.

## Decision

**1. The number resolves the workspace.** `whatsapp_numbers.phone_number_id` is unique **globally**,
with no `organization_id` in the key — one of a handful of such columns in this schema. The lookup is
explicitly platform-scoped (`withPlatformScope('whatsapp: resolve the business number a delivery
arrived at', …)`) and everything after it happens inside `tenantContext.run(systemPrincipal(…))`.
An unknown number answers **404**, the same answer a made-up connection id gets, because the shape of
an id must not become an oracle. The ledger row's workspace and the number's workspace are then
required to agree: delivering one business's customer's message to another business is the one
outcome worth refusing outright.

**2. The lead is found or created through `LeadsService.create`,** the same pipeline a form
submission and an ad delivery go through — with the workspace's own duplicate rules, the assignment
engine, the SLA clock, the timeline and the outbox events that come with it. `createdVia:
'whatsapp'`, and the message itself is passed as a form answer so the lead's first record contains
the question they asked.

A refusal is **not** fatal to the message. If the number cannot be read as E.164, or the capture is
refused, the conversation and the message are stored with `lead_id` null and a warning is logged.
Losing a customer's words because our own rules refused to make a record is the worse outcome by a
long way.

**3. A conversation is keyed on `(channel_account_id, contact_e164)`** — the business number and the
person — not on the lead and not on a thread. One person messaging two of a business's numbers is two
conversations, which is what the agents answering each number expect. A lead with two numbers is
still one lead, and both conversations appear on their timeline.

**4. Every write is idempotent on the provider's own message id.** `provider_events` stops a
redelivery before this service is reached; `messages_provider_message_unique` — partial, and
containing the partition key — stops one that races it; the service answers "we already had that"
rather than throwing, because the second delivery of a message is the normal case and not an error.
The timeline entry's `source_event_id` is a uuid **derived by hash** from the `wamid`, because the
column is a uuid and a `wamid` is not, and `occurred_at` is the customer's own instant so a replayed
job computes the same deduplication key it did the first time.

## Consequences

- **A WhatsApp enquiry is a lead like any other**, which means the assignment rule, the SLA promise
  and the score a workspace configured apply to it without anything being written twice. It also
  means a workspace with a round-robin rule has WhatsApp conversations assigned by it, through the
  number's `default_agent_user_id` for the conversation and the engine's own answer for the lead.
- **The number is a tenant boundary enforced by a global unique**, so two workspaces cannot connect
  the same Meta number. That is correct — Meta would not deliver to both — and it is a refusal
  somebody will meet while testing with a shared sandbox number. It is a 422 from the connect call,
  not a silent second row.
- **A conversation can exist without a lead.** Every read path treats `lead_id` as nullable and the
  inbox says plainly that nobody is attached rather than rendering a blank panel.
- **Deleting a lead does not delete its conversations.** The FK is `Restrict` on the composite pair,
  for the reason `SetNull` cannot be used on a composite FK carrying `organization_id`; a lead with
  conversations is soft-deleted like every other lead and its messages stay readable.
- **A second channel costs the conversation table nothing.** `channel` and `channel_account_id` are
  already general; an email thread or a webchat session is the same shape with a different account
  id, which is why `conversations` is not called `whatsapp_conversations`.
