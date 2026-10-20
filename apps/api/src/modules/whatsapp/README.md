# `whatsapp` — a connected number, the messages it receives, and the replies it sends

Phase 5 steps 1 and 2. A WABA and its numbers, the deliveries Meta posts, the conversations,
messages, leads and timeline entries they become — and the replies, templates and status receipts
that go the other way. Media and the shared inbox's own machinery (assignment, the ownership lock,
transfer, notes, canned replies) are later steps and are deliberately absent.

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
| `whatsapp-send.service.ts` | Sending: the window rule, the template's variables, and the row written before the send. |
| `whatsapp-send.processor.ts` | `whatsapp.send-message`, and the sweep that re-queues one a worker never sent. |
| `whatsapp-status.service.ts` | What Meta says became of a message: the summary, the history, and the shout. |
| `whatsapp-status.processor.ts` | `whatsapp.ingest-status` and `whatsapp.sync-templates`. |
| `whatsapp-templates.service.ts` | Templates: authored here, reviewed by Meta, reconciled by a sweep. |
| `whatsapp-rate-limiter.service.ts` | One second's worth of sends per number, in Redis. |
| `whatsapp-presenters.ts` | The one presenter every screen reads a message through. |
| `whatsapp-ids.ts` | A stable timeline event id from a provider's own id, in its own file to break a cycle. |
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

## Sending, in five sentences (step 2)

**The row is written before the send, and the send is a job**, so a message somebody typed is never
lost to a provider timeout and per-number rate limiting is possible at all
([ADR-0037](../../../../../docs/decisions/ADR-0037-a-send-is-a-queued-write-whose-status-only-moves-forward.md)).
**One function owns the window**: `sendingAllowed` is called by the write path and by the composer,
so the screen cannot offer what the API would refuse. **`accepted` is not `sent`** — Meta taking the
message means it is queued at Meta. **The status is a summary that only moves forward, through a
conditional `UPDATE`**, because the receipt jobs run at the queue's concurrency and three receipts
for one message arrive together; every receipt still writes its own timestamp and its own
`message_status_events` row. **A failure is said three times** — on the message with a retry beside
it, on the lead's timeline, and to whoever sent it, as the one work notification quiet hours do not
hold.

Templates are **authored here, reviewed by Meta and reconciled by a sweep**, never remembered: a
draft is editable, anything Meta has seen is not (Meta has no edit), and a template Meta holds that
this workspace has never seen is adopted rather than hidden.

## Attachments, in six sentences (step 3)

**A message lands before its file.** A delivery carries a media **id**, not the bytes, so an inbound
photo is two writes: the message and its `message_media` row appear immediately — the conversation
reads correctly, the lead gets its timeline entry — and `whatsapp.download-media` fetches the file
after. The row exists from the first write as `pending`, which is what makes "they sent a photo and
we have not got it yet" a state the screen can show rather than a gap.

**The size is checked twice, and the kind is checked before either.** A mime type the kind cannot
have is refused at ingestion, without asking Meta anything. Then Meta's media lookup answers a
`file_size`, which is the one moment this product can refuse a file **before** reading it; the
download enforces the same limit while reading, because a header is a claim.

**A refusal is a state, not an error.** Too large, or a kind this product does not store, is
`refused` with the sentence somebody reads — on the row, beside the message. Throwing would lose the
message and the explanation; a `failed` is Meta's or the network's and is swept.

**An outbound file is ours before Meta has it.** `POST …/attachments` stores the bytes and queues
the message; the **send job** hands Meta the file and keeps the id it answers with. A provider
refusal then costs an attempt rather than the file, and a retry re-uses the id rather than uploading
twice.

**The bytes are served by this product, not by a link**
([ADR-0038](../../../../../docs/decisions/ADR-0038-an-attachment-is-served-by-this-product-not-by-a-signed-url.md)).
`GET …/messages/:id/media` is behind `conversation:read`, `inline` for a photo and `attachment` for
anything else, always `nosniff` and `no-store`.

**The upload parser is a provider of this module.** A Fastify content-type parser is global and the
body is parsed before any guard runs, so `MediaUploadInstaller` also refuses those content types
anywhere but the attachment path — and it is registered on `onApplicationBootstrap` rather than from
`main.ts`, because a hook installed in the HTTP bootstrap is absent from every application the tests
build.

## What is unbuilt, said plainly

The opt-out keyword (`FR-WA-10`), usage metering, bulk sending, the ownership lock,
transfer, close/reopen, notes, mentions, canned replies and realtime.
`conversations.lock_user_id`, `lock_expires_at`, `priority` and `snoozed_until` are columns with no
writer yet, as is `message_media.scan_status` — nothing scans a file, and the column is the hook a
scanner reads, with the same three-word vocabulary `documents.scan_status` has had since Phase 2 — which is said here because a column with no writer is otherwise indistinguishable from a
feature somebody forgot. `first_response_at` **is** written now, from the `sent` receipt rather than
from the queueing — a figure about the business's answer must not be flattered by the queue.
