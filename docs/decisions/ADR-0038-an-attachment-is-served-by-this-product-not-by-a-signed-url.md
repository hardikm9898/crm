# ADR-0038 — An attachment is fetched after its message, refused before it is read, and served by this product rather than by a signed URL

- **Status:** accepted
- **Date:** 2026-10-20
- **Context:** Phase 5 step 3 — WhatsApp media, in both directions (`FR-WA-3`)
- **Builds on:** [ADR-0037](./ADR-0037-a-send-is-a-queued-write-whose-status-only-moves-forward.md)

## Context

A customer sends a photo of the room they want quoted. Meta's delivery does **not** contain the
photo: it contains a media **id**, which has to be exchanged for a URL and then for bytes, with the
access token on both requests. An agent sends a quotation back, which has to be handed to Meta
before it can be attached to a message. Four facts shape every decision below:

- **A file is somebody else's and arbitrarily large.** WhatsApp accepts 100 MB documents; this
  product stores a `Buffer`, which is the same constraint that caps an export at 100 000 rows. A
  limit is therefore not optional, and the cheapest place to apply one is before the bytes move.
- **The storage port has no signing.** `StoragePort` is a `put`/`get`/`delete` over a key, and the
  local driver is a directory. Nothing in it can mint a time-limited URL, and the S3 driver that
  could is Phase 12.
- **A delivery must be acknowledged before the work.** Meta retries a delivery we hold, and a
  retried delivery is a duplicate we created. That was settled for messages in
  [ADR-0035](./ADR-0035-a-provider-event-is-deduplicated-on-the-providers-own-id.md); a file that
  takes four seconds to fetch would undo it.
- **"There is a photo" and "here is the photo" are different sentences.** A thread that renders a
  broken image is worse than one that says the file is still coming.

The exit criterion as written says "media round-trip with type/size validation and signed-URL
delivery". The first two halves are met as written. The third is **not**, deliberately, and this
ADR is where that is said rather than quietly skipped.

## Decision

**1. The message lands first; the file is a job.** `whatsapp.ingest-message` writes the message and
a `message_media` row in the same transaction, status `pending`, and enqueues
`whatsapp.download-media` keyed on the **message's** id. The conversation reads correctly and the
lead's timeline entry is written before Meta's CDN has been touched. The row is what makes "they
sent a photo and we have not got it yet" a state rather than a gap.

**2. The kind is refused without asking Meta; the size is refused before reading.**
`mediaProblem({ type, mimeType, sizeBytes })` in `@leados/shared` is the single decider, called
three times with progressively more information: at ingestion with the kind and the mime type (an
`image` whose mime type is `application/x-msdownload` never costs a request), in the job with Meta's
own `file_size` from the media lookup — the one moment a refusal is free — and in the adapter
**while reading**, because a `file_size` is a claim and a provider that under-reports would
otherwise decide how much memory this process uses. `MEDIA_LIMITS` declares a cap and a mime prefix
per kind; a document has no prefix, because "any file" is what a document is.

**3. A refusal is a state with a sentence, not an exception.** `refused` is ours and final;
`failed` is Meta's or the network's and is swept four times. Either way the row carries the sentence
a person reads, and `message_media_refused_says_why` makes a silent one unrepresentable. Throwing
instead would lose the message along with the explanation.

**4. An outbound file is stored by us before Meta has it.** `POST /conversations/{id}/attachments`
stores the bytes, writes the `message_media` row in the same breath as the `queued` message, and
answers. The **send job** hands Meta the file and keeps the id it answers with, so a provider
refusal costs an attempt rather than the file, and a retry re-uses `provider_media_id` rather than
uploading the same file twice.

**5. The bytes are served by this product, behind the conversation's own permission.**
`GET /conversations/{id}/messages/{messageId}/media` resolves through
`DataScopeService.filterFor('conversation:read')` — somebody who cannot read the conversation cannot
read its attachments, and both answer 404 so the shape of an id is not an oracle. The response is
`inline` for an image, video or audio and `attachment` for everything else, with `nosniff` and
`no-store` always: a file a stranger sent us must never be interpreted as HTML on our own origin.
The browser reaches it through the web app's relay route, because the access token is an httpOnly
cookie and an `<img src>` pointed at the API would be unauthenticated.

**6. The upload is a raw body on one path, and the parser that allows it refuses every other.**
A WhatsApp attachment is one file and nothing else, so the body **is** the bytes and the name and
caption travel in the query string — the CSV import's shape, for the same reason. A Fastify
content-type parser is global and the body is parsed before any guard runs, so `MediaUploadInstaller`
adds an `onRequest` hook that answers 415 for those content types anywhere but the attachment path,
before a byte is read. It is a **provider of the WhatsApp module**, registered on
`onApplicationBootstrap`, not a line in `main.ts`: a hook installed in the HTTP bootstrap is absent
from every application the tests build, which would have left the upload suite proving a parser the
running product has and the tests do not.

## Consequences

- **No signed URL, and the criterion is reported as met-with-a-named-deviation rather than met.**
  A signed URL needs a driver that can sign one; the local disk cannot, and inventing a bearer
  token of our own would be a second authentication scheme for one route. When the S3 driver lands
  (Phase 12), `WhatsAppMediaService.read` is the one place that changes: a `302` to a signed URL
  instead of a buffer, with the permission check unchanged because it already happens before the
  object is touched.
- **A file is held in memory, twice at worst.** The adapter concatenates the download and the
  storage port takes a `Buffer`, so sixteen megabytes is a real ceiling rather than a chosen one.
  Streaming an object into storage is a port change, named here so it is not worked around.
- **A worker that is down holds attachments**, like reminders, mail, held notifications and queued
  sends before it. `maintenance.whatsapp-media-retry` sweeps every five minutes and ignores rows
  younger than a minute, so it never races the job the ingestion already queued.
- **Meta's `sha256` is kept and ours is computed.** The digest of what we actually hold is the one
  worth comparing bytes against; Meta's is stored as it sent it, for a question about the transfer
  rather than about the file.
- **A `file_size` Meta never sends is not a refusal.** `mediaProblem` treats an unknown size as
  acceptable and the adapter's read-time cap is what catches it — the alternative is refusing a
  file because a provider was terse.
- **`scan_status` has no scanner.** It carries the same three-word vocabulary
  `documents.scan_status` has had since Phase 2, with a CHECK so a second producer cannot invent a
  fourth word, and it is said plainly in the module README rather than left to look like a feature.
- **An attachment per message, by a unique index.** `message_media_one_per_message` is
  `(organization_id, message_id)`, so a replayed ingestion is a no-op rather than a second row —
  and since Prisma models it as a list, `presentMessage` reads `media[0]` through the one presenter
  both the thread and the send's own answer use.
