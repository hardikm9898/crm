-- The work on top of the 100k leads: follow-ups and SLA clocks, for `/my/today`'s latency budget.
--
--   psql "$DATABASE_URL" -v slug=acme-realty -f packages/db/perf/leads-100k.sql
--   psql "$DATABASE_URL" -v slug=acme-realty -f packages/db/perf/work-100k.sql
--
-- Run it after `leads-100k.sql`, which is where the leads come from. Removed by
-- `work-100k-remove.sql`, and `leads-100k-remove.sql` will refuse to delete leads these rows still
-- point at, so remove this one first.
--
-- `/my/today` is the one screen with a number in the roadmap's exit criteria (`p95 < 400 ms`), and
-- measuring it against a hundred thousand leads with no work on them measures nothing: every
-- section would be empty, every count zero, and every query would stop at the first index page.
-- So this builds the three things the screen actually reads — an overdue backlog, a day's
-- follow-ups, and promises in every state — at a volume a busy workspace reaches.
--
-- Wrapped in a transaction on purpose: `psql` commits every statement as it goes, so the first
-- version of this script — which was refused by a check constraint two thirds of the way down —
-- left two thirds of its rows behind, and the next run inserted them again. See the note in
-- CLAUDE.md. The inserts are also guarded, so a second run is a no-op rather than a second copy.
\set ON_ERROR_STOP on
\timing off

BEGIN;

CREATE TEMP TABLE scratch AS
SELECT o.id AS organization_id,
       o.timezone,
       (SELECT id FROM task_types WHERE organization_id = o.id ORDER BY sort_order LIMIT 1) AS task_type_id,
       (SELECT id FROM sla_policies WHERE organization_id = o.id ORDER BY priority DESC LIMIT 1) AS policy_id
FROM organizations o WHERE o.slug = :'slug';

-- ── 1. Most leads have been spoken to ─────────────────────────────────────────
-- Seven in ten, so "awaiting first contact" is a *slice* rather than the whole table. A fixture
-- where every row matches the partial index makes the partial index look pointless, which is the
-- opposite of a useful measurement.
UPDATE leads SET first_contacted_at = created_at + interval '2 hours',
                 last_contacted_at = created_at + interval '2 hours'
WHERE organization_id = (SELECT organization_id FROM scratch)
  AND full_name LIKE 'Perf Lead %'
  AND (substr(md5(id::text), 1, 1) IN ('0','1','2','3','4','5','6','7','8','9','a'));

-- ── 2. A follow-up on every fifth lead ────────────────────────────────────────
-- Spread across the sections the screen is made of: a quarter overdue (some of them badly), a
-- handful due in the next half hour, the rest later today and tomorrow onwards.
INSERT INTO tasks (
  id, organization_id, lead_id, assigned_user_id, title, task_type_id,
  due_at, due_date, due_time, priority, status, reminder_offsets, created_via,
  created_at, updated_at
)
SELECT
  (lpad(to_hex((extract(epoch from now())*1000)::bigint), 12, '0') || '7' ||
   substr(md5(l.id::text), 1, 3) || '8' || substr(md5(l.id::text || 'task'), 1, 15))::uuid,
  l.organization_id,
  l.id,
  l.assigned_user_id,
  'Perf follow-up ' || substr(l.id::text, 1, 8),
  s.task_type_id,
  due.at,
  (due.at AT TIME ZONE s.timezone)::date,
  (due.at AT TIME ZONE s.timezone)::time(0),
  (ARRAY['low','medium','high','urgent']::task_priority[])[1 + (('x' || substr(md5(l.id::text), 1, 8))::bit(32)::int & 3)],
  'pending',
  '[60]',
  'manual',
  now(),
  now()
FROM leads l
CROSS JOIN scratch s
JOIN LATERAL (
  SELECT CASE (('x' || substr(md5(l.id::text || 'due'), 1, 8))::bit(32)::int & 7)
           WHEN 0 THEN now() - interval '3 days'
           WHEN 1 THEN now() - interval '26 hours'
           WHEN 2 THEN now() - interval '90 minutes'
           WHEN 3 THEN now() + interval '8 minutes'
           WHEN 4 THEN now() + interval '25 minutes'
           WHEN 5 THEN now() + interval '3 hours'
           WHEN 6 THEN now() + interval '7 hours'
           ELSE now() + interval '2 days'
         END AS at
) due ON true
WHERE l.organization_id = s.organization_id
  AND l.full_name LIKE 'Perf Lead %'
  AND l.assigned_user_id IS NOT NULL
  AND (('x' || substr(md5(l.id::text), 1, 8))::bit(32)::int & 7) = 0
  AND NOT EXISTS (
    SELECT 1 FROM tasks t WHERE t.lead_id = l.id AND t.title LIKE 'Perf follow-up %'
  );

