# views

Saved filters, and the compiler behind them. `FR-VIEW-2`, `FR-VIEW-3`.

## What lives here

| Route                       | Permission  | Notes                                                          |
| --------------------------- | ----------- | -------------------------------------------------------------- |
| `GET /views/fields`         | `lead:read` | Everything filterable, with each field's operators             |
| `GET /views`                | `lead:read` | What this caller can see, system views first                   |
| `GET /views/:id`            | `lead:read` | 404 for a private view that is not theirs                      |
| `POST /views`               | `lead:read` | Anybody who can read leads can save how they look at them      |
| `PATCH`/`DELETE /views/:id` | `lead:read` | Editing a **shared** view additionally needs `settings:manage` |
| `POST /leads/search`        | `lead:read` | Runs a `viewId` or an ad-hoc `filter` — the same path          |

## A filter is data, and it is validated before it is stored

Three properties make saved views worth having:

1. **It is data, not a query.** A view is a row the business owns; it survives a new custom field, a
   renamed status and a deploy.
2. **It is validated on save.** A view that fails at read time fails on somebody's dashboard, at the
   moment they are trying to start work. Saving compiles the filter against the tenant's catalogue —
   if it compiles, it runs.
3. **Its dates are relative.** A date condition may carry a _named window_ (`{ window: 'today' }`)
   rather than a timestamp. "Today's follow-ups" saved with an absolute date is wrong tomorrow and
   misleading forever, and it is the one view an executive opens every morning.

The shape is the same flat AND-within-group / OR-across-groups form the assignment and scoring rules
use. One vocabulary, three features.

## The compiler emits Prisma predicates, never SQL

Not squeamishness about string building: the tenant-scoping extension works by rewriting Prisma's
`where`, so a filter assembled as raw SQL would bypass the layer that makes one tenant unable to read
another's leads. A filter arrives in a request body and is stored as JSON — it is the last thing that
should be near a query string.

Data scoping is applied **after** the filter compiles and combined with `AND`, so a filter can only
narrow what a caller may see. A filter naming somebody else's leads returns nothing rather than being
refused; the refusal would confirm they exist.

## Three kinds of field, and the third is where the work is

1. **Columns** — `city`, `statusId`, `score`. A direct predicate.
2. **Custom fields** — `custom.budget`. A JSONB path predicate against `custom_values`. The _path_
   comes from the type registry: a currency value is stored as `{ currency, amountMinor }`, so the
   comparison has to reach `budget.amountMinor`. Comparing the object itself matches nothing —
   silently, which is how that was found. Money is filtered in **minor units**, and the catalogue
   says so per field (`valueUnit: 'minor'`).
3. **Computed** — `tagIds`, `ageInDays`, `idleDays`, `isDuplicate`. Each is rewritten into something
   indexable: "older than 30 days" becomes a bound on `created_at`, not a subtraction per row. Note
   the inversion — **older** means an **earlier** timestamp, and getting it backwards silently shows
   a manager the wrong half of their pipeline.

## Visibility is enforced on read

Private → the owner only. Team → members of that team. Organization → everyone who can read leads.
A private view that is not yours answers **404**, not 403: confirming it exists is itself a leak of
somebody's work.

A private view belongs to whoever made it; a shared one belongs to the workspace, so it survives that
person leaving. Sharing hands ownership over, and making it private again takes it back. A system
view is editable — a business that wants "Hot leads" to mean something else should be able to say so
(rule 4) — but changing a view **other people use** needs `settings:manage`, because it changes
everyone's list.
