-- Phase 5 step 4 — the shared inbox: who owns a conversation, and the word that stops a send.
--
-- Prisma generated this with 15 spurious DROPs at the top — two composite FKs, four GIN indexes,
-- four trigram indexes, two expression indexes, a partial unique and a partial index — every one
-- of them something `migrate diff` sees in the database, does not see in `schema.prisma`, and
-- drops. They are deleted here. The `-- AlterTable … ADD COLUMN` block lives in the same region
-- and is **kept**: cutting "everything before the first CreateTable" once removed two ADD COLUMNs
-- and the migration failed on a column that did not exist.
--
-- `packages/db/src/schema-objects.int-spec.ts` is the only thing that catches a drop that is missed.

-- AlterTable
ALTER TABLE "conversations" ADD COLUMN     "lock_expires_at" TIMESTAMPTZ(6),
ADD COLUMN     "lock_user_id" UUID,
ADD COLUMN     "snoozed_until" TIMESTAMPTZ(6);

-- CreateTable
CREATE TABLE "conversation_notes" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "body" TEXT NOT NULL,
    "author_user_id" UUID NOT NULL,
    "mentioned_user_ids" UUID[] DEFAULT ARRAY[]::UUID[],
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "conversation_notes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "conversation_notes_organization_id_conversation_id_created__idx" ON "conversation_notes"("organization_id", "conversation_id", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "conversation_notes_organization_id_id_key" ON "conversation_notes"("organization_id", "id");

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_locker_same_org_fk" FOREIGN KEY ("organization_id", "lock_user_id") REFERENCES "memberships"("organization_id", "user_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_notes" ADD CONSTRAINT "conversation_notes_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_notes" ADD CONSTRAINT "conversation_notes_conversation_same_org_fk" FOREIGN KEY ("organization_id", "conversation_id") REFERENCES "conversations"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_notes" ADD CONSTRAINT "conversation_notes_author_same_org_fk" FOREIGN KEY ("organization_id", "author_user_id") REFERENCES "memberships"("organization_id", "user_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────────────
-- Hand-written objects. Prisma cannot express a CHECK or a partial index, so its
-- next diff will try to drop every one of these: they are listed in
-- `packages/db/src/schema-objects.int-spec.ts`, which is the only guard.
-- ─────────────────────────────────────────────────────────────────────────────

-- A lock has both halves or neither.
--
-- Written as a **biconditional**, which this schema usually distrusts — and here both directions
-- really are contradictions, which is the test. A holder with no expiry is a lock that never
-- lapses, which is the single failure the five-minute TTL exists to prevent: a conversation
-- nobody else may touch because somebody opened it once. An expiry with no holder is an expiry
-- for nobody. Neither state is an honest thing to be in, so neither is allowed.
ALTER TABLE "conversations"
  ADD CONSTRAINT "conversations_lock_is_whole"
  CHECK (("lock_user_id" IS NULL) = ("lock_expires_at" IS NULL));

-- A snooze is a promise to come back, so it has to say when.
--
-- One direction only. The mirror — "anything not snoozed has no `snoozed_until`" — reads just as
-- sensibly and is **false**: a conversation closed while it was snoozed keeps the instant it was
-- waiting for, which is the honest record of what somebody asked for.
ALTER TABLE "conversations"
  ADD CONSTRAINT "conversations_snoozed_says_when"
  CHECK (
    CASE WHEN "status" = 'snoozed' THEN "snoozed_until" IS NOT NULL ELSE true END
  );

-- A note nobody can read is not a note.
ALTER TABLE "conversation_notes"
  ADD CONSTRAINT "conversation_notes_body_not_blank"
  CHECK (length(btrim("body")) > 0 AND length("body") <= 4000);

-- `cardinality`, never `array_length`: on an **empty** array `array_length` returns NULL, the
-- comparison is NULL, and Postgres lets the row in — so a check written with it would not bite at
-- all. Twenty is a note that names a team, not a note that names everybody.
ALTER TABLE "conversation_notes"
  ADD CONSTRAINT "conversation_notes_mentions_sane"
  CHECK (cardinality("mentioned_user_ids") <= 20);

-- The two queues the inbox sweep reads. Neither carries an `organization_id` prefix, deliberately:
-- that sweep runs across every tenant, as `messages_queued`, `message_media_awaiting` and
-- `calls_awaiting_outcome` already do.
CREATE INDEX "conversations_locked"
  ON "conversations" ("lock_expires_at")
  WHERE "lock_user_id" IS NOT NULL;

CREATE INDEX "conversations_snoozed"
  ON "conversations" ("snoozed_until")
  WHERE "status" = 'snoozed';
