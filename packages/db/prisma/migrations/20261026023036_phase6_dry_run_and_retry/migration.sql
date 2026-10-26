-- Phase 6, step 3 — the dry run, and the retry that reopens a failed run (`FR-AUT-6`, `FR-AUT-7`).
--
-- Fifteen spurious DROPs again, removed by hand. Note which region was kept: the
-- `-- AlterTable … ADD COLUMN` block sits in the **same** place as the drops, and cutting
-- "everything before the first CreateTable" has already deleted two `ADD COLUMN`s once in this
-- repository. Only the `-- DropForeignKey` and `-- DropIndex` sections go.

-- AlterTable
ALTER TABLE "automation_runs" ADD COLUMN     "dry_run" BOOLEAN NOT NULL DEFAULT false,
ALTER COLUMN "enrollment_id" DROP NOT NULL;

-- ─── Hand-written objects ──────────────────────────────────────────────────

-- A preview that enrols somebody has spent the lead's one allowed cycle under the `once` policy,
-- so the real run afterwards would be refused by the very thing the preview was checking. And a
-- real run with no enrolment is a run outside the re-entry policy. Both directions are
-- contradictions, so the biconditional is right — written as a `CASE` because every
-- sub-expression of a CHECK has to be non-NULL for the check to bite.
ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_real_run_is_enrolled"
  CHECK (CASE WHEN "dry_run" THEN "enrollment_id" IS NULL ELSE "enrollment_id" IS NOT NULL END);

-- A dry run must not count as the live run that stops a real one from starting, so the index the
-- guardrail reads excludes it. Replacing rather than adding: an index whose predicate is wrong is
-- worse than none, because the planner uses it.
DROP INDEX IF EXISTS "automation_runs_live";
CREATE INDEX "automation_runs_live"
  ON "automation_runs" ("organization_id", "workflow_id", "lead_id")
  WHERE "status" IN ('running', 'waiting') AND "dry_run" = false;
