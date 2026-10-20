-- Phase 5 step 3 — WhatsApp media.
--
-- Prisma generated this with 15 spurious DROPs at the top: every composite FK, partial index,
-- expression index and GIN index the earlier migrations added by hand is something `migrate diff`
-- sees in the database, does not see in `schema.prisma`, and drops. They are deleted here, and
-- `packages/db/src/schema-objects.int-spec.ts` is the only thing that catches one that is missed.

-- CreateEnum
CREATE TYPE "media_download_status" AS ENUM ('pending', 'stored', 'refused', 'failed');

-- CreateTable
CREATE TABLE "message_media" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "message_id" UUID NOT NULL,
    "message_created_at" TIMESTAMPTZ(6) NOT NULL,
    "provider_media_id" TEXT,
    "file_key" TEXT,
    "file_name" TEXT,
    "mime_type" TEXT,
    "size_bytes" INTEGER,
    "sha256" TEXT,
    "voice" BOOLEAN NOT NULL DEFAULT false,
    "download_status" "media_download_status" NOT NULL DEFAULT 'pending',
    "reason" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "scan_status" TEXT NOT NULL DEFAULT 'pending',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "message_media_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "message_media_organization_id_download_status_idx" ON "message_media"("organization_id", "download_status");

-- CreateIndex
CREATE UNIQUE INDEX "message_media_organization_id_id_key" ON "message_media"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "message_media_organization_id_message_id_key" ON "message_media"("organization_id", "message_id");

-- AddForeignKey
ALTER TABLE "message_media" ADD CONSTRAINT "message_media_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "message_media" ADD CONSTRAINT "message_media_message_same_org_fk" FOREIGN KEY ("organization_id", "message_id", "message_created_at") REFERENCES "messages"("organization_id", "id", "created_at") ON DELETE CASCADE ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────────────
-- Hand-written objects. Prisma cannot express a CHECK or a partial index, so its
-- next diff will try to drop every one of these: they are listed in
-- `packages/db/src/schema-objects.int-spec.ts`, which is the only guard.
-- ─────────────────────────────────────────────────────────────────────────────

-- A stored file has bytes somewhere and a size. Written as a `CASE` in the one direction that is a
-- contradiction: the mirror ("anything not stored has no file key") is false, because an outbound
-- attachment is stored by us *before* Meta has been given it and before it has been sent.
ALTER TABLE "message_media"
  ADD CONSTRAINT "message_media_stored_has_a_file"
  CHECK (
    CASE
      WHEN "download_status" = 'stored' THEN "file_key" IS NOT NULL AND "size_bytes" IS NOT NULL
      ELSE true
    END
  );

-- A refusal that does not say why is a refusal nobody can act on — the same rule as a failed
-- message and a failed probe.
ALTER TABLE "message_media"
  ADD CONSTRAINT "message_media_refused_says_why"
  CHECK (
    CASE WHEN "download_status" IN ('refused', 'failed') THEN "reason" IS NOT NULL ELSE true END
  );

ALTER TABLE "message_media"
  ADD CONSTRAINT "message_media_size_sane"
  CHECK ("size_bytes" IS NULL OR ("size_bytes" > 0 AND "size_bytes" <= 104857600));

ALTER TABLE "message_media"
  ADD CONSTRAINT "message_media_attempts_sane"
  CHECK ("attempts" >= 0);

-- The same vocabulary `documents_scan_status` already fixes for an uploaded file. Nothing scans
-- either table yet; the column is the hook a scanner reads, and a CHECK is what stops a second
-- producer inventing a fourth word for it.
ALTER TABLE "message_media"
  ADD CONSTRAINT "message_media_scan_status"
  CHECK ("scan_status" IN ('pending', 'clean', 'infected'));

-- The queue the download sweep reads. No `organization_id` prefix, deliberately: that sweep runs
-- across every tenant, as the call-nudge and send-retry indexes already do.
CREATE INDEX "message_media_awaiting"
  ON "message_media" ("created_at")
  WHERE "download_status" IN ('pending', 'failed');
