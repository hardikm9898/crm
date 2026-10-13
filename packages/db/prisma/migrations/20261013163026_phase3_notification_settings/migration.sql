-- Phase 3 step 4 — the notification centre and quiet hours (`FR-NOT-3`).
--
-- Prisma generated **fifteen** spurious statements above the first real one: two composite foreign
-- keys spanning three columns (`leads_stage_in_pipeline_fk`, `deals_stage_in_pipeline_fk`) and
-- thirteen GIN, trigram and partial indexes. None can be expressed in `schema.prisma`, so every
-- diff proposes dropping them; all fifteen were deleted from this file by hand. The `ADD COLUMN`s
-- below sit in the same region as those drops, which is why the cut is statement by statement and
-- not "everything before the first CREATE TABLE" — doing that once cost a failed migration.
--
-- Everything hand-written here is listed in `packages/db/src/schema-objects.int-spec.ts`.

-- AlterTable
ALTER TABLE "notifications" ADD COLUMN     "deferred_until" TIMESTAMPTZ(6),
ADD COLUMN     "superseded_at" TIMESTAMPTZ(6);

-- CreateTable
CREATE TABLE "notification_settings" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "quiet_start_minute" INTEGER,
    "quiet_end_minute" INTEGER,
    "time_zone" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "notification_settings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "notification_settings_organization_id_id_key" ON "notification_settings"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "notification_settings_organization_id_user_id_key" ON "notification_settings"("organization_id", "user_id");

-- AddForeignKey
ALTER TABLE "notification_settings" ADD CONSTRAINT "notification_settings_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_settings" ADD CONSTRAINT "notification_settings_membership_same_org_fk" FOREIGN KEY ("organization_id", "user_id") REFERENCES "memberships"("organization_id", "user_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── Hand-written: the rules a quiet window has to obey ──────────────────────
--
-- Written as explicit `IS NULL OR …` rather than `BETWEEN`, because a CHECK that evaluates to NULL
-- is *satisfied*: on a null column `quiet_start_minute BETWEEN 0 AND 1439` is NULL and lets the row
-- in, which is the same trap `escalations_notified_somebody` paid for. Here null is legal, so the
-- shape has to say so out loud rather than rely on it.
ALTER TABLE "notification_settings"
  ADD CONSTRAINT "notification_settings_quiet_minutes_range" CHECK (
    (quiet_start_minute IS NULL OR (quiet_start_minute >= 0 AND quiet_start_minute < 1440))
    AND (quiet_end_minute IS NULL OR (quiet_end_minute >= 0 AND quiet_end_minute < 1440))
  );

-- Both ends or neither. Half a window is not a window, and the code that reads it would have to
-- invent the other end — which is how one person's quiet hours become "until midnight" silently.
ALTER TABLE "notification_settings"
  ADD CONSTRAINT "notification_settings_quiet_hours_pair" CHECK (
    (quiet_start_minute IS NULL) = (quiet_end_minute IS NULL)
  );

-- A window whose ends are equal is ambiguous — "never quiet" or "always quiet"? — so it cannot be
-- stored. `quietHoursHold` treats one as never quiet defensively; this is where the question is
-- actually settled.
ALTER TABLE "notification_settings"
  ADD CONSTRAINT "notification_settings_quiet_hours_distinct" CHECK (
    quiet_start_minute IS NULL OR quiet_start_minute <> quiet_end_minute
  );

-- ── Hand-written: what the release sweep scans ──────────────────────────────
--
-- Deliberately **not** prefixed by `organization_id`: the sweep runs platform-wide, every few
-- minutes, asking "what is due to be released anywhere" — a leading tenant column would make it
-- scan instead of seek. The same shape, and the same reasoning, as `sla_clocks_awaiting_breach`.
CREATE INDEX notifications_awaiting_release
  ON notifications (deferred_until)
  WHERE deferred_until IS NOT NULL AND superseded_at IS NULL;
