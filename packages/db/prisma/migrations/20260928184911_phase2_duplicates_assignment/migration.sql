-- CreateEnum
CREATE TYPE "duplicate_action" AS ENUM ('attach_to_existing', 'create_and_link', 'reject', 'create_new');

-- CreateEnum
CREATE TYPE "duplicate_status" AS ENUM ('open', 'merged', 'dismissed');

-- CreateEnum
CREATE TYPE "assignment_strategy" AS ENUM ('specific_user', 'team', 'round_robin', 'weighted_round_robin', 'least_open_leads', 'top_performer');

-- ── Deliberately NOT dropped ───────────────────────────────────────────────
-- `prisma migrate diff` generated six DROPs here and every one of them was wrong:
--
--   ALTER TABLE leads DROP CONSTRAINT leads_stage_in_pipeline_fk;
--   DROP INDEX leads_custom_values_gin;
--   DROP INDEX leads_full_name_trgm;
--   DROP INDEX leads_phone_e164_trgm;
--   DROP INDEX leads_search_vector_gin;
--   DROP INDEX pipeline_stages_pipeline_scoped_key;
--
-- They are the hand-written objects from the previous migration — the composite FK that makes "a
-- lead in another pipeline's stage" unrepresentable, its supporting unique index, and the GIN and
-- trigram indexes behind lead search. Prisma cannot express any of them in `schema.prisma`, so it
-- sees them in the database, does not see them in the schema, and removes them. Every future
-- `--create-only` diff will propose the same deletions; they must be deleted from the generated
-- SQL each time. `schema-objects.int-spec.ts` fails if any of them goes missing, which is what
-- turned this from a silent regression into a test failure.

-- AlterTable
ALTER TABLE "leads" ADD COLUMN     "is_duplicate_of_id" UUID,
ADD COLUMN     "merged_into_id" UUID;

-- CreateTable
CREATE TABLE "duplicate_rules" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "match_on" JSONB NOT NULL,
    "lookback_days" INTEGER NOT NULL DEFAULT 365,
    "action" "duplicate_action" NOT NULL DEFAULT 'attach_to_existing',
    "priority" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "duplicate_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lead_duplicates" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "lead_id" UUID NOT NULL,
    "duplicate_lead_id" UUID NOT NULL,
    "rule_id" UUID,
    "match_fields" JSONB NOT NULL DEFAULT '{}',
    "confidence" INTEGER NOT NULL DEFAULT 100,
    "status" "duplicate_status" NOT NULL DEFAULT 'open',
    "resolved_by_id" UUID,
    "resolved_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lead_duplicates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lead_merges" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "surviving_lead_id" UUID NOT NULL,
    "merged_lead_id" UUID NOT NULL,
    "field_choices" JSONB NOT NULL DEFAULT '{}',
    "snapshot" JSONB NOT NULL DEFAULT '{}',
    "performed_by_id" UUID,
    "undone_at" TIMESTAMPTZ(6),
    "undone_by_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lead_merges_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assignment_rules" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "strategy" "assignment_strategy" NOT NULL,
    "target" JSONB NOT NULL DEFAULT '{}',
    "respect_working_hours" BOOLEAN NOT NULL DEFAULT true,
    "capacity_cap" INTEGER,
    "fallback" JSONB NOT NULL DEFAULT '{}',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "assignment_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assignment_rule_conditions" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "rule_id" UUID NOT NULL,
    "field_path" TEXT NOT NULL,
    "operator" TEXT NOT NULL,
    "value" JSONB NOT NULL DEFAULT 'null',
    "group_index" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "assignment_rule_conditions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assignment_pool_members" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "rule_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "weight" INTEGER NOT NULL DEFAULT 1,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "assignment_pool_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "round_robin_state" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "rule_id" UUID NOT NULL,
    "cursor_index" INTEGER NOT NULL DEFAULT 0,
    "last_assigned_user_id" UUID,
    "weight_consumed" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "round_robin_state_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "duplicate_rules_organization_id_is_active_priority_idx" ON "duplicate_rules"("organization_id", "is_active", "priority");

-- CreateIndex
CREATE UNIQUE INDEX "duplicate_rules_organization_id_id_key" ON "duplicate_rules"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "duplicate_rules_organization_id_name_key" ON "duplicate_rules"("organization_id", "name");

