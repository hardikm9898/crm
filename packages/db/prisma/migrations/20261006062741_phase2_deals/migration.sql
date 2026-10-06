-- Deals, products and line items (`FR-DEAL-1`), Phase 2 step 7.
--
-- `prisma migrate diff` proposed **ten** DROPs at the top of this file — the five lead objects it
-- has proposed dropping in each of the last four migrations, plus the four customer objects added
-- last step and `pipeline_stages_pipeline_scoped_key`. They are hand-written objects that cannot be
-- expressed in `schema.prisma`, so the differ sees them in the database, does not see them in the
-- schema, and proposes removing them. They have been deleted from this file. The list grows with
-- every step, which is exactly why `packages/db/src/schema-objects.int-spec.ts` exists: it is the
-- only guard, and the objects added at the bottom of this file are registered there too.

-- AlterTable
ALTER TABLE "activities" ADD COLUMN     "deal_id" UUID;

-- CreateTable
CREATE TABLE "products" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "sku" TEXT,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "category" TEXT,
    "price_minor" BIGINT NOT NULL DEFAULT 0,
    "currency" CHAR(3),
    "tax_percent" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "unit" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deals" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "lead_id" UUID,
    "customer_id" UUID,
    "branch_id" UUID,
    "team_id" UUID,
    "owner_user_id" UUID,
    "name" TEXT NOT NULL,
    "pipeline_id" UUID NOT NULL,
    "stage_id" UUID NOT NULL,
    "probability" INTEGER NOT NULL DEFAULT 0,
    "value_minor" BIGINT NOT NULL DEFAULT 0,
    "gross_minor" BIGINT NOT NULL DEFAULT 0,
    "discount_minor" BIGINT NOT NULL DEFAULT 0,
    "tax_minor" BIGINT NOT NULL DEFAULT 0,
    "currency" CHAR(3) NOT NULL,
    "expected_close_date" DATE,
    "won_at" TIMESTAMPTZ(6),
    "lost_at" TIMESTAMPTZ(6),
    "lost_reason_id" UUID,
    "lost_note" TEXT,
    "custom_values" JSONB NOT NULL DEFAULT '{}',
    "custom_search_text" TEXT,
    "search_vector" tsvector,
    "last_activity_at" TIMESTAMPTZ(6),
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),
    "deleted_by_id" UUID,

    CONSTRAINT "deals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deal_items" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "deal_id" UUID NOT NULL,
    "product_id" UUID,
    "position" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "quantity" DECIMAL(12,3) NOT NULL,
    "unit" TEXT,
    "unit_price_minor" BIGINT NOT NULL,
    "discount_minor" BIGINT NOT NULL DEFAULT 0,
    "tax_percent" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "gross_minor" BIGINT NOT NULL,
    "net_minor" BIGINT NOT NULL,
    "tax_minor" BIGINT NOT NULL,
    "total_minor" BIGINT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "deal_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "products_organization_id_is_active_name_idx" ON "products"("organization_id", "is_active", "name");

-- CreateIndex
CREATE UNIQUE INDEX "products_organization_id_id_key" ON "products"("organization_id", "id");

