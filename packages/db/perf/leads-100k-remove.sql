-- Removes the rows `leads-100k.sql` created, and nothing else.
--
--   psql "$DATABASE_URL" -v slug=acme-realty -f packages/db/perf/leads-100k-remove.sql
--
-- Matched on the `Perf Lead ` name prefix rather than on a date range or a row count, so a real
-- lead captured while the fixture was in place is never taken with it.
\set ON_ERROR_STOP on

DELETE FROM lead_score_events
WHERE lead_id IN (
  SELECT id FROM leads
  WHERE organization_id = (SELECT id FROM organizations WHERE slug = :'slug')
    AND full_name LIKE 'Perf Lead %'
);

DELETE FROM activities
WHERE lead_id IN (
  SELECT id FROM leads
  WHERE organization_id = (SELECT id FROM organizations WHERE slug = :'slug')
    AND full_name LIKE 'Perf Lead %'
);

DELETE FROM leads
WHERE organization_id = (SELECT id FROM organizations WHERE slug = :'slug')
  AND full_name LIKE 'Perf Lead %';

ANALYZE leads;
SELECT count(*) AS leads_remaining FROM leads
WHERE organization_id = (SELECT id FROM organizations WHERE slug = :'slug');
