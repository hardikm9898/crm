-- Phase 4, step 1 — capture forms: `forms`, `form_fields`, `form_submissions`, and the `form_id`
-- columns on `leads` and `lead_touchpoints`.
--
-- Prisma's diff arrived with **fifteen** spurious statements: the two three-column composite FKs
-- that make "a lead in another pipeline's stage" unrepresentable, and thirteen GIN, trigram and
-- partial indexes earlier migrations added by hand. They are objects `schema.prisma` cannot
-- express, so `migrate diff` sees them in the database, does not see them in the schema, and drops
-- them. Removed statement by statement — and only the `-- DropForeignKey` and `-- DropIndex`
-- sections, because Prisma puts `ADD COLUMN` in the same region and cutting the whole region once
-- deleted two of those with it. `packages/db/src/schema-objects.int-spec.ts` is the only thing that
-- catches the ones missed.

-- CreateEnum
CREATE TYPE "form_type" AS ENUM ('embed', 'landing', 'popup');

-- CreateEnum
CREATE TYPE "form_submission_status" AS ENUM ('received', 'processed', 'duplicate', 'rejected', 'error');

-- AlterTable
ALTER TABLE "lead_touchpoints" ADD COLUMN     "form_id" UUID;

-- AlterTable
ALTER TABLE "leads" ADD COLUMN     "form_id" UUID;

-- CreateTable
CREATE TABLE "forms" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "public_key" TEXT NOT NULL,
    "type" "form_type" NOT NULL DEFAULT 'embed',
    "pipeline_id" UUID,
    "lead_source_id" UUID,
    "assignment_rule_id" UUID,
    "settings" JSONB NOT NULL DEFAULT '{}',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "submission_count" INTEGER NOT NULL DEFAULT 0,
    "last_submission_at" TIMESTAMPTZ(6),
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "forms_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "form_fields" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "form_id" UUID NOT NULL,
    "standard_field_key" TEXT,
    "custom_field_definition_id" UUID,
    "label" TEXT NOT NULL,
    "placeholder" TEXT,
    "help_text" TEXT,
    "is_required" BOOLEAN NOT NULL DEFAULT false,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "step_index" INTEGER NOT NULL DEFAULT 0,
    "options" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "form_fields_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "form_submissions" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "form_id" UUID NOT NULL,
    "lead_id" UUID,
    "raw_payload" JSONB NOT NULL,
    "utm" JSONB NOT NULL DEFAULT '{}',
    "session_id" TEXT,
    "visitor_id" TEXT,
    "ip_hash" TEXT,
    "user_agent" TEXT,
    "page_url" TEXT,
    "referrer" TEXT,
    "status" "form_submission_status" NOT NULL DEFAULT 'received',
    "error" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "form_submissions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "forms_organization_id_is_active_updated_at_idx" ON "forms"("organization_id", "is_active", "updated_at" DESC);

-- CreateIndex
CREATE INDEX "forms_organization_id_deleted_at_idx" ON "forms"("organization_id", "deleted_at");

-- CreateIndex
CREATE INDEX "forms_organization_id_pipeline_id_idx" ON "forms"("organization_id", "pipeline_id");

-- CreateIndex
CREATE INDEX "forms_organization_id_lead_source_id_idx" ON "forms"("organization_id", "lead_source_id");

-- CreateIndex
CREATE INDEX "forms_organization_id_assignment_rule_id_idx" ON "forms"("organization_id", "assignment_rule_id");

-- CreateIndex
CREATE UNIQUE INDEX "forms_organization_id_id_key" ON "forms"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "forms_public_key_key" ON "forms"("public_key");

-- CreateIndex
CREATE INDEX "form_fields_organization_id_form_id_step_index_sort_order_idx" ON "form_fields"("organization_id", "form_id", "step_index", "sort_order");

-- CreateIndex
CREATE INDEX "form_fields_organization_id_custom_field_definition_id_idx" ON "form_fields"("organization_id", "custom_field_definition_id");

-- CreateIndex
CREATE UNIQUE INDEX "form_fields_organization_id_id_key" ON "form_fields"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "form_fields_organization_id_form_id_standard_field_key_key" ON "form_fields"("organization_id", "form_id", "standard_field_key");

-- CreateIndex
CREATE UNIQUE INDEX "form_fields_organization_id_form_id_custom_field_definition_key" ON "form_fields"("organization_id", "form_id", "custom_field_definition_id");

