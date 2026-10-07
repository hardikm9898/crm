# Tasks and follow-ups

`FR-TSK-1..7`. The product's answer to "what do I do next" — and `FR-TSK-4`'s other half, which is
making the leads nobody owes anything to visible.

## Tables

| Table                | What it holds                                                                  |
| -------------------- | ------------------------------------------------------------------------------ |
| `tasks`              | A thing somebody has to do, about a lead, a customer or a deal                 |
| `task_types`         | The kinds of follow-up this business does, with duration and reminder defaults |
| `task_outcomes`      | How a follow-up turned out, and whether that counts as progress                |
| `reschedule_reasons` | Why a follow-up moved (`FR-TSK-5`), as the tenant's own list                   |
| `task_reschedules`   | Every move, with its reason — what makes `tasks.reschedule_count` explainable  |
| `task_reminders`     | One row per offset, rewritten whenever the due time moves                      |

`leads.next_action_at`, `leads.next_action_task_id` and `leads.open_tasks_count` are written from
here, and only from here.

## Endpoints

| Method                  | Path                           | Permission        |
| ----------------------- | ------------------------------ | ----------------- |
| `GET`                   | `/tasks`                       | `task:read`       |
| `GET`                   | `/tasks/summary`               | `task:read`       |
| `GET`                   | `/tasks/config`                | `task:read`       |
| `POST`                  | `/tasks`                       | `task:manage`     |
| `GET`                   | `/tasks/:id`                   | `task:read`       |
| `GET`                   | `/tasks/:id/reschedules`       | `task:read`       |
| `PATCH`                 | `/tasks/:id`                   | `task:manage`     |
| `POST`                  | `/tasks/:id/complete`          | `task:manage`     |
| `POST`                  | `/tasks/:id/reschedule`        | `task:manage`     |
| `POST`                  | `/tasks/:id/cancel`            | `task:manage`     |
| `DELETE`                | `/tasks/:id`                   | `task:manage`     |
| `GET`                   | `/settings/task-types`         | `task:read`       |
| `GET`                   | `/settings/task-outcomes`      | `task:read`       |
| `GET`                   | `/settings/reschedule-reasons` | `task:read`       |
| `POST`/`PATCH`/`DELETE` | the three settings paths       | `settings:manage` |

Two permissions apply to a write, not one. `task:manage` plus its **data scope** decides which
tasks a caller can touch at all; **`task:manage_others`** decides whether they may act on a
follow-up assigned to somebody else. A workspace that wants executives to own their own queue and
nothing more grants the first and withholds the second — a configuration the permission catalogue
has always offered and nothing was enforcing before this module.

`GET /tasks/config` is readable with `task:read` rather than `settings:manage`: the task form needs
the three dropdowns, and a sales executive has no business holding a settings permission to plan a
call.

## Business logic worth knowing

- **Overdue is derived, never stored.** A task due at 10:00 is overdue at 10:01, not at 10:30 when
  the sweep next runs. `taskBucket()` in `@leados/shared` reads the clock; the sweep's job is to
  _tell_ somebody, which is why it writes `overdue_notified_at` and a timeline entry rather than a
  status. `task_status` therefore has four values, not six.
- **A reschedule moves the same row.** Closing the task and opening another would double the lead's
  open count and put two things on the Today list for one call. The reason is mandatory
  (`FR-TSK-5`), some reasons demand a note, and `overdue_notified_at` is cleared because the next
  miss is news again.
- **Completion requires an outcome**, and the database agrees
  (`tasks_completed_has_outcome`) — which is why deactivating the last active outcome is refused
  rather than allowed and discovered from a constraint name.
- **"Create the next follow-up" happens in the same transaction** (`FR-TSK-6`), so a lead never
  passes through a state where nothing is owed to it. The new task points back with
  `follows_task_id`, which is the chain a manager reads as "five calls over three weeks".
- **`due_date` and `due_time` are the workspace's wall clock, maintained on write.** "Due today" is
  a question about a day, and the day depends on the workspace's timezone; grouping by
  `due_at AT TIME ZONE …` cannot use an index, and a stored local date can.