-- CreateIndex
CREATE INDEX "deals_organization_id_created_at_idx" ON "deals"("organization_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "deals_organization_id_stage_id_updated_at_idx" ON "deals"("organization_id", "stage_id", "updated_at" DESC);

-- CreateIndex
CREATE INDEX "deals_organization_id_owner_user_id_expected_close_date_idx" ON "deals"("organization_id", "owner_user_id", "expected_close_date");

-- CreateIndex
CREATE INDEX "deals_organization_id_customer_id_idx" ON "deals"("organization_id", "customer_id");

-- CreateIndex
CREATE INDEX "deals_organization_id_lead_id_idx" ON "deals"("organization_id", "lead_id");

-- CreateIndex
CREATE INDEX "deals_organization_id_deleted_at_idx" ON "deals"("organization_id", "deleted_at");

-- CreateIndex
CREATE UNIQUE INDEX "deals_organization_id_id_key" ON "deals"("organization_id", "id");

-- CreateIndex
CREATE INDEX "deal_items_organization_id_deal_id_idx" ON "deal_items"("organization_id", "deal_id");

-- CreateIndex
CREATE INDEX "deal_items_organization_id_product_id_idx" ON "deal_items"("organization_id", "product_id");

-- CreateIndex
CREATE UNIQUE INDEX "deal_items_organization_id_id_key" ON "deal_items"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "deal_items_organization_id_deal_id_position_key" ON "deal_items"("organization_id", "deal_id", "position");

-- CreateIndex
CREATE INDEX "activities_organization_id_deal_id_occurred_at_idx" ON "activities"("organization_id", "deal_id", "occurred_at" DESC);

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deals" ADD CONSTRAINT "deals_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deals" ADD CONSTRAINT "deals_lead_same_org_fk" FOREIGN KEY ("organization_id", "lead_id") REFERENCES "leads"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deals" ADD CONSTRAINT "deals_customer_same_org_fk" FOREIGN KEY ("organization_id", "customer_id") REFERENCES "customers"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deals" ADD CONSTRAINT "deals_branch_same_org_fk" FOREIGN KEY ("organization_id", "branch_id") REFERENCES "branches"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deals" ADD CONSTRAINT "deals_team_same_org_fk" FOREIGN KEY ("organization_id", "team_id") REFERENCES "teams"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deals" ADD CONSTRAINT "deals_owner_same_org_fk" FOREIGN KEY ("organization_id", "owner_user_id") REFERENCES "memberships"("organization_id", "user_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deals" ADD CONSTRAINT "deals_pipeline_same_org_fk" FOREIGN KEY ("organization_id", "pipeline_id") REFERENCES "pipelines"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deals" ADD CONSTRAINT "deals_stage_same_org_fk" FOREIGN KEY ("organization_id", "stage_id") REFERENCES "pipeline_stages"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deals" ADD CONSTRAINT "deals_lost_reason_same_org_fk" FOREIGN KEY ("organization_id", "lost_reason_id") REFERENCES "lost_reasons"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deal_items" ADD CONSTRAINT "deal_items_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deal_items" ADD CONSTRAINT "deal_items_deal_same_org_fk" FOREIGN KEY ("organization_id", "deal_id") REFERENCES "deals"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deal_items" ADD CONSTRAINT "deal_items_product_same_org_fk" FOREIGN KEY ("organization_id", "product_id") REFERENCES "products"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ═══════════════════════════════════════════════════════════════════════════
-- Hand-written objects. Prisma's next diff will propose dropping every one of
-- these; they are covered by packages/db/src/schema-objects.int-spec.ts.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. A deal cannot sit in another pipeline's stage ───────────────────────
-- The same three-column foreign key that `leads` has. No application check can give this
-- guarantee: it makes the state unrepresentable rather than merely refused on the paths somebody
-- remembered to check.
ALTER TABLE deals
  ADD CONSTRAINT deals_stage_in_pipeline_fk
  FOREIGN KEY (organization_id, pipeline_id, stage_id)
  REFERENCES pipeline_stages (organization_id, pipeline_id, id)
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- ── 2. A SKU is unique where it exists ─────────────────────────────────────
-- Partial, because most products in a small business have no SKU at all and a plain unique index
-- would allow exactly one of them.
CREATE UNIQUE INDEX products_sku_key
  ON products (organization_id, sku)
  WHERE sku IS NOT NULL AND deleted_at IS NULL;

-- ── 3. The questions a sales manager actually asks ─────────────────────────
-- "What is closing this month?" — open deals only, which is what makes this cheap. A full index on
-- expected_close_date would also carry every deal ever won or lost.
CREATE INDEX deals_open_close_date
  ON deals (organization_id, expected_close_date)
  WHERE deleted_at IS NULL AND won_at IS NULL AND lost_at IS NULL;

-- "What did we win, and when?" — the revenue report's own index.
CREATE INDEX deals_won
  ON deals (organization_id, won_at DESC)
  WHERE deleted_at IS NULL AND won_at IS NOT NULL;

CREATE INDEX deals_live_created_at
  ON deals (organization_id, created_at DESC)
  WHERE deleted_at IS NULL;

-- ── 4. Search, mirroring leads and customers ───────────────────────────────
-- A deal is searched by its name, the party it is with and its custom values. Maintained by trigger
-- for the same reason as the other two: an import or a raw-SQL writer must not be able to leave a
-- deal unsearchable.
CREATE OR REPLACE FUNCTION deals_search_vector_refresh()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.search_vector :=
      setweight(to_tsvector('simple', coalesce(NEW.name, '')), 'A')
    || setweight(to_tsvector('simple', coalesce(NEW.custom_search_text, '')), 'C');
  RETURN NEW;
END;
$$;

CREATE TRIGGER deals_search_vector_trg
  BEFORE INSERT OR UPDATE OF name, custom_search_text
  ON deals
  FOR EACH ROW
  EXECUTE FUNCTION deals_search_vector_refresh();

CREATE INDEX deals_search_vector_gin ON deals USING GIN (search_vector);
CREATE INDEX deals_custom_values_gin ON deals USING GIN (custom_values jsonb_path_ops);
CREATE INDEX deals_name_trgm ON deals USING GIN (name gin_trgm_ops);

-- ── 5. What a deal may not be ──────────────────────────────────────────────
ALTER TABLE deals
  -- A deal attached to nobody is a figure in a forecast with no party to it.
  ADD CONSTRAINT deals_has_subject CHECK (lead_id IS NOT NULL OR customer_id IS NOT NULL),
  ADD CONSTRAINT deals_name_present CHECK (length(btrim(name)) > 0),
  ADD CONSTRAINT deals_currency_format CHECK (currency ~ '^[A-Z]{3}$'),
  ADD CONSTRAINT deals_probability_range CHECK (probability BETWEEN 0 AND 100),
  -- Money is never negative, and the parts have to add up to the whole. The second is the one that
  -- matters: a header total that disagrees with its own line items is a quotation nobody can defend.
  ADD CONSTRAINT deals_money_non_negative CHECK (
    value_minor >= 0 AND gross_minor >= 0 AND discount_minor >= 0 AND tax_minor >= 0),
  ADD CONSTRAINT deals_totals_add_up CHECK (
    value_minor = gross_minor - discount_minor + tax_minor),
  ADD CONSTRAINT deals_discount_within_gross CHECK (discount_minor <= gross_minor),
  -- Won and lost are mutually exclusive outcomes; being both is how a revenue report and a
  -- loss-reason report end up disagreeing about the same deal.
  ADD CONSTRAINT deals_not_won_and_lost CHECK (won_at IS NULL OR lost_at IS NULL),
  -- A loss reason without a loss, or a loss note without a reason, is an answer to a question
  -- nobody asked.
  ADD CONSTRAINT deals_lost_reason_needs_loss CHECK (lost_reason_id IS NULL OR lost_at IS NOT NULL),
  ADD CONSTRAINT deals_lost_note_needs_loss CHECK (lost_note IS NULL OR lost_at IS NOT NULL);

ALTER TABLE deal_items
  ADD CONSTRAINT deal_items_name_present CHECK (length(btrim(name)) > 0),
  ADD CONSTRAINT deal_items_position_positive CHECK (position >= 1),
  ADD CONSTRAINT deal_items_quantity_positive CHECK (quantity > 0),
  ADD CONSTRAINT deal_items_tax_percent_range CHECK (tax_percent BETWEEN 0 AND 100),
  ADD CONSTRAINT deal_items_money_non_negative CHECK (
    unit_price_minor >= 0 AND discount_minor >= 0 AND gross_minor >= 0
    AND net_minor >= 0 AND tax_minor >= 0 AND total_minor >= 0),
  -- The line's own arithmetic, enforced rather than trusted. `lineTotals()` in `@leados/shared` is
  -- the one implementation, and this is what catches a second one appearing.
  ADD CONSTRAINT deal_items_net_is_gross_less_discount CHECK (net_minor = gross_minor - discount_minor),
  ADD CONSTRAINT deal_items_total_is_net_plus_tax CHECK (total_minor = net_minor + tax_minor),
  ADD CONSTRAINT deal_items_discount_within_gross CHECK (discount_minor <= gross_minor);

ALTER TABLE products
  ADD CONSTRAINT products_name_present CHECK (length(btrim(name)) > 0),
  ADD CONSTRAINT products_price_non_negative CHECK (price_minor >= 0),
  ADD CONSTRAINT products_tax_percent_range CHECK (tax_percent BETWEEN 0 AND 100),
  ADD CONSTRAINT products_currency_format CHECK (currency IS NULL OR currency ~ '^[A-Z]{3}$');
