# ADR-0015 — A lead's score is the sum of its score events

**Status:** Accepted · **Date:** 2026-09-30 · Refines `product-requirements.md` `FR-SCR-2` · Phase 2 step 3

## Context

`FR-SCR-2` requires the score to be **explainable**: "the UI shows which rules contributed how many
points". There are two ways to build that, and they differ in what happens when they disagree with
themselves.

The obvious one is a **computed score**: store the number, and separately log what changed it. The log
is for humans; the number is authoritative. It is simple to write and it is what most CRMs do.

Its failure mode is the one that matters. The log and the number drift — a job retries, a merge moves
rows, a band edit runs halfway, a bug writes the column directly — and then a business owner reads
"Source: Facebook +20, Repeat enquiry +30" under a score of 35 and asks which is lying. There is no
answer, and after that they do not trust the score at all. A scoring engine nobody trusts gets turned
off, at which point it is worse than not having built it, because the assignment rules and the views
that filter on band are now wired to a number nobody believes.

## Decision

**`leads.score` is a cache of `sum(lead_score_events.delta)`, clamped to 0–1000.** Every change to a
score is a row carrying its delta, its reason, and the resulting balance. Four things follow, and each
is a property rather than a convention:

1. **The breakdown is the arithmetic.** `GET /leads/:id/score-breakdown` returns the events, their
   running balances, and `addsUp` — computed, not asserted. If the cache ever drifts, the API says so
   instead of hiding it.
2. **Repair is a re-sum.** `POST /leads/:id/recompute-score` sets the column to the sum. It writes no
   score event: a repair is not a scoring event, and recording the drift as one would break the very
   invariant it restores — the events would then sum to the old wrong number plus a correction.
3. **Idempotency is a unique index**, `(organization_id, lead_id, rule_id, source_event_id)` where a
   source event exists. An at-least-once redelivery scores once, enforced by Postgres rather than by a
   check-then-write.
4. **Decay needs no bookkeeping column.** How much a decay rule should have taken off by now is a
   function of elapsed time; how much it has taken off is the sum of its own rows. A missed nightly
   sweep catches up; a second run the same night takes nothing.

The cached column stays because the alternative — summing on every read — would put an aggregate in
the lead list, the kanban, every band filter and every assignment decision.

**A write lock is part of the decision, not an implementation detail.** Scoring runs off a queue at
concurrency 10 and the same lead routinely has two events in flight. Every path that changes a score
takes `SELECT … FOR UPDATE` on the lead first and reads the score, the band, the per-rule applied
counts and the decay-so-far _after_ the lock. Without it, two jobs read 0 and both write 15: two
events worth 30 under a score of 15, which is exactly the drift this ADR exists to prevent. That was
found by running three real captures through the real queue.

## Consequences

**Positive:** the number is auditable to the point of being reconstructible; a cap is countable; a
replayed event is free; a deleted rule loses none of its history, because the reason is stored as text
rather than assembled from the rule at read time.

**Negative:** a row per scored event, which grows with engagement rather than with leads — Phase 5's
WhatsApp scoring will make `lead_score_events` one of the larger tables, and it will want the same
monthly partitioning `activities` has. The lock also serialises scoring **per lead**, so a burst of
events on one lead processes in sequence; different leads still score in parallel, which is the shape
of the real load.

## Alternatives rejected

- **Computed score with a separate audit log.** The drift above, with no way to answer it.
- **Sum on read, no cached column.** Correct by construction and unaffordable: every lead list, every
  kanban column and every band filter would carry an aggregate.
- **Recompute from the rules rather than from the events.** Requires the historical events — a lead's
  status three months ago, the form it arrived on — which are not kept in a replayable form, so it
  would invent a different number and call it a repair.
- **Optimistic concurrency (a version column, retry on conflict) instead of a lock.** Equivalent
  correctness, worse failure mode: under a burst on one lead it turns into retry storms in a queue
  that is already at-least-once, and the retries are invisible until the queue backs up.
