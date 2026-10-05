# Performance fixtures

Scripts that build a tenant large enough to measure against. They exist because several of the
roadmap's exit criteria are written as latency budgets on a **100 k-lead tenant**, and a budget
nobody can reproduce is a claim rather than a criterion.

## 100 000 leads

```bash
# Build it (about 18 seconds)
psql "$DATABASE_URL" -v slug=acme-realty -f packages/db/perf/leads-100k.sql

# Measure (needs the API, the worker and the web app running)
#   the list, the filters, the board's per-column pages, and the rendered pages

# Remove it again
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
