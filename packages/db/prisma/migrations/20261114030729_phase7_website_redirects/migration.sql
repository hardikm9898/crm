-- Prisma's own diff proposed fifteen DROPs above this line: two composite FKs, six GIN indexes,
-- five trigram indexes, a partial index and a partial unique. Every one of them is
-- a hand-written object earlier migrations added, which `migrate diff` sees in the database, cannot
-- see in schema.prisma, and therefore drops. They have been removed. Read the generated SQL of the
-- next migration too: the count grows with every hand-written object, and
-- packages/db/src/schema-objects.int-spec.ts is the only thing that catches the ones you miss.
-- Only the `-- DropForeignKey` and `-- DropIndex` sections were cut; Prisma puts
-- `-- AlterTable ... ADD COLUMN` in the same region and once took two of those with it.

-- CreateTable
CREATE TABLE "website_redirects" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "website_id" UUID NOT NULL,
    "from_path" TEXT NOT NULL,
    "to_path" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'permanent',
    "note" TEXT,
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "website_redirects_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "website_redirects_organization_id_created_by_id_idx" ON "website_redirects"("organization_id", "created_by_id");

-- CreateIndex
CREATE UNIQUE INDEX "website_redirects_organization_id_id_key" ON "website_redirects"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "website_redirects_organization_id_website_id_from_path_key" ON "website_redirects"("organization_id", "website_id", "from_path");

-- AddForeignKey
ALTER TABLE "website_redirects" ADD CONSTRAINT "website_redirects_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "website_redirects" ADD CONSTRAINT "website_redirects_website_same_org_fk" FOREIGN KEY ("organization_id", "website_id") REFERENCES "websites"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "website_redirects" ADD CONSTRAINT "website_redirects_creator_same_org_fk" FOREIGN KEY ("organization_id", "created_by_id") REFERENCES "memberships"("organization_id", "user_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Hand-written objects. Prisma cannot express any of these, and its next diff will propose
-- dropping all of them: that is what the note at the top of this file is about. Each one is
-- registered in packages/db/src/schema-objects.int-spec.ts, which is the only guard.
-- ---------------------------------------------------------------------------

-- The same shape website_pages_path_is_a_path enforces, character for character, and it has to be:
-- the renderer looks a request's path up as a page, fails, and then looks the same string up here.
-- Two regexes that drifted would make an address that cannot be a page but can be a redirect -
-- a redirect that is unreachable by construction, which looks exactly like one that does not work.
-- Shape as a regex and length as a length() test, because Postgres refuses a repetition count
-- above 255 and the combined form installs happily then fails every insert.
ALTER TABLE "website_redirects" ADD CONSTRAINT "website_redirects_from_is_a_path" CHECK (
  "from_path" = '/'
  OR ("from_path" ~ '^/[a-z0-9]([a-z0-9-]*[a-z0-9])?(/[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$' AND length("from_path") <= 512)
);

-- A redirect to itself is an infinite loop a browser reports as ERR_TOO_MANY_REDIRECTS. The
-- service also collapses chains so that no `to_path` is ever another row's `from_path`, which is
-- what makes a *multi-row* loop unrepresentable; this CHECK is the single-row case, and it is here
-- rather than only in the service because it is expressible, and a rule the database can hold is
-- one no future caller can get wrong.
ALTER TABLE "website_redirects" ADD CONSTRAINT "website_redirects_not_to_self" CHECK (
  "from_path" <> "to_path"
);

-- Two statuses, so a CHECK rather than a CASE. This is a protocol fact (308 against 307), not a
-- tenant catalogue: rule 4 is about a workspace's own vocabulary - its statuses, sources and task
-- types - and the set of HTTP redirect semantics is not something a tenant adds a row to.
ALTER TABLE "website_redirects" ADD CONSTRAINT "website_redirects_kind_is_known" CHECK (
  "kind" IN ('permanent', 'temporary')
);

-- A destination is a path on this site or a full http(s) address. Deliberately looser than the
-- from_path shape: a destination may carry a query string (a campaign link) and may be another
-- domain entirely, because moving a business to a new address is one of the two things a redirect
-- exists for. What it may not be is a scheme that executes - the `javascript:` case - or a
-- protocol-relative `//evil.example`, which a browser resolves against the current scheme and
-- which is therefore an off-site redirect that does not look like one.
ALTER TABLE "website_redirects" ADD CONSTRAINT "website_redirects_to_is_a_destination" CHECK (
  ("to_path" ~ '^/[^/]' OR "to_path" = '/' OR "to_path" ~ '^https?://[^/]')
  AND length("to_path") <= 1024
);
