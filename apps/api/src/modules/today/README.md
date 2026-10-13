# Today — the executive workspace

`FR-TSK-7`. One endpoint: `GET /my/today`. Decisions in
[ADR-0024](../../../../../docs/decisions/ADR-0024-today-is-one-request-and-its-taps-are-queued.md).

## What it is

The whole executive screen in one response: the follow-up queue in three sections, the leads nobody
has spoken to, the promises running out, and nine counts. No parameters — see below.

```
GET /my/today                                task:read
```

```jsonc
{
  "generatedAt": "2026-10-13T09:00:00.000Z",
  "timeZone": "Asia/Kolkata",
  "for": { "userId": "…" },
  "counts": {
    "overdue": 3,
    "dueNow": 2,
    "laterToday": 10,
    "upcoming": 14,
    "awaitingFirstContact": 5,
    "noNextAction": 41,
    "promisesBreached": 1,
    "promisesAtRisk": 2,
    "unacknowledgedEscalations": 0,
  },
  "sections": {
    "overdue": { "count": 3, "items": [/* task cards */], "truncated": false, "available": true },
    "dueNow": { "count": 2, "items": [/* task cards */], "truncated": false, "available": true },
    "laterToday": {
      "count": 10,
      "items": [/* task cards */],
      "truncated": false,
      "available": true,
    },
    "awaitingFirstContact": {
      "count": 5,
      "items": [/* lead cards */],
      "truncated": false,
      "available": true,
    },
    "promisesRunningOut": {
      "count": 3,
      "items": [/* clock cards */],
      "truncated": false,
      "available": true,
    },
  },
}
```

## Why it is its own module

It composes three modules' subjects — follow-ups, leads and SLA clocks — and belongs to none of
them. It injects no other module's service either: each section is a query of its own, shaped for a
**card** rather than for a record, and going through the three list endpoints would mean three
paginations, three presenters and three sets of filters to answer a question that has none.

What it does share is the thing that must not drift: `taskBucketWhere` in `@leados/shared`, the same
definition `/tasks` counts with and the same one `taskBucket` labels each card from. Three sections
of one screen disagreeing about what "overdue" means is why that function lives there.

## The four rules

1. **No parameters.** Today is not a question; it is the answer, for the person holding the phone. A
   manager wanting somebody else's queue has `/tasks?assignedUserId=` and `/sla/board`. It also
   means there is one shape to measure, so the `p95 < 400 ms` exit criterion means something.
2. **"Mine" includes whatever nobody has claimed.** A workspace with no assignment rule leaves
   captured leads unassigned; a screen that is strictly "mine" shows those to _nobody_. The data
   scope narrows it correctly without a second rule — somebody scoped to their own rows cannot read
   an unclaimed row anyway.
3. **Every count is an aggregate over the whole set.** Sections cap at twenty rows (ten for the two
   lists under the queue) and carry `truncated` so the screen can offer "see all". `items.length` is
   never the number shown.
4. **A section the caller may not read is marked `available: false`**, not silently empty. An empty
   list and a forbidden one look identical on a screen.

## Ordering, which is not uniform on purpose

- **Overdue: oldest first.** It answers "who has been waiting longest" — the thing somebody
  apologises for.
- **Due now and later today: most urgent first, then soonest.** These are the next few hours of
  work, where an urgent call due at 16:00 belongs above a routine one due at 10:00.
- **Awaiting first contact: oldest first.** The lead captured two hours ago is the one whose promise
  runs out next; newest-first buries exactly the row that needs the call.
- **Promises: soonest deadline first**, which puts the breaches at the top by arithmetic rather
  than by a second query and a concatenation.

## What it reads from the clock rather than from a column

A promise's health. The sweep runs every five minutes, so a clock that came due forty seconds ago
still says `running` in the database — and a screen that believed the column would tell somebody at
10:01 that their 10:00 promise is fine. Same predicate as `/sla/board`, same reason.

## Performance

`leads_awaiting_first_contact` is the one index this screen added: a partial index on
`(organization_id, created_at)` where the lead is live, uncontacted, unconverted and not lost. On
the 100 k fixture that section's query is **3.4 ms** with it and **10.7 ms** without, and the gap
widens with every lead somebody calls — the slice it covers shrinks while the population it would
otherwise be read past grows.

**The assignee is deliberately not in the key**, although the query filters on it. Rule 2 asks for
"mine _or_ unclaimed", and an `OR` cannot be a range scan: against an index keyed on the assignee
the planner ignores it and falls back to `leads_live_created_at`, filtering eight thousand rows.
The first version of this index was keyed that way, and reading the plan is the only thing that
said so.

Prisma cannot express a partial index, so it is listed in
`packages/db/src/schema-objects.int-spec.ts`; without that entry the next generated migration drops
it.

Measured end to end on `packages/db/perf/leads-100k.sql` + `work-100k.sql` (109 716 leads, 10 862
follow-ups, 21 600 clocks, 31 413 leads nobody has called): **p95 = 60 ms**, p50 47 ms, max 63 ms,
payload 47 kB, against a 400 ms budget. Fifteen queries: the timezone first, then fourteen in
parallel.

## Not here

- **Unread WhatsApp**, the mock-up's sixth section. It arrives with the inbox (Phase 5) as an
  addition to this payload, not as a second request.
- **Anything that writes.** The screen's actions go to `/tasks/{id}/complete` and
  `/tasks/{id}/reschedule`, which already have the preconditions, the timeline entries and the
  effect on the lead's next action. A write endpoint here would be a second implementation of all
  three.
