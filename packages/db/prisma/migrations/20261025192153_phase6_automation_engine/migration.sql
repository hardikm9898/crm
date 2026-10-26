-- Phase 6, step 2 — the executor's own tables (`FR-AUT-6`, `FR-AUT-7`).
--
-- Generated with `--create-only` and then edited by hand, which every migration in this repository
-- needs for the same two reasons:
--
--  1. **Fifteen spurious DROPs** at the top: both three-column `*_stage_in_pipeline_fk`
--     constraints, six GIN indexes, five trigram indexes, `escalations_clock` and
--     `pipeline_stages_pipeline_scoped_key`. None can be expressed in `schema.prisma`, so
--     `migrate diff` sees each in the database, does not see it in the schema, and proposes
--     dropping it. Removed; `packages/db/src/schema-objects.int-spec.ts` is the only guard.
--  2. **Prisma cannot create a partitioned table.** `PARTITION BY RANGE ("started_at")` on
--     `automation_run_steps` is edited into the generated `CREATE TABLE` below, and the partitions
--     and their `ensure_` function are hand-written at the end. §15 retains step rows for 180
--     days, which a partition drop satisfies without deleting a row.

-- CreateTable
CREATE TABLE "automation_enrollments" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "workflow_id" UUID NOT NULL,
    "version_id" UUID NOT NULL,
    "lead_id" UUID NOT NULL,
    "cycle" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'active',
    "exit_reason" TEXT,
    "enrolled_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "automation_enrollments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "automation_runs" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "workflow_id" UUID NOT NULL,
    "version_id" UUID NOT NULL,
    "enrollment_id" UUID NOT NULL,
    "lead_id" UUID NOT NULL,
    "trigger_event_id" UUID,
    "trigger_type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'running',
    "current_step_id" TEXT,
    "resume_at" TIMESTAMPTZ(6),
    "causation_depth" INTEGER NOT NULL DEFAULT 0,
    "context" JSONB NOT NULL DEFAULT '{}',
    "steps_run" INTEGER NOT NULL DEFAULT 0,
    "started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMPTZ(6),
    "error" TEXT,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "automation_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "automation_run_steps" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "step_id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL,
    "decision" TEXT,
    "reason" TEXT,
    "input" JSONB NOT NULL,
    "output" JSONB,
    "error" TEXT,
    "started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMPTZ(6),

    CONSTRAINT "automation_run_steps_pkey" PRIMARY KEY ("id","started_at")
) PARTITION BY RANGE ("started_at");

-- CreateTable
CREATE TABLE "automation_guardrail_counters" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "scope_key" TEXT NOT NULL,
    "window_start" DATE NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "automation_guardrail_counters_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "automation_enrollments_organization_id_lead_id_enrolled_at_idx" ON "automation_enrollments"("organization_id", "lead_id", "enrolled_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "automation_enrollments_organization_id_id_key" ON "automation_enrollments"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "automation_enrollments_organization_id_workflow_id_lead_id__key" ON "automation_enrollments"("organization_id", "workflow_id", "lead_id", "cycle");

-- CreateIndex
CREATE INDEX "automation_runs_organization_id_lead_id_started_at_idx" ON "automation_runs"("organization_id", "lead_id", "started_at" DESC);

