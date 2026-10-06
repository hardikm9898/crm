# ADR-0017 — A customer is a second record, and the timeline is a union

**Status:** Accepted · **Date:** 2026-10-06 · Refines `product-requirements.md` `FR-DEAL-4` · Phase 2 step 6

## Context

`FR-DEAL-4` is one sentence: _"Conversion: lead → customer, preserving the full timeline and all
touchpoints (never a fresh record)."_ Three implementations satisfy the words and only one satisfies
the intent.

**One table with a type column.** The lead row _becomes_ the customer. Nothing to preserve, because
nothing moves. It fails on the second day: a lead has a pipeline, a stage, a score, a lost reason and
an ageing clock; a customer has an account manager, a billing address, a tax id and a lifetime value.
Half the columns would be null for half the rows, every query would begin by asking which kind of row
it was looking at, and the first report that forgot to ask would quietly count customers as open
leads.

**Two tables, with the history copied across.** Satisfies "preserving" literally. It is also the only
design in which a touchpoint can be _lost_: copying is a loop with a failure mode, ids have to be
re-minted or collide, the copy drifts from the original the moment anything is appended to either,
and "which one is the real entry" has no answer. The requirement's parenthesis — "never a fresh
record" — is a warning about exactly this.

**Two tables, and the history is read as a union.** What we built.

## Decision

**`customers.lead_id` points back at the lead, which is kept intact, and a customer's timeline is
`activities.lead_id = <its lead>` OR `activities.customer_id = <the customer>`, computed at read
time.** Nothing is copied, re-parented or renumbered, so there is no step at which a touchpoint can
go missing. Five things follow:

1. **The lead survives, marked `converted_at`, and moves to a `won` status** in the same transaction
   — chosen by `category = 'won'` from the tenant's own statuses, never by name (rule 4). A
   conversion that left the lead in "Negotiating" would make every pipeline and ageing report wrong.
2. **A lead converts at most once, enforced by the database.** `customers_lead_unique` is a _partial_
   unique index on `(organization_id, lead_id) WHERE lead_id IS NOT NULL`, so two clicks or a retried
   request cannot produce two customers, while a workspace full of walk-ins — all with a null
   `lead_id` — is still representable. The service's check exists to give a sentence instead of a
   constraint name.
3. **The two subjects get different activity types.** `lead.converted` on the lead,
   `customer.created` on the customer, written at the same instant. Both appear in the union, and
   two identical sentences there read as a duplicated row rather than as a handover. It also makes
   the direct-creation case honest: somebody who was never a lead did not convert.
4. **A customer who was never a lead has `lead_id` null and no origin panel.** Inventing a lead to
   convert would put a capture that never happened at the top of their timeline.
   `customers_converted_has_lead` makes `(lead_id IS NULL) = (converted_at IS NULL)` an invariant, so
   neither half can be claimed without the other.
5. **Consent is copied at conversion and authoritative from then on,** and the copy is written to the
   timeline. Consent belongs to the person, so re-asking a customer for permission they gave as a
   lead would be absurd — but a silent copy of a permission is exactly the thing that should be
   evidenced.

## Consequences

**Positive:** conversion is non-destructive and therefore reversible by a soft delete rather than by
a migration; the union means a timeline entry written by any future phase lands on whichever subject
it actually happened to, with no rule about which table to append to; and `TimelineReadService` —
extracted here — gives deals and conversations the same page over a different predicate, including
the cursor that has to carry both halves of a partitioned table's key.

**Negative:** every customer timeline read is an `OR` over two indexed columns rather than one, so
`activities` carries a second per-tenant index (`(organization_id, customer_id, occurred_at DESC)`).
And `customers.lead_id` is `ON DELETE RESTRICT`, so a retention purge that must remove a lead has to
clear its customer first — deciding to lose that provenance explicitly rather than silently, which is
the same trade already made for import rows.

**Deferred, and stated rather than implied:** `lifetime_value_minor`, `first_purchase_at` and
`last_purchase_at` are **absent** from `customers`, though the Phase 0 sketch listed them. Their only
writer is the payments ledger, which arrives with deals and quotations, and a money column that is
always zero is a column that lies to every report that reads it. `FR-DUP-5` ("same duplicate
capabilities for customers") is also not built: `merged_into_id` exists so the merge needs no
migration, and nothing reads it yet. Lead-level matching already prevents most duplicate customers,
because almost every customer arrives through a lead that was deduplicated on capture.

## Alternatives rejected

- **One table with a `type` column.** Half the columns null for half the rows; every query has to ask
  what it is looking at.
- **Copying the history onto the customer.** The only design where a touchpoint can be lost, and the
  copy drifts the moment either side is appended to.
- **Re-parenting the lead's activities to the customer** (`UPDATE activities SET customer_id = …`).
  Cheaper to read, and it rewrites history on a table whose entire value is being append-only
  (ADR-0009) — on a partitioned table, in a statement that touches every partition the lead appears
  in.
- **Deleting the lead after conversion.** The pipeline reports lose the sale they were measuring, and
  the attribution chain from spend to revenue (`FR-ATT-4`) loses its middle.
