# Performance fixtures

Scripts that build a tenant large enough to measure against. They exist because several of the
roadmap's exit criteria are written as latency budgets on a **100 k-lead tenant**, and a budget
nobody can reproduce is a claim rather than a criterion.

## 100 000 leads

```bash
# Build it (about 35 seconds)
psql "$DATABASE_URL" -v slug=acme-realty -f packages/db/perf/leads-100k.sql

# ...and the work on top of it: follow-ups and SLA clocks (about 15 seconds)
psql "$DATABASE_URL" -v slug=acme-realty -f packages/db/perf/work-100k.sql

# Measure (needs the API, the worker and the web app running)
#   the list, the filters, the board's per-column pages, /my/today, and the rendered pages

# Remove it again — the work first, because the leads are what it points at
psql "$DATABASE_URL" -v slug=acme-realty -f packages/db/perf/work-100k-remove.sql
psql "$DATABASE_URL" -v slug=acme-realty -f packages/db/perf/leads-100k-remove.sql
```

Built with `generate_series` rather than through the API: a hundred thousand HTTP round trips would
take an hour and would measure the wrong thing. The rows are deliberately **varied** — spread across
every stage, status, owner, city, priority and three months of capture dates — because a fixture
where every row is identical makes every index look good.

Ids are v7-shaped so they sort by time, like the real ones. Random ids would make index scans look
worse than they are in production, which is the opposite of a useful fixture.

**Remove it before using the workspace as a demo.** A hundred thousand rows called "Perf Lead 42813"
is not something to show anybody, and the removal script only deletes rows it created.

## The work on top of the leads

`work-100k.sql` adds what `/my/today` is actually made of, because measuring that screen against a
hundred thousand leads with no follow-ups and no clocks measures nothing — every section would be
empty and every query would stop at the first index page. It writes:

- **10 862 open follow-ups**, spread across overdue (some by days), the next half hour, later today
  and tomorrow onwards, with `leads.next_action_task_id` and `next_action_at` maintained the way
  the real write path maintains them. A fixture that skipped that would make "open leads with
  nothing planned" count leads that plainly have something planned — a wrong answer measured at the
  right speed;
- **21 600 first-response SLA clocks**, a quarter of them already breached, a quarter past due and
  _still marked running_ (the five-minute sweep has not reached them — the case the screen must read
  from the clock rather than from the column), a quarter inside the warning window and a quarter
  comfortable;
- **seven leads in ten marked contacted**, so "nobody has called them" is a slice rather than the
  whole table. A fixture where every row matches the partial index makes the partial index look
  pointless, which is the opposite of a useful measurement.

Both scripts run **inside a transaction** and their inserts are **guarded**, which the first version
of `work-100k.sql` was not: `psql` commits every statement as it goes, so being refused by a check
constraint two thirds of the way down left two thirds of the rows behind, and the next run inserted
them all again. CLAUDE.md records the trap.

The due times and clock instants are **relative to when the script ran**, so a fixture loaded
hours before a measurement has drifted: nothing is "due now" any more and the overdue section has
swallowed it. Remove and reload `work-100k.sql` before measuring — a re-run on its own is a no-op,
which is the price of its being idempotent.

Measured this way, `GET /my/today` answers with p95 = 60 ms against its 400 ms budget.
