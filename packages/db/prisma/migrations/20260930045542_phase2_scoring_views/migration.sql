-- ── Deliberately NOT dropped (again) ───────────────────────────────────────
-- `prisma migrate diff` proposed the same six DROPs it proposed last migration, and will propose
-- them next time too: `leads_stage_in_pipeline_fk`, `pipeline_stages_pipeline_scoped_key`,
-- `leads_search_vector_gin`, `leads_custom_values_gin`, `leads_phone_e164_trgm` and
-- `leads_full_name_trgm`. None of them can be expressed in `schema.prisma`, so the diff sees them
-- in the database, does not see them in the schema, and removes them. They were deleted from the
-- generated SQL. `packages/db/src/schema-objects.int-spec.ts` is what fails if that is forgotten.

-- CreateTable
CREATE TABLE "scoring_rules" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "trigger_event" TEXT NOT NULL,
    "conditions" JSONB NOT NULL DEFAULT '[]',
    "points" INTEGER NOT NULL DEFAULT 0,
    "max_applications" INTEGER,
    "decay" JSONB,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "scoring_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "score_bands" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "min_score" INTEGER NOT NULL,
    "max_score" INTEGER NOT NULL,
    "colour" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "score_bands_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lead_score_events" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "lead_id" UUID NOT NULL,
    "rule_id" UUID,
    "delta" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "score_after" INTEGER NOT NULL,
    "source_event_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lead_score_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "saved_views" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "owner_id" UUID,
    "entity_type" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "filters" JSONB NOT NULL DEFAULT '{}',
    "columns" JSONB NOT NULL DEFAULT '[]',
    "sort" JSONB NOT NULL DEFAULT '{}',
    "visibility" TEXT NOT NULL DEFAULT 'private',
    "team_id" UUID,
    "default_for_role_id" UUID,
    "is_system" BOOLEAN NOT NULL DEFAULT false,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "saved_views_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "scoring_rules_organization_id_trigger_event_is_active_prior_idx" ON "scoring_rules"("organization_id", "trigger_event", "is_active", "priority");

-- CreateIndex
CREATE UNIQUE INDEX "scoring_rules_organization_id_id_key" ON "scoring_rules"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "scoring_rules_organization_id_name_key" ON "scoring_rules"("organization_id", "name");

-- CreateIndex
CREATE INDEX "score_bands_organization_id_min_score_idx" ON "score_bands"("organization_id", "min_score");

-- CreateIndex
CREATE UNIQUE INDEX "score_bands_organization_id_id_key" ON "score_bands"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "score_bands_organization_id_name_key" ON "score_bands"("organization_id", "name");

-- CreateIndex
CREATE INDEX "lead_score_events_organization_id_lead_id_created_at_idx" ON "lead_score_events"("organization_id", "lead_id", "created_at");

-- CreateIndex
CREATE INDEX "lead_score_events_organization_id_rule_id_idx" ON "lead_score_events"("organization_id", "rule_id");

-- CreateIndex
CREATE UNIQUE INDEX "lead_score_events_organization_id_id_key" ON "lead_score_events"("organization_id", "id");

-- CreateIndex
CREATE INDEX "saved_views_organization_id_entity_type_visibility_idx" ON "saved_views"("organization_id", "entity_type", "visibility");

-- CreateIndex
CREATE INDEX "saved_views_organization_id_owner_id_entity_type_idx" ON "saved_views"("organization_id", "owner_id", "entity_type");

-- CreateIndex
CREATE UNIQUE INDEX "saved_views_organization_id_id_key" ON "saved_views"("organization_id", "id");

-- AddForeignKey
ALTER TABLE "scoring_rules" ADD CONSTRAINT "scoring_rules_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "score_bands" ADD CONSTRAINT "score_bands_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lead_score_events" ADD CONSTRAINT "lead_score_events_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lead_score_events" ADD CONSTRAINT "lead_score_events_lead_same_org_fk" FOREIGN KEY ("organization_id", "lead_id") REFERENCES "leads"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lead_score_events" ADD CONSTRAINT "lead_score_events_rule_same_org_fk" FOREIGN KEY ("organization_id", "rule_id") REFERENCES "scoring_rules"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "saved_views" ADD CONSTRAINT "saved_views_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "saved_views" ADD CONSTRAINT "saved_views_owner_same_org_fk" FOREIGN KEY ("organization_id", "owner_id") REFERENCES "memberships"("organization_id", "user_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "saved_views" ADD CONSTRAINT "saved_views_team_same_org_fk" FOREIGN KEY ("organization_id", "team_id") REFERENCES "teams"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "saved_views" ADD CONSTRAINT "saved_views_role_same_org_fk" FOREIGN KEY ("organization_id", "default_for_role_id") REFERENCES "roles"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ═══════════════════════════════════════════════════════════════════════════
-- Hand-written: what Prisma cannot express
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. Overlapping score bands are unrepresentable ─────────────────────────
-- `validateBands` refuses an overlap at configuration time, but a band set is edited by a PUT that
-- replaces the whole set, and two concurrent PUTs could interleave into an overlap that no request
-- ever asked for. An exclusion constraint makes that outcome impossible rather than unlikely: two
-- bands of one organization may not have intersecting score ranges. `btree_gist` is what allows the
-- equality half of the constraint on a uuid.
CREATE EXTENSION IF NOT EXISTS btree_gist;

