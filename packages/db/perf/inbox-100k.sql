-- A shared inbox with 100 000 messages, for Phase 5's own latency budget.
--
--   psql "$DATABASE_URL" -v slug=acme-realty -f packages/db/perf/leads-100k.sql
--   psql "$DATABASE_URL" -v slug=acme-realty -f packages/db/perf/inbox-100k.sql
--
-- Phase 5's last exit criterion is "inbox p95 < 500 ms with 100 k messages in the tenant fixture",
-- and it stayed unmeasured for four steps because `work-100k.sql` creates no conversations at all:
-- the three inbox queries that cost anything — the list with its two aggregates, a message page,
-- and the body search through `messages_body_search` — had only ever been run against a demo
-- workspace with one conversation in it. A budget nobody can reproduce is a claim, not a criterion.
--
-- What it builds, and why each part is varied:
--
--   * **4 000 conversations on one business number.** Fewer conversations with more messages each
--     would make the list's `ORDER BY last_message_at DESC LIMIT 50` stop at the first index page
--     and measure nothing; more conversations with two messages each would make the message page
--     free. Four thousand × twenty-five is the shape a busy workspace reaches in a quarter.
--   * **Spread across two monthly partitions.** `messages` is partitioned by `created_at`, so a
--     hundred thousand rows all in one month measure one partition — and the planner's job on the
--     real query (the newest page of one conversation) is to prune to one partition out of many.
--   * **A quarter unread, a quarter unassigned, an eighth closed, a sixteenth snoozed.** The list's
--     two aggregates (`meta.unread`, `meta.open`) are counts over the whole filter, and a fixture
--     where every row matches makes a partial index look pointless.
--   * **Bodies drawn from a vocabulary, not one repeated string.** `messages_body_search` is a GIN
--     index on `to_tsvector('simple', body)`, and a fixture where every message says the same thing
--     makes the search either free (one posting list) or useless (every row matches).
--
-- One transaction, and every insert guarded, for the reason `work-100k.sql` records: `psql` commits
-- as it goes, so a script refused two thirds of the way down leaves two thirds of its rows behind
-- and the next run writes them again.
\set ON_ERROR_STOP on
\timing off

BEGIN;

CREATE TEMP TABLE scratch AS
SELECT o.id AS organization_id,
       (SELECT user_id FROM memberships WHERE organization_id = o.id ORDER BY created_at LIMIT 1) AS owner_user_id
FROM organizations o WHERE o.slug = :'slug';

-- ── 0. A connected number for the conversations to hang off ───────────────────
-- `conversations.channel_account_id` carries a composite FK into `whatsapp_numbers`, which needs an
-- account, which needs an integration connection. `phone_number_id` is unique **globally** — an
-- inbound delivery carries nothing else, so it has to resolve a workspace — hence the `perf-`
-- prefix the removal script matches on.
INSERT INTO integration_connections (
  id, organization_id, provider, name, credentials_encrypted, scopes, created_at, updated_at
)
SELECT '00000000-0000-7000-8000-00000000f001'::uuid, s.organization_id, 'whatsapp_cloud',
       'Perf WhatsApp', 'v1.1.perffix.perffix.perffix', ARRAY[]::text[], now(), now()
FROM scratch s
WHERE NOT EXISTS (
  SELECT 1 FROM integration_connections WHERE id = '00000000-0000-7000-8000-00000000f001'::uuid
);

INSERT INTO whatsapp_accounts (id, organization_id, integration_connection_id, waba_id, created_at, updated_at)
SELECT '00000000-0000-7000-8000-00000000f002'::uuid, s.organization_id,
       '00000000-0000-7000-8000-00000000f001'::uuid, 'perf-waba-100k', now(), now()
FROM scratch s
WHERE NOT EXISTS (
  SELECT 1 FROM whatsapp_accounts WHERE id = '00000000-0000-7000-8000-00000000f002'::uuid
);

INSERT INTO whatsapp_numbers (
  id, organization_id, account_id, phone_number_id, display_phone_e164, verified_name,
  quality_rating, messaging_limit_tier, is_active, created_at, updated_at
)
SELECT '00000000-0000-7000-8000-00000000f003'::uuid, s.organization_id,
       '00000000-0000-7000-8000-00000000f002'::uuid, 'perf-pn-100k', '+919845000100',
       'Perf Interiors', 'GREEN', 'TIER_1K', true, now(), now()
FROM scratch s
WHERE NOT EXISTS (
  SELECT 1 FROM whatsapp_numbers WHERE id = '00000000-0000-7000-8000-00000000f003'::uuid
);

