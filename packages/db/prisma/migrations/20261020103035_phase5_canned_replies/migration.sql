-- Phase 5 step 5 — canned replies, tags and the usage meter.
--
-- Prisma generated this with 15 spurious DROPs at the top, as every migration in this phase has:
-- two composite FKs, four GIN indexes, four trigram indexes, two expression indexes, a partial
-- unique and a partial index — each one something `migrate diff` sees in the database, does not see
-- in `schema.prisma`, and drops. They are deleted here. The `-- AlterTable … ADD COLUMN` block
-- lives in the same region and is **kept**.
--
-- `packages/db/src/schema-objects.int-spec.ts` is the only thing that catches a drop that is missed.

-- AlterTable
ALTER TABLE "messages" ADD COLUMN     "canned_reply_id" UUID;

-- CreateTable
CREATE TABLE "canned_replies" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "shortcut" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "visibility" TEXT NOT NULL DEFAULT 'shared',
    "owner_user_id" UUID NOT NULL,
    "usage_count" INTEGER NOT NULL DEFAULT 0,
    "last_used_at" TIMESTAMPTZ(6),
    "deleted_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "canned_replies_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "canned_replies_organization_id_usage_count_idx" ON "canned_replies"("organization_id", "usage_count" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "canned_replies_organization_id_id_key" ON "canned_replies"("organization_id", "id");

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_canned_reply_same_org_fk" FOREIGN KEY ("organization_id", "canned_reply_id") REFERENCES "canned_replies"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "canned_replies" ADD CONSTRAINT "canned_replies_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "canned_replies" ADD CONSTRAINT "canned_replies_owner_same_org_fk" FOREIGN KEY ("organization_id", "owner_user_id") REFERENCES "memberships"("organization_id", "user_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────────────
-- Hand-written objects. Prisma cannot express a CHECK or a partial unique, so
-- its next diff will try to drop every one of these: they are listed in
-- `packages/db/src/schema-objects.int-spec.ts`, which is the only guard.
-- ─────────────────────────────────────────────────────────────────────────────

-- A shortcut is what somebody types, so it has to be typeable: lower case, no spaces, one leading
-- slash. The length is a `length()` test rather than a regex quantifier, because Postgres refuses a
-- repetition count above 255 and a CHECK written `{1,1024}` installs happily and then rejects every
-- insert — which this phase has already paid for once, on a template name.
ALTER TABLE "canned_replies"
  ADD CONSTRAINT "canned_replies_shortcut_shape"
  CHECK ("shortcut" ~ '^/[a-z0-9]+(-[a-z0-9]+)*$' AND length("shortcut") <= 32);

-- A reply with nothing in it is a shortcut that sends a blank message. 1024 is WhatsApp's own
-- ceiling for a text body, so a longer one could be stored and never sent.
ALTER TABLE "canned_replies"
  ADD CONSTRAINT "canned_replies_body_not_blank"
  CHECK (length(btrim("body")) > 0 AND length("body") <= 1024);

ALTER TABLE "canned_replies"
  ADD CONSTRAINT "canned_replies_visibility"
  CHECK ("visibility" IN ('shared', 'private'));

ALTER TABLE "canned_replies"
  ADD CONSTRAINT "canned_replies_usage_count_sane"
  CHECK ("usage_count" >= 0);

-- A used reply is archived, never deleted (`messages.canned_reply_id` is `Restrict`), so the
-- unique has to ignore the archived ones or a workspace could never reuse a shortcut it retired.
-- The owner is in the key because a **private** reply is somebody's own: two people may each have
-- their own `/thanks`, and a shared one is unique across the workspace. Prisma cannot express a
-- partial unique, which is why this is here and in the schema-object suite.
CREATE UNIQUE INDEX "canned_replies_live_shortcut"
  ON "canned_replies" ("organization_id", "owner_user_id", "shortcut")
  WHERE "deleted_at" IS NULL;

-- The picker's own read: this workspace's live replies, most-used first. Partial, because an
-- archived reply is never offered and there is no point paging past them.
CREATE INDEX "canned_replies_offerable"
  ON "canned_replies" ("organization_id", "usage_count" DESC)
  WHERE "deleted_at" IS NULL;

-- The usage meter's read (`FR-BIL-4`): billable messages in a window, by category. No
-- `organization_id` prefix is wrong here and it is **not** omitted — unlike the sweeps' indexes,
-- this query is always one workspace asking about itself.
CREATE INDEX "messages_billable"
  ON "messages" ("organization_id", "created_at" DESC)
  WHERE "billable";

