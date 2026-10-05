# ADR-0016 — An import creates leads through the domain service, never by bulk insert

**Status:** Accepted · **Date:** 2026-10-05 · Refines `product-requirements.md` `FR-IO-1`, `FR-IO-2` · Phase 2 step 5

## Context

An import is the fastest way to put ten thousand leads into a workspace, and the fastest way to put
ten thousand _broken_ leads into one.

The obvious implementation is a bulk insert: map the rows, validate them, and write them with one
`COPY` or a batched `createMany`. On this schema that is roughly two orders of magnitude faster than
creating them one at a time, and for a pure data migration it would be the right answer.

It is the wrong answer here because of what creating a lead _means_ in this product. `POST /leads`
does five things besides inserting a row:

1. runs the tenant's **duplicate rules**, which may refuse the capture or attach it as a touchpoint
   on a lead that already exists (`FR-DUP-1`–`FR-DUP-3`);
2. runs the **assignment engine**, so the lead has an owner before there is any window in which it
   belongs to nobody (`FR-ASG-1`);
3. validates **custom values** against the tenant's own field definitions;
4. writes the **timeline entry** a person reads (rule 6);
5. emits `lead.created` **through the outbox**, which is what makes scoring, notifications and every
   later phase react (rule 5).

A bulk insert does none of them. The result looks correct in the database and is wrong in every way
that matters: ten thousand leads with no owner, no timeline, no score, duplicates of each other and
of what was already there, invisible to every rule the business configured. `FR-IO-2` states the
requirement as "import MUST apply duplicate rules (never blind-create)", and that is not a
constraint a faster write path can satisfy halfway.

## Decision

**`ImportRunnerService` processes rows one at a time through `LeadsService.create` and
`LeadsService.update`.** An imported lead is indistinguishable from a typed one. Four things follow:

1. **The three import modes differ only in what they do with a match, never in what a match is.**
   `create_only` hands the row to `create` and lets the tenant's rules decide. `skip_existing` and
   `update_existing` ask `DuplicateDetectionService` first — the same service, the same matcher —
   because they express something the rules cannot: "I am re-uploading a list I have imported
   before."
2. **The run acts as the person who asked for it.** `PrincipalService.build()` rebuilds their
   permissions and data scope; a system principal would let an import update leads its requester may
   not see, and would leave the audit trail naming nobody. If their access was revoked between
   pressing Import and the worker picking the job up, the run fails saying so.
3. **A row is a record.** Every row gets an `import_rows` row — created, updated, attached, skipped
   or failed, with the cells as they arrived. That is what makes the run **resumable** (the rows
   already recorded are the rows already done), what makes the error file reproduce a row exactly,
   and what answers "where did this lead come from" six months later.
4. **A row never fails the run.** Only a fault that makes the whole run impossible does. A run that
   stops at row 1 400 of 5 000 and leaves a person guessing is worse than sixty recorded failures
   they can fix and re-upload.

## Consequences

**Positive:** there is exactly one way a lead comes into existence, so a duplicate rule, an
assignment strategy or a new timeline entry written for the manual path applies to imports the day it
ships, with no second implementation to keep in step. Which is also the only reason the duplicate
behaviour can be stated as a guarantee rather than as a hope.

**Negative, and measured:** **~35 rows per second** — 10 000 rows in a little under five minutes on
the development machine, against ~2 ms per row for a batched insert. That cost is the duplicate
query, the assignment decision, the history rows, the timeline write and the outbox event, per row.
It is why imports are a background job with a progress bar and a cancel button rather than a request,
why the `imports-exports` queue runs at concurrency 5 (each job is long and holds a file in memory),
and why the per-row cap is 50 000. **This number is the point, not a regression to optimise away.**
A future release that needs more throughput should buy it by making the _lead path_ faster — a
batched duplicate pre-query, a cheaper assignment read — not by bypassing it.

A 10 000-row import also emits 10 000 `lead.created` events through the outbox — 9 769 of them on
the measured run, every one dispatched and scored with nothing left waiting, because the scoring
queue at concurrency 10 is comfortably faster than 35 rows a second. That headroom is a consequence
of the slow import rather than a separate piece of luck, and it is worth knowing it is there: a
future faster import path would put the backlog into the scoring queue instead. The alternative —
not scoring imported leads — would mean a freshly imported list has no scores, therefore no bands,
therefore nothing in the hot-lead view the business opens first.

## Alternatives rejected

- **`COPY`/`createMany` with the rules applied afterwards.** Duplicate detection after the fact
  cannot _prevent_ the second record, only report it — and "attach to existing" is specifically the
  outcome where no second record exists. There is no post-hoc equivalent.
- **A separate, simplified import path with its own validation.** A second definition of what a lead
  is, which drifts the first time either side changes, and the drift is silent because both paths
  produce rows that look fine.
- **Batches inside one transaction.** A failure anywhere rolls back work a person can see has
  happened, and a 10 000-row transaction holds locks for minutes. Per-row commits are what make the
  progress bar honest and the run resumable.
- **A faster path chosen above some row count.** Two behaviours for the same feature, with the
  dangerous one reserved for the largest files — exactly the imports where a mistake is hardest to
  undo.
