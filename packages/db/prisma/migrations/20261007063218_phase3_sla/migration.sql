-- Phase 3, step 2 — SLA policies, clocks and escalation (`FR-TSK-8`).
--
-- ┌─────────────────────────────────────────────────────────────────────────────────────────────┐
-- │ GENERATED, THEN EDITED. Prisma's diff arrived with 2 `DropForeignKey` and 11 `DropIndex`     │
-- │ statements at the top — every composite FK, GIN index, trigram index and partial unique      │
-- │ index the earlier migrations added by hand, because none can be expressed in                 │
-- │ `schema.prisma`. They were deleted. Nothing else was in that region this time (no new        │
-- │ columns on existing tables), which was checked rather than assumed: the payments migration   │
-- │ cut two `ADD COLUMN`s along with the drops and failed on the column it had just removed.     │
-- │ `packages/db/src/schema-objects.int-spec.ts` is the only guard against a missed one.          │
-- └─────────────────────────────────────────────────────────────────────────────────────────────┘

-- CreateEnum
CREATE TYPE "sla_target" AS ENUM ('first_response', 'next_response', 'resolution');

-- CreateEnum
CREATE TYPE "sla_subject_type" AS ENUM ('lead', 'conversation', 'task');

-- CreateEnum
CREATE TYPE "sla_clock_state" AS ENUM ('running', 'paused', 'satisfied', 'breached', 'cancelled');

-- CreateEnum
CREATE TYPE "escalation_reason" AS ENUM ('at_risk', 'breached');

-- CreateTable
CREATE TABLE "sla_policies" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "applies_to" JSONB NOT NULL DEFAULT '{}',
    "first_response_minutes" INTEGER NOT NULL,
    "next_response_minutes" INTEGER,
    "resolution_minutes" INTEGER,
    "business_hours_only" BOOLEAN NOT NULL DEFAULT true,
    "warn_at_percent" INTEGER NOT NULL DEFAULT 80,
    "escalate_to" JSONB NOT NULL DEFAULT '{}',
    "priority" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "sla_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sla_clocks" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "policy_id" UUID NOT NULL,
    "subject_type" "sla_subject_type" NOT NULL,
    "subject_id" UUID NOT NULL,
    "lead_id" UUID,
    "target" "sla_target" NOT NULL,
    "branch_id" UUID,
    "team_id" UUID,
    "assigned_user_id" UUID,
    "started_at" TIMESTAMPTZ(6) NOT NULL,
    "due_at" TIMESTAMPTZ(6) NOT NULL,
    "warn_at" TIMESTAMPTZ(6) NOT NULL,
    "target_minutes" INTEGER NOT NULL,
    "paused_ms" INTEGER NOT NULL DEFAULT 0,
    "state" "sla_clock_state" NOT NULL DEFAULT 'running',
    "satisfied_at" TIMESTAMPTZ(6),
    "breached_at" TIMESTAMPTZ(6),
    "warned_at" TIMESTAMPTZ(6),
    "cancelled_at" TIMESTAMPTZ(6),
    "satisfied_by" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "sla_clocks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "escalations" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "clock_id" UUID NOT NULL,
    "policy_id" UUID NOT NULL,
    "subject_type" "sla_subject_type" NOT NULL,
    "subject_id" UUID NOT NULL,
    "level" INTEGER NOT NULL,
    "reason" "escalation_reason" NOT NULL,
    "notified_user_ids" UUID[],
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acknowledged_at" TIMESTAMPTZ(6),
    "acknowledged_by_id" UUID,

    CONSTRAINT "escalations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "sla_policies_organization_id_is_active_priority_idx" ON "sla_policies"("organization_id", "is_active", "priority");

-- CreateIndex
CREATE UNIQUE INDEX "sla_policies_organization_id_id_key" ON "sla_policies"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "sla_policies_organization_id_name_key" ON "sla_policies"("organization_id", "name");

-- CreateIndex
CREATE INDEX "sla_clocks_organization_id_state_due_at_idx" ON "sla_clocks"("organization_id", "state", "due_at");

-- CreateIndex
CREATE INDEX "sla_clocks_organization_id_assigned_user_id_state_due_at_idx" ON "sla_clocks"("organization_id", "assigned_user_id", "state", "due_at");

-- CreateIndex
CREATE INDEX "sla_clocks_organization_id_lead_id_idx" ON "sla_clocks"("organization_id", "lead_id");

-- CreateIndex
CREATE UNIQUE INDEX "sla_clocks_organization_id_id_key" ON "sla_clocks"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "sla_clocks_organization_id_subject_type_subject_id_target_key" ON "sla_clocks"("organization_id", "subject_type", "subject_id", "target");