-- ── 1. Four thousand conversations ────────────────────────────────────────────
-- Each on a `Perf Lead`, so `FR-WA-8`'s lead context join is measured too — the inbox list reads
-- the lead's name and status for every row, which is the join a fixture with no leads would skip.
INSERT INTO conversations (
  id, organization_id, channel, channel_account_id, contact_e164, lead_id, assigned_user_id,
  status, priority, last_message_at, last_inbound_at, last_outbound_at, unread_count,
  window_expires_at, snoozed_until, closed_at, closed_by_id, tags, created_at, updated_at
)
SELECT
  -- v7-shaped, so the `(last_message_at DESC, id DESC)` paging order behaves as it does in
  -- production. Random ids would make the tie-break look worse than it is.
  (lpad(to_hex((extract(epoch from now())*1000)::bigint), 12, '0') || '7' ||
   substr(md5('conv' || g), 1, 3) || '8' || substr(md5('conv' || g || 'x'), 1, 15))::uuid,
  s.organization_id,
  'whatsapp',
  '00000000-0000-7000-8000-00000000f003'::uuid,
  '+9198450' || lpad((20000 + g)::text, 5, '0'),
  l.id,
  -- A quarter unassigned: the case the inbox's scope widening exists for, and the one a "mine"
  -- filter would hide.
  CASE WHEN g % 4 = 0 THEN NULL ELSE m.user_id END,
  (CASE
     WHEN g % 16 = 0 THEN 'snoozed'
     WHEN g % 8 = 1 THEN 'closed'
     WHEN g % 8 = 5 THEN 'pending'
     ELSE 'open'
   END)::conversation_status,
  g % 3,
  -- Set from the newest message once they exist (see step 3): a fixture whose `last_message_at`
  -- disagrees with its own newest message measures a sort order the product never produces.
  now() - ((g % 55) || ' days')::interval - interval '20 hours',
  now() - ((g % 55) || ' days')::interval - interval '20 hours',
  CASE WHEN g % 3 = 0 THEN NULL
       ELSE now() - ((g % 55) || ' days')::interval - interval '20 hours' END,
  -- A quarter unread, which is what `meta.unread` counts and what the badge on the shell reads.
  CASE WHEN g % 4 = 1 THEN 1 + (g % 9) ELSE 0 END,
  -- Written in step 3 from the newest inbound message, not guessed here.
  NULL,
  CASE WHEN g % 16 = 0 THEN now() + ((1 + g % 48) || ' hours')::interval ELSE NULL END,
  CASE WHEN g % 8 = 1 THEN now() - ((g % 30) || ' days')::interval ELSE NULL END,
  CASE WHEN g % 8 = 1 THEN s.owner_user_id ELSE NULL END,
  -- Tags on a third of them, from a small vocabulary: a filter on an array column is only
  -- interesting when the values repeat.
  CASE WHEN g % 3 = 0
       THEN ARRAY[(ARRAY['site-visit','pricing','documents','follow-up'])[1 + (g % 4)]]
       ELSE ARRAY[]::text[] END,
  -- Twenty hours back, always: the messages below are written forward from here at 37-minute
  -- steps, twenty-five of them, which is 15½ hours. Without the offset a conversation created
  -- "now" would carry messages dated in the **future** — and then "the latest message" is one
  -- that has not happened, the list's preview shows it, and the whole sort order is a thing the
  -- product never produces. A fixture may be artificial; it may not be impossible.
  now() - ((g % 55) || ' days')::interval - interval '20 hours',
  now() - ((g % 55) || ' days')::interval - interval '20 hours'
FROM generate_series(1, 4000) g
CROSS JOIN scratch s
JOIN LATERAL (
  SELECT id FROM leads
   WHERE organization_id = s.organization_id AND full_name = 'Perf Lead ' || g
   LIMIT 1
) l ON true
JOIN LATERAL (
  SELECT user_id FROM memberships WHERE organization_id = s.organization_id ORDER BY user_id
  OFFSET (g % 4) LIMIT 1
) m ON true
WHERE NOT EXISTS (
  SELECT 1 FROM conversations
   WHERE organization_id = s.organization_id AND contact_e164 = '+9198450' || lpad((20000 + g)::text, 5, '0')
);