ALTER TABLE score_bands
  ADD CONSTRAINT score_bands_no_overlap
  EXCLUDE USING gist (
    organization_id WITH =,
    int4range(min_score, max_score, '[]') WITH &&
  );

ALTER TABLE score_bands
  ADD CONSTRAINT score_bands_range CHECK (
    min_score >= 0 AND max_score <= 1000 AND min_score <= max_score
  ),
  ADD CONSTRAINT score_bands_name_present CHECK (length(btrim(name)) > 0);

-- ── 2. A scoring rule is additive or decaying, never neither and never both ─
-- An additive rule on the decay trigger would never fire; a decay spec on `lead.created` would
-- never be swept. Both are silent misconfigurations, so the two are tied together here.
ALTER TABLE scoring_rules
  ADD CONSTRAINT scoring_rules_decay_matches_trigger CHECK (
    (trigger_event = 'schedule.decay') = (decay IS NOT NULL)
  ),
  ADD CONSTRAINT scoring_rules_conditions_is_array CHECK (jsonb_typeof(conditions) = 'array'),
  ADD CONSTRAINT scoring_rules_decay_shape CHECK (
    decay IS NULL OR (
      jsonb_typeof(decay) = 'object'
      AND decay ? 'afterDays' AND decay ? 'points' AND decay ? 'everyDays' AND decay ? 'floor'
    )
  ),
  ADD CONSTRAINT scoring_rules_points_range CHECK (points >= -1000 AND points <= 1000),
  ADD CONSTRAINT scoring_rules_max_applications_positive CHECK (
    max_applications IS NULL OR max_applications >= 1
  ),
  ADD CONSTRAINT scoring_rules_name_present CHECK (length(btrim(name)) > 0);

-- ── 3. One score event per (lead, rule, source event) ──────────────────────
-- This is the idempotency guarantee for `FR-SCR-2`: an at-least-once redelivery of an outbox event
-- scores once. Partial, because an adjustment that no event produced (a recompute correction) has
-- no source event and several of those are legitimate.
CREATE UNIQUE INDEX lead_score_events_once_per_source_event
  ON lead_score_events (organization_id, lead_id, rule_id, source_event_id)
  WHERE source_event_id IS NOT NULL;

ALTER TABLE lead_score_events
  ADD CONSTRAINT lead_score_events_delta_not_zero CHECK (delta <> 0),
  ADD CONSTRAINT lead_score_events_score_after_range CHECK (score_after >= 0 AND score_after <= 1000),
  ADD CONSTRAINT lead_score_events_reason_present CHECK (length(btrim(reason)) > 0);

-- ── 4. Saved views ─────────────────────────────────────────────────────────
ALTER TABLE saved_views
  ADD CONSTRAINT saved_views_visibility CHECK (visibility IN ('private', 'team', 'organization')),
  -- A team view with no team is a view nobody can see; a private view with no owner is a view
  -- nobody owns. Both are reachable only through a bug, and both are invisible once stored.
  ADD CONSTRAINT saved_views_team_requires_team CHECK (visibility <> 'team' OR team_id IS NOT NULL),
  ADD CONSTRAINT saved_views_private_requires_owner CHECK (
    visibility <> 'private' OR owner_id IS NOT NULL OR is_system
  ),
  ADD CONSTRAINT saved_views_filters_is_object CHECK (jsonb_typeof(filters) = 'object'),
  ADD CONSTRAINT saved_views_columns_is_array CHECK (jsonb_typeof(columns) = 'array'),
  ADD CONSTRAINT saved_views_sort_is_object CHECK (jsonb_typeof(sort) = 'object'),
  ADD CONSTRAINT saved_views_name_present CHECK (length(btrim(name)) > 0);

-- One view per name per owner, and one per name among the views everyone can see. Case-insensitive,
-- because "Hot Leads" and "hot leads" in the same list is a bug report waiting to happen. Partial on
-- `deleted_at`, so a deleted view's name is reusable.
CREATE UNIQUE INDEX saved_views_owner_name_key
  ON saved_views (organization_id, owner_id, entity_type, lower(name))
  WHERE owner_id IS NOT NULL AND deleted_at IS NULL;

CREATE UNIQUE INDEX saved_views_shared_name_key
  ON saved_views (organization_id, entity_type, lower(name))
  WHERE visibility = 'organization' AND deleted_at IS NULL;

-- At most one landing view per role per entity.
CREATE UNIQUE INDEX saved_views_one_default_per_role
  ON saved_views (organization_id, entity_type, default_for_role_id)
  WHERE default_for_role_id IS NOT NULL AND deleted_at IS NULL;

-- ── 5. Indexes for the questions bands and views ask ───────────────────────
-- "Show me the hot leads" is the whole point of `FR-SCR-3`, and it is asked from a dashboard.
CREATE INDEX leads_score_band
  ON leads (organization_id, score_band, created_at DESC)
  WHERE deleted_at IS NULL;

-- The decay sweep's own query: live leads with a score to lose, oldest activity first.
CREATE INDEX leads_decay_candidates
  ON leads (organization_id, last_activity_at)
  WHERE deleted_at IS NULL AND score > 0;