-- CreateIndex
CREATE INDEX "form_submissions_organization_id_form_id_created_at_idx" ON "form_submissions"("organization_id", "form_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "form_submissions_organization_id_status_created_at_idx" ON "form_submissions"("organization_id", "status", "created_at" DESC);

-- CreateIndex
CREATE INDEX "form_submissions_organization_id_lead_id_idx" ON "form_submissions"("organization_id", "lead_id");

-- CreateIndex
CREATE UNIQUE INDEX "form_submissions_organization_id_id_key" ON "form_submissions"("organization_id", "id");

-- CreateIndex
CREATE INDEX "lead_touchpoints_organization_id_form_id_occurred_at_idx" ON "lead_touchpoints"("organization_id", "form_id", "occurred_at");

-- CreateIndex
CREATE INDEX "leads_organization_id_form_id_created_at_idx" ON "leads"("organization_id", "form_id", "created_at" DESC);

-- AddForeignKey
ALTER TABLE "leads" ADD CONSTRAINT "leads_form_same_org_fk" FOREIGN KEY ("organization_id", "form_id") REFERENCES "forms"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lead_touchpoints" ADD CONSTRAINT "lead_touchpoints_form_same_org_fk" FOREIGN KEY ("organization_id", "form_id") REFERENCES "forms"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "forms" ADD CONSTRAINT "forms_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "forms" ADD CONSTRAINT "forms_pipeline_same_org_fk" FOREIGN KEY ("organization_id", "pipeline_id") REFERENCES "pipelines"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "forms" ADD CONSTRAINT "forms_source_same_org_fk" FOREIGN KEY ("organization_id", "lead_source_id") REFERENCES "lead_sources"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "forms" ADD CONSTRAINT "forms_assignment_rule_same_org_fk" FOREIGN KEY ("organization_id", "assignment_rule_id") REFERENCES "assignment_rules"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "forms" ADD CONSTRAINT "forms_creator_same_org_fk" FOREIGN KEY ("organization_id", "created_by_id") REFERENCES "memberships"("organization_id", "user_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "form_fields" ADD CONSTRAINT "form_fields_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "form_fields" ADD CONSTRAINT "form_fields_form_same_org_fk" FOREIGN KEY ("organization_id", "form_id") REFERENCES "forms"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "form_fields" ADD CONSTRAINT "form_fields_definition_same_org_fk" FOREIGN KEY ("organization_id", "custom_field_definition_id") REFERENCES "custom_field_definitions"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "form_submissions" ADD CONSTRAINT "form_submissions_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "form_submissions" ADD CONSTRAINT "form_submissions_form_same_org_fk" FOREIGN KEY ("organization_id", "form_id") REFERENCES "forms"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "form_submissions" ADD CONSTRAINT "form_submissions_lead_same_org_fk" FOREIGN KEY ("organization_id", "lead_id") REFERENCES "leads"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ───────────────────────────────────────────────────────────────────────────
-- Hand-written objects. Prisma cannot express any of these, which means its next diff will
-- propose dropping them: every one is listed in `packages/db/src/schema-objects.int-spec.ts`,
-- which is the only thing that catches a drop that slips through.
-- ───────────────────────────────────────────────────────────────────────────

-- A question with no answer to write to is not a question. Exactly one target, and both
-- sub-expressions are non-NULL booleans, so the biconditional really does bite.
ALTER TABLE "form_fields" ADD CONSTRAINT "form_fields_one_target"
  CHECK ((standard_field_key IS NOT NULL) <> (custom_field_definition_id IS NOT NULL));

ALTER TABLE "form_fields" ADD CONSTRAINT "form_fields_label_present"
  CHECK (length(btrim(label)) > 0);

-- A step or a position below zero would sort a field off the form.
ALTER TABLE "form_fields" ADD CONSTRAINT "form_fields_position_non_negative"
  CHECK (step_index >= 0 AND sort_order >= 0);

ALTER TABLE "forms" ADD CONSTRAINT "forms_name_present"
  CHECK (length(btrim(name)) > 0);

-- The slug is in a URL and in a `UNIQUE (organization_id, slug)`; a slash or a space in it would
-- make the admin link ambiguous and the embed snippet wrong.
ALTER TABLE "forms" ADD CONSTRAINT "forms_slug_is_url_safe"
  CHECK (slug ~ '^[a-z0-9][a-z0-9-]*$');

-- The public key *is* the authentication on the public endpoints: it decides which workspace a
-- stranger's submission lands in. A short one is a guessable URL, so the floor is in the database
-- rather than in the service that happens to mint it today (ADR-0029).
ALTER TABLE "forms" ADD CONSTRAINT "forms_public_key_long_enough"
  CHECK (length(public_key) >= 16);

ALTER TABLE "forms" ADD CONSTRAINT "forms_submission_count_non_negative"
  CHECK (submission_count >= 0);

ALTER TABLE "forms" ADD CONSTRAINT "forms_settings_is_object"
  CHECK (jsonb_typeof(settings) = 'object');

-- A `CASE` rather than a biconditional, because `status` has five values and only two of them
-- mean a lead exists. Written so every sub-expression is non-NULL: a CHECK that evaluates to NULL
-- is satisfied, which is how an escalation claiming to have notified nobody once got through.
ALTER TABLE "form_submissions" ADD CONSTRAINT "form_submissions_outcome_has_a_lead"
  CHECK (CASE WHEN status IN ('processed', 'duplicate') THEN lead_id IS NOT NULL ELSE true END);

-- "Why was my form submission refused" has to be answerable from the row.
ALTER TABLE "form_submissions" ADD CONSTRAINT "form_submissions_refusal_is_explained"
  CHECK (CASE WHEN status IN ('rejected', 'error') THEN error IS NOT NULL ELSE true END);

ALTER TABLE "form_submissions" ADD CONSTRAINT "form_submissions_payload_is_object"
  CHECK (jsonb_typeof(raw_payload) = 'object');

ALTER TABLE "form_submissions" ADD CONSTRAINT "form_submissions_utm_is_object"
  CHECK (jsonb_typeof(utm) = 'object');

-- The queue the operator reads: submissions that never became a lead, newest first. Partial, so
-- it stays small however many captures succeed.
CREATE INDEX "form_submissions_unresolved" ON "form_submissions" ("organization_id", "created_at" DESC)
  WHERE status IN ('received', 'rejected', 'error');

-- One live form per slug. The Prisma unique covers every row, including soft-deleted ones, which
-- would stop a workspace reusing the slug of a form they deleted; this is the one that matters to
-- a person, and the pair is deliberate.
CREATE UNIQUE INDEX "forms_live_slug" ON "forms" ("organization_id", "slug") WHERE deleted_at IS NULL;

-- ═══════════════════════════════════════════════════════════════════════════
-- `form:read` and `form:manage` for the workspaces that already exist.
--
-- `SYSTEM_ROLE_TEMPLATES` is read when a workspace is *created*, so a new permission key reaches
-- new workspaces and nothing else — the trap `payment:read` paid for and `sla:read`, `call:read`
-- and `call:log` repeated. This inserts the grants for roles still marked `is_system`, at the
-- scope the template gives them, only where they are absent. `PrincipalService` then caches grants
-- for five minutes, so a 403 continues until that expires.
--
-- Neither permission supports a scope: a form belongs to the workspace rather than to a branch.
-- The auditor and the sales manager read; the marketing manager, who builds the campaign the form
-- serves, manages. A sales executive gets neither — a form decides where every capture in the
-- workspace lands.
-- ═══════════════════════════════════════════════════════════════════════════

INSERT INTO "permissions" ("key", "module", "description", "supports_scope")
VALUES
  ('form:read', 'forms', 'View capture forms and their submissions', false),
  ('form:manage', 'forms', 'Create and edit capture forms', false)
ON CONFLICT ("key") DO NOTHING;

INSERT INTO "role_permissions" ("id", "organization_id", "role_id", "permission_key", "scope")
SELECT gen_random_uuid(), r."organization_id", r."id", g.permission, g."scope"::"data_scope"
  FROM "roles" r
  JOIN (VALUES
          ('owner', 'form:read', 'organization'),
          ('owner', 'form:manage', 'organization'),
          ('admin', 'form:read', 'organization'),
          ('admin', 'form:manage', 'organization'),
          ('sales_manager', 'form:read', 'organization'),
          ('marketing_manager', 'form:read', 'organization'),
          ('marketing_manager', 'form:manage', 'organization'),
          ('auditor', 'form:read', 'organization')
       ) AS g(code, permission, scope) ON g.code = r."code"
 WHERE r."is_system" = true
   AND r."deleted_at" IS NULL
   AND NOT EXISTS (
     SELECT 1 FROM "role_permissions" rp
      WHERE rp."organization_id" = r."organization_id"
        AND rp."role_id" = r."id"
        AND rp."permission_key" = g.permission
   );
