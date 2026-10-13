# notifications

A person's own in-app inbox, and the consumers that fill it.

## What lives here

| Route                              | Authorization                                           | Notes                                       |
| ---------------------------------- | ------------------------------------------------------- | ------------------------------------------- |
| `GET /notifications`               | `@NoPermissionRequired('own notifications')`            | Cursor-paginated; `unreadOnly=true` filters |
| `GET /notifications/unread-count`  | same                                                    | What the shell's badge reads                |
| `GET /notifications/preferences`   | `@NoPermissionRequired('own notification preferences')` | Quiet hours + a switch per type             |
| `PATCH /notifications/preferences` | same                                                    | Partial: an absent key means "unchanged"    |
| `POST /notifications/:id/read`     | same                                                    | `@AllowWhenRestricted()`                    |
| `POST /notifications/read-all`     | same                                                    | `@AllowWhenRestricted()`                    |

## Decisions worth knowing

**No permission gates these routes, and that is not a gap.** Every query is scoped to
`principal.actorId` inside the service, so the only reachable rows are the caller's own. A permission
would have to be one every role holds, which is a permission that decides nothing — the boot-time
route audit accepts this only with an explicit stated reason (docs/security.md §4).

**Housekeeping stays available in restricted mode.** Clearing your own badge is not a write anyone
needs to pay for, and a read-only tenant staring at an unclearable "3 unread" would reasonably think
the product was broken.

**Rows are written by outbox consumers, not by the request that caused them.** `invitation.accepted`
and `onboarding.completed` produce notifications from the worker, which is why an invitation accepted
at 2am shows up without anybody being online, and why the notification survives a crash in the
request that triggered it (rule 5).

**Consumers are idempotent on `eventId`** and take their subject from the envelope's `aggregateId`,
never from a field inside `payload` — an event emitted by an older release still has to process.

**`list` returns `{ items, pagination, unreadCount }`,** and the envelope interceptor lifts `items`
into `data` and `pagination` into `meta`. `unreadCount` is therefore _dropped_ from the response;
the shell reads `/notifications/unread-count` instead. Anything else added alongside a paginated
list would vanish the same way.

## Preferences and quiet hours (`FR-NOT-3`)

Decisions in
[ADR-0025](../../../../../docs/decisions/ADR-0025-quiet-hours-hold-a-notification-and-the-release-re-checks-it.md).
The short version:

**The gate is in `create`, not in the producers.** Five producers write notifications and every one
of them calls that method; a check in each would be five places to forget it. It has three answers:
write and deliver, write and **hold**, or do not write at all. A type somebody switched off leaves
no row — a notification nobody will ever see is not a record worth keeping, and leaving one would
make the badge and the inbox disagree about what "off" means.

**Two rows behind one screen.** `notification_settings` holds the person's quiet window and its
zone — one row per person per workspace, because quiet hours are a property of the person and
putting them on a per-type row means copies that can disagree. `notification_preferences` holds
which channels each type goes out on, one row per type somebody has actually changed; absence means
the registry default, so a new type reaches everybody without a backfill.

**Held, then re-checked.** `deferred_until` is the instant the quiet window closes, computed in the
person's own zone (`quietHoursHold`, with both DST nights tested). The per-minute
`notifications.release` sweep then re-checks each held notification against its subject before
delivering it:

| `staleness`           | Dropped when                                 | Types                           |
| --------------------- | -------------------------------------------- | ------------------------------- |
| `task_still_open`     | the follow-up is finished, cancelled or gone | `task.reminder`, `task.overdue` |
| `clock_still_running` | the promise has since been answered          | `sla.at_risk`                   |
| `never`               | — delivered as written                       | `sla.breached` and the rest     |

`sla.breached` is `never` on purpose: a missed promise is a fact about the past, and the morning
after is exactly when somebody should hear about it. A type with **no** registry entry is also
never stale — a producer added without one should deliver and be noticed, not disappear.

A dropped notification is marked `superseded_at`, not deleted, so "was I ever told?" has an answer.

**Visibility is the sweep's write, not the passage of time.** The inbox and the unread count both
filter `deferred_until IS NULL AND superseded_at IS NULL`. Showing a row once its instant passed
would make it visible before anything had checked it. The cost, named rather than hidden: **with no
worker running, held notifications are not released** — the same failure the product already has
for reminders, overdue sweeps and outgoing mail.

**Only `in_app` is offered.** Email and WhatsApp arrive with their own channels; a tick box for a
channel that silently drops every message is worse than saying it is not here yet. `digest` is not
implemented for the same reason — a digest is an email feature, and a daily summary of an inbox
somebody is already looking at is not one.

**Nobody else can read or write somebody's settings.** No permission gates the routes (they are
scoped to the caller), and there is deliberately no manager route: a preference somebody else can
change is not a preference.
