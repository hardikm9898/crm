-- Phase 7 step 1 - websites, their pages and their published versions (FR-WEB-1..FR-WEB-6).
--
-- The 15 statements Prisma generated above this line were deleted by hand, as every migration in
-- this repository since Phase 2 step 2 has had to delete them: two composite foreign keys
-- (deals_stage_in_pipeline_fk, leads_stage_in_pipeline_fk - the guarantee that makes "a row in
-- another pipeline's stage" unrepresentable), four GIN indexes, four trigram indexes, a partial
-- index and a partial unique. "prisma migrate diff" sees them in the database, cannot see them in
-- schema.prisma, and proposes dropping them. Applying that once already cost lead search its
-- indexes with every test still green. packages/db/src/schema-objects.int-spec.ts is what catches
-- the ones that get missed.

-- CreateTable
CREATE TABLE "websites" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "template_code" TEXT,
    "subdomain" TEXT NOT NULL,
    "theme" JSONB NOT NULL DEFAULT '{}',
    "seo_defaults" JSONB NOT NULL DEFAULT '{}',
    "status" TEXT NOT NULL DEFAULT 'draft',
    "published_version_id" UUID,
    "created_by_id" UUID NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "websites_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "website_pages" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "website_id" UUID NOT NULL,
    "path" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "blocks" JSONB NOT NULL DEFAULT '[]',
    "seo" JSONB NOT NULL DEFAULT '{}',
    "is_home" BOOLEAN NOT NULL DEFAULT false,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "website_pages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "website_versions" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "website_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "snapshot" JSONB NOT NULL,
    "published_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "published_by_id" UUID,
    "restored_from_version_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "website_versions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "websites_subdomain_key" ON "websites"("subdomain");

-- CreateIndex
CREATE INDEX "websites_organization_id_status_updated_at_idx" ON "websites"("organization_id", "status", "updated_at" DESC);

-- CreateIndex
CREATE INDEX "websites_organization_id_created_by_id_idx" ON "websites"("organization_id", "created_by_id");

-- CreateIndex
CREATE UNIQUE INDEX "websites_organization_id_id_key" ON "websites"("organization_id", "id");

-- CreateIndex
CREATE INDEX "website_pages_organization_id_website_id_sort_order_idx" ON "website_pages"("organization_id", "website_id", "sort_order");

-- CreateIndex
CREATE UNIQUE INDEX "website_pages_organization_id_id_key" ON "website_pages"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "website_pages_organization_id_website_id_path_key" ON "website_pages"("organization_id", "website_id", "path");

-- CreateIndex
CREATE INDEX "website_versions_organization_id_website_id_version_idx" ON "website_versions"("organization_id", "website_id", "version" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "website_versions_organization_id_id_key" ON "website_versions"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "website_versions_organization_id_website_id_version_key" ON "website_versions"("organization_id", "website_id", "version");

-- AddForeignKey
ALTER TABLE "websites" ADD CONSTRAINT "websites_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "websites" ADD CONSTRAINT "websites_creator_same_org_fk" FOREIGN KEY ("organization_id", "created_by_id") REFERENCES "memberships"("organization_id", "user_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "websites" ADD CONSTRAINT "websites_published_version_same_org_fk" FOREIGN KEY ("organization_id", "published_version_id") REFERENCES "website_versions"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "website_pages" ADD CONSTRAINT "website_pages_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "website_pages" ADD CONSTRAINT "website_pages_website_same_org_fk" FOREIGN KEY ("organization_id", "website_id") REFERENCES "websites"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "website_versions" ADD CONSTRAINT "website_versions_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "website_versions" ADD CONSTRAINT "website_versions_website_same_org_fk" FOREIGN KEY ("organization_id", "website_id") REFERENCES "websites"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "website_versions" ADD CONSTRAINT "website_versions_publisher_same_org_fk" FOREIGN KEY ("organization_id", "published_by_id") REFERENCES "memberships"("organization_id", "user_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "website_versions" ADD CONSTRAINT "website_versions_restored_from_same_org_fk" FOREIGN KEY ("organization_id", "restored_from_version_id") REFERENCES "website_versions"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Hand-written objects. Prisma cannot express any of these, which means its next
-- migrate diff will propose dropping them: every one is listed in
-- packages/db/src/schema-objects.int-spec.ts, which is the only thing that notices.
-- ---------------------------------------------------------------------------

-- The shape as a regex and the length as a length() test, not one regex doing both: Postgres
-- refuses a regex repetition count above 255, and a CHECK written name ~ '^...{3,512}$' installs
-- happily and then fails every insert. The reserved-name list is deliberately NOT here - that is
-- policy, it changes without a migration, and the service refuses it with a sentence somebody can
-- act on. This constraint is about shape only.
ALTER TABLE "websites" ADD CONSTRAINT "websites_subdomain_is_an_address" CHECK (
  "subdomain" ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?$' AND length("subdomain") BETWEEN 3 AND 63
);

-- One way, not a biconditional. "A published site has a version it is serving" is a contradiction
-- to violate. Its mirror - "a draft has no published version" - reads just as sensibly and is
-- false: unpublishing a site that was live keeps the pointer so republishing is one write, and the
-- payments pair that together made a refund impossible is why this file no longer writes the
-- symmetrical-sounding version.
ALTER TABLE "websites" ADD CONSTRAINT "websites_published_has_version" CHECK (
  "status" <> 'published' OR "published_version_id" IS NOT NULL
);

-- The same guarantee api_logs_path_is_a_path gives: a path is a location, so a query string is not
-- part of it, and "something other than normalizePagePath wrote this row" is unrepresentable rather
-- than merely unlikely. The regex is character-for-character the one in
-- packages/shared/src/websites.ts; a CHECK that says what belongs in a table while the service
-- writes something else is a 500 nobody sees until the path runs.
ALTER TABLE "website_pages" ADD CONSTRAINT "website_pages_path_is_a_path" CHECK (
  "path" = '/'
  OR ("path" ~ '^/[a-z0-9]([a-z0-9-]*[a-z0-9])?(/[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$' AND length("path") <= 512)
);

-- At most one home page per site. A plain unique on (organization_id, website_id, is_home) reads
-- identically in review and allows one home page AND one non-home page per site, which is the
-- opposite of the rule - the mistake integration_connections_live_provider already paid for once.
CREATE UNIQUE INDEX "website_pages_one_home" ON "website_pages" ("organization_id", "website_id")
  WHERE "is_home";

-- A version number is a counter, not an id.
ALTER TABLE "website_versions" ADD CONSTRAINT "website_versions_number_positive" CHECK ("version" >= 1);

-- A rollback names the version whose snapshot it carries, and that can never be itself: a version
-- restored from itself would make the history unreadable while looking like an ordinary row.
ALTER TABLE "website_versions" ADD CONSTRAINT "website_versions_not_restored_from_self" CHECK (
  "restored_from_version_id" IS NULL OR "restored_from_version_id" <> "id"
);

-- Postgres indexes the referenced side of a foreign key and never the referencing side, so each of
-- these three nullable FK columns would otherwise make a delete of its parent scan the whole table.
-- Partial, because the rows that matter are the few where the column is set.
CREATE INDEX "websites_published_version" ON "websites" ("organization_id", "published_version_id")
  WHERE "published_version_id" IS NOT NULL;
CREATE INDEX "website_versions_publisher" ON "website_versions" ("organization_id", "published_by_id")
  WHERE "published_by_id" IS NOT NULL;
CREATE INDEX "website_versions_restored_from" ON "website_versions" ("organization_id", "restored_from_version_id")
  WHERE "restored_from_version_id" IS NOT NULL;

-- A version row is written once and never again. This is a trigger rather than a convention for
-- the reason the composite foreign keys are constraints rather than application checks: "rollback
-- restores the previous version exactly" is only true while nothing can edit a snapshot, and a
-- service method that does not update one today is not the same promise as an update that cannot
-- happen. There is no legitimate UPDATE on this table - a rollback writes a NEW row - so the
-- trigger refuses all of them rather than guarding particular columns, which would need extending
-- every time the table gains one.
CREATE OR REPLACE FUNCTION "website_versions_refuse_update"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION
    'website_versions_are_immutable: version % of website % was already published and cannot be changed; a rollback writes a new version',
    OLD."version", OLD."website_id";
  -- Deliberately the default SQLSTATE (P0001) and not a tidier-sounding one. Raising this with
  -- ERRCODE = 'restrict_violation' makes Prisma classify it as a foreign-key violation and report
  -- "Foreign key constraint violated on the (not available)" *instead of* the sentence above: the
  -- explanation is replaced by something unrelated and wrong, which is the recordFailure defect in
  -- a new place. Found by the test that asserts the message rather than the failure.
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "website_versions_are_immutable"
  BEFORE UPDATE ON "website_versions"
  FOR EACH ROW EXECUTE FUNCTION "website_versions_refuse_update"();
