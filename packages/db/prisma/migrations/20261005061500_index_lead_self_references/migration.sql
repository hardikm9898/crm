-- ── Index the two self-referential foreign keys on `leads` ─────────────────
--
-- `leads_duplicate_of_same_org_fk` and `leads_merged_into_same_org_fk` point from `leads` back at
-- `leads` with `ON DELETE RESTRICT`. Postgres does not index a referencing side automatically, so
-- before this migration **every deletion of a lead had to scan the whole `leads` table twice** —
-- once per constraint — looking for rows that referenced it.
--
-- At demo scale that is invisible. On the 100 k-lead fixture in `packages/db/perf` it turns
-- "delete these leads" into roughly 10^10 comparisons: the statement was still running after three
-- minutes and had to be cancelled, which is how this was found. It would have shown up in
-- production as an organization deletion or a retention purge that never finished.
--
-- Partial, because the columns are null for almost every lead: a lead is usually neither flagged as
-- a duplicate of another nor merged into one, and indexing those nulls would double the index for
-- no benefit. They also answer two real questions — "which leads were flagged against this one"
-- and "what was merged into this lead" — which the merge history screen asks.
CREATE INDEX leads_duplicate_of
  ON leads (organization_id, is_duplicate_of_id)
  WHERE is_duplicate_of_id IS NOT NULL;

CREATE INDEX leads_merged_into
  ON leads (organization_id, merged_into_id)
  WHERE merged_into_id IS NOT NULL;
