-- Customers and conversion (`FR-DEAL-4`), Phase 2 step 6.
--
-- `prisma migrate diff` proposed six DROPs at the top of this file, for the fourth migration in a
-- row: `leads_stage_in_pipeline_fk`, `pipeline_stages_pipeline_scoped_key` and four GIN/trigram
-- indexes. They are hand-written objects that cannot be expressed in `schema.prisma`, so the differ
-- sees them in the database, does not see them in the schema, and proposes dropping them. They have
-- been deleted from this file. `packages/db/src/schema-objects.int-spec.ts` is the only guard that
-- catches this, and the objects added at the bottom of this file are registered there too.

-- AlterTable
ALTER TABLE "activities" ADD COLUMN     "customer_id" UUID;

-- CreateTable
CREATE TABLE "customers" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "lead_id" UUID,
    "converted_at" TIMESTAMPTZ(6),
    "branch_id" UUID,
    "team_id" UUID,
    "owner_user_id" UUID,
    "first_name" TEXT,
    "last_name" TEXT,
    "full_name" TEXT NOT NULL,
    "company" TEXT,
    "job_title" TEXT,
    "phone_e164" TEXT,
    "phone_raw" TEXT,
    "whatsapp_e164" TEXT,
    "email" TEXT,
    "timezone" TEXT,
    "billing_line1" TEXT,
    "billing_line2" TEXT,
    "city" TEXT,
    "state" TEXT,
    "country" CHAR(2),
    "postal_code" TEXT,
    "tax_id" TEXT,
    "custom_values" JSONB NOT NULL DEFAULT '{}',
    "custom_search_text" TEXT,
    "search_vector" tsvector,
    "consent_whatsapp" BOOLEAN NOT NULL DEFAULT false,
    "consent_email" BOOLEAN NOT NULL DEFAULT false,
    "consent_calls" BOOLEAN NOT NULL DEFAULT false,
    "last_activity_at" TIMESTAMPTZ(6),
    "merged_into_id" UUID,
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),
    "deleted_by_id" UUID,

    CONSTRAINT "customers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "customers_organization_id_created_at_idx" ON "customers"("organization_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "customers_organization_id_owner_user_id_created_at_idx" ON "customers"("organization_id", "owner_user_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "customers_organization_id_phone_e164_idx" ON "customers"("organization_id", "phone_e164");

-- CreateIndex
CREATE INDEX "customers_organization_id_email_idx" ON "customers"("organization_id", "email");

-- CreateIndex
CREATE INDEX "customers_organization_id_last_activity_at_idx" ON "customers"("organization_id", "last_activity_at");

-- CreateIndex
CREATE INDEX "customers_organization_id_deleted_at_idx" ON "customers"("organization_id", "deleted_at");

-- CreateIndex
CREATE UNIQUE INDEX "customers_organization_id_id_key" ON "customers"("organization_id", "id");

-- CreateIndex
CREATE INDEX "activities_organization_id_customer_id_occurred_at_idx" ON "activities"("organization_id", "customer_id", "occurred_at" DESC);

-- AddForeignKey
ALTER TABLE "customers" ADD CONSTRAINT "customers_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customers" ADD CONSTRAINT "customers_lead_same_org_fk" FOREIGN KEY ("organization_id", "lead_id") REFERENCES "leads"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customers" ADD CONSTRAINT "customers_branch_same_org_fk" FOREIGN KEY ("organization_id", "branch_id") REFERENCES "branches"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customers" ADD CONSTRAINT "customers_team_same_org_fk" FOREIGN KEY ("organization_id", "team_id") REFERENCES "teams"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customers" ADD CONSTRAINT "customers_owner_same_org_fk" FOREIGN KEY ("organization_id", "owner_user_id") REFERENCES "memberships"("organization_id", "user_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customers" ADD CONSTRAINT "customers_merged_into_same_org_fk" FOREIGN KEY ("organization_id", "merged_into_id") REFERENCES "customers"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ═══════════════════════════════════════════════════════════════════════════
-- Hand-written objects. Prisma's next diff will propose dropping every one of
-- these; they are covered by packages/db/src/schema-objects.int-spec.ts.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. A lead converts at most once ────────────────────────────────────────
-- Partial, because `lead_id` is null for a customer who was never a lead and a plain unique index
-- would then allow exactly one of those. This is what makes `POST /leads/:id/convert` idempotent at
-- the database level rather than only in the service: two clicks, or a retry, cannot produce two
-- customers for one lead.
CREATE UNIQUE INDEX customers_lead_unique
  ON customers (organization_id, lead_id)
  WHERE lead_id IS NOT NULL;

-- ── 2. The referencing side of the self-FK ─────────────────────────────────
-- Postgres indexes the referenced side of a foreign key, never the referencing side, so without
-- this every customer deletion would scan the whole table to check `merged_into_id`. The same
-- omission made lead deletion quadratic on the 100 k fixture.
CREATE INDEX customers_merged_into
  ON customers (organization_id, merged_into_id)
  WHERE merged_into_id IS NOT NULL;

-- ── 3. Search, mirroring leads exactly ─────────────────────────────────────
-- Maintained by trigger rather than by the application: an import or a future raw-SQL writer must
-- not be able to leave a customer unsearchable. The weights and the digits-only phone handling are
-- the same as `leads_search_vector_refresh`, so one search box can rank both tables consistently.
CREATE OR REPLACE FUNCTION customers_search_vector_refresh()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.search_vector :=
      setweight(to_tsvector('simple', coalesce(NEW.full_name, '')), 'A')
    || setweight(to_tsvector('simple', coalesce(NEW.company, '')), 'B')
    || setweight(to_tsvector('simple', regexp_replace(coalesce(NEW.phone_e164, ''), '\D', '', 'g')), 'A')
    || setweight(to_tsvector('simple', regexp_replace(coalesce(NEW.phone_raw, ''), '\D', '', 'g')), 'B')
    || setweight(to_tsvector('simple', coalesce(NEW.email, '')), 'A')
    || setweight(to_tsvector('simple', coalesce(NEW.city, '')), 'C')
    || setweight(to_tsvector('simple', coalesce(NEW.tax_id, '')), 'B')
    || setweight(to_tsvector('simple', coalesce(NEW.custom_search_text, '')), 'C');
  RETURN NEW;
END;
$$;

CREATE TRIGGER customers_search_vector_trg
  BEFORE INSERT OR UPDATE OF full_name, company, phone_e164, phone_raw, email, city, tax_id, custom_search_text
  ON customers
  FOR EACH ROW
  EXECUTE FUNCTION customers_search_vector_refresh();

CREATE INDEX customers_search_vector_gin ON customers USING GIN (search_vector);

-- jsonb_path_ops for the same reason as on leads: it indexes paths-with-values, which is what a
-- custom-field filter asks, and is materially smaller than the default.
CREATE INDEX customers_custom_values_gin ON customers USING GIN (custom_values jsonb_path_ops);

CREATE INDEX customers_phone_e164_trgm ON customers USING GIN (phone_e164 gin_trgm_ops);
CREATE INDEX customers_full_name_trgm ON customers USING GIN (full_name gin_trgm_ops);
CREATE INDEX customers_email_trgm ON customers USING GIN (lower(email) gin_trgm_ops);

-- ── 4. The live list skips deleted rows; Prisma's indexes do not ───────────
CREATE INDEX customers_live_created_at
  ON customers (organization_id, created_at DESC)
  WHERE deleted_at IS NULL;

-- ── 5. What a customer may not be ──────────────────────────────────────────
ALTER TABLE customers
  -- A record with no name is a record nobody can find again. `full_name` is derived from whatever
  -- identity the caller gave, so an empty one means the caller gave none.
  ADD CONSTRAINT customers_name_present CHECK (length(btrim(full_name)) > 0),
  -- ISO 3166-1 alpha-2, uppercase. CHAR(2) alone would accept 'xx' and '  '.
  ADD CONSTRAINT customers_country_code CHECK (country IS NULL OR country ~ '^[A-Z]{2}$'),
  -- Long enough for any national tax identifier, short enough that the column is not a notes field.
  ADD CONSTRAINT customers_tax_id_length CHECK (tax_id IS NULL OR length(btrim(tax_id)) BETWEEN 4 AND 40),
  -- A customer absorbed into itself would make the merge pointer a cycle of length one, and every
  -- traversal of it an infinite loop.
  ADD CONSTRAINT customers_not_merged_into_self CHECK (merged_into_id IS NULL OR merged_into_id <> id),
  -- A customer converted from a lead has a conversion date, and one entered directly does not have
  -- a conversion date without a lead to have converted from.
  ADD CONSTRAINT customers_converted_has_lead CHECK ((lead_id IS NULL) = (converted_at IS NULL));
