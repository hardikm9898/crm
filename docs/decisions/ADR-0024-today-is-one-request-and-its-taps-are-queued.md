# ADR-0024 — Today is one request with no parameters, and its taps are queued in the browser

**Status:** Accepted · **Date:** 2026-10-13 · **Phase 3, step 3** · Traces to `FR-TSK-7`, `FR-TSK-4`

## Context

`FR-TSK-7` asks for a Today workspace: "the executive's screen — what is due, what is overdue, what
is new". Phase 3's exit criteria turn that into three measurable things, two of which nothing in the
product had met:

- **`GET /my/today` returns the entire executive screen in one request, p95 < 400 ms on the 100 k
  fixture**;
- **the Today workspace is usable one-handed at 375 px, and its actions survive a flaky connection
  (queued + retried)**.

Everything the screen reads already existed by the end of step 2: the task buckets, the
`leads.next_action_task_id` pointer, and the SLA clocks. What did not exist was a screen that is a
**queue rather than a list** — the first one in the product — and the two guarantees above, which
are the difference between a page that displays data and a tool somebody works a day out of.

## Decision

### 1. One request, and it takes no parameters at all

`GET /my/today` returns five sections, nine counts and the workspace's timezone in a single
response. It accepts no query string: no `mine`, no `assignedUserId`, no `limit`.

- **One request, because the screen is read on a phone outside a site visit.** Five requests are
  five chances for a stalled connection to leave the screen three-fifths rendered — and somebody
  reading "no overdue follow-ups" off a section that has not arrived yet, then going home, is the
  worst outcome this product has. A section that cannot load must take the whole screen's error
  with it, which is only possible if there is one request to fail.
- **No parameters, because Today is not a question.** Every other list in the product is
  filterable, because every other list _is_ a question somebody asks. This one is the answer, for
  the person holding the phone. A screen whose contents depend on a query string is a screen two
  colleagues describe differently while trying to help each other over a call. A manager who wants
  somebody else's queue has `/tasks?assignedUserId=` and `/sla/board`, which data-scope properly.
- It also keeps the budget honest: there is exactly one shape to measure, so `p95 < 400 ms` means
  something rather than being true of the cheapest parameterisation.

Measured on the 100 k fixture (109 716 leads, 10 862 follow-ups, 21 600 clocks): **p95 = 60 ms**,
p50 47 ms, payload 47 kB. Fifteen queries — the workspace's timezone first, then fourteen in
parallel.

### 2. "Mine" means mine **plus whatever nobody has claimed**

Each section is the caller's own rows _or_ rows with no assignee, narrowed afterwards by the
caller's data scope.

The first implementation was strictly "mine", and the browser check found what that costs: a
workspace with no assignment rule leaves every captured lead unassigned, so the new leads — and the
first-response promises running out on them — appeared on **nobody's** Today. The leads at the
greatest risk of never being called were the ones the screen hid.

The data scope then supplies the rest of the rule without a second rule being written:
`applyScopeFilter` adds `assigned_user_id = me` for somebody scoped to their own rows, so the
unclaimed branch cannot widen what they see — they cannot read an unclaimed row at all. For somebody
scoped to a team, a branch or the workspace, it can, and surfacing it is exactly the point.

### 3. Every count is an aggregate over the whole set, and the page is capped

Each section ships at most twenty rows (ten for the two lists under the queue) and carries its own
`count`, which is a separate aggregate over the whole set, plus `truncated` and a link to the full
list. A board that totals the rows it loaded tells somebody they owe twenty calls when they owe
ninety — the mistake the pipeline board and the SLA board each made once.

### 4. A section the caller may not read is marked, not silently empty

`task:read` gates the route. `lead:read` and `sla:read` gate their sections, and a caller without
them gets `available: false` rather than a 403 on the whole screen: a role with the follow-up queue
and nothing else is a configuration the permission catalogue has always offered, and it must not
make the product's landing page unreachable. An empty section and a forbidden one look identical on
a screen, and must not.

### 5. The taps are queued in the browser, retried, and persisted

This is the only place in the app where an action is not a round trip. A tap is recorded before the
request leaves, retried with backoff (immediately, then 1 s, 2 s, 4 s), kept in `localStorage`
across a reload, and — once it has run out of attempts — shown as failed with a button to send it
again.

The queue decides something no form ever does: **whether trying again could possibly help.** A
refusal (a missing outcome, a reason that requires a note, a follow-up somebody else already
finished) is not retried, because sending it three more times produces the same refusal three more
times and buries the one sentence explaining it. A dropped connection, a timeout, a rate limit or a
5xx is retried, because that is the case the queue exists for.

It does **not** guarantee delivery — nothing running in a browser tab can. It guarantees the tap is
never lost _silently_, which is the thing that actually erodes trust in a tool somebody works a
queue out of.

### 6. Landing is resolved once, by permission

`/` sends anybody holding `task:read` to `/today` and everybody else to `/dashboard`.
`docs/frontend-architecture.md` had said "executive → /today", which rule 4 forbids: roles are rows
a tenant edits, so code that branches on the word "executive" breaks the day somebody renames one.
`task:read` is the honest test of "does this person have work owed to them". Sign-in, invitation
acceptance and the workspace switcher all redirect to `/` rather than carrying their own copy of
that rule — and the switcher in particular has to, because permissions differ per workspace.

## Consequences

- A sixth section (unread WhatsApp, in the mock-up) is an addition to one payload and one page, not
  a new endpoint. It arrives with the inbox in Phase 5.
- The 100 k fixture now has work on it (`packages/db/perf/work-100k.sql`): measuring a Today screen
  against a hundred thousand leads with no follow-ups and no clocks measures nothing, because every
  section is empty and every query stops at the first index page.
- `leads_awaiting_first_contact` is a new hand-written partial index, and therefore something
  Prisma's next diff will propose dropping. It is listed in
  `packages/db/src/schema-objects.int-spec.ts`, which is the only thing that notices. Its key is
  `(organization_id, created_at)` and deliberately **not** the assignee the query also filters on:
  rule 2's `OR` cannot be a range scan, so an index keyed on the assignee is not used for this
  query at all. The first version of it was, and was not — found by reading the plan rather than
  by trusting the shape.
- The queue is per-viewer browser storage, so it is invisible to the server and to any other
  device. A tap made on a phone that never regains signal is lost when that tab is closed — the
  honest limit of a client-side queue, and the reason the failed state is loud rather than quiet.
- Resuming the queue on mount can re-send a request whose _response_ was lost. The API refuses a
  follow-up that is already finished, with a sentence saying so, which is a far better outcome than
  dropping the tap.

## Alternatives considered

- **Five requests, one per section.** Cheaper to write, and it is what every other screen does. It
  fails the one thing this screen must not fail: a partly-rendered queue that reads as an empty one.
- **A service worker with Background Sync**, which would survive the tab closing. It needs an
  installable PWA, a second code path for the token, and a way to reconcile a sync that lands after
  the user has signed out of that workspace. Worth revisiting when the product ships as a PWA; it
  is not worth it to satisfy a criterion the queue above already satisfies honestly.
- **An optimistic removal of the card on tap.** Rejected: the card has to stay visible to carry its
  own "sending" and "failed" state, and a card that vanishes and comes back is worse than one that
  dims.
- **`/today` as a role-based landing.** Rejected by rule 4, as above.
