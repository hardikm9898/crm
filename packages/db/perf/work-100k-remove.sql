-- Removes the follow-ups and clocks `work-100k.sql` created, and nothing else.
--
--   psql "$DATABASE_URL" -v slug=acme-realty -f packages/db/perf/work-100k-remove.sql
--
-- Run this before `leads-100k-remove.sql`: the clocks and tasks reference the leads, so deleting
-- the leads first would be refused (`ON DELETE RESTRICT` on the next-action pointer).
\set ON_ERROR_STOP on

-- The pointer first, or the lead's FK into `tasks` refuses the delete.
UPDATE leads SET next_action_task_id = NULL, next_action_at = NULL, open_tasks_count = 0
WHERE organization_id = (SELECT id FROM organizations WHERE slug = :'slug')
  AND next_action_task_id IN (SELECT id FROM tasks WHERE title LIKE 'Perf follow-up %');

DELETE FROM sla_clocks
WHERE organization_id = (SELECT id FROM organizations WHERE slug = :'slug')
  AND lead_id IN (
    SELECT id FROM leads
    WHERE organization_id = (SELECT id FROM organizations WHERE slug = :'slug')
      AND full_name LIKE 'Perf Lead %'
  );

DELETE FROM task_reminders
WHERE task_id IN (SELECT id FROM tasks WHERE title LIKE 'Perf follow-up %');

DELETE FROM tasks
WHERE organization_id = (SELECT id FROM organizations WHERE slug = :'slug')
  AND title LIKE 'Perf follow-up %';

ANALYZE tasks;
ANALYZE sla_clocks;

SELECT
  (SELECT count(*) FROM tasks WHERE title LIKE 'Perf follow-up %') AS follow_ups_remaining,
  (SELECT count(*) FROM sla_clocks) AS clocks_remaining;