-- CreateIndex
CREATE INDEX "automation_runs_organization_id_workflow_id_started_at_idx" ON "automation_runs"("organization_id", "workflow_id", "started_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "automation_runs_organization_id_id_key" ON "automation_runs"("organization_id", "id");

-- CreateIndex
CREATE INDEX "automation_run_steps_organization_id_run_id_started_at_idx" ON "automation_run_steps"("organization_id", "run_id", "started_at");

-- CreateIndex
CREATE UNIQUE INDEX "automation_run_steps_organization_id_id_started_at_key" ON "automation_run_steps"("organization_id", "id", "started_at");

-- CreateIndex
CREATE UNIQUE INDEX "automation_run_steps_organization_id_run_id_step_id_attempt_key" ON "automation_run_steps"("organization_id", "run_id", "step_id", "attempt", "started_at");

-- CreateIndex
CREATE UNIQUE INDEX "automation_guardrail_counters_organization_id_id_key" ON "automation_guardrail_counters"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "automation_guardrail_counters_organization_id_scope_key_win_key" ON "automation_guardrail_counters"("organization_id", "scope_key", "window_start");

-- AddForeignKey
ALTER TABLE "automation_enrollments" ADD CONSTRAINT "automation_enrollments_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "automation_enrollments" ADD CONSTRAINT "automation_enrollments_workflow_same_org_fk" FOREIGN KEY ("organization_id", "workflow_id") REFERENCES "workflows"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "automation_enrollments" ADD CONSTRAINT "automation_enrollments_version_same_org_fk" FOREIGN KEY ("organization_id", "version_id") REFERENCES "workflow_versions"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "automation_enrollments" ADD CONSTRAINT "automation_enrollments_lead_same_org_fk" FOREIGN KEY ("organization_id", "lead_id") REFERENCES "leads"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_workflow_same_org_fk" FOREIGN KEY ("organization_id", "workflow_id") REFERENCES "workflows"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_version_same_org_fk" FOREIGN KEY ("organization_id", "version_id") REFERENCES "workflow_versions"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_enrollment_same_org_fk" FOREIGN KEY ("organization_id", "enrollment_id") REFERENCES "automation_enrollments"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_lead_same_org_fk" FOREIGN KEY ("organization_id", "lead_id") REFERENCES "leads"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "automation_run_steps" ADD CONSTRAINT "automation_run_steps_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "automation_run_steps" ADD CONSTRAINT "automation_run_steps_run_same_org_fk" FOREIGN KEY ("organization_id", "run_id") REFERENCES "automation_runs"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "automation_guardrail_counters" ADD CONSTRAINT "automation_guardrail_counters_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ─── Hand-written objects. Prisma cannot express any of these, and proposes dropping each on
-- every later diff, which is why they are all listed in
-- `packages/db/src/schema-objects.int-spec.ts`.

-- The idempotency that makes "a retried delivery produces one automation run" true (`FR-AUT-6`).
-- The outbox dispatcher is at-least-once by design, so the second delivery of `lead.created` must
-- find this row rather than start a second run. Partial, because a manual run has no event — and a
-- plain unique would then allow exactly one manual run per workflow for ever.
CREATE UNIQUE INDEX "automation_runs_one_per_event"
  ON "automation_runs" ("organization_id", "workflow_id", "trigger_event_id")
  WHERE "trigger_event_id" IS NOT NULL;

-- The reconciliation sweep's own read: every waiting run across every workspace whose moment has
-- come. Keyed on `resume_at` alone because the sweep runs under `withPlatformScope` — the same
-- reasoning as `message_media_awaiting`.
CREATE INDEX "automation_runs_resumable"
  ON "automation_runs" ("resume_at")
  WHERE "status" = 'waiting';

-- "Is this workflow already running for this lead" — asked on every trigger, by the guardrail.
CREATE INDEX "automation_runs_live"
  ON "automation_runs" ("organization_id", "workflow_id", "lead_id")
  WHERE "status" IN ('running', 'waiting');

-- The vocabularies. Code's, not a tenant's, exactly as `saved_views_visibility` is.
ALTER TABLE "automation_enrollments" ADD CONSTRAINT "automation_enrollments_status_is_known"
  CHECK ("status" IN ('active', 'completed', 'exited', 'failed'));
ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_status_is_known"
  CHECK ("status" IN ('running', 'waiting', 'completed', 'failed', 'cancelled'));
ALTER TABLE "automation_run_steps" ADD CONSTRAINT "automation_run_steps_status_is_known"
  CHECK ("status" IN ('pending', 'succeeded', 'skipped', 'failed'));

ALTER TABLE "automation_enrollments" ADD CONSTRAINT "automation_enrollments_cycle_positive"
  CHECK ("cycle" >= 1);
ALTER TABLE "automation_run_steps" ADD CONSTRAINT "automation_run_steps_attempt_positive"
  CHECK ("attempt" >= 1);
ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_steps_run_non_negative"
  CHECK ("steps_run" >= 0);

-- A run that climbed past the ceiling should never have been created, so a negative or absurd
-- depth is a bug rather than a state. The ceiling itself lives in code, because changing it must
-- not need a migration.
ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_causation_depth_sane"
  CHECK ("causation_depth" >= 0 AND "causation_depth" <= 100);

-- A waiting run that nothing will wake is the failure the reconciliation sweep exists to prevent,
-- so it is unrepresentable: `waiting` implies an instant to wake at. Written as the one direction
-- that is a contradiction — the mirror is **false**, because a run that was waiting and has since
-- been resumed keeps its `resume_at` as the record of when it was due.
ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_waiting_has_a_moment"
  CHECK (CASE WHEN "status" = 'waiting' THEN "resume_at" IS NOT NULL ELSE true END);

-- A finished run has an instant; an unfinished one does not. Both directions are contradictions
-- here, so the biconditional is right — and it is a `CASE` because every sub-expression of a CHECK
-- has to be non-NULL for the check to bite.
ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_finished_has_an_instant"
  CHECK (CASE WHEN "status" IN ('completed', 'failed', 'cancelled')
              THEN "finished_at" IS NOT NULL
              ELSE "finished_at" IS NULL END);

-- A failure with no explanation is the thing nobody can act on.
ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_failed_says_why"
  CHECK ("status" <> 'failed' OR ("error" IS NOT NULL AND length(btrim("error")) > 0));
ALTER TABLE "automation_run_steps" ADD CONSTRAINT "automation_run_steps_failed_says_why"
  CHECK ("status" <> 'failed' OR ("error" IS NOT NULL AND length(btrim("error")) > 0));
-- And a skip with no reason is the one the timeline cannot explain, which is the whole point of
-- `FR-AUT-7`'s "including *skipped because*".
ALTER TABLE "automation_run_steps" ADD CONSTRAINT "automation_run_steps_skipped_says_why"
  CHECK ("status" <> 'skipped' OR ("reason" IS NOT NULL AND length(btrim("reason")) > 0));

ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_context_is_an_object"
  CHECK (jsonb_typeof("context") = 'object');
ALTER TABLE "automation_run_steps" ADD CONSTRAINT "automation_run_steps_input_is_an_object"
  CHECK (jsonb_typeof("input") = 'object');

ALTER TABLE "automation_guardrail_counters" ADD CONSTRAINT "automation_counters_count_non_negative"
  CHECK ("count" >= 0);
ALTER TABLE "automation_guardrail_counters" ADD CONSTRAINT "automation_counters_scope_not_blank"
  CHECK (length(btrim("scope_key")) > 0);

-- ── The monthly partitions ────────────────────────────────────────────────
--
-- The fifth table in this product partitioned this way, for the fifth time for the same reason: a
-- step row per step per run is the fastest-growing thing automation produces, and §15's 180-day
-- retention is a partition drop rather than a delete of millions of rows.

CREATE OR REPLACE FUNCTION ensure_automation_run_step_partition(target timestamptz)
RETURNS text
LANGUAGE plpgsql
AS $$
DECLARE
  month_start date := date_trunc('month', target)::date;
  month_end   date := (date_trunc('month', target) + interval '1 month')::date;
  part_name   text := format('automation_run_steps_%s', to_char(month_start, 'YYYY_MM'));
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = part_name) THEN
    EXECUTE format(
      'CREATE TABLE %I PARTITION OF automation_run_steps FOR VALUES FROM (%L) TO (%L)',
      part_name, month_start, month_end
    );
  END IF;
  RETURN part_name;
END;
$$;

COMMENT ON FUNCTION ensure_automation_run_step_partition(timestamptz) IS
  'Creates the monthly automation_run_steps partition containing the given instant, if it does not exist. Idempotent; called by the partition-maintenance job.';

-- One month back and twelve forward. A step is written now; only a waiting run resumed after a
-- long delay could write into a month that has already turned, and a delay is measured in days.
DO $$
DECLARE
  offset_months int;
BEGIN
  FOR offset_months IN -1..12 LOOP
    PERFORM ensure_automation_run_step_partition(now() + (offset_months || ' months')::interval);
  END LOOP;
END;
$$;

CREATE TABLE automation_run_steps_default PARTITION OF automation_run_steps DEFAULT;

COMMENT ON TABLE automation_run_steps_default IS
  'Catch-all for instants outside the pre-created monthly partitions. Rows here block ATTACH of the overlapping month, so the maintenance job reports them.';
