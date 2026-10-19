-- Phase 4, step 6 — the integration framework: `integration_connections` (the credential vault),
-- `sync_cursors` and `integration_health_checks`.
--
-- Prisma's diff arrived with the same **fifteen** spurious statements as the last three migrations:
-- the two three-column composite FKs on `leads` and `deals`, and thirteen GIN, trigram and partial
-- indexes earlier migrations added by hand. Removed, and only the `-- DropForeignKey` and
-- `-- DropIndex` sections, because Prisma puts `ADD COLUMN` in the same region.
--
-- What Prisma cannot express here, and will propose dropping on its next diff: the partial unique
-- index that allows one **live** connection per provider, and every CHECK at the bottom.

-- CreateEnum
CREATE TYPE "integration_status" AS ENUM ('connected', 'degraded', 'error', 'revoked');

-- CreateTable
CREATE TABLE "integration_connections" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "external_account_id" TEXT,
    "credentials_encrypted" TEXT NOT NULL,
    "key_version" INTEGER NOT NULL DEFAULT 1,
    "scopes" TEXT[],
    "settings" JSONB NOT NULL DEFAULT '{}',
    "field_mappings" JSONB NOT NULL DEFAULT '[]',
    "status" "integration_status" NOT NULL DEFAULT 'connected',
    "last_success_at" TIMESTAMPTZ(6),
    "last_error_at" TIMESTAMPTZ(6),
    "last_error" TEXT,
    "expires_at" TIMESTAMPTZ(6),
    "connected_by_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "disconnected_at" TIMESTAMPTZ(6),

    CONSTRAINT "integration_connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sync_cursors" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "connection_id" UUID NOT NULL,
    "resource" TEXT NOT NULL,
    "cursor" TEXT,
    "state" JSONB NOT NULL DEFAULT '{}',
    "last_synced_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "sync_cursors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "integration_health_checks" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "connection_id" UUID NOT NULL,
    "outcome" TEXT NOT NULL,
    "latency_ms" INTEGER,
    "detail" JSONB NOT NULL DEFAULT '{}',
    "checked_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "integration_health_checks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "integration_connections_organization_id_provider_idx" ON "integration_connections"("organization_id", "provider");

