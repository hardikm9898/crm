-- Phase 6, step 1 — workflows, their versions, and the dispatch index (`FR-AUT-1`, `FR-AUT-5`).
--
-- `prisma migrate dev --create-only` generated this with **fifteen** spurious DROPs at the top of
-- it: both three-column `*_stage_in_pipeline_fk` constraints, six GIN indexes, five trigram
-- indexes, the `escalations_clock` partial index and `pipeline_stages_pipeline_scoped_key` (the
-- support index without which the FK above it cannot exist). None of them can be expressed in
-- `schema.prisma`, so `migrate diff` sees each one in the database, does not see it in the schema,
-- and proposes deleting it. They have been removed by hand, as in every migration since step 2 of
-- Phase 1; `packages/db/src/schema-objects.int-spec.ts` is the only thing that catches the ones
-- that are missed.

-- CreateTable
CREATE TABLE "workflows" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "current_version_id" UUID,
    "kill_switch" BOOLEAN NOT NULL DEFAULT false,
    "max_runs_per_entity" INTEGER,
    "reentry_policy" TEXT NOT NULL DEFAULT 'once',
    "cooldown_hours" INTEGER,
    "created_by_id" UUID NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "workflows_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow_versions" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "workflow_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "definition" JSONB NOT NULL,
    "published_at" TIMESTAMPTZ(6),
    "published_by_id" UUID,
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "workflow_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow_triggers" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "workflow_id" UUID NOT NULL,
    "version_id" UUID NOT NULL,
    "trigger_type" TEXT NOT NULL,
    "event" TEXT,
    "params" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "workflow_triggers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "workflows_organization_id_status_updated_at_idx" ON "workflows"("organization_id", "status", "updated_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "workflows_organization_id_id_key" ON "workflows"("organization_id", "id");

