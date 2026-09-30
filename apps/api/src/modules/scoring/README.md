# scoring

How hot is this lead, and why. `FR-SCR-1`–`FR-SCR-3`.

## The one decision everything else follows from

**A lead's score is the running total of its score events.** `leads.score` is a cache of
`sum(lead_score_events.delta)`, clamped to 0–1000. Every consequence of that is load-bearing:

- **Explainability is exact, not approximate.** The breakdown a manager reads _is_ the arithmetic
  that produced the number, so it always adds up. `GET /leads/:id/score-breakdown` returns
  `addsUp`, and if it is ever false the cache has drifted and says so rather than hiding it.
- **Repair is a re-sum, not a re-derivation.** Replaying the rules would need the historical events,
  which are gone, and would invent a different number. `POST /leads/:id/recompute-score` sets the
  cached column to the sum and writes **no score event** — a repair is not a scoring event, and
  recording the drift as one would break the invariant it exists to restore.
- **Idempotency is a unique index.** `(organization_id, lead_id, rule_id, source_event_id)` is unique
  where a source event exists, so an at-least-once redelivery of `lead.created` scores once. The
  engine swallows that collision: a duplicate delivery is a success, not a failure.

## What lives here

| Route                               | Permission        | Notes                                         |
| ----------------------------------- | ----------------- | --------------------------------------------- |
| `GET /scoring/triggers`             | `lead:read`       | The registry, live and dormant                |
| `GET /scoring/rules`                | `lead:read`       | In priority order, each marked dormant or not |
| `POST /scoring/rules`               | `settings:manage` | Refuses a rule that could never fire          |
| `PATCH`/`DELETE /scoring/rules/:id` | `settings:manage` | Soft delete; awarded points stay              |
| `GET /scoring/bands`                | `lead:read`       |                                               |
| `PUT /scoring/bands`                | `settings:manage` | The whole set; re-bands every lead at once    |
| `POST /scoring/test`                | `lead:read`       | "What would this lead score?" Writes nothing  |
| `GET /leads/:id/score-breakdown`    | `lead:read`       | On the lead, where a person looks for it      |
| `POST /leads/:id/recompute-score`   | `lead:update`     | It writes, so it is not a read permission     |

## A dormant trigger is refused, not stored

`FR-SCR-1` names website behaviour, WhatsApp engagement and email engagement as scoring inputs, and
none of those events exist before Phases 5, 8 and 9. A rule configured against an event nothing emits
is worse than a missing feature: the business believes their scoring covers engagement and nothing
tells them otherwise. So `SCORING_TRIGGERS` marks each trigger `live`, and creating a rule on a
dormant one is refused with the phase it arrives in.

## The row lock is the correctness of the whole feature

Scoring runs at concurrency 10 off the `scoring` queue, and the same lead routinely has two events in
flight — three captures of one person arrive within milliseconds. Without a lock, both jobs read
`score = 0`, both write `score = 15`, and the lead ends up with two score events worth 30 and a
cached score of 15: **a breakdown that does not add up**, which is the one thing that would make the
number untrustworthy. The same race lets two jobs both pass a `maxApplications` cap of 1 and both
write a "band changed" timeline entry.

So `commit()` opens a transaction, takes `SELECT … FOR UPDATE` on the lead, and only then reads the
score, the band, the per-rule applied counts and the decay already taken off. This was found by
running three captures through the real queue, not by a unit test — the test that would have caught it
is the one that uses a real database and real concurrency.

## Decay is a function of elapsed time, not of how often the sweep ran

"After 14 days with no activity, take 5 points off every 7 days, never below 20." The deduction is
computed as _what should be gone by now, minus what already is_, so a missed night catches up and a
second run the same night takes nothing. There is no "last swept at" column to get wrong.

A lead with **no** recorded activity decays by nothing: a lead captured an hour ago is new, not stale.
The sweep skips tenants with no decay rule entirely, so its cost is paid by the tenants who asked for
it.

## Bands are a partition, enforced twice

Validated as a contiguous cover of 0–1000 with no overlap and no gap — and `score_bands_no_overlap`
is a Postgres **exclusion constraint**, so an overlap is unrepresentable rather than merely refused.
The application check gives the good error message; the constraint is what holds when two band
replacements interleave.

An overlap would make a lead's band depend on evaluation order. A gap would leave a lead with a score
and no band, quietly missing from every band-filtered view the business relies on. Editing the set
re-bands every lead **in the same request** — leaving it to a job means a business renames a band and
their "Hot leads" view is empty until the job runs, which reads as data loss.

## Only a band change reaches the timeline

Rule 6 is about what a business owner wants to see, not about everything that happened. Cold → Hot is
news; 45 → 50 is arithmetic, and the breakdown has it. A timeline entry per +5 would bury the calls
and status changes that matter.
