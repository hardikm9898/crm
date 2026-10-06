# ADR-0018 — Line-item arithmetic lives in one pure function, and the database checks it

**Status:** Accepted · **Date:** 2026-10-06 · Refines `product-requirements.md` `FR-DEAL-1`, `FR-DEAL-2` · Phase 2 step 7

## Context

Three things will compute the same money: a deal's value, a quotation's totals, and the PDF a
customer receives. Later, an invoice and a payment reconciliation make five. They are written at
different times, by different code paths, in different modules.

A quotation that says ₹1,18,000 and an invoice that says ₹1,17,999 is not a rounding curiosity. It
is the end of a sale, and then a support conversation in which nobody can say which number is right.
The usual way this happens is not a bug in the arithmetic — it is **two implementations** of it, one
of which rounds the running total and the other each line, or one of which applies tax before the
discount.

The second trap is floating point. `0.1 * 3` is `0.30000000000000004`, and money held as a decimal
fraction of a rupee will eventually produce a quotation whose lines do not add up to its own total.

## Decision

**`lineTotals()` and `documentTotals()` in `@leados/shared` are the only implementation, and the
database refuses a row whose columns disagree with them.** Six things follow:

1. **Minor units and integers, everywhere.** No floating point touches money. Quantity is the one
   fractional input (2.5 hours, 1.75 kg), so it is scaled to an integer before multiplying and
   rounded **once per line** — which is what makes the sum of the lines equal the document total
   exactly.
2. **A document's total is the sum of its already-rounded lines**, never a recomputation from the
   raw inputs. The two differ by a unit or two on a long document, and the sum is the one a customer
   can check by adding up the column in front of them. That is the only definition of "correct" that
   survives a dispute.
3. **Tax is per line.** A single Indian quotation routinely mixes 5%, 12% and 18% GST, which a
   document-level rate cannot express. The breakdown is then grouped by rate, because that is what a
   tax invoice has to print.
4. **Discount is an absolute amount, not a percentage**, and it comes off before tax. A percentage is
   a thing a person types; an amount is a thing a document states, and the document is what is
   binding.
5. **The database enforces the arithmetic.** `deal_items_net_is_gross_less_discount`,
   `deal_items_total_is_net_plus_tax` and `deals_totals_add_up` make a disagreeing row
   unrepresentable. They are not belt-and-braces: they are what catches a _second_ implementation
   appearing, which is the failure this ADR exists to prevent and the one no unit test of the first
   implementation can see.
6. **A line records what was agreed.** Name, price and tax rate are copied from the product when the
   line is written, never read from the catalogue at display time. A price change today must not
   rewrite last quarter's quotations — and the one thing worse than a wrong number on a document is a
   number that changes after it was sent.

## Consequences

**Positive:** one place to fix a rounding rule, one place to test it (29 cases, no database), and a
guarantee that survives a future module written by somebody who has not read this file — because the
constraint rejects their row rather than trusting their code. The totals are also cheap to query: a
pipeline report sums a stored column instead of recomputing thousands of lines.

**Negative:** the columns are denormalized, so every write path that touches a line must recompute
the header in the same transaction. `DealsService.setItems` does, and the constraint is what makes
"must" into "does". A line's stored total also cannot be corrected by editing the catalogue, which is
the point, but it does mean a mis-priced quotation is fixed by editing the line.

**The precision bounds are stated, not implied:** quantity to three decimal places, tax to two, and
a maximum quantity of 1 000 000 beyond which the integer arithmetic stops being exact. Those are in
`line-items.ts` as constants with the reasoning next to them.

## Alternatives rejected

- **Floating-point rupees.** The classic. A quotation whose lines do not add up to its own total,
  discovered by a customer.
- **A `Decimal` type end to end.** Correct, and it would mean Prisma `Decimal` objects crossing the
  wire as strings, a decimal library in the browser bundle, and arithmetic that cannot be done in a
  SQL `CHECK`. Integers in minor units are exact for money and need none of that.
- **Recomputing totals on read.** No denormalized columns to keep in step — and every pipeline
  report becomes an aggregate over `deal_items`, every list a join, and a disputed invoice becomes
  un-reconstructible once a tax rate changes.
- **Tax at the document level.** Simpler, and wrong for the market this product is built for.
- **Trusting the application and skipping the constraints.** It would have been enough for the code
  as written today. It is not enough for the quotation module, the invoice module and the payment
  reconciliation that will each want to write these columns.
