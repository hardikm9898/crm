-- Removes the inbox fixture. Run this before `work-100k-remove.sql` and `leads-100k-remove.sql`:
-- the conversations point at `Perf Lead` rows, and `conversations_lead_same_org_fk` is `Restrict`.
--
--   psql "$DATABASE_URL" -v slug=acme-realty -f packages/db/perf/inbox-100k-remove.sql
--
-- Only rows this fixture created: the messages by their `wamid.perf.` provider id, the
-- conversations by the fixture number they hang off, and the number, account and connection by
-- their fixed ids. Nothing here can take a real conversation with it.
\set ON_ERROR_STOP on

BEGIN;

DELETE FROM messages WHERE provider_message_id LIKE 'wamid.perf.%';
DELETE FROM conversation_notes
 WHERE conversation_id IN (
   SELECT id FROM conversations WHERE channel_account_id = '00000000-0000-7000-8000-00000000f003'::uuid
 );
DELETE FROM conversations WHERE channel_account_id = '00000000-0000-7000-8000-00000000f003'::uuid;
DELETE FROM whatsapp_numbers WHERE id = '00000000-0000-7000-8000-00000000f003'::uuid;
DELETE FROM whatsapp_accounts WHERE id = '00000000-0000-7000-8000-00000000f002'::uuid;
DELETE FROM integration_connections WHERE id = '00000000-0000-7000-8000-00000000f001'::uuid;

SELECT (SELECT count(*) FROM conversations WHERE channel_account_id = '00000000-0000-7000-8000-00000000f003'::uuid) AS conversations_left,
       (SELECT count(*) FROM messages WHERE provider_message_id LIKE 'wamid.perf.%') AS messages_left;

COMMIT;
