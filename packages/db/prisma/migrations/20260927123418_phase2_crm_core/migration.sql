-- CreateEnum
CREATE TYPE "lead_status_category" AS ENUM ('open', 'won', 'lost', 'invalid');

-- CreateEnum
CREATE TYPE "lead_priority" AS ENUM ('low', 'medium', 'high', 'urgent');

-- CreateEnum
CREATE TYPE "lead_created_via" AS ENUM ('manual', 'form', 'api', 'webhook', 'import', 'whatsapp', 'meta_ads', 'google_ads', 'website');

-- CreateEnum
CREATE TYPE "pipeline_entity" AS ENUM ('lead', 'deal');

-- CreateEnum
CREATE TYPE "custom_field_entity" AS ENUM ('lead', 'customer', 'deal', 'task', 'conversation');

-- CreateEnum
CREATE TYPE "custom_field_type" AS ENUM ('text', 'textarea', 'number', 'decimal', 'currency', 'boolean', 'date', 'datetime', 'select', 'multiselect', 'radio', 'checkbox_group', 'email', 'phone', 'url', 'rating', 'file');

-- CreateEnum
CREATE TYPE "activity_visibility" AS ENUM ('all', 'internal');

-- CreateEnum
CREATE TYPE "touchpoint_channel" AS ENUM ('website', 'form', 'whatsapp', 'call', 'email', 'meta_ads', 'google_ads', 'referral', 'walk_in', 'marketplace', 'import', 'manual', 'api', 'other');

-- CreateTable
CREATE TABLE "custom_field_sections" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "entity_type" "custom_field_entity" NOT NULL,
    "name" TEXT NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "collapsed_by_default" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "custom_field_sections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "custom_field_definitions" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "entity_type" "custom_field_entity" NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "type" "custom_field_type" NOT NULL,
    "placeholder" TEXT,
    "help_text" TEXT,
    "is_required" BOOLEAN NOT NULL DEFAULT false,
    "default_value" JSONB,
    "validation" JSONB NOT NULL DEFAULT '{}',
    "section_id" UUID,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "visibility" JSONB NOT NULL DEFAULT '{}',
    "show_in_list" BOOLEAN NOT NULL DEFAULT false,
    "is_searchable" BOOLEAN NOT NULL DEFAULT false,
    "is_filterable" BOOLEAN NOT NULL DEFAULT true,
    "is_indexed" BOOLEAN NOT NULL DEFAULT false,
    "index_name" TEXT,
    "indexed_at" TIMESTAMPTZ(6),
    "is_pii" BOOLEAN NOT NULL DEFAULT false,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "custom_field_definitions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "custom_field_options" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "definition_id" UUID NOT NULL,
    "value" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "colour" TEXT,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "custom_field_options_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lead_statuses" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "colour" TEXT,
    "category" "lead_status_category" NOT NULL DEFAULT 'open',
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "lead_statuses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lead_sources" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT,
    "cost_model" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "lead_sources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lost_reasons" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "requires_note" BOOLEAN NOT NULL DEFAULT false,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "lost_reasons_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tags" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "colour" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "tags_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lead_tags" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "lead_id" UUID NOT NULL,
    "tag_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lead_tags_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pipelines" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "entity_type" "pipeline_entity" NOT NULL DEFAULT 'lead',
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "pipelines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pipeline_stages" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "pipeline_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "colour" TEXT,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "probability" SMALLINT,
    "is_won" BOOLEAN NOT NULL DEFAULT false,
    "is_lost" BOOLEAN NOT NULL DEFAULT false,
    "required_fields" JSONB NOT NULL DEFAULT '[]',
    "target_duration_hours" INTEGER,
    "automation_hooks" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "pipeline_stages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "leads" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "branch_id" UUID,
    "team_id" UUID,
    "assigned_user_id" UUID,
    "first_name" TEXT,
    "last_name" TEXT,
    "full_name" TEXT NOT NULL,
    "company" TEXT,
    "job_title" TEXT,
    "phone_e164" TEXT,
    "phone_raw" TEXT,
    "whatsapp_e164" TEXT,
    "email" TEXT,
    "city" TEXT,
    "state" TEXT,
    "country" CHAR(2),
    "postal_code" TEXT,
    "timezone" TEXT,
    "lead_source_id" UUID,
    "landing_page_url" TEXT,
    "utm" JSONB NOT NULL DEFAULT '{}',
    "created_via" "lead_created_via" NOT NULL DEFAULT 'manual',
    "status_id" UUID NOT NULL,
    "pipeline_id" UUID NOT NULL,
    "stage_id" UUID NOT NULL,
    "priority" "lead_priority" NOT NULL DEFAULT 'medium',
    "score" INTEGER NOT NULL DEFAULT 0,
    "score_band" TEXT,
    "value_minor" BIGINT,
    "currency" CHAR(3),
    "custom_values" JSONB NOT NULL DEFAULT '{}',
    "custom_search_text" TEXT,
    "search_vector" tsvector,
    "first_contacted_at" TIMESTAMPTZ(6),
    "last_contacted_at" TIMESTAMPTZ(6),
    "last_activity_at" TIMESTAMPTZ(6),
    "next_action_at" TIMESTAMPTZ(6),
    "open_tasks_count" INTEGER NOT NULL DEFAULT 0,
    "touch_count" INTEGER NOT NULL DEFAULT 0,
    "converted_at" TIMESTAMPTZ(6),
    "lost_at" TIMESTAMPTZ(6),
    "lost_reason_id" UUID,
    "lost_note" TEXT,
    "consent_whatsapp" BOOLEAN NOT NULL DEFAULT false,
    "consent_email" BOOLEAN NOT NULL DEFAULT false,
    "consent_calls" BOOLEAN NOT NULL DEFAULT false,
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),
    "deleted_by_id" UUID,

    CONSTRAINT "leads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lead_touchpoints" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "lead_id" UUID NOT NULL,
    "sequence" INTEGER NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL,
    "channel" "touchpoint_channel" NOT NULL,
    "lead_source_id" UUID,
    "landing_page_url" TEXT,
    "utm" JSONB NOT NULL DEFAULT '{}',
    "session_id" TEXT,
    "cost_attributable" BOOLEAN NOT NULL DEFAULT false,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lead_touchpoints_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lead_assignments" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "lead_id" UUID NOT NULL,
    "from_user_id" UUID,
    "to_user_id" UUID,
    "to_team_id" UUID,
    "assigned_by_id" UUID,
    "reason" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lead_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lead_status_history" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "lead_id" UUID NOT NULL,
    "from_status_id" UUID,
    "to_status_id" UUID NOT NULL,
    "changed_by_id" UUID,
    "duration_seconds" INTEGER,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lead_status_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lead_stage_history" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "lead_id" UUID NOT NULL,
    "from_stage_id" UUID,
    "to_stage_id" UUID NOT NULL,
    "changed_by_id" UUID,
    "duration_seconds" INTEGER,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lead_stage_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
