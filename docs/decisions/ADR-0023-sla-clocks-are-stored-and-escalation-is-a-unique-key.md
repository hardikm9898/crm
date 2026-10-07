# ADR-0023 — An SLA clock's due instant is stored, and escalating once is a unique key

**Status:** Accepted · **Date:** 2026-10-07 · **Phase 3, step 2** · Traces to `FR-TSK-8`

## Context

`FR-TSK-8` promises "per-source/priority first-response and next-response targets; SLA clocks
respect working hours; breach and near-breach raise escalation to the manager and are reportable".
The phase's exit criteria sharpen two of those into things that can be got wrong invisibly:

- **the clock respects working hours and holidays across timezones, DST included**, and
- **overdue and near-breach escalate to the manager exactly once.**

`working_hours` and `holidays` have existed since the first migration with a single reader — the
assignment engine, asking "is this person on shift right now". An SLA needs the same rows read as a
_calendar_: not "are we open" but "when will we next be, and for how long".

## Decision

### 1. `due_at` and `warn_at` are computed when the clock starts, and stored

Both are derived by walking the workspace's calendar (`addBusinessMinutes`) at the moment of
capture, and written to the row. They are not recomputed at read time.

Two reasons, and the second is the one that matters:

- **The sweep needs one indexed query across every tenant.** `sla_clocks_awaiting_breach` is a
  partial index on `due_at WHERE state = 'running'`; a derived due instant would make the sweep a
  full scan plus a calendar walk per row.
- **A promise that was made was made.** Recomputing against a calendar somebody has since edited —
  a new holiday, changed opening hours, a relaxed target — would silently move a deadline that had
  already been communicated, and let a breach un-breach itself. `sla_clocks.target_minutes` records
  what each clock promised, so a report can still say so after the policy changes. Editing a policy
  therefore affects **new clocks only**, which the API says in its own response message.

### 2. Escalating exactly once is a unique key, not careful code

`escalations` is unique on `(organization_id, clock_id, level)`, with level 1 the near-breach warning
and level 2 the breach. The sweep **inserts and reads the collision**: `createMany` with
`skipDuplicates`, whose count is the answer. A read-then-write would let two sweeps — two workers, a
manual run beside a cron tick — both pass the read and both notify.

`escalations_level_matches_reason` keeps the two columns from disagreeing, and
`escalations_notified_somebody` makes a row claiming somebody was told when nobody was
unrepresentable. (That one shipped broken: `array_length(arr, 1)` is **NULL** for an empty array and
a CHECK evaluating to NULL is _satisfied_. `cardinality` is the function it always wanted;
`20261007103000_escalation_notified_check` corrects it.)

### 3. `breached` is stored; "is it late" is not

The opposite of the task module's `overdue`, deliberately. Overdue is a fact anybody can recompute
from a due time; a **breach is an event** that was escalated to named people at a named moment, and
recomputing it would lose who was told. So the state is stored.

But `slaHealth()` reads the wall clock: a `running` clock past its due instant already reads
`breached` on every screen. A manager refreshing a board at 10:01 is never told a 10:00 promise is
still fine because a cron has not fired. **The stored state is about having escalated; the reading
is about what is true.**

### 4. A workspace has working hours of its own

Provisioning has written `working_hours` for the _owner_ since Phase 1. It now also writes
workspace-wide rows (`user_id IS NULL, branch_id IS NULL`), and `seedWorkingHours` backfills the
workspaces that already exist.

Without them `SlaCalendarService` finds no calendar and falls back to always-open, which would make
every clock run through the night — wrong, and invisibly so. A branch's own rows win over the
workspace's, because a business with a Saturday-opening Mumbai branch and a closed Pune branch has
two calendars and a lead belongs to one of them.

A workspace with **no** hours at all is treated as always open rather than never open. Never open
would make every due instant `null` and every SLA silently inert; always open is wrong in a
different direction but it is _visible_ — the board fills up and somebody fixes the hours.

### 5. A completed follow-up is what satisfies a first-response clock

`leads.first_contacted_at` and `last_contacted_at` have existed since Phase 2 step 1 with **no
writer** — the same shape as a money column that reads as zero and lies to every report touching it.
A completed task is the first real signal the product has: somebody rang, or sent the WhatsApp, and
logged what happened. Completing one now writes both columns and satisfies the clock.

`SlaService.satisfy` is idempotent on the clock's state — the first thing that answers wins and
everything after it is a no-op — precisely so that the WhatsApp send, the logged call and the email
of later phases can each call it without coordinating.

## Consequences

- A lead captured out of hours comes due in business hours, which is the whole feature. The
  arithmetic is a pure function with 26 tests of its own, three of them across a DST boundary in
  both directions.
- `business_hours_only = false` is an always-open calendar rather than a separate code path, so the
  elapsed-time case is the same function with different data.
- Starting a clock **never throws**. A lead the business paid for must not fail to be created
  because a policy is misconfigured, an `applies_to` is unparseable, or a calendar never opens; the
  board then shows a lead with no promise rather than a capture that failed.
- A clock is started after assignment, so it copies the lead's branch, team and owner and the board
  can be data-scoped without a join.
- A promise that stopped applying is **cancelled**, not satisfied: a deleted lead, a lead absorbed
  by a merge, a lead marked `invalid`. Counting a wrong number as a kept promise is how an SLA
  report becomes flattering and useless. The sweep also skips clocks on soft-deleted leads, so a
  future call site that forgets cannot produce a phantom breach.
- `next_response` is stored on a policy and **no clock is started for it**: it measures a reply to a
  waiting conversation, and the inbox arrives in Phase 5. Starting it now would breach every policy
  that set it.
- Neither the sweep nor the reminder dispatcher is quiet-hours aware. That needs
  `notification_preferences` to carry quiet hours, which is the notification-centre step; it is
  named in the roadmap rather than assumed.

## Alternatives rejected

- **Derive `due_at` at read time.** Rejected above: a full scan for the sweep, and a deadline that
  moves when the calendar does.
- **A `met_on_time` boolean on the clock.** Rejected: it is `satisfied_at <= due_at`, and a second
  copy is a second thing that can disagree with the timestamps it came from. The board counts
  "answered late" with a Prisma field reference comparing the two columns.
- **Escalate from the sweep directly.** Rejected: "write the escalation" and "tell somebody" then
  retry together, and a second consumer (a WhatsApp nudge, a digest) means changing the sweep.
  `sla.at_risk` / `sla.breached` leave through the outbox and one processor serves both, dispatching
  on the envelope's event name. The recipients are resolved **by the sweep and stored on the row**,
  so the escalation and the notifications cannot disagree when somebody's role changes in between.
- **An `sla:manage` permission.** Rejected: a policy is workspace configuration like a status or a
  pipeline, so it is written with `settings:manage`. `sla:read` exists because the _other_ half is
  worth separating — a manager who sees the breach board without being able to move the targets.