-- CreateIndex
CREATE INDEX "workflow_versions_organization_id_workflow_id_version_idx" ON "workflow_versions"("organization_id", "workflow_id", "version" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "workflow_versions_organization_id_id_key" ON "workflow_versions"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "workflow_versions_organization_id_workflow_id_version_key" ON "workflow_versions"("organization_id", "workflow_id", "version");

-- CreateIndex
CREATE INDEX "workflow_triggers_organization_id_event_idx" ON "workflow_triggers"("organization_id", "event");

-- CreateIndex
CREATE UNIQUE INDEX "workflow_triggers_organization_id_id_key" ON "workflow_triggers"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "workflow_triggers_organization_id_workflow_id_key" ON "workflow_triggers"("organization_id", "workflow_id");

-- AddForeignKey
ALTER TABLE "workflows" ADD CONSTRAINT "workflows_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflows" ADD CONSTRAINT "workflows_creator_same_org_fk" FOREIGN KEY ("organization_id", "created_by_id") REFERENCES "memberships"("organization_id", "user_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflows" ADD CONSTRAINT "workflows_current_version_same_org_fk" FOREIGN KEY ("organization_id", "current_version_id") REFERENCES "workflow_versions"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_versions" ADD CONSTRAINT "workflow_versions_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_versions" ADD CONSTRAINT "workflow_versions_workflow_same_org_fk" FOREIGN KEY ("organization_id", "workflow_id") REFERENCES "workflows"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_versions" ADD CONSTRAINT "workflow_versions_author_same_org_fk" FOREIGN KEY ("organization_id", "created_by_id") REFERENCES "memberships"("organization_id", "user_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_versions" ADD CONSTRAINT "workflow_versions_publisher_same_org_fk" FOREIGN KEY ("organization_id", "published_by_id") REFERENCES "memberships"("organization_id", "user_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_triggers" ADD CONSTRAINT "workflow_triggers_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_triggers" ADD CONSTRAINT "workflow_triggers_workflow_same_org_fk" FOREIGN KEY ("organization_id", "workflow_id") REFERENCES "workflows"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_triggers" ADD CONSTRAINT "workflow_triggers_version_same_org_fk" FOREIGN KEY ("organization_id", "version_id") REFERENCES "workflow_versions"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ─── Hand-written objects. Prisma cannot express any of these, and proposes dropping each of
-- them on every later diff, which is why they are all listed in
-- `packages/db/src/schema-objects.int-spec.ts`.

-- A workspace cannot have two live workflows whose names read the same. The partial `WHERE` is
-- what lets a deleted name be reused — a plain unique reads identically in review and would stop
-- a workspace ever reusing the name of something it threw away, which
-- `integration_connections_live_provider` and `canned_replies_live_shortcut` already paid for.
-- `lower(btrim(...))` because "Nurture" beside "nurture " is a list nobody can read.
CREATE UNIQUE INDEX "workflows_live_name" ON "workflows" ("organization_id", lower(btrim("name")))
  WHERE "deleted_at" IS NULL;

-- The vocabularies. Rows, not enums, is rule 4 — but these are *code's* vocabulary rather than a
-- tenant's, exactly as `saved_views_visibility` is, so the database holds them.
ALTER TABLE "workflows" ADD CONSTRAINT "workflows_status_is_known"
  CHECK ("status" IN ('draft', 'active', 'paused', 'archived'));
ALTER TABLE "workflows" ADD CONSTRAINT "workflows_reentry_is_known"
  CHECK ("reentry_policy" IN ('once', 'cooldown', 'always'));

ALTER TABLE "workflows" ADD CONSTRAINT "workflows_name_not_blank"
  CHECK (length(btrim("name")) > 0);

-- A cooldown policy with no cooldown cannot be evaluated; a cooldown on any other policy is a
-- number nothing reads, which is the "column with no reader" defect one row down. Both directions
-- are contradictions, so the biconditional is right — and it is written as a `CASE` because every
-- sub-expression of a CHECK has to be non-NULL for the check to bite.
ALTER TABLE "workflows" ADD CONSTRAINT "workflows_cooldown_matches_policy"
  CHECK (CASE WHEN "reentry_policy" = 'cooldown'
              THEN "cooldown_hours" IS NOT NULL AND "cooldown_hours" > 0
              ELSE "cooldown_hours" IS NULL END);

ALTER TABLE "workflows" ADD CONSTRAINT "workflows_max_runs_positive"
  CHECK ("max_runs_per_entity" IS NULL OR "max_runs_per_entity" > 0);

-- An active workflow with nothing published is one dispatch finds and cannot run. The mirror —
-- "a workflow with a published version is active" — is false, and deliberately so: a paused
-- workflow keeps its current version, which is the whole point of pausing.
ALTER TABLE "workflows" ADD CONSTRAINT "workflows_active_has_a_version"
  CHECK (CASE WHEN "status" = 'active' THEN "current_version_id" IS NOT NULL ELSE true END);

ALTER TABLE "workflow_versions" ADD CONSTRAINT "workflow_versions_version_positive"
  CHECK ("version" >= 1);

-- A definition that is an array or a bare string is not something `validateWorkflowDefinition`
-- ever wrote.
ALTER TABLE "workflow_versions" ADD CONSTRAINT "workflow_versions_definition_is_an_object"
  CHECK (jsonb_typeof("definition") = 'object');

-- One direction only. A publisher with no publication is a contradiction; the mirror would make a
-- version published by the *system* — an industry template's starter workflow, which nobody
-- published — unrepresentable, and the service would have to write a lie or fail. The same shape
-- as `webhook_deliveries_pending_is_untried`, whose mirror was wrong for the same reason.
ALTER TABLE "workflow_versions" ADD CONSTRAINT "workflow_versions_publisher_published_it"
  CHECK ("published_by_id" IS NULL OR "published_at" IS NOT NULL);

-- `event` is NULL for a trigger nothing dispatches (`manual`). An empty string, though, would sit
-- in the dispatch index matching nothing, which is the shape of a projection written wrong.
ALTER TABLE "workflow_triggers" ADD CONSTRAINT "workflow_triggers_event_not_blank"
  CHECK ("event" IS NULL OR length(btrim("event")) > 0);
ALTER TABLE "workflow_triggers" ADD CONSTRAINT "workflow_triggers_type_not_blank"
  CHECK (length(btrim("trigger_type")) > 0);
ALTER TABLE "workflow_triggers" ADD CONSTRAINT "workflow_triggers_params_is_an_object"
  CHECK (jsonb_typeof("params") = 'object');
