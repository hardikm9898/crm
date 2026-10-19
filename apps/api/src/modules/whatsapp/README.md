# `whatsapp` — a connected number, and the messages it receives

Phase 5 step 1. The inbound half of WhatsApp: a WABA and its numbers, the deliveries Meta posts, and
the conversations, messages, leads and timeline entries they become. Sending, templates, media and
the shared inbox's own machinery (assignment, the ownership lock, transfer, notes, canned replies)
are later steps and are deliberately absent — a route that accepted a message nothing could deliver
would be worse than its absence.

The credential is **not** here. It belongs to the integration framework next door, which stores it,
rotates it, probes it and owns the door Meta posts to (`POST /wh/whatsapp_cloud/{connectionId}`).
This module is what a WhatsApp delivery becomes once that door has verified it.

## What is here

| File | What it decides |
| --- | --- |
| `whatsapp-inbound.service.ts` | One message → a number, a lead, a conversation, a message row, a timeline entry. |
| `whatsapp.processor.ts` | `whatsapp.ingest-message`: one `provider_events` row, idempotently. |
| `conversations.service.ts` | The inbox, read: the list, one conversation with its lead context, its messages, mark-read, search. |
| `whatsapp-accounts.service.ts` | Connecting a WABA, discovering its numbers, and who answers each. |
| `whatsapp.controller.ts` | `/conversations` behind `conversation:read`; `/whatsapp/*` behind `whatsapp:manage`. |
| `whatsapp.dto.ts` | The request shapes, and the one schema that makes "nobody by default" expressible. |

The adapter (`../integrations/adapters/whatsapp-cloud.adapter.ts`) and the registry entry
(`@leados/shared/src/integrations.ts`) live with the framework, because that is what makes a
provider a registry entry and an adapter rather than a module of its own. The vocabulary — the
message types, the statuses, the 24-hour window's arithmetic, the delivery parser — is in
`@leados/shared/src/whatsapp.ts`, pure and tested on its own.

## The decisions worth knowing before changing anything

**The number resolves the workspace, and that read is platform-scoped.** A delivery names
`metadata.phone_number_id` and nothing else, so `whatsapp_numbers.phone_number_id` is unique
**globally** — no `organization_id` — and the lookup says why it crosses tenants. Everything after it
runs inside `tenantContext.run(systemPrincipal(organizationId, …))`. An unknown number is a 404, the
same answer a made-up id gets. See
[ADR-0036](../../../../../docs/decisions/ADR-0036-an-inbound-message-becomes-a-lead-through-the-capture-path.md).

**The lead comes from `LeadsService.create`, and a refusal does not lose the message.** The capture
path is the one ingestion pipeline: duplicate rules, assignment, SLA, timeline, outbox. If it
refuses, the conversation is stored with no lead and a warning is logged, because losing a
customer's words because our own rules refused to make a record is the worse outcome.

**A conversation is keyed on `(channel_account_id, contact_e164)`.** One person messaging two of a
business's numbers is two conversations; a lead with two numbers is still one lead.

**`created_at` is ours; `sent_at` is theirs.** `created_at` is the partition key and the inbox's sort
order, so it is when the delivery reached us. Meta's timestamp is in **whole seconds**: writing it
into `created_at` made two messages in one second tie, and "the latest message" became whichever row
the planner returned first. The 24-hour window is measured from `sent_at`, because Meta's clock is
the one that closes it and a window computed from a later instant would let an agent write a
free-form reply Meta then refuses. The timeline entry's `occurred_at` is `sent_at` too — it is both
what a business owner means by when they said it and half of the deduplication key a replayed job
has to recompute.

**Every write is idempotent on the `wamid`, in three places.** `provider_events` stops a redelivery
before this module is reached; `messages_provider_message_unique` (partial, and containing the
partition key, because every unique on a partitioned table must) stops one that races it; and
`store()` answers `alreadyHad` rather than throwing. The timeline's `source_event_id` is a uuid
derived by **hash** from the `wamid`, because the column is a uuid and a `wamid` is not.

**`messages` is partitioned monthly, so a cursor carries both halves of its key.** An id alone
selects the wrong page — the `activities` lesson, in the second table to have it. The paging order is
`(createdAt DESC, id DESC)` and every "latest message" read uses the same pair, so the first row of
`/messages` and the preview on the list cannot disagree.

**A delivery with nothing in it for us is acknowledged.** WhatsApp posts status receipts about
messages we sent; a 4xx teaches Meta to disable the endpoint, which stops the deliveries we do want.
That branch is decided by the provider's declared `deliveryShape`, not by a near-synonym — the same
registry reconciliation that `inboundVerification` goes through.

**Nothing here writes a placeholder body.** An inbound image has `body` null and a payload; the
sentence the screen shows ("Sent a photo") is computed by `describeMessagePreview`. `[image]` in the
body column would be indistinguishable from somebody typing it, and would be indexed as if they had.

## What is unbuilt, said plainly

Sending (`POST /conversations/{id}/messages`), templates, media download, the opt-out keyword, usage
metering, the ownership lock, transfer, close/reopen, notes, mentions, canned replies and realtime.
`conversations.lock_user_id`, `lock_expires_at`, `priority`, `snoozed_until`, `first_response_at` and
`customer_id` are columns with no writer yet, which is said here because a column with no writer is
otherwise indistinguishable from a feature somebody forgot.