-- HAND-EDITED: `activities` is created PARTITIONED, which Prisma cannot express.
-- Monthly range partitions on occurred_at (docs/database-design.md §14, ADR-0009). Doing this now
-- rather than later is the whole point: converting a populated table to a partitioned one means
-- moving every row.
CREATE TABLE "activities" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "lead_id" UUID,
    "type" TEXT NOT NULL,
    "actor_type" "actor_type" NOT NULL DEFAULT 'user',
    "actor_id" UUID,
    "actor_label" TEXT,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "visibility" "activity_visibility" NOT NULL DEFAULT 'all',
    "source_event_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "activities_pkey" PRIMARY KEY ("id","occurred_at")
) PARTITION BY RANGE ("occurred_at");

-- CreateIndex
CREATE INDEX "custom_field_sections_organization_id_entity_type_sort_orde_idx" ON "custom_field_sections"("organization_id", "entity_type", "sort_order");

-- CreateIndex
CREATE UNIQUE INDEX "custom_field_sections_organization_id_id_key" ON "custom_field_sections"("organization_id", "id");

-- CreateIndex
CREATE INDEX "custom_field_definitions_organization_id_entity_type_is_act_idx" ON "custom_field_definitions"("organization_id", "entity_type", "is_active", "sort_order");

-- CreateIndex
CREATE INDEX "custom_field_definitions_organization_id_is_indexed_idx" ON "custom_field_definitions"("organization_id", "is_indexed");

