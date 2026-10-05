-- A 100k-lead tenant, for the latency budgets in the roadmap's exit criteria.
--
--   psql "$DATABASE_URL" -v slug=acme-realty -f packages/db/perf/leads-100k.sql
--
-- See packages/db/perf/README.md. Remove the rows with leads-100k-remove.sql before using the
-- workspace as a demo.
-- Built with generate_series rather than through the API: 100k HTTP round trips would take an hour
-- and would be measuring the wrong thing. The rows are shaped like real ones — spread across
-- stages, statuses, owners, cities and three months of capture dates — because a fixture where
-- every row is identical makes every index look good.
\set ON_ERROR_STOP on
\timing off

CREATE TEMP TABLE scratch AS
SELECT o.id AS organization_id,
       (SELECT id FROM lead_statuses WHERE organization_id = o.id ORDER BY sort_order LIMIT 1) AS status_id,
       (SELECT id FROM pipelines WHERE organization_id = o.id AND is_default ORDER BY created_at LIMIT 1) AS pipeline_id
FROM organizations o WHERE o.slug = :'slug';

INSERT INTO leads (
  id, organization_id, full_name, first_name, last_name, phone_e164, email, city,
  status_id, pipeline_id, stage_id, priority, score, score_band, value_minor, currency,
  created_via, utm, custom_values, consent_whatsapp, consent_email, consent_calls,
  open_tasks_count, touch_count, assigned_user_id, last_activity_at, created_at, updated_at
)
SELECT
  -- A v7-shaped uuid: the real ids are time-ordered, and random ids would make every index scan
  -- look worse than it is in production.
  (lpad(to_hex((extract(epoch from now())*1000)::bigint), 12, '0') || '7' ||
   substr(md5(g::text), 1, 3) || '8' || substr(md5(g::text || 'x'), 1, 15))::uuid,
  s.organization_id,
  -- The name carries the marker the removal script matches on, so a cleanup can never take a real
  -- lead with it.
  'Perf Lead ' || g,
  'Perf', 'Lead ' || g,
  '+9199' || lpad((g % 100000000)::text, 8, '0'),
  'perf' || g || '@fixture.test',
  (ARRAY['Pune','Mumbai','Nashik','Nagpur','Ahmedabad','Surat','Indore','Jaipur'])[1 + (g % 8)],
  st.id,
  s.pipeline_id,
  stg.id,
  (ARRAY['low','medium','high','urgent']::lead_priority[])[1 + (g % 4)],
  (g * 7) % 1001,
  (ARRAY['Cold','Warm','Hot'])[1 + (g % 3)],
  ((g % 500) + 1) * 100000,
  'INR',
  (ARRAY['manual','form','whatsapp','meta_ads','google_ads']::lead_created_via[])[1 + (g % 5)],
  '{}', '{}', g % 2 = 0, g % 3 = 0, g % 2 = 1,
  0, 1 + (g % 4),
  CASE WHEN g % 7 = 0 THEN NULL ELSE m.user_id END,
  now() - ((g % 90) || ' days')::interval - ((g % 24) || ' hours')::interval,
  now() - ((g % 90) || ' days')::interval,
  now() - ((g % 90) || ' days')::interval
FROM generate_series(1, 100000) g
CROSS JOIN scratch s
JOIN LATERAL (
  SELECT id FROM lead_statuses WHERE organization_id = s.organization_id ORDER BY sort_order
  OFFSET (g % 6) LIMIT 1
) st ON true
JOIN LATERAL (
  SELECT id FROM pipeline_stages WHERE organization_id = s.organization_id AND pipeline_id = s.pipeline_id
  ORDER BY sort_order OFFSET (g % 7) LIMIT 1
) stg ON true
JOIN LATERAL (
  SELECT user_id FROM memberships WHERE organization_id = s.organization_id ORDER BY user_id
  OFFSET (g % 4) LIMIT 1
) m ON true;

ANALYZE leads;
SELECT count(*) AS leads_in_fixture FROM leads
WHERE organization_id = (SELECT id FROM organizations WHERE slug = :'slug');
