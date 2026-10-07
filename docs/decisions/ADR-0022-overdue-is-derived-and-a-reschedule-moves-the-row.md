# ADR-0022 — Overdue is derived, a reschedule moves the row, and a reminder is a row

**Status:** Accepted · **Date:** 2026-10-06 · **Phase 3, step 1** · Traces to `FR-TSK-1..7`

## Context

`FR-TSK-3` lists six task statuses: `pending`, `in_progress`, `completed`, **`overdue` (derived)**,
`cancelled` and **`rescheduled`**. `docs/database-design.md` §6.4 carried five of them in the
`tasks.status` column and gave the table both a `rescheduled_from_task_id` and a
`reschedule_count`, which are two different models of the same event. `FR-TSK-1` asks for reminder
offsets per task, and §5 of the queue document schedules a `task.reminder-dispatch` job every
minute.

Three decisions had to be made before any of it could be built, and each has a wrong answer that
looks right.

## Decision

### 1. `overdue` is derived from the clock, never stored

`task_status` has **four** values: `pending`, `in_progress`, `completed`, `cancelled`. Whether a
task is late is `due_at < now()` on an open task, computed by `taskBucket()` in `@leados/shared`
and by a matching `where` clause beside it for the aggregates.

A stored flag is wrong between the sweep's ticks. A task due at 10:00 is overdue at 10:01; a
half-hourly sweep would make it overdue at 10:30, and the screen would disagree with the clock in
front of the person reading it. What a sweep is actually for is **telling somebody**, which is a
different job from knowing — so `task.overdue-sweep` writes `overdue_notified_at`, a timeline entry
and an event, and changes nothing about what is true.

### 2. A reschedule moves the same row, and `rescheduled` is not a status

Moving a follow-up updates `due_at` on the existing task, increments `reschedule_count`, and
appends a row to `task_reschedules` carrying the old time, the new time and a **mandatory reason**
from the tenant's own list (`FR-TSK-5`).

Closing the task as `rescheduled` and opening a replacement — which the contract's
`rescheduled_from_task_id` hinted at — would put two things on the Today list for one call, double
the lead's open-task count, and make "this lead has been pushed five times" require walking a chain
instead of reading a column. And a `rescheduled` status would drop an open task out of "what is
due", which is the one list it has to stay in.

`rescheduled_from_task_id` is therefore implemented as **`follows_task_id`**, which means something
else: the follow-up created at the moment of completion (`FR-TSK-6`) points back at the task it came
out of. That chain is what a manager reads as "five calls over three weeks", and it is the only
chain worth storing.

### 3. A reminder is a row, not a delayed job

`task_reminders` holds one row per offset per task, with `remind_at` and `sent_at`.
`task.reminder-dispatch` runs every minute over
`(remind_at <= now(), sent_at IS NULL)` — a partial index, so an indexed read of nothing on almost
every tick.

A delayed BullMQ job per reminder is the obvious alternative and it is wrong: the job would have to
be cancelled on every reschedule, every completion and every delete, and BullMQ's job removal is
best-effort, so a reminder for a time nobody is waiting for any more would still fire. Rewriting
rows inside the same transaction as the change cannot drift, and deleting a row is how a reminder is
cancelled.

The dispatcher creates the notification **before** marking the row sent. A crash between the two
retries, and `NotificationsService.create` is idempotent on its dedupe key, so the worst case is a
repeated attempt rather than a reminder nobody gets. The other order loses it silently.

## Consequences

- `task_status` has four values and the migration's enum will not need widening later.
- Every list, counter and screen that asks "is this late" asks the clock. The bucket definitions
  live twice — once in TypeScript for the row, once as a Prisma `where` for the aggregate — and are
  deliberately adjacent, because a change to one that misses the other is a screen whose counts
  contradict its own list.
- `tasks.reschedule_count` is a cache of `count(task_reschedules)` and `task_reschedules` is what
  makes it explainable. A reschedule report (`FR-TSK-5`'s coaching signal) joins the reasons.
- `overdue_notified_at` is cleared by a reschedule, because the next miss is news again.
- `leads.next_action_at` / `next_action_task_id` / `open_tasks_count` are **recomputed** from the
  open tasks after every write, under the lead's row lock — never incremented. The lock is taken
  **before** the task write: inserting a task takes a `FOR KEY SHARE` lock on its lead, so asking
  for `FOR UPDATE` afterwards deadlocks two simultaneous creates on one lead.
- A reminder whose moment has already passed is not written at all. Being told at 15:00 about a call
  due at 14:00 is the overdue sweep's job, and the two arriving together is how a notification list
  becomes noise.

## Alternatives rejected

- **Store `overdue` and sweep it.** Rejected: wrong between ticks, and it makes the truth depend on
  a cron's health. Also needs a second sweep to _un_-overdue a rescheduled task.
- **Reschedule as close-and-replace.** Rejected above: two rows for one call, a doubled open count,
  and `FR-TSK-4`'s "exactly one next action" becomes a chain walk.
- **A delayed job per reminder.** Rejected above: cancellation is best-effort and a stale reminder
  fires.
- **One `outcomes` table shared with calls.** Rejected for now: `docs/database-design.md` §6.4 gives
  `call_outcomes` a provider-level `category` and a `score_delta` that a task outcome has no use
  for, and `calls.task_id` already ties the two records together. `task_outcomes` is its own list
  with `is_positive`, which is what makes "forty calls, nine of them positive" a sentence somebody
  can say.
