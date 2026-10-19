-- ═══════════════════════════════════════════════════════════════════════════
-- Phase 5, step 1 — WhatsApp: a connected number, and the messages it receives.
--
-- Four tables. `whatsapp_accounts` and `whatsapp_numbers` are the connection's own shape — a WABA
-- has numbers, and a number is what a conversation belongs to. `conversations` and `messages` are
-- the channel-agnostic pair §7 specifies, because email, SMS and webchat arrive later into the same
-- inbox and a `whatsapp_conversations` table would have to be unioned with three others.
--
-- `whatsapp_numbers.phone_number_id` is **globally** unique rather than per workspace, and that is
-- load-bearing: an inbound delivery carries only that id, so it is the one thing that resolves
-- which workspace a message belongs to. Two workspaces claiming one number would make that a
-- guess, and a guess here delivers somebody's customer's message to the wrong business.
--
-- §7 specifies `UNIQUE (provider, provider_message_id)` globally as `FR-WA-6`'s idempotency gate.
-- A unique on a partitioned table must contain the partition key, so the one below is
-- `(provider, provider_message_id, created_at)`: a race guard within the month, not a point read.
-- The point read is `provider_events`, which is not partitioned — the same division
-- `inbound_payloads` and `idempotency_keys` already have, and the reason that ledger was built a
-- step early.
--
-- Prisma generated this with 15 spurious `DROP`s at the top — every composite FK, GIN, trigram and
-- partial index the earlier migrations added by hand, which `migrate diff` sees in the database and
-- not in `schema.prisma`. They have been removed: the `-- DropForeignKey` and `-- DropIndex`
-- sections only, because `AlterTable … ADD COLUMN` lives in the same region and cutting
-- "everything before the first CreateTable" has deleted those before.
-- `packages/db/src/schema-objects.int-spec.ts` is the only guard against the ones somebody misses.
-- ═══════════════════════════════════════════════════════════════════════════

-- CreateEnum
CREATE TYPE "whatsapp_account_status" AS ENUM ('pending', 'connected', 'revoked');

-- CreateEnum
CREATE TYPE "conversation_channel" AS ENUM ('whatsapp', 'email', 'sms', 'webchat');

-- CreateEnum
CREATE TYPE "conversation_status" AS ENUM ('open', 'pending', 'snoozed', 'closed');

-- CreateEnum
CREATE TYPE "message_direction" AS ENUM ('inbound', 'outbound');

-- CreateEnum
CREATE TYPE "message_type" AS ENUM ('text', 'image', 'video', 'audio', 'document', 'location', 'contacts', 'sticker', 'template', 'interactive', 'reaction', 'system');

-- CreateEnum
CREATE TYPE "message_status" AS ENUM ('queued', 'accepted', 'sent', 'delivered', 'read', 'failed');

