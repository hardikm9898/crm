# leads

The entity the product exists to serve.

## What lives here

| Route                                          | Permission    | Notes                                                      |
| ---------------------------------------------- | ------------- | ---------------------------------------------------------- |
| `GET /leads`                                   | `lead:read`   | Scoped by grant; filters for unassigned and no-next-action |
| `POST /leads`                                  | `lead:create` | Seat-limited by the `leads` entitlement                    |
| `GET /leads/:id`                               | `lead:read`   | Re-checks authority on the row                             |
| `PATCH /leads/:id`                             | `lead:update` | Fields only — never a transition                           |
| `DELETE /leads/:id`, `POST /leads/:id/restore` | `lead:delete` | Soft; a recycle bin                                        |
| `POST /leads/:id/status`                       | `lead:update` | Demands a lost reason when the status is a loss            |
| `POST /leads/:id/stage`                        | `lead:update` | Checks the stage's required fields                         |
| `POST /leads/:id/assign`                       | `lead:assign` | `null` returns the lead to the pool                        |
| `PUT /leads/:id/tags`                          | `lead:update` | The intended final set                                     |
| `POST /leads/:id/touchpoints`                  | `lead:update` | Appends; never overwrites                                  |
| `GET /leads/:id/timeline`                      | `lead:read`   | The journey, newest first                                  |

## Every mutation does four things at once

In one transaction: change the row, write the structured history a manager queries
(`lead_status_history`, `lead_stage_history`, `lead_assignments`), write the timeline entry a person
reads (rule 6), and emit the domain event later phases subscribe to (rule 5). Splitting any of them
out would produce a lead that moved with nothing knowing why.

## Transitions are endpoints, not fields

Status, stage and assignment each have their own method because each has its own permission
(`lead:assign` is not `lead:update`), its own preconditions, and its own history table. A general
`PATCH` that happened to include `stageId` could not check the stage's required fields — the check
would be conditional on what the client chose to send.

## Reading is scoped twice

`list` applies `DataScopeService.filterFor`, so `lead:read` at `own` returns the caller's leads even
when they ask for everything. `findOne` and every write additionally call `canAct` on the row,
because **knowing an id must never be authority**. Both answer `404`, not `403`: confirming the lead
exists would itself leak.

## Phone numbers

Normalized to E.164 on write using the organization's default country, with the raw form kept in
`phone_raw` for support conversations ("the number I was given was 98765 43210"). A database CHECK
enforces the E.164 shape, because duplicate detection compares these as strings and one unnormalized
row would silently stop matching its own duplicates. Custom fields of type `phone` are normalized the
same way, so the two are comparable.

## Attribution starts at creation

A `lead_touchpoints` row is written when the lead is created, not on the second contact — attribution
that starts late has already lost the answer to "where did this lead come from". Touchpoints are
**appended**: the same person reached through three channels is one lead with three touchpoints, and
the first is never overwritten (`FR-ATT-1`). `cost_attributable` is false for manual entries and
imports, so a hand-typed lead cannot inflate cost per lead.

## Search

`searchIds` is the one place in this codebase where a tenant filter is written **by hand**, because
`search_vector` is a tsvector Prisma cannot express and the scoping extension cannot see inside a raw
query. The `organization_id = $1` bind is therefore load-bearing and worth reading twice. It combines
the trigger-maintained full-text vector with `ILIKE`/trigram fallbacks, so "the last four digits of
the number" and a misspelt name both work.

## The timeline read is here, the write is not

`LeadTimelineService` is the product surface. The writer is `infra/timeline`, because every module
uses it. The read resolves actor names from `users` at request time rather than trusting the
denormalized label, so a rename shows everywhere and a departure degrades to "Removed user". Cursors
carry both halves of the composite primary key, since `activities` is partitioned and an id alone
does not identify a row.

## Deferred to later steps

Duplicate detection and merge, the assignment engine (strategies, round-robin, capacity, working
hours), the scoring engine, the filter DSL and saved views, import/export, bulk actions, customers
and deals. Columns whose tables do not exist yet are deliberately absent from the schema rather than
present as unconstrained uuids — see `docs/database-design.md` §6.1.
