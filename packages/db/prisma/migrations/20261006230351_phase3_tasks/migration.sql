-- Phase 3, step 1 — tasks and follow-ups (`FR-TSK-1..6`).
--
-- ┌─────────────────────────────────────────────────────────────────────────────────────────────┐
-- │ GENERATED, THEN EDITED. Prisma's diff arrived with 2 `DropForeignKey` and 11 `DropIndex`     │
-- │ statements at the top — every composite FK, GIN index, trigram index and partial unique      │
-- │ index the earlier migrations added by hand, because none of them can be expressed in          │
-- │ `schema.prisma` and `migrate diff` therefore sees them as drift. They were deleted from this  │
-- │ file. Only the `-- DropForeignKey` and `-- DropIndex` sections were removed: the              │
-- │ `-- AlterTable … ADD COLUMN` that Prisma puts in the same region is real and was kept, which  │
-- │ is the mistake the payments migration made.                                                   │
-- │ `packages/db/src/schema-objects.int-spec.ts` is the only thing that catches a missed one.     │
-- └─────────────────────────────────────────────────────────────────────────────────────────────┘

-- CreateEnum
CREATE TYPE "task_status" AS ENUM ('pending', 'in_progress', 'completed', 'cancelled');

-- CreateEnum
CREATE TYPE "task_priority" AS ENUM ('low', 'medium', 'high', 'urgent');

-- CreateEnum
CREATE TYPE "task_created_via" AS ENUM ('manual', 'automation', 'api', 'system', 'import');

ALTER TABLE "leads" ADD COLUMN     "next_action_task_id" UUID;

-- CreateTable
CREATE TABLE "task_types" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "icon" TEXT,
    "default_duration_minutes" INTEGER,
    "default_reminder_offsets" JSONB NOT NULL DEFAULT '[]',
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "task_types_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "task_outcomes" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "is_positive" BOOLEAN,
    "requires_note" BOOLEAN NOT NULL DEFAULT false,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "task_outcomes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reschedule_reasons" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "requires_note" BOOLEAN NOT NULL DEFAULT false,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "reschedule_reasons_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tasks" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "lead_id" UUID,
    "customer_id" UUID,
    "deal_id" UUID,
    "branch_id" UUID,
    "team_id" UUID,
    "assigned_user_id" UUID,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "task_type_id" UUID,
    "due_at" TIMESTAMPTZ(6) NOT NULL,
    "due_date" DATE NOT NULL,
    "due_time" TIME(0) NOT NULL,
    "priority" "task_priority" NOT NULL DEFAULT 'medium',
    "status" "task_status" NOT NULL DEFAULT 'pending',
    "completed_at" TIMESTAMPTZ(6),
    "cancelled_at" TIMESTAMPTZ(6),
    "outcome_id" UUID,
    "completion_note" TEXT,
    "reminder_offsets" JSONB NOT NULL DEFAULT '[]',
    "created_via" "task_created_via" NOT NULL DEFAULT 'manual',
    "follows_task_id" UUID,
    "reschedule_count" INTEGER NOT NULL DEFAULT 0,
    "overdue_notified_at" TIMESTAMPTZ(6),
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "task_reschedules" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "task_id" UUID NOT NULL,
    "from_due_at" TIMESTAMPTZ(6) NOT NULL,
    "to_due_at" TIMESTAMPTZ(6) NOT NULL,
    "reason_id" UUID NOT NULL,
    "reason_note" TEXT,
    "rescheduled_by_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "task_reschedules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "task_reminders" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "task_id" UUID NOT NULL,
    "remind_at" TIMESTAMPTZ(6) NOT NULL,
    "channel" "notification_channel" NOT NULL DEFAULT 'in_app',
    "offset_minutes" INTEGER NOT NULL,
    "sent_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "task_reminders_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "task_types_organization_id_is_active_sort_order_idx" ON "task_types"("organization_id", "is_active", "sort_order");

-- CreateIndex
CREATE UNIQUE INDEX "task_types_organization_id_id_key" ON "task_types"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "task_types_organization_id_name_key" ON "task_types"("organization_id", "name");

-- CreateIndex
CREATE INDEX "task_outcomes_organization_id_is_active_sort_order_idx" ON "task_outcomes"("organization_id", "is_active", "sort_order");

-- CreateIndex
CREATE UNIQUE INDEX "task_outcomes_organization_id_id_key" ON "task_outcomes"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "task_outcomes_organization_id_name_key" ON "task_outcomes"("organization_id", "name");

-- CreateIndex
CREATE INDEX "reschedule_reasons_organization_id_is_active_sort_order_idx" ON "reschedule_reasons"("organization_id", "is_active", "sort_order");

-- CreateIndex
CREATE UNIQUE INDEX "reschedule_reasons_organization_id_id_key" ON "reschedule_reasons"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "reschedule_reasons_organization_id_name_key" ON "reschedule_reasons"("organization_id", "name");

