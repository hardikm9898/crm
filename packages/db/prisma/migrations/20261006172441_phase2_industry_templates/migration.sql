-- Phase 2 step 10 — industry templates as platform reference data.
--
-- FOURTEEN `DROP`s WERE DELETED FROM THE TOP OF THIS FILE — the same fourteen as the last two
-- migrations: the two three-column stage FKs and the twelve GIN, trigram and partial indexes on
-- `leads`, `customers`, `deals` and `pipeline_stages`. Remove the `DropForeignKey` and `DropIndex`
-- sections only: Prisma puts its `AlterTable … ADD COLUMN` in this same region, and cutting the
-- whole region is what made the payments migration fail on a column that did not exist.
-- `packages/db/src/schema-objects.int-spec.ts` is the guard for the rest.

-- AlterTable
ALTER TABLE "organizations" ADD COLUMN     "industry_template_key" TEXT;

-- CreateTable
CREATE TABLE "industry_templates" (
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "definition" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "industry_templates_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE INDEX "industry_templates_is_active_sort_order_idx" ON "industry_templates"("is_active", "sort_order");

-- AddForeignKey
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_industry_template_key_fkey" FOREIGN KEY ("industry_template_key") REFERENCES "industry_templates"("key") ON DELETE SET NULL ON UPDATE CASCADE;

-- ──────────────────────────────────────────────────────────────────────────────
-- Hand-written objects. Prisma's next diff will propose dropping these; they are
-- asserted present by packages/db/src/schema-objects.int-spec.ts.
-- ──────────────────────────────────────────────────────────────────────────────

ALTER TABLE "industry_templates"
  ADD CONSTRAINT industry_templates_key_format CHECK (key ~ '^[a-z][a-z0-9_]*$'),
  ADD CONSTRAINT industry_templates_name_present CHECK (length(btrim(name)) > 0),
  -- A picker whose entries have no sentence of description is a picker nobody can
  -- choose from, so the description is not merely NOT NULL.
  ADD CONSTRAINT industry_templates_description_present CHECK (length(btrim(description)) > 20),
  -- `definition` carries the statuses, stages, sources, lost reasons, tags, custom
  -- fields and views. An array or a string here would be a template the seeder
  -- cannot read, discovered at the moment a new workspace applies it.
  ADD CONSTRAINT industry_templates_definition_is_object
    CHECK (jsonb_typeof(definition) = 'object');