-- CreateIndex
CREATE INDEX "escalations_organization_id_created_at_idx" ON "escalations"("organization_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "escalations_organization_id_acknowledged_at_idx" ON "escalations"("organization_id", "acknowledged_at");

-- CreateIndex
CREATE UNIQUE INDEX "escalations_organization_id_id_key" ON "escalations"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "escalations_organization_id_clock_id_level_key" ON "escalations"("organization_id", "clock_id", "level");

-- AddForeignKey
ALTER TABLE "sla_policies" ADD CONSTRAINT "sla_policies_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sla_clocks" ADD CONSTRAINT "sla_clocks_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sla_clocks" ADD CONSTRAINT "sla_clocks_policy_same_org_fk" FOREIGN KEY ("organization_id", "policy_id") REFERENCES "sla_policies"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sla_clocks" ADD CONSTRAINT "sla_clocks_lead_same_org_fk" FOREIGN KEY ("organization_id", "lead_id") REFERENCES "leads"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sla_clocks" ADD CONSTRAINT "sla_clocks_branch_same_org_fk" FOREIGN KEY ("organization_id", "branch_id") REFERENCES "branches"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sla_clocks" ADD CONSTRAINT "sla_clocks_team_same_org_fk" FOREIGN KEY ("organization_id", "team_id") REFERENCES "teams"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sla_clocks" ADD CONSTRAINT "sla_clocks_assignee_same_org_fk" FOREIGN KEY ("organization_id", "assigned_user_id") REFERENCES "memberships"("organization_id", "user_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "escalations" ADD CONSTRAINT "escalations_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "escalations" ADD CONSTRAINT "escalations_clock_same_org_fk" FOREIGN KEY ("organization_id", "clock_id") REFERENCES "sla_clocks"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "escalations" ADD CONSTRAINT "escalations_policy_same_org_fk" FOREIGN KEY ("organization_id", "policy_id") REFERENCES "sla_policies"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ═══════════════════════════════════════════════════════════════════════════
-- Hand-written objects. Prisma cannot express any of these, so its next diff proposes
-- dropping them; each is listed in `packages/db/src/schema-objects.int-spec.ts`.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE "sla_policies"
  ADD CONSTRAINT "sla_policies_name_present" CHECK (length(btrim("name")) > 0),
  -- A policy that promises nothing is a row with no effect, so the one mandatory target has to be
  -- a real number of minutes.
  ADD CONSTRAINT "sla_policies_first_response_positive" CHECK ("first_response_minutes" > 0),
  ADD CONSTRAINT "sla_policies_next_response_positive"
    CHECK ("next_response_minutes" IS NULL OR "next_response_minutes" > 0),
  ADD CONSTRAINT "sla_policies_resolution_positive"
    CHECK ("resolution_minutes" IS NULL OR "resolution_minutes" > 0),
  -- Strictly inside the target: a warning at 0 % fires the moment the clock starts and one at
  -- 100 % arrives with the breach. Neither is a warning.
  ADD CONSTRAINT "sla_policies_warn_percent_range"
    CHECK ("warn_at_percent" BETWEEN 1 AND 99),
  ADD CONSTRAINT "sla_policies_applies_to_is_object"
    CHECK (jsonb_typeof("applies_to") = 'object'),
  ADD CONSTRAINT "sla_policies_escalate_to_is_object"
    CHECK (jsonb_typeof("escalate_to") = 'object');

ALTER TABLE "sla_clocks"
  -- A clock on a lead has to name the lead. The polymorphic `subject_id` alone would let a lead
  -- clock exist with nothing the board could join to, and the composite FK is what makes "a clock
  -- on another tenant's lead" unrepresentable.
  ADD CONSTRAINT "sla_clocks_lead_subject_has_lead"
    CHECK (("subject_type" = 'lead') = ("lead_id" IS NOT NULL)),
  ADD CONSTRAINT "sla_clocks_subject_matches_lead"
    CHECK ("lead_id" IS NULL OR "lead_id" = "subject_id"),
  ADD CONSTRAINT "sla_clocks_target_minutes_positive" CHECK ("target_minutes" > 0),
  ADD CONSTRAINT "sla_clocks_paused_non_negative" CHECK ("paused_ms" >= 0),
  -- The warning cannot be after the breach, and neither can precede the start. A clock whose
  -- instants are out of order would make the sweep escalate in the wrong order.
  ADD CONSTRAINT "sla_clocks_instants_ordered"
    CHECK ("warn_at" >= "started_at" AND "due_at" >= "warn_at"),
  -- The state/timestamp pairs, as a `CASE` rather than as biconditionals — the shape that made
  -- refunding impossible when payments wrote it the obvious way.
  ADD CONSTRAINT "sla_clocks_satisfied_has_timestamp"
    CHECK (CASE WHEN "state" = 'satisfied' THEN "satisfied_at" IS NOT NULL
                ELSE "satisfied_at" IS NULL END),
  ADD CONSTRAINT "sla_clocks_breached_has_timestamp"
    CHECK (CASE WHEN "state" = 'breached' THEN "breached_at" IS NOT NULL
                ELSE "breached_at" IS NULL END),
  ADD CONSTRAINT "sla_clocks_cancelled_has_timestamp"
    CHECK (CASE WHEN "state" = 'cancelled' THEN "cancelled_at" IS NOT NULL
                ELSE "cancelled_at" IS NULL END);

ALTER TABLE "escalations"
  ADD CONSTRAINT "escalations_level_matches_reason"
    CHECK (("reason" = 'at_risk' AND "level" = 1) OR ("reason" = 'breached' AND "level" = 2)),
  -- An escalation that reached nobody is a row that says somebody was told when nobody was. The
  -- sweep writes none rather than an empty one, and this makes that a guarantee.
  ADD CONSTRAINT "escalations_notified_somebody"
    CHECK (array_length("notified_user_ids", 1) >= 1),
  ADD CONSTRAINT "escalations_acknowledged_pair"
    CHECK (("acknowledged_at" IS NULL) = ("acknowledged_by_id" IS NULL));

-- Exactly one default-ish catch-all is not enforced (a workspace may legitimately have none), but
-- a name must be unique per workspace, which the generated unique index already gives.

-- What the five-minute sweep scans, across tenants: the handful of running clocks whose moment has
-- come. Deliberately **not** prefixed by `organization_id` — the sweep runs platform-wide, and a
-- leading tenant column would make it scan the index rather than seek into it. Two separate
-- partial indexes rather than one on `state`, because "needs warning" and "needs breaching" are
-- different questions and each is answered by a handful of rows.
CREATE INDEX "sla_clocks_awaiting_warning"
  ON "sla_clocks" ("warn_at")
  WHERE "state" = 'running' AND "warned_at" IS NULL;
CREATE INDEX "sla_clocks_awaiting_breach"
  ON "sla_clocks" ("due_at")
  WHERE "state" = 'running';

-- The manager's board: what is at risk or already breached, soonest first.
CREATE INDEX "sla_clocks_open"
  ON "sla_clocks" ("organization_id", "due_at")
  WHERE "state" = 'running';

-- The referencing side of the FK into `sla_clocks`. Postgres indexes the referenced side only, so
-- without this every clock deletion scans `escalations` end to end.
CREATE INDEX "escalations_clock" ON "escalations" ("organization_id", "clock_id");
-- The board's "who has not acknowledged" column.
CREATE INDEX "escalations_unacknowledged"
  ON "escalations" ("organization_id", "created_at" DESC)
  WHERE "acknowledged_at" IS NULL;

-- ═══════════════════════════════════════════════════════════════════════════
-- `sla:read` for the workspaces that already exist.
--
-- `SYSTEM_ROLE_TEMPLATES` is read when a workspace is *created*, so a new permission key reaches
-- new workspaces and nothing else — the trap `payment:read` paid for, where the owner of a seeded
-- workspace got a 403 five minutes after the permission was written. This inserts the grant for
-- roles still marked `is_system`, at the scope the template gives them, only where it is absent.
-- `PrincipalService` then caches grants for five minutes, so the 403 continues until that expires.
-- ═══════════════════════════════════════════════════════════════════════════

INSERT INTO "permissions" ("key", "module", "description", "supports_scope")
VALUES ('sla:read', 'tasks', 'View SLA clocks, the breach board and escalations', true)
ON CONFLICT ("key") DO NOTHING;

INSERT INTO "role_permissions" ("id", "organization_id", "role_id", "permission_key", "scope")
SELECT gen_random_uuid(), r."organization_id", r."id", 'sla:read', t."scope"::"data_scope"
  FROM "roles" r
  JOIN (VALUES
          ('owner', 'organization'),
          ('admin', 'organization'),
          ('sales_manager', 'branch'),
          ('sales_executive', 'own'),
          ('auditor', 'organization')
       ) AS t(code, scope) ON t.code = r."code"
 WHERE r."is_system" = true
   AND r."deleted_at" IS NULL
   AND NOT EXISTS (
     SELECT 1 FROM "role_permissions" rp
      WHERE rp."organization_id" = r."organization_id"
        AND rp."role_id" = r."id"
        AND rp."permission_key" = 'sla:read'
   );