-- CreateIndex
CREATE INDEX "integration_connections_organization_id_status_idx" ON "integration_connections"("organization_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "integration_connections_organization_id_id_key" ON "integration_connections"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "sync_cursors_organization_id_id_key" ON "sync_cursors"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "sync_cursors_organization_id_connection_id_resource_key" ON "sync_cursors"("organization_id", "connection_id", "resource");

-- CreateIndex
CREATE INDEX "integration_health_checks_organization_id_connection_id_che_idx" ON "integration_health_checks"("organization_id", "connection_id", "checked_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "integration_health_checks_organization_id_id_key" ON "integration_health_checks"("organization_id", "id");

-- AddForeignKey
ALTER TABLE "integration_connections" ADD CONSTRAINT "integration_connections_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "integration_connections" ADD CONSTRAINT "integration_connections_connector_same_org_fk" FOREIGN KEY ("organization_id", "connected_by_id") REFERENCES "memberships"("organization_id", "user_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sync_cursors" ADD CONSTRAINT "sync_cursors_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sync_cursors" ADD CONSTRAINT "sync_cursors_connection_same_org_fk" FOREIGN KEY ("organization_id", "connection_id") REFERENCES "integration_connections"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "integration_health_checks" ADD CONSTRAINT "integration_health_checks_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "integration_health_checks" ADD CONSTRAINT "integration_health_checks_connection_same_org_fk" FOREIGN KEY ("organization_id", "connection_id") REFERENCES "integration_connections"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
-- ── Hand-written objects ──────────────────────────────────────────────────

-- One **live** connection per provider per workspace. Partial, because a disconnected connection is
-- history that `inbound_payloads` and `email_messages` still reference — and a plain `@@unique`
-- would mean a workspace that disconnected Postmark could never connect it again.
CREATE UNIQUE INDEX "integration_connections_live_provider"
  ON "integration_connections" ("organization_id", "provider")
  WHERE "disconnected_at" IS NULL;

-- The probe sweep reads across every tenant, so its index cannot be prefixed by `organization_id`:
-- the same reason `calls_awaiting_outcome` and `webhook_deliveries_due` are keyed the way they are.
CREATE INDEX "integration_connections_live"
  ON "integration_connections" ("status", "updated_at")
  WHERE "disconnected_at" IS NULL;

-- ── CHECK constraints ─────────────────────────────────────────────────────

-- The vault holds an `EncryptionService` envelope, never a plaintext credential. The obvious
-- mistake is storing the token as the provider gave it, and ADR-0030 paid for noticing it late:
-- this refuses anything that is not an envelope, and anything that still looks like a Postmark
-- server token or one of our own `sk_`/`whsec_` secrets.
ALTER TABLE "integration_connections" ADD CONSTRAINT "integration_connections_credentials_encrypted"
  CHECK (
    credentials_encrypted LIKE 'v1.%'
    AND credentials_encrypted NOT LIKE 'sk_%'
    AND credentials_encrypted NOT LIKE 'whsec_%'
  );

ALTER TABLE "integration_connections" ADD CONSTRAINT "integration_connections_key_version_positive"
  CHECK (key_version >= 1);

-- A provider key is a registry key, not prose: lower-case, underscore-separated, bounded.
ALTER TABLE "integration_connections" ADD CONSTRAINT "integration_connections_provider_is_a_key"
  CHECK (provider ~ '^[a-z][a-z0-9_]{1,40}$');

-- Written as a CASE in the one direction that is a contradiction, for the reason the payments pair
-- and `webhook_deliveries_pending_is_untried` paid for: a disconnected connection cannot still be
-- `connected`. The mirror ("a live connection is never disconnected") is about a column that is
-- already NULL, and a CHECK over two statuses that reads symmetrically is how a refund became
-- impossible.
ALTER TABLE "integration_connections" ADD CONSTRAINT "integration_connections_disconnected_is_not_connected"
  CHECK (
    CASE
      WHEN disconnected_at IS NOT NULL THEN status <> 'connected'
      ELSE true
    END
  );

-- `field_mappings` is an array of entries, not an object: a mapping stored as `{}` would be read as
-- "no mapping" by code that iterates it and as "a mapping" by code that checks for the key.
ALTER TABLE "integration_connections" ADD CONSTRAINT "integration_connections_mappings_are_a_list"
  CHECK (jsonb_typeof(field_mappings) = 'array');

ALTER TABLE "integration_connections" ADD CONSTRAINT "integration_connections_settings_are_an_object"
  CHECK (jsonb_typeof(settings) = 'object');

-- A probe's outcome is one of the four the shared vocabulary defines; a fifth would be a row no
-- screen and no transition rule can read.
ALTER TABLE "integration_health_checks" ADD CONSTRAINT "integration_health_checks_outcome_is_known"
  CHECK (outcome IN ('ok', 'degraded', 'unauthorized', 'unreachable'));

-- A latency of less than nothing is a clock that moved, not a measurement.
ALTER TABLE "integration_health_checks" ADD CONSTRAINT "integration_health_checks_latency_sane"
  CHECK (latency_ms IS NULL OR latency_ms >= 0);

-- Nothing reached means nothing timed: `unreachable` with a latency is a contradiction, and a
-- successful probe with none is a measurement somebody forgot to take.
ALTER TABLE "integration_health_checks" ADD CONSTRAINT "integration_health_checks_ok_was_timed"
  CHECK (
    CASE
      WHEN outcome = 'ok' THEN latency_ms IS NOT NULL
      ELSE true
    END
  );

-- A resource is the adapter's own name for what it syncs, and it is half of a unique key.
ALTER TABLE "sync_cursors" ADD CONSTRAINT "sync_cursors_resource_is_a_key"
  CHECK (resource ~ '^[a-z][a-z0-9_]{1,40}$');

ALTER TABLE "sync_cursors" ADD CONSTRAINT "sync_cursors_state_is_an_object"
  CHECK (jsonb_typeof(state) = 'object');
