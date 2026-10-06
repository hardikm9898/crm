# modules/deals

The sale itself: what is being sold, for how much, and where it has got to (`FR-DEAL-1`).
Quotations (`FR-DEAL-2`) and payments (`FR-DEAL-3`) are separate modules over the same arithmetic.

- `deals.controller.ts` — `DealsController` (list, board, create, get, timeline, update, items,
  stage, win, lose, reopen, delete, restore) and `ProductsController` (the catalogue)
- `deals.service.ts` — placement, the line-item write, the outcome transitions, the journey
- `products.service.ts` — the catalogue, and the one refusal that matters (below)
- `deals.dto.ts` — request shapes

Reads are `deal:read`; deal writes are `deal:manage`; **product writes are `settings:manage`**,
because a price list is configuration — the person who closes deals is not necessarily the person
who decides what things cost.

## The decisions

**Money is computed in exactly one place.** `lineTotals` / `documentTotals` in
`@leados/shared/line-items`, a pure function over integers, and the database re-checks the result
with `deals_totals_add_up`, `deal_items_net_is_gross_less_discount` and
`deal_items_total_is_net_plus_tax`. A quotation that says ₹1,18,000 and an invoice that says
₹1,17,999 is not a rounding curiosity, it is the end of a sale; the reasoning and the alternatives
rejected are [ADR-0018](../../../../../docs/decisions/ADR-0018-money-arithmetic-in-one-place.md).

**A deal with lines does not accept a `valueMinor`.** `PATCH` refuses it with a sentence
("This deal's value comes from its line items"), because a header total that disagrees with the
lines it is supposed to summarise is the specific failure the CHECK constraints exist to prevent.
A deal with no lines is a perfectly good deal — a single agreed number, typed once — and keeps the
field.

**`PUT /deals/:id/items` replaces the whole set.** Line items have no independent identity worth
addressing: they are a document body, edited as a body, and a per-line PATCH API would invite a
client to add a line and forget to re-read the total. The header is recomputed **in the same
transaction** as the lines, so there is no instant at which the two disagree.

**A deal's subject is a lead or a customer, and the deal is written on both.** `deals_has_subject`
requires one; `recordOnAllSubjects` writes the timeline entry against the deal **and** against the
party, because a business owner reading a lead must see that it was won without opening anything
else. That is rule 6 of CLAUDE.md applied to a second subject, not a convenience.

**The catalogue pre-fills a line and then lets go.** `buildLines` takes the product's name, price
and tax **only when the caller omitted them**; once written, the line owns its numbers. Re-pricing
a product therefore never silently re-prices a deal that was already agreed — and a product that
has been sold cannot be deleted at all (`products.remove` answers "Deactivate it instead"), because
a deleted product would take the history of what was sold with it.

**Won and lost are transitions, not a status field.** `POST :id/win` and `:id/lose` set `won_at` /
`lost_at` (never both — `deals_not_won_and_lost`), move the deal to the pipeline's own won or lost
stage when it has one (`is_won` / `is_lost`, never a stage name), and write the amount and the
reason into the timeline. A loss reason is the tenant's
`lost_reasons` row, not a string; `reopen` clears the outcome and returns the deal to the first open
stage, which is what happens when a customer comes back.

## Traps

- **A service method may not share its name with an injected dependency.** `timeline()` beside
  `private readonly timeline: TimelineService` compiles and then fails at runtime in a way that
  reads like a DI problem. The read method is `journey()`; the controller route is still
  `GET :id/timeline`.
- **The board's totals are the column's, not the page's.** Each column reports `count`,
  `valueMinor` and `weightedMinor` over the whole filtered column while returning one page of
  cards — a board that sums the twenty cards it loaded tells a business owner their pipeline is
  worth a fifth of what it is. `list` does the same thing with `meta.totalValueMinor`.
- **`weightedValueMinor` rounds once, at the end.** `Math.round(valueMinor * probability / 100)`;
  summing per-deal rounded weights drifts by rupees across a large pipeline.
- **Quantity is scaled, not floated.** `quantity` is `DECIMAL(12,3)` and the multiply happens in
  thousandths (`QUANTITY_SCALE`), so 2.5 × ₹1,999.99 is exact. `0.1 * 3` is
  `0.30000000000000004`, and a deal whose lines do not add up to its own total is the result.
- **Discount is applied before tax, per line.** Both orders are defensible; only one can be
  implemented, and tax on a discount nobody paid is the one a customer notices.
- **`LineItemError` carries a field, and the DTO layer indexes it.** `items.2.quantity`, not a
  sentence about "a line item" — a twelve-line quotation needs to say which line.
