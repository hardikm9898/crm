# ADR-0025 — Quiet hours hold a notification, and the release re-checks whether it still matters

**Status:** Accepted · **Date:** 2026-10-13 · **Phase 3, step 4** · Traces to `FR-NOT-1..3`

## Context

`notification_preferences` has existed since the very first migration, with `channels` and
`quiet_hours` columns, and **nothing has ever read it**. Every notification this product sends — a
follow-up reminder, an overdue sweep, an SLA escalation — went out whatever the hour and whatever
the person had asked for. `FR-NOT-3` asks for "per-user, per-type, per-channel preferences with
quiet hours and digest options; system/security notices are not opt-out", and the last two steps of
this phase each carried the same item forward: neither sweep is quiet-hours aware.

Holding a notification is arithmetic. The question holding one _creates_ is the hard part: what do
you do at 07:00 with a warning written at 21:40 about a follow-up somebody finished at 08:15?
Delivering it is worse than never holding it — it reads as the product being a day behind, and the
one thing a notification must be is current.

## Decision

### 1. The gate is in `NotificationsService.create`, not in the producers

Five producers write notifications today and every one of them calls `create`. A check in each
would be five places to forget it, and the sixth producer somebody adds next month would ship
without one. `create` already answered `null` for somebody who is not a member of the workspace, so
callers already treat "no notification was written" as a normal outcome.

The gate has three answers: **write and deliver**, **write and hold**, or **do not write at all**. A
type somebody switched off leaves no row — a notification nobody will ever see is not a record worth
keeping, and leaving one would make the unread badge and the inbox disagree about what "off" means.

### 2. Quiet hours live on the person, not on the notification type

`docs/database-design.md` §13 had `quiet_hours` and `digest` on `notification_preferences`, whose key
is `(organization_id, user_id, type)`. That is one copy of the person's quiet hours per notification
type, and copies can disagree with each other.

So the two facts are split by their real cardinality:

- **`notification_settings`** — one row per person per workspace: the quiet window as two
  wall-clock minutes on a local day, and the zone to read them in (null ⇒ the workspace's).
- **`notification_preferences`** — one row per type the person has actually changed: which channels
  that type goes out on. Absence means the registry's default, so a new notification type reaches
  everybody without a row being backfilled per person.

Per workspace, not per person globally: somebody consulting for two businesses in different
timezones has two sets of working hours and two sets of quiet ones.

### 3. Minutes on a local day, and the release instant is the window's end

The same storage decision the working-hours calendar made, for the same reason: "21:30 to 07:00"
has to survive a clock change, and an instant does not. `quietHoursHold` returns **the end of the
window in the person's own zone** rather than `now + n hours` — adding a duration would deliver at
06:00 on the spring-forward morning and at 08:00 on the autumn one, and the second is an hour late
on the day somebody has an extra hour to read it. Both DST nights are asserted in
`packages/shared/src/notifications.spec.ts`.

A window whose ends are equal is ambiguous — "never quiet" or "always quiet"? — so the database
refuses it (`notification_settings_quiet_hours_distinct`) and the API answers with a sentence rather
than a constraint name. Half a window is refused too: the reader would have to invent the other end,
which is how somebody's quiet hours silently become "until midnight".

### 4. A held notification is re-checked when it is released

Each type declares what makes it stale (`NOTIFICATION_TYPES[].staleness`):

- `task_still_open` — a reminder or an overdue notice is dropped if the follow-up has since been
  finished, cancelled or deleted.
- `clock_still_running` — a near-breach warning is dropped if the promise has since been answered.
- `never` — released as written. **The breach notice is `never`**, deliberately: a missed promise is
  a fact about the past, and the morning after is exactly when somebody should hear about it. The
  clock being answered at 08:00 does not unmake the breach, unlike the warning, which was about a
  deadline that has stopped mattering.

A type with no registry entry is **never** stale: a producer added without one should deliver and be
noticed, not disappear. Silence is the one failure nobody debugs — the same default the timeline
registry takes.

A dropped notification is marked `superseded_at` rather than deleted. "Was I ever told?" then has an
answer, and the answer is "no — it was held until 07:00, and by then you had already done it".

### 5. Visibility is the sweep's write, not the passage of time

The inbox and the unread count both filter on `deferred_until IS NULL AND superseded_at IS NULL`.
The alternative — showing a row once `deferred_until <= now()` — would make it visible _before_
anything had checked whether it still mattered, so somebody opening the app at 07:00:10 would read
a warning the 07:01 sweep was about to drop.

The cost is named rather than hidden: **with no worker running, held notifications are not
released.** That is the same failure the product already has for reminders, overdue sweeps and
outgoing mail, and it is why the release cron runs every minute rather than every five — a window
that closes at 07:00 should deliver at 07:00, not "some time in the first five minutes of your
morning".

### 6. Only the channels that can actually be delivered are offered

`in_app`. The email adapter and the WhatsApp sender are later steps, and a preferences screen with a
tick box for a channel that silently drops every message is worse than one that says the channel is
not here yet — somebody would turn the in-app notification off in favour of an email that never
arrives. `PATCH` refuses `email` with a sentence saying so.

For the same reason `digest` is **not** implemented, although §13 lists the column: a digest is an
email feature, and a daily summary of an inbox somebody is already looking at is not a feature.

### 7. Only the person can read or write their own settings

`@NoPermissionRequired('own notification preferences')`, scoped to `principal.actorId`, and there is
no route by which a manager edits somebody's quiet hours. A preference that somebody else can change
is not a preference — and "the system kept telling me at 11pm" would become unanswerable. The
generated route-authorization suite lists the `PATCH` among its reviewed self-scoped writes, which
is how it caught the route on the commit that added it.

## Consequences

- Every future producer gets preferences and quiet hours for free, and cannot opt out of them.
- `NOTIFICATION_TYPES` is now the list the preferences screen renders. Adding a producer without a
  registry entry gives a notification nobody can switch off — the registry spec asserts the shape
  of every entry, and the web spec asserts the screen has a heading for every group.
- Seven of the thirteen types `FR-NOT-2` lists exist. The other six arrive with the modules and
  channels behind them; listing all thirteen would give the screen six switches that control
  nothing, which is the kind of half-truth that makes somebody stop believing the rest of it.
- `notifications` grew two nullable columns and one partial index
  (`notifications_awaiting_release`), which is platform-wide like the SLA sweep's and therefore
  something Prisma's next diff will propose dropping. It is listed in
  `packages/db/src/schema-objects.int-spec.ts`.

## Alternatives considered

- **A `type = '*'` sentinel row** for the person's defaults, keeping one table. Rejected: a magic
  string in a `type` column, and `quiet_hours` on a typed row would have no defined meaning.
- **Quiet hours on `Membership`.** It is the right cardinality, but it couples an IAM table to the
  notification module, and `Membership` is read on every request.
- **Deleting a stale notification** instead of marking it superseded. Cheaper, and it loses the only
  record that would answer "why was I never told about X".
- **Deferring at _delivery_ time rather than at write time** — i.e. writing every notification
  immediately and filtering the inbox by the reader's quiet hours. Rejected: the hold has to be a
  decision made once, at a known instant, or the same notification is visible or not depending on
  when somebody looks, and the staleness check has nowhere to hang.
