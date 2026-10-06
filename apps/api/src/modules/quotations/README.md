# modules/quotations

The priced offer a customer is actually sent (`FR-DEAL-2`).

- `quotations.controller.ts` — `QuotationsController` (list, create, get, PDF, update, items, send,
  accept, reject, revise, delete) and `NumberSeriesController` (the numbering, under settings)
- `quotations.service.ts` — the lifecycle, the version chain, the write-back onto the deal
- `quotation-pdf.service.ts` — the document itself
- `number-series.service.ts` — the locked counter behind every number
- `quotations.processor.ts` — `maintenance.quotation-expiry`
- `quotations.dto.ts` — request shapes; the line shape is imported from the deals DTO

Reads are `deal:read` and writes are `deal:manage` — the permission catalogue has said "deals and
quotations" since Phase 1, and somebody who may price a deal may quote it. The **number series** is
`settings:manage`, because renumbering affects every quotation that follows.

## The decisions

All of them follow from one observation: a quotation is the only record in this product that
**leaves the building**. The reasoning and the alternatives rejected are
[ADR-0019](../../../../../docs/decisions/ADR-0019-quotation-versions-are-immutable.md).

**A version is immutable; a revision is a new row.** `number` identifies the quotation,
`(number, version)` identifies the document. `PATCH` and `PUT /items` refuse a sent version with a
sentence that says to raise a revision; the superseded row keeps its status, because it _was_ sent.
Only the current version can be accepted.

**The number comes from a locked counter.** `number_series`, one row per `(organization, kind)`,
read with `SELECT … FOR UPDATE` inside the inserting transaction — so a rolled-back write cannot
burn a number, and two people raising a quotation in the same second cannot get the same one. The
counter moves forward only.

**The lines are copied from the deal, not referenced.** Omitting `items` on create means "copy the
deal's lines", which is what raising a quotation from a deal means. After that the deal goes on
moving and the document does not.

**One `LineBuilderService`, one `lineTotals()`.** A quotation's lines are priced by the same code as
a deal's, and the database re-checks the result. That is the other half of
[ADR-0018](../../../../../docs/decisions/ADR-0018-money-arithmetic-in-one-place.md).

**Accepting writes the agreed figure back onto an open deal.** A forecast that disagrees with the
document the customer signed is worse than no forecast. A won or lost deal is left alone, and the
timeline says so — `dealClosed: true` in the payload — because a refusal nobody can see is
indistinguishable from a bug.

**The PDF is synchronous and cached per version.** Milliseconds to render, and immutable once the
version is frozen, so the bytes are stored once as a `documents` row with no expiry. A draft renders
fresh and is never stored.

## Traps

- **A service method may not share its name with an injected dependency.** The read method is
  `journey()`-style naming elsewhere; here the timeline writer is `record()` and the injected
  service is `timeline`, deliberately different. `async timeline()` beside
  `private readonly timeline: TimelineService` shadows the property and fails like a DI problem.
- **One timeline row per party, not one per column.** A converted person's timeline is the union of
  their lead's entries and their customer's, so writing against both `lead_id` and `customer_id`
  when both are set shows the same sentence twice on the customer's screen. `record()` keeps the
  lead row (the union already carries it across) and writes the customer row only when it would not
  otherwise appear.
- **The expiry sweep's read is cross-tenant and its write is not.** `TimelineService` takes the
  organization from the context, so the sweep enters each row's own tenant context as a
  `systemPrincipal` rather than writing activity rows by hand under `withPlatformScope`. Doing it
  the other way is how a timeline row ends up in the wrong workspace.
- **The sweep's `UPDATE` re-checks `status = 'sent'`.** A quotation accepted between the read and
  the write must not be quietly expired underneath the acceptance; the predicate makes the sweep
  idempotent and the `updated.count === 0` case is a skip, not an error.
- **An expired quotation cannot be accepted.** The price lapsed, and the status/timestamp CHECKs
  would refuse the row anyway (`expired_at` set with `status = 'accepted'`). The refusal says to
  revise it, which is the thing the person actually wants to do.
- **The PDF font is a dependency, not a path.** `dejavu-fonts-ttf`, resolved through
  `createRequire`. Reading `/usr/share/fonts/...` would work in development and render every
  quotation in production unreadable, with nothing failing until somebody opened one. Its coverage
  is Latin plus `₹`; an Indic-script name prints as empty boxes, and `unsupported()` logs the code
  points so that is found in a log rather than by a customer.