-- CreateIndex
CREATE INDEX "tasks_organization_id_assigned_user_id_status_due_at_idx" ON "tasks"("organization_id", "assigned_user_id", "status", "due_at");

-- CreateIndex
CREATE INDEX "tasks_organization_id_lead_id_status_due_at_idx" ON "tasks"("organization_id", "lead_id", "status", "due_at");

-- CreateIndex
CREATE INDEX "tasks_organization_id_customer_id_status_due_at_idx" ON "tasks"("organization_id", "customer_id", "status", "due_at");

-- CreateIndex
CREATE INDEX "tasks_organization_id_deal_id_status_due_at_idx" ON "tasks"("organization_id", "deal_id", "status", "due_at");

-- CreateIndex
CREATE INDEX "tasks_organization_id_status_due_at_idx" ON "tasks"("organization_id", "status", "due_at");

-- CreateIndex
CREATE INDEX "tasks_organization_id_reschedule_count_idx" ON "tasks"("organization_id", "reschedule_count");

-- CreateIndex
CREATE UNIQUE INDEX "tasks_organization_id_id_key" ON "tasks"("organization_id", "id");

-- CreateIndex
CREATE INDEX "task_reschedules_organization_id_task_id_created_at_idx" ON "task_reschedules"("organization_id", "task_id", "created_at");

-- CreateIndex
CREATE INDEX "task_reschedules_organization_id_reason_id_idx" ON "task_reschedules"("organization_id", "reason_id");

-- CreateIndex
CREATE UNIQUE INDEX "task_reschedules_organization_id_id_key" ON "task_reschedules"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "task_reminders_organization_id_id_key" ON "task_reminders"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "task_reminders_organization_id_task_id_offset_minutes_key" ON "task_reminders"("organization_id", "task_id", "offset_minutes");