-- The denormalised next action, which the real write path maintains on every task write. A fixture
-- that skipped it would make "open leads with nothing planned" count leads that plainly have
-- something planned — a wrong answer measured at the right speed.
UPDATE leads l
SET next_action_task_id = t.id,
    next_action_at = t.due_at,
    open_tasks_count = 1
FROM tasks t
WHERE t.lead_id = l.id
  AND t.organization_id = l.organization_id
  AND t.title LIKE 'Perf follow-up %';

-- ── 3. A promise on every eighth lead, in every state ─────────────────────────
INSERT INTO sla_clocks (
  id, organization_id, policy_id, subject_type, subject_id, lead_id, target,
  assigned_user_id, started_at, due_at, warn_at, target_minutes, state, breached_at, satisfied_at,
  satisfied_by, created_at, updated_at
)
SELECT
  (lpad(to_hex((extract(epoch from now())*1000)::bigint), 12, '0') || '7' ||
   substr(md5(l.id::text), 1, 3) || '8' || substr(md5(l.id::text || 'clock'), 1, 15))::uuid,
  l.organization_id,
  s.policy_id,
  'lead',
  l.id,
  l.id,
  'first_response',
  l.assigned_user_id,
  span.started,
  span.due,
  span.started + ((span.due - span.started) * 0.8),
  60,
  span.state::sla_clock_state,
  -- `sla_clocks_breached_has_timestamp` is a `CASE`, not a biconditional, and it is right: a clock
  -- that says it was missed has to say when. The satisfied pair below is the same shape.
  CASE WHEN span.state = 'breached' THEN span.due ELSE NULL END,
  span.answered,
  CASE WHEN span.state = 'satisfied' THEN 'a call was logged' ELSE NULL END,
  now(),
  now()
FROM leads l
CROSS JOIN scratch s
JOIN LATERAL (
  SELECT (('x' || substr(md5(l.id::text || 'sla'), 1, 8))::bit(32)::int % 5) AS kind
) k ON true
JOIN LATERAL (
  SELECT
    CASE k.kind
      -- Breached, and the sweep has already said so.
      WHEN 0 THEN now() - interval '4 hours'
      -- Past due and *still* marked running: the five-minute sweep has not reached it. The screen
      -- has to read this from the clock, which is the case worth measuring.
      WHEN 1 THEN now() - interval '70 minutes'
      -- Inside the warning window.
      WHEN 2 THEN now() - interval '55 minutes'
      -- Answered. A fifth state, because a workspace where nothing was ever answered exercises
      -- neither the on-time rate nor the median response time — the two numbers on the oversight
      -- screen that cost anything to compute.
      WHEN 3 THEN now() - ((1 + (('x' || substr(md5(l.id::text || 'ans'), 1, 8))::bit(32)::int % 20)) || ' days')::interval
      -- Comfortable.
      ELSE now() - interval '5 minutes'
    END AS started,
    CASE k.kind
      WHEN 0 THEN now() - interval '3 hours'
      WHEN 1 THEN now() - interval '10 minutes'
      WHEN 2 THEN now() + interval '5 minutes'
      WHEN 3 THEN now() - ((1 + (('x' || substr(md5(l.id::text || 'ans'), 1, 8))::bit(32)::int % 20)) || ' days')::interval + interval '60 minutes'
      ELSE now() + interval '55 minutes'
    END AS due,
    CASE k.kind WHEN 0 THEN 'breached' WHEN 3 THEN 'satisfied' ELSE 'running' END AS state,
    -- Answered somewhere between four minutes and two hours after the promise started, so the
    -- median is a real percentile over a spread rather than one repeated number, and a fifth of
    -- them are late.
    CASE k.kind
      WHEN 3 THEN now()
        - ((1 + (('x' || substr(md5(l.id::text || 'ans'), 1, 8))::bit(32)::int % 20)) || ' days')::interval
        + ((4 + (('x' || substr(md5(l.id::text || 'spd'), 1, 8))::bit(32)::int % 116)) || ' minutes')::interval
      ELSE NULL
    END AS answered
) span ON true
WHERE l.organization_id = s.organization_id
  AND l.full_name LIKE 'Perf Lead %'
  AND l.assigned_user_id IS NOT NULL
  AND (('x' || substr(md5(l.id::text), 1, 8))::bit(32)::int & 7) IN (0, 1)
  AND NOT EXISTS (
    SELECT 1 FROM sla_clocks c WHERE c.subject_type = 'lead' AND c.subject_id = l.id
      AND c.target = 'first_response'
  );

ANALYZE leads;
ANALYZE tasks;
ANALYZE sla_clocks;

SELECT
  (SELECT count(*) FROM tasks WHERE title LIKE 'Perf follow-up %') AS follow_ups,
  (SELECT count(*) FROM sla_clocks c JOIN leads l ON l.id = c.lead_id
    WHERE l.full_name LIKE 'Perf Lead %') AS clocks,
  (SELECT count(*) FROM leads WHERE full_name LIKE 'Perf Lead %'
     AND first_contacted_at IS NULL) AS awaiting_first_contact;

COMMIT;