-- CreateIndex
CREATE INDEX "lead_duplicates_organization_id_status_created_at_idx" ON "lead_duplicates"("organization_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "lead_duplicates_organization_id_duplicate_lead_id_idx" ON "lead_duplicates"("organization_id", "duplicate_lead_id");

-- CreateIndex
CREATE UNIQUE INDEX "lead_duplicates_organization_id_id_key" ON "lead_duplicates"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "lead_duplicates_organization_id_lead_id_duplicate_lead_id_key" ON "lead_duplicates"("organization_id", "lead_id", "duplicate_lead_id");

-- CreateIndex
CREATE INDEX "lead_merges_organization_id_merged_lead_id_idx" ON "lead_merges"("organization_id", "merged_lead_id");

-- CreateIndex
CREATE INDEX "lead_merges_organization_id_surviving_lead_id_created_at_idx" ON "lead_merges"("organization_id", "surviving_lead_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "lead_merges_organization_id_id_key" ON "lead_merges"("organization_id", "id");

-- CreateIndex
CREATE INDEX "assignment_rules_organization_id_is_active_priority_idx" ON "assignment_rules"("organization_id", "is_active", "priority");

-- CreateIndex
CREATE UNIQUE INDEX "assignment_rules_organization_id_id_key" ON "assignment_rules"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "assignment_rules_organization_id_name_key" ON "assignment_rules"("organization_id", "name");

-- CreateIndex
CREATE INDEX "assignment_rule_conditions_organization_id_rule_id_group_in_idx" ON "assignment_rule_conditions"("organization_id", "rule_id", "group_index");

-- CreateIndex
CREATE UNIQUE INDEX "assignment_rule_conditions_organization_id_id_key" ON "assignment_rule_conditions"("organization_id", "id");

-- CreateIndex
CREATE INDEX "assignment_pool_members_organization_id_user_id_idx" ON "assignment_pool_members"("organization_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "assignment_pool_members_organization_id_id_key" ON "assignment_pool_members"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "assignment_pool_members_organization_id_rule_id_user_id_key" ON "assignment_pool_members"("organization_id", "rule_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "round_robin_state_organization_id_id_key" ON "round_robin_state"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "round_robin_state_organization_id_rule_id_key" ON "round_robin_state"("organization_id", "rule_id");

-- AddForeignKey
ALTER TABLE "leads" ADD CONSTRAINT "leads_duplicate_of_same_org_fk" FOREIGN KEY ("organization_id", "is_duplicate_of_id") REFERENCES "leads"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leads" ADD CONSTRAINT "leads_merged_into_same_org_fk" FOREIGN KEY ("organization_id", "merged_into_id") REFERENCES "leads"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "duplicate_rules" ADD CONSTRAINT "duplicate_rules_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lead_duplicates" ADD CONSTRAINT "lead_duplicates_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lead_duplicates" ADD CONSTRAINT "lead_duplicates_lead_same_org_fk" FOREIGN KEY ("organization_id", "lead_id") REFERENCES "leads"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lead_duplicates" ADD CONSTRAINT "lead_duplicates_candidate_same_org_fk" FOREIGN KEY ("organization_id", "duplicate_lead_id") REFERENCES "leads"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lead_duplicates" ADD CONSTRAINT "lead_duplicates_rule_same_org_fk" FOREIGN KEY ("organization_id", "rule_id") REFERENCES "duplicate_rules"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lead_merges" ADD CONSTRAINT "lead_merges_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lead_merges" ADD CONSTRAINT "lead_merges_survivor_same_org_fk" FOREIGN KEY ("organization_id", "surviving_lead_id") REFERENCES "leads"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lead_merges" ADD CONSTRAINT "lead_merges_absorbed_same_org_fk" FOREIGN KEY ("organization_id", "merged_lead_id") REFERENCES "leads"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assignment_rules" ADD CONSTRAINT "assignment_rules_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assignment_rule_conditions" ADD CONSTRAINT "assignment_rule_conditions_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assignment_rule_conditions" ADD CONSTRAINT "assignment_rule_conditions_rule_same_org_fk" FOREIGN KEY ("organization_id", "rule_id") REFERENCES "assignment_rules"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assignment_pool_members" ADD CONSTRAINT "assignment_pool_members_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assignment_pool_members" ADD CONSTRAINT "assignment_pool_members_rule_same_org_fk" FOREIGN KEY ("organization_id", "rule_id") REFERENCES "assignment_rules"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assignment_pool_members" ADD CONSTRAINT "assignment_pool_members_membership_same_org_fk" FOREIGN KEY ("organization_id", "user_id") REFERENCES "memberships"("organization_id", "user_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "round_robin_state" ADD CONSTRAINT "round_robin_state_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "round_robin_state" ADD CONSTRAINT "round_robin_state_rule_same_org_fk" FOREIGN KEY ("organization_id", "rule_id") REFERENCES "assignment_rules"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ═════════════════════════════════════════════════════════════════════════════
-- HAND-WRITTEN HARDENING
-- ═════════════════════════════════════════════════════════════════════════════

-- ── 1. A lead cannot be its own duplicate or its own merge target ──────────
-- Reachable through a bad id in a request, and the damage is a cycle nothing can render.
ALTER TABLE leads
  ADD CONSTRAINT leads_not_own_duplicate CHECK (is_duplicate_of_id IS NULL OR is_duplicate_of_id <> id),
  ADD CONSTRAINT leads_not_own_merge_target CHECK (merged_into_id IS NULL OR merged_into_id <> id);

ALTER TABLE lead_duplicates
  ADD CONSTRAINT lead_duplicates_distinct_pair CHECK (lead_id <> duplicate_lead_id),
  ADD CONSTRAINT lead_duplicates_confidence_range CHECK (confidence >= 0 AND confidence <= 100),
  ADD CONSTRAINT lead_duplicates_match_fields_is_object CHECK (jsonb_typeof(match_fields) = 'object');

ALTER TABLE lead_merges
  ADD CONSTRAINT lead_merges_distinct_pair CHECK (surviving_lead_id <> merged_lead_id),
  ADD CONSTRAINT lead_merges_snapshot_is_object CHECK (jsonb_typeof(snapshot) = 'object'),
  ADD CONSTRAINT lead_merges_field_choices_is_object CHECK (jsonb_typeof(field_choices) = 'object');

-- ── 2. A lead can be absorbed by at most one *standing* merge ──────────────
-- Not a plain unique index: after an undo the lead is free to be merged again, and a full unique
-- constraint would make that impossible. The partial index says exactly what is true.
CREATE UNIQUE INDEX lead_merges_one_standing_per_merged_lead
  ON lead_merges (organization_id, merged_lead_id) WHERE undone_at IS NULL;

-- ── 3. Duplicate rule shape ────────────────────────────────────────────────
ALTER TABLE duplicate_rules
  ADD CONSTRAINT duplicate_rules_match_on_is_array CHECK (jsonb_typeof(match_on) = 'array'),
  -- A rule that matches on nothing would match everything.
  ADD CONSTRAINT duplicate_rules_match_on_not_empty CHECK (jsonb_array_length(match_on) > 0),
  ADD CONSTRAINT duplicate_rules_lookback_positive CHECK (lookback_days >= 1 AND lookback_days <= 3650);

-- ── 4. Assignment rule shape ───────────────────────────────────────────────
ALTER TABLE assignment_rules
  ADD CONSTRAINT assignment_rules_target_is_object CHECK (jsonb_typeof(target) = 'object'),
  ADD CONSTRAINT assignment_rules_fallback_is_object CHECK (jsonb_typeof(fallback) = 'object'),
  -- A cap of zero would assign to nobody, forever, silently.
  ADD CONSTRAINT assignment_rules_capacity_positive CHECK (capacity_cap IS NULL OR capacity_cap >= 1);

ALTER TABLE assignment_pool_members
  ADD CONSTRAINT assignment_pool_members_weight_positive CHECK (weight >= 1 AND weight <= 100);

ALTER TABLE assignment_rule_conditions
  ADD CONSTRAINT assignment_rule_conditions_group_non_negative CHECK (group_index >= 0);

ALTER TABLE round_robin_state
  ADD CONSTRAINT round_robin_state_cursor_non_negative CHECK (cursor_index >= 0),
  ADD CONSTRAINT round_robin_state_weight_non_negative CHECK (weight_consumed >= 0);

-- ── 5. Indexes for the questions these tables exist to answer ──────────────
-- "Which leads are suspected duplicates and still need a decision?"
CREATE INDEX lead_duplicates_open
  ON lead_duplicates (organization_id, created_at DESC) WHERE status = 'open';

-- "Show me this lead's open duplicate candidates", from either side of the pair.
CREATE INDEX lead_duplicates_open_by_lead
  ON lead_duplicates (organization_id, lead_id) WHERE status = 'open';

-- A merged lead is soft-deleted, so the live-lead indexes already exclude it. This one serves the
-- opposite question: "what was merged into this lead, and can it be undone?"
CREATE INDEX lead_merges_undoable
  ON lead_merges (organization_id, surviving_lead_id, created_at DESC) WHERE undone_at IS NULL;

-- Duplicate detection looks up by phone, whatsapp and lowercased email within a lookback window.
-- The equality indexes from step 1 cover phone and whatsapp; email needs the lowercased form,
-- because addresses are compared case-insensitively.
CREATE INDEX leads_email_lower
  ON leads (organization_id, lower(email)) WHERE deleted_at IS NULL AND email IS NOT NULL;

-- "How many open leads does this person hold?" — the capacity cap and the least-open-leads
-- strategy both ask it on every assignment.
CREATE INDEX leads_open_per_assignee
  ON leads (organization_id, assigned_user_id, status_id) WHERE deleted_at IS NULL;
