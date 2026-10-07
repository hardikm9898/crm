# SLA — policies, clocks, the sweep and escalation

`FR-TSK-8`. The product's answer to "did anybody get back to them, and how fast". `FR-ASG-4`'s
unassigned-pool notification covers the case where nobody _owns_ a lead; this covers the commoner
one, where somebody owns it and nothing happens.

## Tables

| Table          | What it holds                                                              |
| -------------- | -------------------------------------------------------------------------- |
| `sla_policies` | The promise, with its conditions, its targets and who hears about a breach |
| `sla_clocks`   | One promise about one record, with the instant it comes due                |
| `escalations`  | Somebody was told — once per clock per level, by a unique key              |

`working_hours` and `holidays` are read as a **calendar** by `SlaCalendarService`. Both have existed
since the first migration with a single reader (the assignment engine, asking "is this person on
shift"); a workspace-wide row set (`user_id IS NULL, branch_id IS NULL`) is new, and
`seedWorkingHours` backfills the workspaces that already existed.

## Endpoints

| Method   | Path                               | Permission        |
| -------- | ---------------------------------- | ----------------- |
| `GET`    | `/sla/board`                       | `sla:read`        |
| `GET`    | `/sla/clocks`                      | `sla:read`        |
| `GET`    | `/sla/escalations`                 | `sla:read`        |
| `POST`   | `/sla/escalations/:id/acknowledge` | `sla:read`        |
| `GET`    | `/sla/policies`                    | `sla:read`        |
| `POST`   | `/sla/policies`                    | `settings:manage` |
| `PATCH`  | `/sla/policies/:id`                | `settings:manage` |
| `DELETE` | `/sla/policies/:id`                | `settings:manage` |

There is deliberately **no endpoint that starts or satisfies a clock**. Both happen as part of the
write that caused them — a lead being captured, a follow-up being completed, a lead reaching a
terminal status — inside that write's own transaction. An endpoint that let a client mark its own
SLA met would make the whole measurement worthless.

Acknowledging takes `sla:read` rather than a write permission: it is a statement about the reader,
and requiring `settings:manage` would mean the person who was escalated to could not clear it.

## Business logic worth knowing

The reasoning is
[ADR-0023](../../../../../docs/decisions/ADR-0023-sla-clocks-are-stored-and-escalation-is-a-unique-key.md).
In short:

- **`due_at` and `warn_at` are walked through the calendar at capture and stored.** The sweep needs
  one indexed query across every tenant, and a promise recomputed later against an edited calendar
  would move a deadline that had already been communicated.
- **Editing a policy affects new clocks only.** `sla_clocks.target_minutes` is why a report can say
  what each old clock promised. The API's own response message says so.
- **Escalating once is `UNIQUE (organization_id, clock_id, level)`.** The sweep inserts and reads
  the collision; a read-then-write would let two sweeps both notify.
- **`breached` is stored, but "is it late" is read from the clock.** `slaHealth()` reports a running
  clock past its due instant as breached, so no screen is ever a cron tick behind the truth.
- **Starting a clock never throws.** A lead the business paid for must not fail to be created
  because a policy is misconfigured; the board shows a lead with no promise instead.
- **A promise that stopped applying is cancelled, not satisfied** — a deleted lead, a merged
  duplicate, a lead marked `invalid`. Counting a wrong number as a kept promise makes the report
  flattering and useless.
- **A completed follow-up is the first response**, and it is also what finally writes
  `leads.first_contacted_at` / `last_contacted_at`, which had no writer at all until this step.

## Events and jobs

| Job                     | Schedule     | What it does                                     |
| ----------------------- | ------------ | ------------------------------------------------ |
| `sla.sweep`             | every 5 min  | Warn what is at risk, escalate what has breached |
| `notify.sla-escalation` | on the event | Tells the people the escalation named            |

Emits `sla.at_risk` and `sla.breached` through the outbox. One processor serves both, dispatching on
the envelope's event name. The recipients were resolved **by the sweep and stored on the row**, not
re-resolved at delivery: an escalation records who was told, and recomputing the list later would
let the row and the notifications disagree the moment somebody's role changed.

Breaches are handled before warnings in a single tick, because warning about something that has
already happened is noise.

## Failure modes

- **The sweep reads across tenants and writes inside one.** `withPlatformScope` leaves
  `tenantContext.organizationId()` unset and `TimelineService` takes the organization from the
  context by design — the trap the quotation expiry sweep paid for.
- **An escalation with no recipients is not written.** `escalations_notified_somebody` would refuse
  it, so the sweep marks the clock and moves on rather than retrying the same row every five
  minutes forever. That constraint shipped broken — `array_length(arr, 1)` is NULL for an empty
  array and a NULL CHECK is satisfied — and `20261007103000_escalation_notified_check` corrects it
  to `cardinality`.
- **A workspace with no working hours is treated as always open.** Never open would make every due
  instant `null` and every SLA silently inert; always open is wrong in a visible way.
- **A calendar that never opens again inside a year produces no clock**, not a due date invented by
  a fallback.

## Security notes

- The board and the clock list go through `DataScopeService` on `sla:read`, so an executive sees
  their own and a branch manager their branch. A clock copies its lead's branch, team and owner at
  creation, which is what makes that a predicate rather than a join.
- A clock cannot reference another workspace's lead, policy or assignee: three composite foreign
  keys say so, and `tenant-isolation.int-spec.ts` exercises each.
- `sla_clocks_lead_subject_has_lead` and `sla_clocks_subject_matches_lead` keep the polymorphic
  `subject_id` and the typed `lead_id` from disagreeing.

## Example payloads

```http
POST /api/v1/sla/policies
{ "name": "Urgent leads in ten minutes", "appliesTo": { "priorities": ["urgent"] },
  "firstResponseMinutes": 10, "warnAtPercent": 70, "businessHoursOnly": true,
  "escalateTo": { "permission": "task:manage_others" }, "priority": 0 }

GET /api/v1/sla/board
→ { "counts": { "breached": 3, "at_risk": 1, "running": 12, "met": 48, "answered_late": 5 },
    "items": [ … ], "unacknowledged": 2 }
```