-- CreateIndex
CREATE UNIQUE INDEX "custom_field_definitions_organization_id_id_key" ON "custom_field_definitions"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "custom_field_definitions_organization_id_entity_type_key_key" ON "custom_field_definitions"("organization_id", "entity_type", "key");

-- CreateIndex
CREATE INDEX "custom_field_options_organization_id_definition_id_sort_ord_idx" ON "custom_field_options"("organization_id", "definition_id", "sort_order");

-- CreateIndex
CREATE UNIQUE INDEX "custom_field_options_organization_id_id_key" ON "custom_field_options"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "custom_field_options_organization_id_definition_id_value_key" ON "custom_field_options"("organization_id", "definition_id", "value");

-- CreateIndex
CREATE INDEX "lead_statuses_organization_id_category_sort_order_idx" ON "lead_statuses"("organization_id", "category", "sort_order");

-- CreateIndex
CREATE UNIQUE INDEX "lead_statuses_organization_id_id_key" ON "lead_statuses"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "lead_statuses_organization_id_name_key" ON "lead_statuses"("organization_id", "name");

-- CreateIndex
CREATE INDEX "lead_sources_organization_id_is_active_sort_order_idx" ON "lead_sources"("organization_id", "is_active", "sort_order");

-- CreateIndex
CREATE UNIQUE INDEX "lead_sources_organization_id_id_key" ON "lead_sources"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "lead_sources_organization_id_name_key" ON "lead_sources"("organization_id", "name");

-- CreateIndex
CREATE INDEX "lost_reasons_organization_id_is_active_sort_order_idx" ON "lost_reasons"("organization_id", "is_active", "sort_order");