-- CreateTable
CREATE TABLE "whatsapp_accounts" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "integration_connection_id" UUID NOT NULL,
    "waba_id" TEXT NOT NULL,
    "business_name" TEXT,
    "status" "whatsapp_account_status" NOT NULL DEFAULT 'pending',
    "verified_at" TIMESTAMPTZ(6),
    "last_error" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "whatsapp_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "whatsapp_numbers" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "phone_number_id" TEXT NOT NULL,
    "display_phone_e164" TEXT NOT NULL,
    "verified_name" TEXT,
    "quality_rating" TEXT,
    "messaging_limit_tier" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "default_agent_user_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "whatsapp_numbers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conversations" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "channel" "conversation_channel" NOT NULL DEFAULT 'whatsapp',
    "channel_account_id" UUID NOT NULL,
    "contact_e164" TEXT,
    "lead_id" UUID,
    "customer_id" UUID,
    "assigned_user_id" UUID,
    "assigned_team_id" UUID,
    "status" "conversation_status" NOT NULL DEFAULT 'open',
    "priority" INTEGER NOT NULL DEFAULT 0,
    "last_message_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_inbound_at" TIMESTAMPTZ(6),
    "last_outbound_at" TIMESTAMPTZ(6),
    "unread_count" INTEGER NOT NULL DEFAULT 0,
    "first_response_at" TIMESTAMPTZ(6),
    "window_expires_at" TIMESTAMPTZ(6),
    "closed_at" TIMESTAMPTZ(6),
    "closed_by_id" UUID,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "conversations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "messages" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "direction" "message_direction" NOT NULL,
    "type" "message_type" NOT NULL,
    "body" TEXT,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "provider" TEXT NOT NULL DEFAULT 'whatsapp_cloud',
    "provider_message_id" TEXT,
    "reply_to_provider_id" TEXT,
    "sender_user_id" UUID,
    "status" "message_status" NOT NULL DEFAULT 'delivered',
    "error_code" TEXT,
    "error_message" TEXT,
    "sent_at" TIMESTAMPTZ(6),
    "delivered_at" TIMESTAMPTZ(6),
    "read_at" TIMESTAMPTZ(6),
    "failed_at" TIMESTAMPTZ(6),
    "billable" BOOLEAN NOT NULL DEFAULT false,
    "conversation_category" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "messages_pkey" PRIMARY KEY ("id","created_at")
)
-- Hand-written: Prisma cannot create a partitioned table, and its later diffs do not notice this
-- clause. `messages` is the fastest-growing table a WhatsApp workspace has and §15 retains it for
-- 24 months, which a partition drop satisfies without deleting a row.
PARTITION BY RANGE ("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "whatsapp_accounts_organization_id_id_key" ON "whatsapp_accounts"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "whatsapp_accounts_organization_id_waba_id_key" ON "whatsapp_accounts"("organization_id", "waba_id");

-- CreateIndex
CREATE UNIQUE INDEX "whatsapp_numbers_phone_number_id_key" ON "whatsapp_numbers"("phone_number_id");

-- CreateIndex
CREATE INDEX "whatsapp_numbers_organization_id_account_id_idx" ON "whatsapp_numbers"("organization_id", "account_id");

-- CreateIndex
CREATE UNIQUE INDEX "whatsapp_numbers_organization_id_id_key" ON "whatsapp_numbers"("organization_id", "id");

-- CreateIndex
CREATE INDEX "conversations_organization_id_channel_account_id_status_las_idx" ON "conversations"("organization_id", "channel_account_id", "status", "last_message_at" DESC);

-- CreateIndex
CREATE INDEX "conversations_organization_id_assigned_user_id_status_last__idx" ON "conversations"("organization_id", "assigned_user_id", "status", "last_message_at" DESC);

-- CreateIndex
CREATE INDEX "conversations_organization_id_lead_id_idx" ON "conversations"("organization_id", "lead_id");

-- CreateIndex
CREATE UNIQUE INDEX "conversations_organization_id_id_key" ON "conversations"("organization_id", "id");

-- CreateIndex
CREATE INDEX "messages_organization_id_conversation_id_created_at_idx" ON "messages"("organization_id", "conversation_id", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "messages_organization_id_id_created_at_key" ON "messages"("organization_id", "id", "created_at");

-- AddForeignKey
ALTER TABLE "whatsapp_accounts" ADD CONSTRAINT "whatsapp_accounts_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "whatsapp_accounts" ADD CONSTRAINT "whatsapp_accounts_connection_same_org_fk" FOREIGN KEY ("organization_id", "integration_connection_id") REFERENCES "integration_connections"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "whatsapp_numbers" ADD CONSTRAINT "whatsapp_numbers_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "whatsapp_numbers" ADD CONSTRAINT "whatsapp_numbers_account_same_org_fk" FOREIGN KEY ("organization_id", "account_id") REFERENCES "whatsapp_accounts"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "whatsapp_numbers" ADD CONSTRAINT "whatsapp_numbers_default_agent_same_org_fk" FOREIGN KEY ("organization_id", "default_agent_user_id") REFERENCES "memberships"("organization_id", "user_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_number_same_org_fk" FOREIGN KEY ("organization_id", "channel_account_id") REFERENCES "whatsapp_numbers"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_lead_same_org_fk" FOREIGN KEY ("organization_id", "lead_id") REFERENCES "leads"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_customer_same_org_fk" FOREIGN KEY ("organization_id", "customer_id") REFERENCES "customers"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_assignee_same_org_fk" FOREIGN KEY ("organization_id", "assigned_user_id") REFERENCES "memberships"("organization_id", "user_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_closer_same_org_fk" FOREIGN KEY ("organization_id", "closed_by_id") REFERENCES "memberships"("organization_id", "user_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_same_org_fk" FOREIGN KEY ("organization_id", "conversation_id") REFERENCES "conversations"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_sender_same_org_fk" FOREIGN KEY ("organization_id", "sender_user_id") REFERENCES "memberships"("organization_id", "user_id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ── The monthly partitions ────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION ensure_message_partition(target timestamptz)
RETURNS text
LANGUAGE plpgsql
AS $$
DECLARE
  month_start date := date_trunc('month', target)::date;
  month_end   date := (date_trunc('month', target) + interval '1 month')::date;
  part_name   text := format('messages_%s', to_char(month_start, 'YYYY_MM'));
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = part_name) THEN
    EXECUTE format(
      'CREATE TABLE %I PARTITION OF messages FOR VALUES FROM (%L) TO (%L)',
      part_name, month_start, month_end
    );
  END IF;
  RETURN part_name;
END;
$$;

COMMENT ON FUNCTION ensure_message_partition(timestamptz) IS
  'Creates the monthly messages partition containing the given instant, if it does not exist. Idempotent; called by the partition-maintenance job.';

-- One month back and twelve forward. A message arrives now; only a queued outbound one could sit
-- behind, which is minutes.
DO $$
DECLARE
  offset_months int;
BEGIN
  FOR offset_months IN -1..12 LOOP
    PERFORM ensure_message_partition(now() + (offset_months || ' months')::interval);
  END LOOP;
END;
$$;

CREATE TABLE messages_default PARTITION OF messages DEFAULT;

COMMENT ON TABLE messages_default IS
  'Catch-all for instants outside the pre-created monthly partitions. Rows here block ATTACH of the overlapping month, so the maintenance job reports them.';

-- ── Hand-written indexes Prisma cannot express ────────────────────────────

-- `FR-WA-6`'s race guard. Partial, because an outbound message has no provider id until Meta
-- accepts it — a complete unique would allow exactly one unsent message per month.
CREATE UNIQUE INDEX "messages_provider_message_unique"
  ON "messages" ("provider", "provider_message_id", "created_at")
  WHERE provider_message_id IS NOT NULL;

-- The unread badge (§7). Partial, so it stays small however many conversations are read.
CREATE INDEX "conversations_unread" ON "conversations" ("organization_id", "last_message_at" DESC)
  WHERE unread_count > 0 AND status <> 'closed';

-- The window-expiry sweep's queue. Keyed on `window_expires_at` alone, with no `organization_id`
-- prefix, because that sweep runs across every tenant and cannot use one that has it — the same
-- reason `calls_awaiting_outcome` is keyed the way it is.
CREATE INDEX "conversations_window_closing" ON "conversations" ("window_expires_at")
  WHERE window_expires_at IS NOT NULL AND status <> 'closed';

-- Message body search (`FR-VIEW-1`, §7's own GIN). An expression index rather than a stored
-- `tsvector` column: the body is written once and never edited, so there is no trigger to keep in
-- step and nothing for Prisma's diff to disagree with beyond this statement.
CREATE INDEX "messages_body_search" ON "messages"
  USING GIN (to_tsvector('simple', coalesce(body, '')));

-- ── CHECK constraints ─────────────────────────────────────────────────────

-- A number is E.164 or it is not a number anybody can message.
ALTER TABLE "whatsapp_numbers" ADD CONSTRAINT "whatsapp_numbers_display_phone_e164"
  CHECK (display_phone_e164 ~ '^\+[1-9][0-9]{7,14}$');

ALTER TABLE "conversations" ADD CONSTRAINT "conversations_contact_e164"
  CHECK (contact_e164 IS NULL OR contact_e164 ~ '^\+[1-9][0-9]{7,14}$');

-- An unread count below nothing is a decrement that ran twice.
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_unread_count_sane"
  CHECK (unread_count >= 0);

-- Written as a CASE in the one direction that is a contradiction, for the reason the payments pair
-- paid for: a closed conversation says when, and by whom. The mirror ("anything with a closed_at is
-- closed") reads just as sensibly and is false — a reopened conversation keeps the instant it was
-- closed, which is the history somebody reads.
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_closed_says_when"
  CHECK (
    CASE
      WHEN status = 'closed' THEN closed_at IS NOT NULL
      ELSE true
    END
  );

-- The 24-hour window is written from the customer's last message, so one cannot exist without the
-- other. Again one direction only: a conversation whose window has been cleared by the sweep still
-- has a `last_inbound_at`, and that is the honest state.
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_window_needs_inbound"
  CHECK (
    CASE
      WHEN window_expires_at IS NOT NULL THEN last_inbound_at IS NOT NULL
      ELSE true
    END
  );

-- An inbound message is somebody else's: it has no sender of ours, and a row claiming one would
-- put a colleague's name on a customer's words.
ALTER TABLE "messages" ADD CONSTRAINT "messages_inbound_has_no_sender"
  CHECK (
    CASE
      WHEN direction = 'inbound' THEN sender_user_id IS NULL
      ELSE true
    END
  );

-- A failed message says why and when. The mirror would forbid a `failed_at` on a message that was
-- later resent successfully, which is a state the retry path produces.
ALTER TABLE "messages" ADD CONSTRAINT "messages_failed_says_why"
  CHECK (
    CASE
      WHEN status = 'failed' THEN failed_at IS NOT NULL AND (error_code IS NOT NULL OR error_message IS NOT NULL)
      ELSE true
    END
  );

-- A provider id is the shape the provider sends. `wamid.` for WhatsApp; a bare id for anything
-- else, so this only refuses what is plainly not an id.
ALTER TABLE "messages" ADD CONSTRAINT "messages_provider_id_shape"
  CHECK (provider_message_id IS NULL OR length(provider_message_id) BETWEEN 4 AND 200);

ALTER TABLE "messages" ADD CONSTRAINT "messages_payload_is_an_object"
  CHECK (jsonb_typeof(payload) = 'object');
