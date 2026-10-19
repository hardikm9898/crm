-- ═══════════════════════════════════════════════════════════════════════════
-- Phase 4, step 7 — `provider_events`, the inbound idempotency ledger.
--
-- One table, and the thing that makes it worth having is the unique:
-- `(organization_id, provider, external_event_id)`. Meta retries a delivery it did not get a 200
-- for, so "a duplicate webhook delivery produces exactly one lead" is a constraint rather than a
-- hope — and because this table is **not partitioned**, that unique is a genuine point read. The
-- same unique on `inbound_payloads` has to contain the partition key, which makes it a race guard
-- that would allow the same id again next month; that is exactly why both tables exist.
--
-- Prisma generated this with 15 spurious `DROP`s at the top — every composite FK, GIN, trigram and
-- partial index the earlier migrations added by hand, which `migrate diff` sees in the database,
-- cannot see in `schema.prisma`, and therefore drops. They have been removed. Only the
-- `-- DropForeignKey` and `-- DropIndex` sections: the `AlterTable … ADD COLUMN` statements live in
-- the same region, and cutting "everything before the first CreateTable" has deleted those before.
-- `packages/db/src/schema-objects.int-spec.ts` is the only guard against the ones somebody misses.
-- ═══════════════════════════════════════════════════════════════════════════

-- CreateEnum
CREATE TYPE "provider_event_status" AS ENUM ('received', 'processed', 'duplicate', 'failed');

-- CreateTable
CREATE TABLE "provider_events" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "connection_id" UUID,
    "external_event_id" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "raw" JSONB NOT NULL DEFAULT '{}',
    "status" "provider_event_status" NOT NULL DEFAULT 'received',
    "lead_id" UUID,
    "error" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "received_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMPTZ(6),

    CONSTRAINT "provider_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "provider_events_organization_id_status_received_at_idx" ON "provider_events"("organization_id", "status", "received_at" DESC);

-- CreateIndex
CREATE INDEX "provider_events_organization_id_connection_id_received_at_idx" ON "provider_events"("organization_id", "connection_id", "received_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "provider_events_organization_id_id_key" ON "provider_events"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "provider_events_organization_id_provider_external_event_id_key" ON "provider_events"("organization_id", "provider", "external_event_id");

-- AddForeignKey
ALTER TABLE "provider_events" ADD CONSTRAINT "provider_events_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "provider_events" ADD CONSTRAINT "provider_events_connection_same_org_fk" FOREIGN KEY ("organization_id", "connection_id") REFERENCES "integration_connections"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ── Hand-written objects Prisma cannot express ────────────────────────────

-- The work queue a retry reads: events that have not become leads, newest first. Partial, so it
-- stays small however many deliveries succeed — the shape `form_submissions_unresolved` already has.
CREATE INDEX "provider_events_unresolved" ON "provider_events" ("organization_id", "received_at" DESC)
  WHERE status IN ('received', 'failed');

-- ── CHECK constraints ─────────────────────────────────────────────────────

-- A provider key is a registry key, not prose: the same shape `integration_connections.provider`
-- is held to, because the two columns carry the same vocabulary and a join between them has to mean
-- something.
ALTER TABLE "provider_events" ADD CONSTRAINT "provider_events_provider_is_a_key"
  CHECK (provider ~ '^[a-z][a-z0-9_]{1,40}$');

-- An external id is what the unique is built on, so an empty one would make every event from a
-- provider that forgot to send one collide with the first.
ALTER TABLE "provider_events" ADD CONSTRAINT "provider_events_external_id_present"
  CHECK (length(external_event_id) BETWEEN 1 AND 200);

-- Written as a CASE in the one direction that is a contradiction, for the reason the payments pair
-- and `webhook_deliveries_pending_is_untried` paid for: an event that became a lead has been
-- processed and carries the instant it was. The mirror ("anything processed produced a lead") reads
-- just as sensibly and is **false** — a delivery whose payload we accepted and whose lead the
-- duplicate rules attached to an existing one is honestly `processed` with no lead of its own.
ALTER TABLE "provider_events" ADD CONSTRAINT "provider_events_lead_was_processed"
  CHECK (
    CASE
      WHEN lead_id IS NOT NULL THEN status = 'processed' AND processed_at IS NOT NULL
      ELSE true
    END
  );

-- `received` means nothing has been tried yet, which a non-zero attempt count contradicts. Again
-- one direction only: an event abandoned as `failed` having never been attempted is representable
-- on purpose, because a connection switched off between the delivery and the attempt is a real
-- state and the first version of the webhook constraint made exactly that unrepresentable.
ALTER TABLE "provider_events" ADD CONSTRAINT "provider_events_received_is_untried"
  CHECK (
    CASE
      WHEN status = 'received' THEN attempts = 0
      ELSE true
    END
  );

ALTER TABLE "provider_events" ADD CONSTRAINT "provider_events_raw_is_an_object"
  CHECK (jsonb_typeof(raw) = 'object');