- **The lead's denormalized next action is recomputed, never incremented** — and the lead's row
  lock is taken **before** the task write. Inserting a task takes a `FOR KEY SHARE` lock on its
  lead, so asking for `FOR UPDATE` afterwards is how two simultaneous creates on one lead deadlock
  and both callers get a 500. `NextActionService.lockLeads` is the whole fix.
- **Rule 6 on every subject**, never twice for the same party: a converted lead appears as itself
  and as its customer, and writing both reads as a duplicated row rather than as one event.

## Events and jobs

Emits `task.created`, `task.completed`, `task.rescheduled`, `task.cancelled` and `task.overdue`
through the outbox. Only `task.overdue` has a consumer today
(`TaskOverdueNotificationProcessor` → the assignee and whoever holds `task:manage_others`); the
others are recorded and listed in `EVENT_SUBSCRIPTIONS` so a typo shows up as "unsubscribed"
rather than as silence.

| Job                      | Schedule     | What it does                             |
| ------------------------ | ------------ | ---------------------------------------- |
| `task.reminder-dispatch` | every minute | Due reminder rows → in-app notifications |
| `task.overdue-sweep`     | every 30 min | `task.overdue` once per missed follow-up |
| `notify.task-overdue`    | on the event | Tells the assignee and their manager     |

**A reminder is a row, not a delayed job.** A delayed BullMQ job per reminder would have to be
cancelled on every reschedule, completion and delete, and job removal is best-effort — so a
reminder for a time nobody is waiting for any more would still fire. Rewriting rows inside the same
transaction as the change cannot drift.

The dispatcher creates the notification **before** marking the row sent: a crash between the two
retries, and `NotificationsService.create` is idempotent on its dedupe key, so the worst case is a
repeated attempt rather than a reminder nobody gets. The other order loses it silently.

## Failure modes

- **The sweeps read across tenants and write inside one.** `withPlatformScope` leaves
  `tenantContext.organizationId()` unset and `TimelineService` takes the organization from the
  context by design, so each row's writes happen inside `tenantContext.run(systemPrincipal(...))` —
  the trap the quotation expiry sweep paid for.
- **A reminder whose moment has already gone is dropped, not fired late.** Being told at 15:00
  about a call due at 14:00 is the overdue sweep's job, and the two arriving together is how a
  notification list becomes noise.
- **A reminder for a finished, deleted or unassigned task is marked sent without being delivered.**
  The row records that its moment passed; there is nobody to tell.
- **Deleting a task writes no timeline entry.** A follow-up created on the wrong lead and removed a
  minute later is not part of that lead's history, and "task deleted" would make the mistake
  permanent on the one screen a business owner reads. Cancelling _is_ recorded — "we decided not
  to" is information.

## Security notes

- Every write goes through `loadForWrite`, which checks the data scope **and** `task:manage_others`,
  and answers 404 either way: a malformed id and somebody else's id must be indistinguishable.
- A task cannot be created about another workspace's lead, carry another workspace's type or end
  with another workspace's outcome — six composite foreign keys say so, and
  `tenant-isolation.int-spec.ts` exercises each.
- `assignedUserId` is checked against an **active membership**, not merely a user row.

## Example payloads

```http
POST /api/v1/tasks
{ "leadId": "…", "title": "Call about the 3BHK", "taskTypeId": "…",
  "dueAt": "2026-04-02T04:30:00.000Z", "priority": "high", "reminderOffsets": [1440, 60] }

POST /api/v1/tasks/:id/complete
{ "outcomeId": "…", "note": "Wants an east-facing flat",
  "nextFollowUp": { "title": "Site visit", "dueAt": "2026-04-05T05:00:00.000Z" } }

POST /api/v1/tasks/:id/reschedule
{ "dueAt": "2026-04-09T04:30:00.000Z", "reasonId": "…", "note": "Decision maker travelling" }
```
