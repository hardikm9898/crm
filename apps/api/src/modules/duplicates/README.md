# duplicates

The same person, captured twice. `FR-DUP-1`–`FR-DUP-4`.

A B2C business buys the same lead more than once — a form on Monday, a WhatsApp message on
Wednesday, a call on Friday — and the cost of getting this wrong runs both ways: two records mean
two people chasing one customer, while a wrong merge silently destroys history nobody can get back.
So detection and merging are separate: detection is automatic, merging is a decision, and every
merge is undoable.

## What lives here

| Route                                  | Permission        | Notes                                                 |
| -------------------------------------- | ----------------- | ----------------------------------------------------- |
| `GET /duplicates`                      | `lead:read`       | The triage queue; filter by status and confidence     |
| `POST /duplicates/:id/dismiss`         | `lead:merge`      | "Different people" — the pair is never raised again   |
| `GET /duplicates/matchable-fields`     | `lead:read`       | What a rule may match on, and how each field compares |
| `GET /duplicates/rules`                | `lead:read`       | In priority order                                     |
| `POST /duplicates/rules`               | `settings:manage` | Refuses criteria too weak to discriminate             |
| `PATCH`/`DELETE /duplicates/rules/:id` | `settings:manage` | Soft delete                                           |
| `POST /duplicates/test`                | `lead:read`       | "What would happen to this capture?" — writes nothing |
| `GET /duplicates/mergeable-fields`     | `lead:read`       | So a merge screen does not hardcode the field list    |
| `POST /duplicates/merge`               | `lead:merge`      | Field-by-field choices; returns a `mergeId`           |
| `POST /duplicates/merges/:id/undo`     | `lead:merge`      | Restores both records                                 |

## A rule is a list of field sets

`[["phoneE164"], ["email", "lastName"]]` reads "the same phone, **or** the same email and surname".
A list of sets rather than a boolean expression for two reasons: it is how a business states the
rule out loud, and each set maps to one indexed lookup.

`validateMatchOn` refuses a set that would not discriminate — `["city"]`, or
`["firstName", "city"]`. Such a rule passes any schema check and would then quietly group strangers,
which is the one duplicate-detection failure a business cannot recover from.

## The phone columns are aliases of each other

A number that arrived in `whatsapp_e164` and the same number in `phone_e164` are the same person, so
`MATCHABLE_FIELDS` declares the two as aliases and a rule naming either sees both, on both sides of
the comparison. This is not a nicety: a WhatsApp conversation (Phase 5) creates a lead with only a
WhatsApp number, and without the alias it would never match the form capture from the same person.

The matched fields are reported under the name **the rule used**, so an explanation names a
manager's own rule back to them rather than an internal column they never configured.

## Detection is two stages, and they must agree

1. **A narrow candidate query** — the indexed identifier columns only (`phone_e164`,
   `whatsapp_e164`, `lower(email)`) plus the lookback window, capped at 50 rows. Every valid rule
   carries an identifier in each set, which is what makes this possible on the write path.
2. **Exact comparison in memory**, using the same pure matcher (`@leados/shared/duplicates`) that
   the rule tester uses — so the answer a manager sees in the tester is the answer the write path
   gave.

Stage 1 being wider than stage 2 is a real bug class, not a theoretical one: the candidate query
looked in both phone columns before the matcher did, so it fetched the right lead and the matcher
then rejected it. That is what the alias above fixed.

Rules are evaluated in priority order and **the first that matches decides** — not the
highest-confidence match. A business that puts `reject` above `attach_to_existing` is saying
something, and overruling it with a better score would be the engine second-guessing the operator.

## The four actions, and which of them can lose information

| Action               | What happens                                                                                 |
| -------------------- | -------------------------------------------------------------------------------------------- |
| `attach_to_existing` | No new lead. A touchpoint is appended, blanks are enriched, two timeline entries are written |
| `create_and_link`    | A new lead, linked to the original and queued in `lead_duplicates` for a person              |
| `reject`             | The capture is refused with `409` and the reason names the existing lead                     |
| `create_new`         | Detection is recorded on the timeline and otherwise ignored                                  |

Only `create_and_link` leaves a row in `lead_duplicates`: attaching _resolves_ the pair, so queueing
it would ask a person to decide something already decided. The provisioned default is
`attach_to_existing` because it is the only action that cannot lose the second capture.

Enrichment fills blanks and **never overwrites an answer**. A customer mistyping their surname on a
second form must not rename themselves; consent is widened but never narrowed.

## A merge is undoable, and that is a schema property

`merge()` moves activities using the full composite primary key (`id, occurred_at` — the table is
partitioned), renumbers touchpoints onto the survivor's sequence, drops tags and pairs that would
become redundant, soft-deletes the absorbed lead, and snapshots every survivor column it overwrote
into `lead_merges.snapshot`. `undo()` replays that snapshot.

`lead_merges_one_standing_per_merged_lead` is a **partial** unique index
(`WHERE undone_at IS NULL`): one standing merge per absorbed lead, and a lead that was merged,
restored and merged again is representable. A plain unique index would have made the second merge
impossible, which is a thing nobody discovers until a user tries it.
