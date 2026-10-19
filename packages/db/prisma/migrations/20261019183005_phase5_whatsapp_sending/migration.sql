-- Phase 5 step 2 — WhatsApp sending.
--
-- Prisma generated this with 15 spurious DROPs at the top: every composite FK, partial index,
-- expression index and GIN index the earlier migrations added by hand is something `migrate diff`
-- sees in the database, does not see in `schema.prisma`, and drops. They are deleted here, and
-- `packages/db/src/schema-objects.int-spec.ts` is the only thing that catches one that is missed.
-- The `ALTER TABLE … ADD COLUMN` below sits in the same region and is deliberately kept.

-- CreateEnum
CREATE TYPE "whatsapp_template_category" AS ENUM ('marketing', 'utility', 'authentication');

-- CreateEnum
CREATE TYPE "whatsapp_template_status" AS ENUM ('draft', 'pending', 'approved', 'rejected', 'paused', 'disabled');

-- AlterTable
ALTER TABLE "messages" ADD COLUMN     "send_attempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "template_id" UUID;

-- CreateTable
CREATE TABLE "whatsapp_templates" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "language" TEXT NOT NULL,
    "category" "whatsapp_template_category" NOT NULL,
    "status" "whatsapp_template_status" NOT NULL DEFAULT 'draft',
    "rejection_reason" TEXT,
    "components" JSONB NOT NULL,
    "variable_map" JSONB NOT NULL DEFAULT '{}',
    "provider_template_id" TEXT,
    "submitted_at" TIMESTAMPTZ(6),
    "synced_at" TIMESTAMPTZ(6),
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "whatsapp_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "message_status_events" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "message_id" UUID NOT NULL,
    "message_created_at" TIMESTAMPTZ(6) NOT NULL,
    "status" "message_status" NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL,
    "error_code" TEXT,
    "error_message" TEXT,
    "conversation_category" TEXT,
    "billable" BOOLEAN NOT NULL DEFAULT false,
    "raw" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "message_status_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "whatsapp_templates_organization_id_status_idx" ON "whatsapp_templates"("organization_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "whatsapp_templates_organization_id_id_key" ON "whatsapp_templates"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "whatsapp_templates_organization_id_account_id_name_language_key" ON "whatsapp_templates"("organization_id", "account_id", "name", "language");

-- CreateIndex
CREATE INDEX "message_status_events_organization_id_message_id_occurred_a_idx" ON "message_status_events"("organization_id", "message_id", "occurred_at");

