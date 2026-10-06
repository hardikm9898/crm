# modules/payments

Money that actually arrived (`FR-DEAL-3`).

- `payments.controller.ts` — `PaymentsController` (list, record, get, correct, confirm, fail,
  refund, delete) and `PaymentMethodsController` (the methods, under settings)
- `payments.service.ts` — the ledger and its transitions
- `payment-rollups.service.ts` — `deals.paid_minor` and the three `customers` columns
- `payment-methods.service.ts` — how money arrives, as the tenant's own list
- `payments.dto.ts` — request shapes

`payment:read` and `payment:record`, **separate from `deal:*`**: quoting a price and recording that
money arrived are different acts, done by different people in most businesses. A workspace that
wants one person to do both grants both — these are rows. Method writes are `settings:manage`.

## The decisions

The reasoning and the alternatives rejected are
[ADR-0020](../../../../../docs/decisions/ADR-0020-derived-money-is-recomputed.md).

**A deal's value and a deal's payments are different numbers.** `value_minor` is what was agreed,
`paid_minor` is what arrived, and the difference is what a collections call is about. No single
column answers both.

**Partial payments are rows.** Three instalments are three rows, each with its own date, method and
reference. Nothing caps the total at the deal's value: an advance for next year's work and an
overpayment somebody has to refund are both real, and refusing them would make the system disagree
with the bank statement. `outstandingMinor` floors at zero.

**A refund is a status, not a negative row.** `amount_minor > 0` is a constraint. Reversing a
payment sets `refunded_at` and takes it out of every total while leaving the record of having
received it.

**Every derived figure is recomputed from the ledger, never incremented.** `PaymentRollupsService`
takes the row lock and then sums — the trap the scoring queue already paid for, except that here the
drift would be money and nothing would be left to compare the column against.

**A method can require a reference.** The tenant ticks the box; a UPI payment with no transaction id
or a cheque with no number cannot be reconciled, so the API refuses it with a sentence naming the
method. The form shows that requirement as soon as the method is picked, which is the difference
between a form and an argument.

## Traps

- **The two timestamp CHECKs contradicted each other.** `payments_received_has_timestamp` is
  deliberately **not** `(status = 'succeeded') = (paid_at IS NOT NULL)`: a refunded payment did
  arrive and `payments_refund_was_received` requires it to keep that date, so the biconditional made
  refunding anything impossible. It is a `CASE` instead: pending and failed have no date, everything
  else has one. Found by refunding something, not by reading the SQL.
- **Failing a payment clears `paid_at`.** The constraint requires it, and it is also right: a cheque
  that bounced did not arrive on the day it appeared to.
- **A cross-tenant read, a per-tenant write.** Nothing here sweeps across tenants yet, but the
  rollup service takes `organizationId` explicitly and names it in its raw SQL, because
  `$queryRaw` bypasses the scoped client. A raw query on a tenant table that does not name the
  organization is an unscoped query with extra steps.
- **One timeline entry per party, not one per column.** A converted person's timeline is the union
  of their lead's entries and their customer's, so writing against both `lead_id` and `customer_id`
  when both are set shows "they paid" twice. `record_()` keeps the lead row and writes the customer
  row only when it would not otherwise appear. (It is named with a trailing underscore because
  `record()` is the public method that records a payment, and a method that shadows an injected
  `timeline` is a trap this repository has already paid for.)
- **The customer rollup is a union with the lead's payments.** A deposit taken before conversion is
  on the lead and is still this customer's money. Conversion itself does not recompute — the figures
  are derived and are recomputed on write — so a pre-conversion deposit lands in the lifetime value
  at the next payment write. Deliberate: two modules owning the same four columns is worse.
- **Adding a permission does not reach existing workspaces.** `payment:read` 403'd for the owner of
  a seeded workspace five minutes after being written, because its roles were created before the key
  existed. The migration grants the new permissions to the system roles the templates name — and
  `PrincipalService` caches grants for five minutes, so a workspace that was already open keeps
  getting 403 until `invalidateOrganization()` runs or the cache expires.
