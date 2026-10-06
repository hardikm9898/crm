# ADR-0020 — Derived money is recomputed from the ledger, never incremented

**Status:** Accepted · **Date:** 2026-10-06 · Refines `product-requirements.md` `FR-DEAL-3`, `FR-ATT-4` · Phase 2 step 9

## Context

`FR-DEAL-3` asks for _"payments recorded manually or via a payment provider adapter, partial
payments supported; payment events feed automation and attribution"_. Three figures fall out of it
immediately, and every one of them is a number somebody will act on:

- `deals.paid_minor` — what has arrived against this deal, so "₹1,15,050 agreed, ₹50,000 received"
  is a sentence a collections call can start from.
- `customers.lifetime_value_minor`, `first_purchase_at`, `last_purchase_at` — the three columns
  `database-design.md` §6.7 has carried as **deliberately absent** since step 6, because their only
  legitimate writer is this ledger.
- Revenue on every marketing and attribution report from Phase 9 onwards (`FR-ATT-4` says it comes
  from `payments`).

The question is how those figures are kept true. Two answers, and only one of them survives
concurrency.

**Increment on write.** `UPDATE deals SET paid_minor = paid_minor + :amount`. Cheap, and wrong in
two separate ways. Postgres makes the increment itself atomic, so the naive race is covered — but
nothing else is: a refund, a bounced cheque, a corrected amount and a deleted row each need a
compensating decrement, and every one of those is a second place the arithmetic lives. The moment
one path forgets (or decrements the _new_ amount instead of the old), the column drifts from the
ledger and **nothing ever notices**, because there is no longer anything to compare it against.
This repository has already paid for the simpler version of this bug once, in the scoring queue,
where two jobs read `score = 0` and both wrote `15`. There the cost was a wrong score; here it is
money.

**Recompute from the ledger.** Take the row lock, sum the payments, write the result.

## Decision

**Every derived money figure is recomputed from `payments` after any write that could change it —
recording, confirming, failing, refunding, correcting an amount, deleting — inside the same
transaction, after `SELECT … FOR UPDATE` on the row being updated.** `PaymentRollupsService` is the
only writer of all four columns.

- **The lock comes before the sum**, not after. Reading the total and then locking is how two
  concurrent payments both compute the same "before" figure.
- **Only `succeeded` rows count.** A pending cheque is not revenue and a refunded payment is not
  either; both stay in the ledger, because "when did this fail, and why" is a question somebody
  asks.
- **A customer's lifetime value is a union**, exactly like their timeline: payments recorded against
  the customer _and_ payments recorded against the lead they came from. Conversion re-parents
  nothing (`FR-DEAL-4`), so a deposit taken before the sale closed is still on the lead — and it is
  still this customer's money.
- **It is cheap.** Two indexed aggregates over a handful of rows, against `payments_received`
  (partial on `status = 'succeeded'`). A workspace with ten thousand receipts still sums only the
  ones belonging to one deal or one customer.
- **It is self-healing.** A figure that somehow drifts — a bad migration, a hand-edited row — is
  corrected by the next write, because the next write does not trust the old value.

**A refund is a status, not a negative row.** `payments_amount_positive` is a constraint, so a
negative payment cannot exist. Reversing one sets `refunded_at` and takes it out of every total
while leaving the record of having received it. The alternative — a compensating negative row —
would make `SUM(amount_minor)` the only safe way to read anything, break "how much did this customer
pay us" into "net of refunds", and leave `amount_minor > 0` unenforceable.

**Partial payments are rows.** Three instalments are three rows, each with its own date, method and
reference. Nothing caps the total at the deal's value: an advance for next year's work and an
overpayment somebody has to refund are both real, and refusing them would make the system disagree
with the bank statement. `outstanding_minor` is presented as `max(0, value − paid)`, because an
overpayment is a refund to arrange rather than a negative debt.

## Consequences

- The four columns can always be checked against the ledger with one query, which is a test and also
  an answer to "is this number right".
- Conversion does **not** recompute a customer's rollups: the figures are derived, and derived
  figures are recomputed on write. A lead's deposit therefore appears in the customer's lifetime
  value at the next payment write, not at the instant of conversion. Making conversion recompute
  would be correct too; it is deliberately not done, because then two modules would own the same
  four columns.
- **Partial refunds are not representable.** `refunded` is all-or-nothing. A half refund is a second
  document (a credit note) with its own number, which belongs with the GST surface rather than here.
- A provider adapter, when it arrives, writes through this same service and the same statuses;
  `payments_provider_payment_key` is already the idempotency key its webhook needs (`CLAUDE.md`
  rule 12).

## Alternatives rejected

| Alternative                                    | Why not                                                                                            |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `paid_minor = paid_minor + :amount`            | Every reversal needs a compensating decrement; one missed path drifts silently, forever            |
| Compute the totals at read time, store nothing | A pipeline report sums thousands of deals; and a stored total is what a dispute is settled against |
| A negative row for a refund                    | Makes `amount_minor > 0` unenforceable and turns every total into "net of refunds"                 |
| Cap a payment at the deal's value              | An advance and an overpayment are real; the system would disagree with the bank                    |
| A nightly job that reconciles the columns      | The figures would be wrong for up to a day, on the screen somebody is looking at now               |
