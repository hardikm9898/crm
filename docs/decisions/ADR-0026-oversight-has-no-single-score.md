# ADR-0026 — Oversight ranks nothing, and counts no activity

**Status:** Accepted · **Date:** 2026-10-13 · **Phase 3, step 5** · Traces to brief §4, `FR-TSK-5`,
`FR-TSK-8`

## Context

The brief gives the Sales Manager one question — "Which leads are being missed?" — and a screen to
answer it with: "Team SLA/overdue board, leaderboard, pipeline, conversation oversight".
`docs/frontend-architecture.md` §5.4 expands it: "Manager: SLA board, overdue by executive,
unassigned queue, no-next-action list, leaderboard, response times", and adds the rule the whole
screen rests on — "every number has a drill-through to the filtered list behind it (a metric you
cannot click is a dead end)".

Everything it needs already exists: `tasks.reschedule_count`, the SLA clocks, the next-action
pointer, `leads.first_contacted_at`. The risk in this step was never the queries. It was the word
**leaderboard**.

## Decision

### 1. There is no rank, no score and no total column

The screen is a table of per-person numbers with no ordering imposed on it and no composite figure
anywhere.

Two reasons, and the second is the one that matters:

- **A single number hides which dimension somebody is behind on.** "Priya: 63" says nothing a
  manager can act on. "Priya: 11 overdue, 2 never called, 92 % answered on time" is three different
  conversations, and only one of them is a problem.
- **The moment a score exists, people optimise it.** That is not cynicism about salespeople; it is
  the predictable result of putting a number on somebody's week and ranking them by it. The
  question is only ever _which_ behaviour the number buys.

### 2. Nothing on it counts activity

No "calls logged", no "activities recorded", no "touches". Every column is either an **outcome** —
promises answered on time, median reply time, leads converted — or a **cost**: overdue follow-ups,
follow-ups moved, leads never called, leads with nothing planned.

A leaderboard ranked by calls logged teaches everybody to log calls. The product already writes
every touch to the timeline automatically (rule 6), so an activity count here would measure the
diligence of somebody's data entry and call it performance.

`reschedule_count` is on the screen because `FR-TSK-5` asks for it — "chronic rescheduling is a
coaching signal" — and it is deliberately framed as a cost beside the others rather than as a
headline: somebody moving six follow-ups in a week they spent at a trade show is not a problem.

### 3. A rate computed from nothing is `null`, not 0 % and not 100 %

Somebody who has answered no promises in the period has `onTimeRate: null` and
`medianResponseMinutes: null`, and the screen shows "—". Either number would be a lie that ranks a
new joiner against people who have done a month's work, and 100 % is the worse of the two because
it reads as excellent.

### 4. A median, not a mean, for response time

One lead answered three days late drags a mean across a team of ten into uselessness, while the
median still says "half our replies are inside eleven minutes". Prisma has no percentile aggregate,
so this one number is raw SQL (`percentile_cont`) — with `organization_id` passed explicitly,
because raw SQL does not pass through the tenant-scoping extension, and **with the same person
filter as every count beside it**: the first version had none, so a branch manager read their
branch's counts next to the whole workspace's median. Found by measuring on the 100 k fixture and
noticing the headline disagreeing with every row under it.

### 5. One endpoint, scoped — not one per role

`GET /oversight`, read with `report:read` through `DataScopeService`: a branch manager sees their
branch and the owner sees the workspace, from the same route. `docs/api-architecture.md` sketched
`GET /dashboard/{owner|manager|executive|…}`; a path named after a role is what rule 4 forbids, and
the breadth of the answer is already a predicate `DataScopeService` owns — the arrangement
`/sla/board` settled in step 2.

`report:read` was already in the catalogue and already granted to the manager, marketing-manager and
auditor templates, so this step adds no permission and needs no data migration. Worth stating
because every previous step that added one needed both.

### 6. The people come from the member list, not from the work

A person nobody has given anything to has no tasks, no leads and no clocks — and would be invisible
on exactly the screen whose job is to notice that. So the rows are the active memberships in scope,
and the aggregates are joined onto them.

For the same reason, the **unassigned** backlog is a tile of its own at the top: a lead with no owner
appears in no person's row, which makes it the number a manager would otherwise never see.

### 7. Every number is a link, and the link lives beside the number

Each column is defined in `apps/web/src/lib/oversight.ts` as a label, a hint, a kind
(`outcome`/`cost`/`volume`) **and a function producing its destination**. Keeping the figure and
where it goes in one place is what stops them drifting into a link that shows a different count from
the one that was clicked, and a spec asserts that every column produces a link carrying that
person's own id.

The lead links are filter-DSL URLs (`/leads?f=assignedUserId:eq:…~firstContactedAt:is_null`), not
query parameters: `/leads` has no query-parameter filters, so a link like `?uncontacted=true`
renders the _unfiltered_ list — worse than no link at all, and a trap `/today` already paid for.
`/tasks` and `/sla` gained an `assignedUserId` parameter so "Priya: 7 overdue" has somewhere to
land.

### 8. Live aggregates now, rollups later

§5.4 says these cards read rollup tables, and they will (ADR-0010, Phase 10). Inventing the rollups
now would mean a second definition of every number on this page, to disagree with this one in six
months. Measured on the 100 k fixture — 109 716 leads, 10 719 follow-ups, 21 411 clocks of which
2 135 answered — `GET /oversight` is **p95 = 110 ms** at thirty days and 111 ms at ninety, with
fourteen grouped aggregates and five percentile queries. The period is a fixed set of windows
(7/30/90) rather than a free range, because an arbitrary range is how somebody asks for two years of
live aggregation by accident.

## Consequences

- The screen cannot answer "who is best", and will be asked to. The honest answer is that the table
  shows the five things somebody could be best at, and that a business wanting one number should
  decide which of them it actually means.
- Adding a column is three edits: the service's aggregate, the shared column definition, and its
  destination. The spec fails if the third is missing.
- The per-person median is one query each, capped at `OVERSIGHT_PEOPLE_LIMIT` (50) and skipped for
  anybody who answered nothing. A workspace of fifty with ten active people runs ten.
- Teams are not a dimension yet: the rows are people, and the scope narrows by branch. Grouping by
  team arrives with the team-level reporting in Phase 10.

## Alternatives considered

- **A weighted score with published weights.** Transparent, and still a single number people
  optimise — the weights just tell them how.
- **Ranking the table by one column server-side.** Rejected for now: whichever column it was would
  become the de-facto score, and the sort belongs to the person reading it. The table is ordered by
  how long people have been in the workspace, which is the one ordering that implies nothing.
- **Counting activities, "because the brief says leaderboard".** The brief asks for a leaderboard;
  it does not ask for an activity count, and §5.4's own insistence that every metric be clickable is
  an argument for metrics that mean something when you open them.