-- AddForeignKey
ALTER TABLE "leads" ADD CONSTRAINT "leads_next_action_task_same_org_fk" FOREIGN KEY ("organization_id", "next_action_task_id") REFERENCES "tasks"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_types" ADD CONSTRAINT "task_types_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_outcomes" ADD CONSTRAINT "task_outcomes_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reschedule_reasons" ADD CONSTRAINT "reschedule_reasons_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_lead_same_org_fk" FOREIGN KEY ("organization_id", "lead_id") REFERENCES "leads"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_customer_same_org_fk" FOREIGN KEY ("organization_id", "customer_id") REFERENCES "customers"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_deal_same_org_fk" FOREIGN KEY ("organization_id", "deal_id") REFERENCES "deals"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_branch_same_org_fk" FOREIGN KEY ("organization_id", "branch_id") REFERENCES "branches"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_team_same_org_fk" FOREIGN KEY ("organization_id", "team_id") REFERENCES "teams"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_assignee_same_org_fk" FOREIGN KEY ("organization_id", "assigned_user_id") REFERENCES "memberships"("organization_id", "user_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_type_same_org_fk" FOREIGN KEY ("organization_id", "task_type_id") REFERENCES "task_types"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_outcome_same_org_fk" FOREIGN KEY ("organization_id", "outcome_id") REFERENCES "task_outcomes"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_follows_same_org_fk" FOREIGN KEY ("organization_id", "follows_task_id") REFERENCES "tasks"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_reschedules" ADD CONSTRAINT "task_reschedules_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_reschedules" ADD CONSTRAINT "task_reschedules_task_same_org_fk" FOREIGN KEY ("organization_id", "task_id") REFERENCES "tasks"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_reschedules" ADD CONSTRAINT "task_reschedules_reason_same_org_fk" FOREIGN KEY ("organization_id", "reason_id") REFERENCES "reschedule_reasons"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_reminders" ADD CONSTRAINT "task_reminders_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_reminders" ADD CONSTRAINT "task_reminders_task_same_org_fk" FOREIGN KEY ("organization_id", "task_id") REFERENCES "tasks"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ═══════════════════════════════════════════════════════════════════════════
-- Hand-written objects. Prisma cannot express any of these, which means its next diff
-- proposes dropping them. Each one is listed in `packages/db/src/schema-objects.int-spec.ts`.
-- ═══════════════════════════════════════════════════════════════════════════

-- A task is about somebody. An unattached task writes to no timeline, and rule 6 is the product.
ALTER TABLE "tasks"
  ADD CONSTRAINT "tasks_has_subject"
    CHECK ("lead_id" IS NOT NULL OR "customer_id" IS NOT NULL OR "deal_id" IS NOT NULL),
  ADD CONSTRAINT "tasks_title_present" CHECK (length(btrim("title")) > 0),
  -- The status/timestamp pairs, written as `CASE` rather than as biconditionals: two
  -- biconditionals over three statuses are how the payments migration made refunding impossible.
  ADD CONSTRAINT "tasks_completed_has_timestamp"
    CHECK (CASE WHEN "status" = 'completed' THEN "completed_at" IS NOT NULL
                ELSE "completed_at" IS NULL END),
  ADD CONSTRAINT "tasks_cancelled_has_timestamp"
    CHECK (CASE WHEN "status" = 'cancelled' THEN "cancelled_at" IS NOT NULL
                ELSE "cancelled_at" IS NULL END),
  -- `FR-TSK-6`. One-directional on purpose: an outcome chosen before the task is finished is
  -- harmless, and forbidding it would be a second rule that could contradict the first.
  ADD CONSTRAINT "tasks_completed_has_outcome"
    CHECK ("status" <> 'completed' OR "outcome_id" IS NOT NULL),
  ADD CONSTRAINT "tasks_reminder_offsets_is_array"
    CHECK (jsonb_typeof("reminder_offsets") = 'array'),
  ADD CONSTRAINT "tasks_reschedule_count_non_negative" CHECK ("reschedule_count" >= 0),
  ADD CONSTRAINT "tasks_not_own_follow_up"
    CHECK ("follows_task_id" IS NULL OR "follows_task_id" <> "id");

ALTER TABLE "task_types"
  ADD CONSTRAINT "task_types_name_present" CHECK (length(btrim("name")) > 0),
  ADD CONSTRAINT "task_types_duration_positive"
    CHECK ("default_duration_minutes" IS NULL OR "default_duration_minutes" > 0),
  ADD CONSTRAINT "task_types_reminder_offsets_is_array"
    CHECK (jsonb_typeof("default_reminder_offsets") = 'array');

ALTER TABLE "task_outcomes"
  ADD CONSTRAINT "task_outcomes_name_present" CHECK (length(btrim("name")) > 0);

ALTER TABLE "reschedule_reasons"
  ADD CONSTRAINT "reschedule_reasons_name_present" CHECK (length(btrim("name")) > 0);

ALTER TABLE "task_reschedules"
  -- A reschedule that moved nothing is a reason attached to no move. The direction is deliberately
  -- unconstrained: bringing a call forward because the customer rang back is also a reschedule.
  ADD CONSTRAINT "task_reschedules_changes_the_time" CHECK ("to_due_at" <> "from_due_at"),
  ADD CONSTRAINT "task_reschedules_note_present"
    CHECK ("reason_note" IS NULL OR length(btrim("reason_note")) > 0);

ALTER TABLE "task_reminders"
  ADD CONSTRAINT "task_reminders_offset_non_negative" CHECK ("offset_minutes" >= 0);

-- The Today view (`FR-TSK-7`): one person's open work, in due order. Partial, because a workspace
-- accumulates completed tasks forever and none of them belong in this index.
CREATE INDEX "tasks_open"
  ON "tasks" ("organization_id", "assigned_user_id", "due_at")
  WHERE "deleted_at" IS NULL AND "status" IN ('pending', 'in_progress');

-- "Due today" is a question about the workspace's calendar day, which is what `due_date` stores.
CREATE INDEX "tasks_open_due_date"
  ON "tasks" ("organization_id", "assigned_user_id", "due_date")
  WHERE "deleted_at" IS NULL AND "status" IN ('pending', 'in_progress');

-- What the overdue sweep scans, across tenants: every half hour, and it has to find the handful of
-- tasks that went past their time and have not been reported yet rather than reading every task
-- every workspace has ever created.
CREATE INDEX "tasks_overdue_unreported"
  ON "tasks" ("due_at")
  WHERE "deleted_at" IS NULL
    AND "status" IN ('pending', 'in_progress')
    AND "overdue_notified_at" IS NULL;

-- A lead's task panel, and the recompute that keeps `leads.next_action_at` honest.
CREATE INDEX "tasks_lead_open"
  ON "tasks" ("organization_id", "lead_id", "due_at")
  WHERE "deleted_at" IS NULL
    AND "lead_id" IS NOT NULL
    AND "status" IN ('pending', 'in_progress');

CREATE INDEX "tasks_live_created_at"
  ON "tasks" ("organization_id", "created_at" DESC)
  WHERE "deleted_at" IS NULL;

-- The referencing side of the two foreign keys that point at `tasks`. Postgres indexes the
-- *referenced* side of an FK and never the referencing one, so without these every task deletion
-- scans `tasks` and `leads` end to end — the omission that made lead deletion quadratic.
CREATE INDEX "tasks_follows" ON "tasks" ("organization_id", "follows_task_id")
  WHERE "follows_task_id" IS NOT NULL;
CREATE INDEX "leads_next_action_task" ON "leads" ("organization_id", "next_action_task_id")
  WHERE "next_action_task_id" IS NOT NULL;

-- What the one-minute reminder sweep reads. Deliberately **not** prefixed by `organization_id`:
-- the sweep runs across tenants, and a leading tenant column would make it scan the index rather
-- than seek into it.
CREATE INDEX "task_reminders_pending"
  ON "task_reminders" ("remind_at")
  WHERE "sent_at" IS NULL;
