# oversight

The manager's screen (brief §4, `docs/frontend-architecture.md` §5.4). One endpoint:
`GET /oversight`. Decisions in
[ADR-0026](../../../../../docs/decisions/ADR-0026-oversight-has-no-single-score.md).

## What it is

```
GET /oversight?days=7|30|90          report:read, through DataScopeService
```

One response: the backlog that belongs to nobody, the promises over the period, and a row per person
in scope.

```jsonc
{
  "period": { "from": "…", "to": "…", "days": 30 },
  "scope": { "kind": "organization", "people": 9, "truncated": false },
  "queue": { "unassigned": 14, "awaitingFirstContact": 41, "noNextAction": 98, "overdue": 4, "dueToday": 2 },
  "promises": { "breached": 6, "atRisk": 2, "met": 21, "answeredLate": 5, "onTimeRate": 76, "medianResponseMinutes": 8 },
  "people": [{ "userId": "…", "name": "…", "overdue": 3, "onTimeRate": 80, "medianResponseMinutes": 14, … }]
}
```

## The four rules

1. **No rank, no score, no total.** A single number hides which dimension somebody is behind on, and
   the moment it exists people optimise it. Every column is an **outcome** (promises answered on
   time, median reply, conversions) or a **cost** (overdue, moved, never called, nothing planned).
2. **Nothing counts activity.** A leaderboard ranked by calls logged teaches everybody to log calls.
   The timeline already records every touch automatically, so an activity count here would measure
   data-entry diligence and call it performance.
3. **A rate from nothing is `null`.** Somebody who has answered no promises is not at 0 % and not at
   100 %; the screen shows "—". 100 % is the more dangerous of the two, because it reads as
   excellent.
4. **Every number is an aggregate over the whole set**, and every number is a link. The column
   definitions in `apps/web/src/lib/oversight.ts` carry the figure _and_ its destination, so the two
   cannot drift.

## Why one endpoint rather than one per role

`report:read` through `DataScopeService`: a branch manager sees their branch, the owner sees the
workspace, from the same route. `docs/api-architecture.md` sketched
`GET /dashboard/{owner|manager|…}`; a path named after a role is what rule 4 forbids, and the
breadth is already a predicate the scope service owns. The same arrangement `/sla/board` settled.

`report:read` was already granted to the manager, marketing-manager and auditor templates, so this
module added **no permission and no data migration** — unlike every previous step that added one.

## Two things worth knowing

**The people come from the member list, not from the work.** Somebody nobody has given anything to
has no tasks, no leads and no clocks, and would be invisible on the one screen whose job is to
notice that. For the same reason the **unassigned** backlog is its own tile: a lead with no owner is
in nobody's row.

**The median is raw SQL, and it is filtered like everything else.** Prisma has no percentile
aggregate, so `percentile_cont` it is — with `organization_id` passed explicitly, because raw SQL
does not pass through the tenant-scoping extension, and with the same person filter as the counts
beside it. The first version had no person filter, so a branch manager read their branch's counts
next to the whole workspace's median; it was found by measuring on the 100 k fixture and noticing
the headline disagreeing with every row under it.

## Performance

`p95 = 110 ms` on the 100 k fixture (109 716 leads, 10 719 follow-ups, 21 411 clocks, 2 135 of them
answered), at thirty days and at ninety. Fourteen grouped aggregates — one `groupBy` per question
rather than one query per person, so the shape does not change when the team doubles — plus one
percentile query per person who answered something, capped at `OVERSIGHT_PEOPLE_LIMIT`.

No index was added: the three tables are already indexed on `(organization_id, assigned_user_id, …)`
from the steps that built them.

## Not here

- **Rollups.** §5.4 says these cards read rollup tables, and they will (ADR-0010, Phase 10).
  Inventing them now would mean a second definition of every number here, to disagree with this one
  later. The period is therefore a fixed set of windows, not a free range.
- **Teams as a dimension.** The rows are people and the scope narrows by branch; grouping by team
  arrives with the Phase 10 reporting.
- **Pipeline and conversation oversight**, the other two things the brief lists for this role. The
  pipeline board exists at `/pipeline`; conversations arrive with the inbox.