-- CreateIndex
CREATE UNIQUE INDEX "message_status_events_organization_id_id_key" ON "message_status_events"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "message_status_events_organization_id_message_id_status_key" ON "message_status_events"("organization_id", "message_id", "status");

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_template_same_org_fk" FOREIGN KEY ("organization_id", "template_id") REFERENCES "whatsapp_templates"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "whatsapp_templates" ADD CONSTRAINT "whatsapp_templates_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "whatsapp_templates" ADD CONSTRAINT "whatsapp_templates_account_same_org_fk" FOREIGN KEY ("organization_id", "account_id") REFERENCES "whatsapp_accounts"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "whatsapp_templates" ADD CONSTRAINT "whatsapp_templates_author_same_org_fk" FOREIGN KEY ("organization_id", "created_by_id") REFERENCES "memberships"("organization_id", "user_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "message_status_events" ADD CONSTRAINT "message_status_events_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "message_status_events" ADD CONSTRAINT "message_status_events_message_same_org_fk" FOREIGN KEY ("organization_id", "message_id", "message_created_at") REFERENCES "messages"("organization_id", "id", "created_at") ON DELETE CASCADE ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────────────
-- Hand-written objects. Prisma cannot express a CHECK or a partial index, so its
-- next diff will try to drop every one of these: they are listed in
-- `packages/db/src/schema-objects.int-spec.ts`, which is the only guard.
-- ─────────────────────────────────────────────────────────────────────────────

-- Meta's own naming rule, enforced here as well as in the validator: a name it refuses is a
-- template whose submission fails hours after somebody wrote it.
--
-- The length is a `length()` test rather than a repetition count, because Postgres refuses a regex
-- quantifier above **255** — `{3,512}` is `invalid repetition count(s)` at insert time, which is a
-- 500 on a feature whose tests all passed when the constraint was written.
ALTER TABLE "whatsapp_templates"
  ADD CONSTRAINT "whatsapp_templates_name_shape"
  CHECK ("name" ~ '^[a-z0-9_]+$' AND length("name") BETWEEN 3 AND 512);

ALTER TABLE "whatsapp_templates"
  ADD CONSTRAINT "whatsapp_templates_language_shape"
  CHECK ("language" ~ '^[a-z]{2}(_[A-Z]{2})?$');

-- A `CASE`, not a biconditional: the mirror ("anything not rejected carries no reason") is false,
-- because a template resubmitted after a rejection keeps the reason it was refused for last time —
-- which is the one thing the person editing it needs to read.
ALTER TABLE "whatsapp_templates"
  ADD CONSTRAINT "whatsapp_templates_rejected_says_why"
  CHECK (CASE WHEN "status" = 'rejected' THEN "rejection_reason" IS NOT NULL ELSE true END);

-- Anything Meta knows about has Meta's id. A draft is ours alone and has none.
ALTER TABLE "whatsapp_templates"
  ADD CONSTRAINT "whatsapp_templates_submitted_has_provider_id"
  CHECK (CASE WHEN "status" <> 'draft' THEN "provider_template_id" IS NOT NULL ELSE true END);

ALTER TABLE "whatsapp_templates"
  ADD CONSTRAINT "whatsapp_templates_components_is_an_object"
  CHECK (jsonb_typeof("components") = 'object');

ALTER TABLE "whatsapp_templates"
  ADD CONSTRAINT "whatsapp_templates_variable_map_is_an_object"
  CHECK (jsonb_typeof("variable_map") = 'object');

-- The templates a composer may offer. Keyed `(organization_id, account_id)` because that is how
-- the picker asks, and partial because an unapproved template is not one of them.
CREATE INDEX "whatsapp_templates_sendable"
  ON "whatsapp_templates" ("organization_id", "account_id")
  WHERE "status" = 'approved' AND "deleted_at" IS NULL;

-- A failed receipt that says nothing is a failure nobody can act on, which is the whole point of
-- `FR-WA-4`. Again a `CASE`: a *successful* receipt may also carry an error Meta reports for
-- information, so the mirror would refuse an honest row.
ALTER TABLE "message_status_events"
  ADD CONSTRAINT "message_status_events_failed_says_why"
  CHECK (
    CASE
      WHEN "status" = 'failed' THEN "error_code" IS NOT NULL OR "error_message" IS NOT NULL
      ELSE true
    END
  );

ALTER TABLE "message_status_events"
  ADD CONSTRAINT "message_status_events_raw_is_an_object"
  CHECK (jsonb_typeof("raw") = 'object');

-- Sending is something we do to an outbound message. A non-zero count on an inbound row would mean
-- something tried to send a customer's own words back to them.
ALTER TABLE "messages"
  ADD CONSTRAINT "messages_send_attempts_sane"
  CHECK (
    "send_attempts" >= 0
    AND CASE WHEN "direction" = 'inbound' THEN "send_attempts" = 0 ELSE true END
  );

-- A message that names one of our templates is a template message. The mirror is false: a
-- `template` message may have arrived from outside this product, or be one Meta reports for a
-- template we have never stored, and making that unrepresentable would lose the row.
ALTER TABLE "messages"
  ADD CONSTRAINT "messages_template_id_is_a_template"
  CHECK (CASE WHEN "template_id" IS NOT NULL THEN "type" = 'template' ELSE true END);

-- The send queue's own index, for the sweep that re-queues a message a worker never sent. No
-- `organization_id` prefix, deliberately: that sweep runs across every tenant, as the call-nudge
-- index already does.
CREATE INDEX "messages_queued"
  ON "messages" ("created_at")
  WHERE "status" = 'queued';