-- CreateIndex
CREATE UNIQUE INDEX "lost_reasons_organization_id_id_key" ON "lost_reasons"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "lost_reasons_organization_id_name_key" ON "lost_reasons"("organization_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "tags_organization_id_id_key" ON "tags"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "tags_organization_id_name_key" ON "tags"("organization_id", "name");

-- CreateIndex
CREATE INDEX "lead_tags_organization_id_tag_id_idx" ON "lead_tags"("organization_id", "tag_id");

-- CreateIndex
CREATE UNIQUE INDEX "lead_tags_organization_id_id_key" ON "lead_tags"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "lead_tags_organization_id_lead_id_tag_id_key" ON "lead_tags"("organization_id", "lead_id", "tag_id");

-- CreateIndex
CREATE INDEX "pipelines_organization_id_entity_type_is_active_idx" ON "pipelines"("organization_id", "entity_type", "is_active");

-- CreateIndex
CREATE UNIQUE INDEX "pipelines_organization_id_id_key" ON "pipelines"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "pipelines_organization_id_entity_type_name_key" ON "pipelines"("organization_id", "entity_type", "name");

-- CreateIndex
CREATE INDEX "pipeline_stages_organization_id_pipeline_id_sort_order_idx" ON "pipeline_stages"("organization_id", "pipeline_id", "sort_order");

-- CreateIndex
CREATE UNIQUE INDEX "pipeline_stages_organization_id_id_key" ON "pipeline_stages"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "pipeline_stages_organization_id_pipeline_id_name_key" ON "pipeline_stages"("organization_id", "pipeline_id", "name");

-- CreateIndex
CREATE INDEX "leads_organization_id_created_at_idx" ON "leads"("organization_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "leads_organization_id_assigned_user_id_next_action_at_idx" ON "leads"("organization_id", "assigned_user_id", "next_action_at");

-- CreateIndex
CREATE INDEX "leads_organization_id_stage_id_updated_at_idx" ON "leads"("organization_id", "stage_id", "updated_at" DESC);

-- CreateIndex
CREATE INDEX "leads_organization_id_status_id_idx" ON "leads"("organization_id", "status_id");

-- CreateIndex
CREATE INDEX "leads_organization_id_phone_e164_idx" ON "leads"("organization_id", "phone_e164");

-- CreateIndex
CREATE INDEX "leads_organization_id_whatsapp_e164_idx" ON "leads"("organization_id", "whatsapp_e164");

-- CreateIndex
CREATE INDEX "leads_organization_id_lead_source_id_created_at_idx" ON "leads"("organization_id", "lead_source_id", "created_at");

-- CreateIndex
CREATE INDEX "leads_organization_id_score_idx" ON "leads"("organization_id", "score" DESC);

-- CreateIndex
CREATE INDEX "leads_organization_id_last_activity_at_idx" ON "leads"("organization_id", "last_activity_at");

-- CreateIndex
CREATE INDEX "leads_organization_id_deleted_at_idx" ON "leads"("organization_id", "deleted_at");

-- CreateIndex
CREATE UNIQUE INDEX "leads_organization_id_id_key" ON "leads"("organization_id", "id");

-- CreateIndex
CREATE INDEX "lead_touchpoints_organization_id_lead_id_occurred_at_idx" ON "lead_touchpoints"("organization_id", "lead_id", "occurred_at");

-- CreateIndex
CREATE INDEX "lead_touchpoints_organization_id_channel_occurred_at_idx" ON "lead_touchpoints"("organization_id", "channel", "occurred_at");

-- CreateIndex
CREATE UNIQUE INDEX "lead_touchpoints_organization_id_id_key" ON "lead_touchpoints"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "lead_touchpoints_organization_id_lead_id_sequence_key" ON "lead_touchpoints"("organization_id", "lead_id", "sequence");

-- CreateIndex
CREATE INDEX "lead_assignments_organization_id_lead_id_created_at_idx" ON "lead_assignments"("organization_id", "lead_id", "created_at");

-- CreateIndex
CREATE INDEX "lead_assignments_organization_id_to_user_id_created_at_idx" ON "lead_assignments"("organization_id", "to_user_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "lead_assignments_organization_id_id_key" ON "lead_assignments"("organization_id", "id");

-- CreateIndex
CREATE INDEX "lead_status_history_organization_id_lead_id_created_at_idx" ON "lead_status_history"("organization_id", "lead_id", "created_at");

-- CreateIndex
CREATE INDEX "lead_status_history_organization_id_to_status_id_created_at_idx" ON "lead_status_history"("organization_id", "to_status_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "lead_status_history_organization_id_id_key" ON "lead_status_history"("organization_id", "id");

-- CreateIndex
CREATE INDEX "lead_stage_history_organization_id_lead_id_created_at_idx" ON "lead_stage_history"("organization_id", "lead_id", "created_at");

-- CreateIndex
CREATE INDEX "lead_stage_history_organization_id_to_stage_id_created_at_idx" ON "lead_stage_history"("organization_id", "to_stage_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "lead_stage_history_organization_id_id_key" ON "lead_stage_history"("organization_id", "id");

-- CreateIndex
CREATE INDEX "activities_organization_id_lead_id_occurred_at_idx" ON "activities"("organization_id", "lead_id", "occurred_at" DESC);

-- CreateIndex
CREATE INDEX "activities_organization_id_type_occurred_at_idx" ON "activities"("organization_id", "type", "occurred_at" DESC);

-- CreateIndex
CREATE INDEX "activities_organization_id_actor_id_occurred_at_idx" ON "activities"("organization_id", "actor_id", "occurred_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "activities_organization_id_id_occurred_at_key" ON "activities"("organization_id", "id", "occurred_at");

-- CreateIndex
CREATE UNIQUE INDEX "activities_organization_id_source_event_id_occurred_at_key" ON "activities"("organization_id", "source_event_id", "occurred_at");

-- AddForeignKey
ALTER TABLE "custom_field_sections" ADD CONSTRAINT "custom_field_sections_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "custom_field_definitions" ADD CONSTRAINT "custom_field_definitions_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "custom_field_definitions" ADD CONSTRAINT "custom_field_definitions_section_same_org_fk" FOREIGN KEY ("organization_id", "section_id") REFERENCES "custom_field_sections"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "custom_field_options" ADD CONSTRAINT "custom_field_options_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "custom_field_options" ADD CONSTRAINT "custom_field_options_definition_same_org_fk" FOREIGN KEY ("organization_id", "definition_id") REFERENCES "custom_field_definitions"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lead_statuses" ADD CONSTRAINT "lead_statuses_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lead_sources" ADD CONSTRAINT "lead_sources_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lost_reasons" ADD CONSTRAINT "lost_reasons_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tags" ADD CONSTRAINT "tags_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lead_tags" ADD CONSTRAINT "lead_tags_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lead_tags" ADD CONSTRAINT "lead_tags_lead_same_org_fk" FOREIGN KEY ("organization_id", "lead_id") REFERENCES "leads"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lead_tags" ADD CONSTRAINT "lead_tags_tag_same_org_fk" FOREIGN KEY ("organization_id", "tag_id") REFERENCES "tags"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pipelines" ADD CONSTRAINT "pipelines_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pipeline_stages" ADD CONSTRAINT "pipeline_stages_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pipeline_stages" ADD CONSTRAINT "pipeline_stages_pipeline_same_org_fk" FOREIGN KEY ("organization_id", "pipeline_id") REFERENCES "pipelines"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leads" ADD CONSTRAINT "leads_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leads" ADD CONSTRAINT "leads_branch_same_org_fk" FOREIGN KEY ("organization_id", "branch_id") REFERENCES "branches"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leads" ADD CONSTRAINT "leads_team_same_org_fk" FOREIGN KEY ("organization_id", "team_id") REFERENCES "teams"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leads" ADD CONSTRAINT "leads_assignee_same_org_fk" FOREIGN KEY ("organization_id", "assigned_user_id") REFERENCES "memberships"("organization_id", "user_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leads" ADD CONSTRAINT "leads_status_same_org_fk" FOREIGN KEY ("organization_id", "status_id") REFERENCES "lead_statuses"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leads" ADD CONSTRAINT "leads_pipeline_same_org_fk" FOREIGN KEY ("organization_id", "pipeline_id") REFERENCES "pipelines"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leads" ADD CONSTRAINT "leads_stage_same_org_fk" FOREIGN KEY ("organization_id", "stage_id") REFERENCES "pipeline_stages"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leads" ADD CONSTRAINT "leads_source_same_org_fk" FOREIGN KEY ("organization_id", "lead_source_id") REFERENCES "lead_sources"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leads" ADD CONSTRAINT "leads_lost_reason_same_org_fk" FOREIGN KEY ("organization_id", "lost_reason_id") REFERENCES "lost_reasons"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lead_touchpoints" ADD CONSTRAINT "lead_touchpoints_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lead_touchpoints" ADD CONSTRAINT "lead_touchpoints_lead_same_org_fk" FOREIGN KEY ("organization_id", "lead_id") REFERENCES "leads"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lead_touchpoints" ADD CONSTRAINT "lead_touchpoints_source_same_org_fk" FOREIGN KEY ("organization_id", "lead_source_id") REFERENCES "lead_sources"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lead_assignments" ADD CONSTRAINT "lead_assignments_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lead_assignments" ADD CONSTRAINT "lead_assignments_lead_same_org_fk" FOREIGN KEY ("organization_id", "lead_id") REFERENCES "leads"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lead_status_history" ADD CONSTRAINT "lead_status_history_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lead_status_history" ADD CONSTRAINT "lead_status_history_lead_same_org_fk" FOREIGN KEY ("organization_id", "lead_id") REFERENCES "leads"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lead_status_history" ADD CONSTRAINT "lead_status_history_from_same_org_fk" FOREIGN KEY ("organization_id", "from_status_id") REFERENCES "lead_statuses"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lead_status_history" ADD CONSTRAINT "lead_status_history_to_same_org_fk" FOREIGN KEY ("organization_id", "to_status_id") REFERENCES "lead_statuses"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lead_stage_history" ADD CONSTRAINT "lead_stage_history_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lead_stage_history" ADD CONSTRAINT "lead_stage_history_lead_same_org_fk" FOREIGN KEY ("organization_id", "lead_id") REFERENCES "leads"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lead_stage_history" ADD CONSTRAINT "lead_stage_history_from_same_org_fk" FOREIGN KEY ("organization_id", "from_stage_id") REFERENCES "pipeline_stages"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lead_stage_history" ADD CONSTRAINT "lead_stage_history_to_same_org_fk" FOREIGN KEY ("organization_id", "to_stage_id") REFERENCES "pipeline_stages"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "activities" ADD CONSTRAINT "activities_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ═════════════════════════════════════════════════════════════════════════════
-- HAND-WRITTEN HARDENING — things Prisma cannot express.
-- ═════════════════════════════════════════════════════════════════════════════

-- ── 1. Activity partitions ──────────────────────────────────────────────────
-- One month per partition. The function is idempotent so the monthly maintenance job can call it
-- without checking first, and so re-running a migration on a partly-built database is safe.
CREATE OR REPLACE FUNCTION ensure_activity_partition(target timestamptz)
RETURNS text
LANGUAGE plpgsql
AS $$
DECLARE
  month_start date := date_trunc('month', target)::date;
  month_end   date := (date_trunc('month', target) + interval '1 month')::date;
  part_name   text := format('activities_%s', to_char(month_start, 'YYYY_MM'));
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = part_name) THEN
    EXECUTE format(
      'CREATE TABLE %I PARTITION OF activities FOR VALUES FROM (%L) TO (%L)',
      part_name, month_start, month_end
    );
  END IF;
  RETURN part_name;
END;
$$;

COMMENT ON FUNCTION ensure_activity_partition(timestamptz) IS
  'Creates the monthly activities partition containing the given instant, if it does not exist. Idempotent; called by the partition-maintenance job.';

-- Twelve months back and twelve forward. Backwards matters because an import of historical leads
-- writes activities at historical instants; forwards is the runway the maintenance job extends.
DO $$
DECLARE
  offset_months int;
BEGIN
  FOR offset_months IN -12..12 LOOP
    PERFORM ensure_activity_partition(now() + (offset_months || ' months')::interval);
  END LOOP;
END;
$$;

-- The safety net. Without it an insert outside every range fails, which would turn a backdated
-- import into a 500. Rows landing here are an anomaly the maintenance job reports rather than
-- something to ignore: a new partition overlapping rows in the default cannot be attached until
-- they are moved.
CREATE TABLE activities_default PARTITION OF activities DEFAULT;

COMMENT ON TABLE activities_default IS
  'Catch-all for instants outside the pre-created monthly partitions. Rows here block ATTACH of the overlapping month, so the maintenance job reports them.';

-- ── 2. A lead cannot be in another pipeline's stage ─────────────────────────
-- The composite FKs Prisma generated stop a lead pointing at another *tenant's* stage. They cannot
-- stop it pointing at a stage of a different pipeline in the same tenant — which would make the
-- kanban render a lead in a column that does not belong to its board. This closes that.
CREATE UNIQUE INDEX pipeline_stages_pipeline_scoped_key
  ON pipeline_stages (organization_id, pipeline_id, id);

ALTER TABLE leads
  ADD CONSTRAINT leads_stage_in_pipeline_fk
  FOREIGN KEY (organization_id, pipeline_id, stage_id)
  REFERENCES pipeline_stages (organization_id, pipeline_id, id)
  ON DELETE RESTRICT;

-- ── 3. Value objects the database refuses to corrupt ───────────────────────
ALTER TABLE leads
  ADD CONSTRAINT leads_currency_format CHECK (currency IS NULL OR currency ~ '^[A-Z]{3}$'),
  ADD CONSTRAINT leads_value_non_negative CHECK (value_minor IS NULL OR value_minor >= 0),
  ADD CONSTRAINT leads_score_range CHECK (score >= 0 AND score <= 1000),
  ADD CONSTRAINT leads_counters_non_negative CHECK (open_tasks_count >= 0 AND touch_count >= 0),
  -- A value without a currency is a number nobody can act on.
  ADD CONSTRAINT leads_value_needs_currency CHECK (value_minor IS NULL OR currency IS NOT NULL),
  -- E.164: a leading + and 8–15 digits. Enforced here because duplicate detection compares these
  -- as strings, and one unnormalized row would silently stop matching its own duplicates.
  ADD CONSTRAINT leads_phone_e164_format CHECK (phone_e164 IS NULL OR phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  ADD CONSTRAINT leads_whatsapp_e164_format CHECK (whatsapp_e164 IS NULL OR whatsapp_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  -- Names are optional individually, but a lead with nothing to call it by is not a lead.
  ADD CONSTRAINT leads_full_name_present CHECK (length(btrim(full_name)) > 0);

ALTER TABLE lead_touchpoints
  ADD CONSTRAINT lead_touchpoints_sequence_positive CHECK (sequence >= 1);

ALTER TABLE pipeline_stages
  ADD CONSTRAINT pipeline_stages_probability_range
    CHECK (probability IS NULL OR (probability >= 0 AND probability <= 100)),
  -- A stage cannot be both the won and the lost outcome.
  ADD CONSTRAINT pipeline_stages_outcome_exclusive CHECK (NOT (is_won AND is_lost)),
  ADD CONSTRAINT pipeline_stages_required_fields_is_array
    CHECK (jsonb_typeof(required_fields) = 'array');

ALTER TABLE custom_field_definitions
  ADD CONSTRAINT custom_field_definitions_key_shape
    CHECK (key ~ '^[a-z][a-z0-9_]{1,48}$'),
  ADD CONSTRAINT custom_field_definitions_validation_is_object
    CHECK (jsonb_typeof(validation) = 'object');

ALTER TABLE leads
  ADD CONSTRAINT leads_custom_values_is_object CHECK (jsonb_typeof(custom_values) = 'object'),
  ADD CONSTRAINT leads_utm_is_object CHECK (jsonb_typeof(utm) = 'object');

-- ── 4. One default per organization ────────────────────────────────────────
-- A second default status or pipeline is not a validation error a service can be trusted to catch
-- forever; it is a state the database should not hold.
CREATE UNIQUE INDEX lead_statuses_one_default_per_org
  ON lead_statuses (organization_id) WHERE is_default AND deleted_at IS NULL;

CREATE UNIQUE INDEX pipelines_one_default_per_org_entity
  ON pipelines (organization_id, entity_type) WHERE is_default AND deleted_at IS NULL;

-- ── 5. Search (docs/database-design.md §15) ────────────────────────────────
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Maintained by trigger rather than by the application: an import, a merge or a future raw-SQL
-- writer must not be able to leave a lead unsearchable.
CREATE OR REPLACE FUNCTION leads_search_vector_refresh()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.search_vector :=
      setweight(to_tsvector('simple', coalesce(NEW.full_name, '')), 'A')
    || setweight(to_tsvector('simple', coalesce(NEW.company, '')), 'B')
    -- Digits only, so "9876 543 210" and "+919876543210" are the same search term.
    || setweight(to_tsvector('simple', regexp_replace(coalesce(NEW.phone_e164, ''), '\D', '', 'g')), 'A')
    || setweight(to_tsvector('simple', regexp_replace(coalesce(NEW.phone_raw, ''), '\D', '', 'g')), 'B')
    || setweight(to_tsvector('simple', coalesce(NEW.email, '')), 'A')
    || setweight(to_tsvector('simple', coalesce(NEW.city, '')), 'C')
    || setweight(to_tsvector('simple', coalesce(NEW.custom_search_text, '')), 'C');
  RETURN NEW;
END;
$$;

CREATE TRIGGER leads_search_vector_trg
  BEFORE INSERT OR UPDATE OF full_name, company, phone_e164, phone_raw, email, city, custom_search_text
  ON leads
  FOR EACH ROW
  EXECUTE FUNCTION leads_search_vector_refresh();

CREATE INDEX leads_search_vector_gin ON leads USING GIN (search_vector);

-- jsonb_path_ops is deliberate: it indexes paths-with-values rather than keys alone, which is what a
-- custom-field filter actually asks, and the index is materially smaller than the default.
CREATE INDEX leads_custom_values_gin ON leads USING GIN (custom_values jsonb_path_ops);

-- Trigram indexes answer "the last four digits of the number" and misspelt names.
CREATE INDEX leads_phone_e164_trgm ON leads USING GIN (phone_e164 gin_trgm_ops);
CREATE INDEX leads_full_name_trgm ON leads USING GIN (full_name gin_trgm_ops);
CREATE INDEX leads_email_trgm ON leads USING GIN (lower(email) gin_trgm_ops);

-- ── 6. Partial indexes for the questions managers actually ask ─────────────
-- "Which of my leads have nobody doing anything next?" — the single most valuable query in the
-- product, and the one a full index would not serve cheaply.
CREATE INDEX leads_no_next_action
  ON leads (organization_id, assigned_user_id)
  WHERE deleted_at IS NULL AND next_action_at IS NULL;

CREATE INDEX leads_unassigned
  ON leads (organization_id, created_at DESC)
  WHERE deleted_at IS NULL AND assigned_user_id IS NULL;

-- The default list and the kanban both filter out deleted rows; the Prisma-generated indexes do not.
CREATE INDEX leads_live_created_at
  ON leads (organization_id, created_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX leads_live_stage_updated
  ON leads (organization_id, stage_id, updated_at DESC)
  WHERE deleted_at IS NULL;
