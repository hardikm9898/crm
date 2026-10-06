# modules/customers

Customers, and the conversion that creates most of them (`FR-DEAL-4`).

- `customers.controller.ts` — list, create, get, timeline, update, delete, restore
- `customers.service.ts` — conversion, direct creation, the journey union, the writes
- `customers.dto.ts` — request shapes

Conversion is exposed as `POST /leads/:id/convert`, on the **lead**: it is a lead transition that
happens to produce a customer, and a client holding a lead should not have to know a second resource
exists to finish the sale.

## The decisions

All five come from taking `FR-DEAL-4` literally; the reasoning and the rejected alternatives are in
[ADR-0017](../../../../../docs/decisions/ADR-0017-customer-is-a-second-record.md).

**The lead is not consumed.** It keeps its row, its touchpoints, its score, its history and its
timeline, and gains a `converted_at` plus a `won` status — chosen by `category`, never by name. The
customer points back at it.

**A customer's timeline is a union, computed at read time.** `activities.lead_id` of the lead it came
from, plus `activities.customer_id` of the customer. Nothing is copied, re-parented or renumbered, so
there is no step at which a touchpoint can be lost — which is exactly what "never a fresh record"
warns about. Both halves go through `TimelineReadService`, which owns the presentation and the cursor
that has to carry both halves of a partitioned table's key.

**The two subjects get different activity types.** `lead.converted` on the lead and
`customer.created` on the customer, at the same instant. They appear together in the union, and two
identical sentences there read as a duplicated row rather than as a handover. It also keeps the
direct-creation case honest: somebody who was never a lead did not convert.

**A lead converts once, and the database says so.** `customers_lead_unique` is partial, so two clicks
or a retried request cannot produce two customers while a workspace full of walk-ins stays
representable. The service's check exists to answer with a sentence rather than a constraint name.

**Authority is checked on both sides.** `customer:manage` is the route's permission, and the lead has
to be inside the caller's `lead:update` scope — converting another branch's lead is not something a
customer permission should grant. Both refusals are **404**: knowing an id is never authority, and
confirming that a row exists is itself a leak.

## Traps

- **Consent is copied at conversion and is authoritative from then on.** Consent belongs to the
  person, so re-asking a customer for permission they gave as a lead would be absurd — but a silent
  copy of a permission is the thing that most needs evidencing, so the carried-over values are
  written into the `customer.created` timeline payload.
- **Custom fields are the `customer` entity's, not the lead's.** The field engine has always been a
  registry over entity types; this is the first module other than leads to use one, and a write
  validated against the lead definitions would accept fields that do not apply and refuse ones that
  do.
- **`full_name` is derived on every write, never accepted from the caller.** Shared with leads
  through `buildDisplayName` in `@leados/shared`, so a workspace cannot have a lead called
  "Kavita Rao" whose customer reads "+919845012345".
- **The owner defaults to whoever was working the lead.** Somebody who has just closed a sale is the
  person the customer expects to hear from, and an unowned account is one nobody follows up.
- **This module does not import `LeadsModule`.** Conversion writes the customer and the lead's status
  history in one transaction; routing the status move through `LeadsService.changeStatus` would mean
  two transactions and a window in which a customer exists for a lead that is still open.
  `LeadsModule` imports _this_ module, for the convert route.