-- ── 2. A hundred thousand messages ────────────────────────────────────────────
-- Twenty-five per conversation, spread over the **two** monthly partitions the fixture's window
-- covers. `created_at` is ours (when the delivery arrived) and `sent_at` is theirs; the window is
-- measured from the second, which is why both are written.
INSERT INTO messages (
  id, organization_id, conversation_id, direction, type, body, payload, provider,
  provider_message_id, send_attempts, sender_user_id, status, error_code, error_message,
  sent_at, delivered_at, read_at, failed_at, billable, conversation_category, created_at
)
SELECT
  (lpad(to_hex((extract(epoch from now())*1000)::bigint), 12, '0') || '7' ||
   substr(md5('msg' || c.n || '-' || k), 1, 3) || '8' || substr(md5('msg' || c.n || '-' || k || 'x'), 1, 15))::uuid,
  c.organization_id,
  c.id,
  dir.direction,
  'text'::message_type,
  -- Drawn from a vocabulary of nine, so `to_tsvector('simple', body)` has nine posting lists of
  -- about eleven thousand rows each: a term that matches a slice, which is what a search measures.
  (ARRAY[
    'Is the 3BHK still available for a site visit this weekend',
    'Could you send the floor plan and the price list please',
    'We are comparing two projects, what is your best offer',
    'Thank you, I will discuss with my family and confirm',
    'What are the documents needed for the home loan',
    'Can we meet on Saturday morning at the site office',
    'The possession date you mentioned works for us',
    'Please share the payment schedule and the registration cost',
    'I am still thinking about it, call me next week'
  ])[1 + ((c.n * 7 + k) % 9)],
  '{}'::jsonb,
  'whatsapp_cloud',
  'wamid.perf.' || c.n || '.' || k,
  CASE WHEN dir.direction = 'inbound' THEN 0 ELSE 1 END,
  CASE WHEN dir.direction = 'inbound' THEN NULL ELSE c.assigned_user_id END,
  (CASE
     WHEN dir.direction = 'inbound' THEN 'delivered'
     WHEN (c.n + k) % 37 = 0 THEN 'failed'
     WHEN (c.n + k) % 5 = 0 THEN 'sent'
     ELSE 'read'
   END)::message_status,
  CASE WHEN dir.direction = 'outbound' AND (c.n + k) % 37 = 0 THEN '131047' ELSE NULL END,
  CASE WHEN dir.direction = 'outbound' AND (c.n + k) % 37 = 0
       THEN 'More than 24 hours have passed since the customer last replied' ELSE NULL END,
  c.created_at + ((k * 37) || ' minutes')::interval,
  CASE WHEN dir.direction = 'outbound' AND (c.n + k) % 37 <> 0
       THEN c.created_at + ((k * 37 + 1) || ' minutes')::interval ELSE NULL END,
  CASE WHEN dir.direction = 'outbound' AND (c.n + k) % 5 <> 0 AND (c.n + k) % 37 <> 0
       THEN c.created_at + ((k * 37 + 4) || ' minutes')::interval ELSE NULL END,
  CASE WHEN dir.direction = 'outbound' AND (c.n + k) % 37 = 0
       THEN c.created_at + ((k * 37 + 2) || ' minutes')::interval ELSE NULL END,
  -- `FR-BIL-4`'s two columns, written from Meta's receipts in production and written here so a
  -- meter has something to read. Only an outbound message that opened a conversation is billed.
  dir.direction = 'outbound' AND k % 25 = 1,
  CASE WHEN dir.direction = 'outbound' AND k % 25 = 1
       THEN (ARRAY['service','utility','marketing','authentication'])[1 + ((c.n + k) % 4)]
       ELSE NULL END,
  -- Inside the conversation's own lifetime, and therefore inside the partitions the fixture spans.
  -- `messages` has no `updated_at`: it is append-only apart from its status columns, which is why
  -- Prisma generated none and why this insert names one column fewer than the others here.
  c.created_at + ((k * 37) || ' minutes')::interval
FROM (
  SELECT c.id, c.organization_id, c.assigned_user_id, c.created_at,
         row_number() OVER (ORDER BY c.contact_e164) AS n
    FROM conversations c
   WHERE c.organization_id = (SELECT organization_id FROM scratch)
     AND c.channel_account_id = '00000000-0000-7000-8000-00000000f003'::uuid
) c
CROSS JOIN generate_series(1, 25) k
JOIN LATERAL (
  SELECT (CASE WHEN (c.n + k) % 2 = 0 THEN 'inbound' ELSE 'outbound' END)::message_direction AS direction
) dir ON true
WHERE NOT EXISTS (
  SELECT 1 FROM messages WHERE provider_message_id = 'wamid.perf.' || c.n || '.' || k
);

-- ── 3. The conversation's own summary columns, from the messages ──────────────
-- `last_message_at` is what the list sorts by and `last_inbound_at` is what the 24-hour window is
-- measured from, so both have to agree with the rows they summarise. Computed here rather than
-- guessed above, because a guess is what made the first version of this fixture sort by an instant
-- no message had.
UPDATE conversations c
   SET last_message_at = m.newest,
       last_inbound_at = m.newest_inbound,
       last_outbound_at = m.newest_outbound,
       -- Open on the handful whose newest inbound is inside the last 24 hours, which is what the
       -- composer's text box is enabled by. The CHECK insists on a `last_inbound_at` to count from.
       window_expires_at = CASE
         WHEN m.newest_inbound > now() - interval '24 hours' THEN m.newest_inbound + interval '24 hours'
         ELSE NULL
       END
  FROM (
    SELECT conversation_id,
           max(created_at) AS newest,
           max(created_at) FILTER (WHERE direction = 'inbound') AS newest_inbound,
           max(created_at) FILTER (WHERE direction = 'outbound') AS newest_outbound
      FROM messages
     WHERE provider_message_id LIKE 'wamid.perf.%'
     GROUP BY conversation_id
  ) m
 WHERE c.id = m.conversation_id
   AND c.channel_account_id = '00000000-0000-7000-8000-00000000f003'::uuid;

ANALYZE conversations;
ANALYZE messages;

SELECT (SELECT count(*) FROM conversations WHERE channel_account_id = '00000000-0000-7000-8000-00000000f003'::uuid) AS conversations_in_fixture,
       (SELECT count(*) FROM messages WHERE provider_message_id LIKE 'wamid.perf.%') AS messages_in_fixture,
       (SELECT count(DISTINCT date_trunc('month', created_at)) FROM messages WHERE provider_message_id LIKE 'wamid.perf.%') AS months_spanned;

COMMIT;
