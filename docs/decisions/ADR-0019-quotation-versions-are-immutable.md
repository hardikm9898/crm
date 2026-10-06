# ADR-0019 — A quotation version is immutable, and its PDF is a cached artefact of it

**Status:** Accepted · **Date:** 2026-10-06 · Refines `product-requirements.md` `FR-DEAL-2` · Phase 2 step 8

## Context

`FR-DEAL-2` asks for _"quotations with line items, taxes, discounts, validity, PDF generation,
versioning and send-via-WhatsApp/email"_. The word that decides the design is **versioning**, and
the reason is not tidiness: a quotation is the only record in this product that **leaves the
building**. The customer has a copy. When they ring up three weeks later and read a number off it,
the system has to be able to say what that number was.

Three designs were considered.

**Edit the quotation in place, and keep an audit log.** The cheapest. It is also the one in which
"what did we actually send them on the 14th?" has no answer that can be shown to anybody: an audit
log records that `total_minor` changed from 250000 to 220000, not what the document said, in what
order its lines were, or what its terms were at the time. Reconstructing a document from a column
diff is not something a business owner can do during a phone call, and the moment a discount is
disputed, the audit log is evidence of the dispute rather than evidence about the price.

**One row, with versions in a child table.** `quotations` plus `quotation_versions`, the parent
carrying the current figures. Better, and still wrong in a specific way: the parent's money columns
are then a denormalised copy of one child's, so there are two places a total lives and a migration,
a backfill or a bug can make them disagree. It also makes "the version the customer accepted" a
different kind of thing from "the quotation", which every screen and every report then has to join
back together.

**A version is a row.** What we built.

## Decision

**`number` identifies the quotation; `(number, version)` identifies the document. A revision inserts
a new row with the same `number` and `version + 1`, and sets `superseded_by_id` and `superseded_at`
on the row it replaces. Nothing about a sent version is ever updated again.**

The consequences are deliberate:

- **`UNIQUE (organization_id, number, version)`** is the key that makes this work. A second version
  of a number is expected; a second version 1 is not.
- **A sent version refuses `PATCH` and refuses `PUT /items`**, with a sentence that says to raise a
  revision instead. A draft is freely editable, because nobody has seen it.
- **`quotations_current`**, a partial index on `superseded_at IS NULL`, is what every list reads.
  "The quotations" means the current version of each number; the history is `?versions=all`.
- **A sent version keeps its status when superseded.** It _was_ sent — that remains true — and the
  superseded marker is a separate fact. Rewriting the status would be editing the record again.
- **Only the current version can be accepted.** Accepting a superseded one would make the agreed
  figure ambiguous, which is the whole thing this ADR exists to prevent.
- **The money columns are the same four as a deal's**, computed by the same `documentTotals()` and
  re-checked by the same shape of CHECK constraint
  ([ADR-0018](./ADR-0018-money-arithmetic-in-one-place.md)). A quotation that disagrees with its own
  deal by a rupee is a support conversation nobody can win.

**The number comes from a locked counter row, not from `MAX(number) + 1` and not from a Postgres
sequence.** `number_series` holds one row per `(organization, kind)`, read with `SELECT … FOR UPDATE`
inside the transaction that inserts the document. `MAX + 1` is a read-then-write race that hands two
people the same number — the same trap as the scoring queue's double write, with the same answer.
A sequence is global, so one workspace's quotations would advance another's numbering and leak how
much business the platform is doing. The prefix and the padding are columns, because they are the
tenant's choice; the counter only ever moves **forward**, because an earlier number is already in
somebody's inbox.

**The PDF is rendered synchronously and cached per version.** The Phase 0 sketch put
`pdf.quotation` on a background queue (`queue-event-architecture.md` §3). One page of a dozen lines
renders in milliseconds, so a queued render would buy a polling UI, a job state machine and a
download button that says "come back in a moment", in exchange for nothing. And because a non-draft
version is immutable, its bytes are too: the first request stores them as a `documents` row and
every later request serves that row. A draft is rendered fresh and **never** stored — the database
refuses it (`quotations_pdf_needs_sending`), because a file of a document that is still being
written is a file somebody will send by mistake.

**Accepting a quotation writes its figures onto the deal, while the deal is still open.** A pipeline
forecast that disagrees with the document the customer signed is worse than no forecast. A won or
lost deal is left alone — that sale is settled, and quietly rewriting a closed deal's value would
change a revenue report that has already been read — and the timeline says which of the two
happened, because a refusal nobody can see is indistinguishable from a bug.

## Consequences

- A workspace accumulates rows for every revision ever raised. That is the point, and it is cheap:
  a quotation is a handful of rows, and the partial index keeps the lists reading only current ones.
- `activities` gained no `quotation_id` column. A quotation's events are written on the **deal** and
  on the **party**, because those are the screens somebody opens; the document's own lifecycle is
  already in its columns. Adding a third subject would have put the document's history somewhere
  nobody looks.
- An invoice, when it arrives, is the same shape: a numbered, versioned, immutable document over the
  same arithmetic and the same number series. `number_series.kind` exists for that.
- Per-script font fallback in the PDF is **not** built. The document font (DejaVu Sans, a declared
  dependency rather than a system path) covers Latin, the rupee sign and ordinary punctuation; a
  name in Devanagari or Gujarati renders as empty boxes, and the renderer logs the code points it
  could not draw so that this is discovered from a log rather than by a customer.

## Alternatives rejected

| Alternative                           | Why not                                                                                       |
| ------------------------------------- | --------------------------------------------------------------------------------------------- |
| Edit in place, rely on the audit log  | Cannot reproduce the document that was sent; a column diff is not evidence about a price      |
| Versions in a child table             | The parent's totals become a second copy of a child's, with two places for a total to live    |
| `MAX(number) + 1`                     | Read-then-write race: two people get the same number, under a unique index that then fails    |
| A Postgres sequence per platform      | Global, so numbering leaks cross-tenant volume and jumps for no reason a tenant can see       |
| Render the PDF on a queue             | A polling UI and a job state machine for work that takes milliseconds                         |
| Re-render the PDF on every request    | A frozen version's document would not be guaranteed byte-identical to the one already sent    |
| Accepting a quotation closes the deal | A signed quotation is not a received payment; winning the deal stays a separate, explicit act |
