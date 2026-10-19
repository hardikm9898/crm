-- Phase 4, step 6 — `inbound_payloads.integration_connection_id`.
--
-- §8 of `database-design.md` has specified this column since Phase 0. Step 6 is the step that has
-- something to put in it: a payload that arrived through a connection rather than through a key,
-- where "which integration sent this" is the first question anybody asks about the lead.
--
-- Its own migration rather than an edit to the one applied five minutes earlier, because editing an
-- applied migration breaks its stored checksum and demands a reset — the trap the quotation
-- constraint paid for.
--
-- Prisma's diff again carried the fifteen spurious drops; only the two statements below are kept.
-- A composite FK on a **partitioned** table is attached to the parent and inherited by every
-- partition, which is why the index behind it is the one `inbound_payloads` already has.

-- AlterTable
ALTER TABLE "inbound_payloads" ADD COLUMN "integration_connection_id" UUID;

-- AddForeignKey
ALTER TABLE "inbound_payloads" ADD CONSTRAINT "inbound_payloads_connection_same_org_fk" FOREIGN KEY ("organization_id", "integration_connection_id") REFERENCES "integration_connections"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- The referencing side of the new FK, which Postgres does not index for us: a connection being
-- disconnected (RESTRICT) would otherwise scan every partition of this table.
CREATE INDEX "inbound_payloads_connection" ON "inbound_payloads" ("organization_id", "integration_connection_id")
  WHERE "integration_connection_id" IS NOT NULL;
