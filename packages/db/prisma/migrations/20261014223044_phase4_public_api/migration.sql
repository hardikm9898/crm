-- Phase 4, step 2 — the public lead API: `api_keys`, `inbound_payloads` (partitioned monthly),
-- `ingestion_errors` and `idempotency_keys`.
--
-- Prisma's diff arrived with **fifteen** spurious statements again: the two three-column composite
-- FKs and thirteen GIN, trigram and partial indexes earlier migrations added by hand. Removed
-- statement by statement, and only the `-- DropForeignKey` and `-- DropIndex` sections, because
-- Prisma puts `ADD COLUMN` in the same region. `packages/db/src/schema-objects.int-spec.ts` is the
-- only thing that catches the ones missed.
--
-- Two things in here Prisma cannot express and will propose dropping on its next diff: the
-- `PARTITION BY RANGE (received_at)` on `inbound_payloads` (edited into the generated
-- `CREATE TABLE` by hand, exactly as `activities` was), and the composite FK from
-- `ingestion_errors` into it, which spans three columns.

-- CreateEnum
CREATE TYPE "ingest_channel" AS ENUM ('public_api', 'webhook', 'meta_ads', 'google_ads', 'form', 'whatsapp', 'import');

-- CreateEnum
CREATE TYPE "inbound_status" AS ENUM ('received', 'processed', 'duplicate', 'failed');

-- CreateTable
CREATE TABLE "api_keys" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "key_id" TEXT NOT NULL,
    "key_prefix" TEXT NOT NULL,
    "secret_encrypted" TEXT NOT NULL,
    "scopes" TEXT[],
    "ip_allowlist" TEXT[],
    "rate_limit_per_min" INTEGER,
    "expires_at" TIMESTAMPTZ(6),
    "last_used_at" TIMESTAMPTZ(6),
    "last_used_ip" TEXT,
    "revoked_at" TIMESTAMPTZ(6),
    "revoked_by" UUID,
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "api_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inbound_payloads" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "channel" "ingest_channel" NOT NULL,
    "api_key_id" UUID,
    "raw_body" JSONB NOT NULL,
    "headers" JSONB NOT NULL DEFAULT '{}',
    "signature_valid" BOOLEAN NOT NULL DEFAULT false,
    "idempotency_key" TEXT NOT NULL,
    "dedupe_hash" TEXT NOT NULL,
    "status" "inbound_status" NOT NULL DEFAULT 'received',
    "lead_id" UUID,
    "error" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 1,
    "replayed_at" TIMESTAMPTZ(6),
    "replayed_by_id" UUID,
    "ip_hash" TEXT,
    "user_agent" TEXT,
    "received_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inbound_payloads_pkey" PRIMARY KEY ("id","received_at")
-- Hand-edited: Prisma cannot declare a partitioned table, and its later diffs do not notice this
-- clause. Partitioned by the instant the payload arrived, which is the only instant a
-- never-lose store can be pruned by — the same arrangement `activities` has.
) PARTITION BY RANGE ("received_at");

-- CreateTable
CREATE TABLE "ingestion_errors" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "payload_id" UUID NOT NULL,
    "payload_received_at" TIMESTAMPTZ(6) NOT NULL,
    "stage" TEXT NOT NULL,
    "error_code" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "details" JSONB NOT NULL DEFAULT '{}',
    "is_replayable" BOOLEAN NOT NULL DEFAULT true,
    "replayed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ingestion_errors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "idempotency_keys" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "request_hash" TEXT NOT NULL,
    "response_status" INTEGER NOT NULL,
    "response_body" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "idempotency_keys_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "api_keys_organization_id_revoked_at_idx" ON "api_keys"("organization_id", "revoked_at");

-- CreateIndex
CREATE UNIQUE INDEX "api_keys_organization_id_id_key" ON "api_keys"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "api_keys_key_id_key" ON "api_keys"("key_id");

-- CreateIndex
CREATE INDEX "inbound_payloads_organization_id_received_at_idx" ON "inbound_payloads"("organization_id", "received_at" DESC);

-- CreateIndex
CREATE INDEX "inbound_payloads_organization_id_status_received_at_idx" ON "inbound_payloads"("organization_id", "status", "received_at" DESC);

-- CreateIndex
CREATE INDEX "inbound_payloads_organization_id_channel_idempotency_key_idx" ON "inbound_payloads"("organization_id", "channel", "idempotency_key");

-- CreateIndex
CREATE INDEX "inbound_payloads_organization_id_api_key_id_received_at_idx" ON "inbound_payloads"("organization_id", "api_key_id", "received_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "inbound_payloads_organization_id_id_received_at_key" ON "inbound_payloads"("organization_id", "id", "received_at");

-- CreateIndex
CREATE UNIQUE INDEX "inbound_payloads_organization_id_channel_idempotency_key_re_key" ON "inbound_payloads"("organization_id", "channel", "idempotency_key", "received_at");

-- CreateIndex
CREATE INDEX "ingestion_errors_organization_id_created_at_idx" ON "ingestion_errors"("organization_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "ingestion_errors_organization_id_payload_id_idx" ON "ingestion_errors"("organization_id", "payload_id");

-- CreateIndex
CREATE INDEX "ingestion_errors_organization_id_stage_created_at_idx" ON "ingestion_errors"("organization_id", "stage", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "ingestion_errors_organization_id_id_key" ON "ingestion_errors"("organization_id", "id");

-- CreateIndex
CREATE INDEX "idempotency_keys_expires_at_idx" ON "idempotency_keys"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "idempotency_keys_organization_id_id_key" ON "idempotency_keys"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "idempotency_keys_organization_id_endpoint_key_key" ON "idempotency_keys"("organization_id", "endpoint", "key");

-- AddForeignKey
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_creator_same_org_fk" FOREIGN KEY ("organization_id", "created_by_id") REFERENCES "memberships"("organization_id", "user_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inbound_payloads" ADD CONSTRAINT "inbound_payloads_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inbound_payloads" ADD CONSTRAINT "inbound_payloads_api_key_same_org_fk" FOREIGN KEY ("organization_id", "api_key_id") REFERENCES "api_keys"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ingestion_errors" ADD CONSTRAINT "ingestion_errors_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ingestion_errors" ADD CONSTRAINT "ingestion_errors_payload_same_org_fk" FOREIGN KEY ("organization_id", "payload_id", "payload_received_at") REFERENCES "inbound_payloads"("organization_id", "id", "received_at") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ═══════════════════════════════════════════════════════════════════════════
-- Hand-written objects. Every one of these is in
-- `packages/db/src/schema-objects.int-spec.ts`, which is the only thing that catches a diff that
-- proposes dropping them.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── The monthly partitions of the never-lose store ─────────────────────────
--
-- The same shape `activities` has, and for the same reasons: a month with no partition does not
-- fail (rows land in the default) but the default then **blocks attaching** the real partition
-- until they are moved, so the maintenance job creates months ahead and reports anything stranded.
CREATE OR REPLACE FUNCTION ensure_inbound_payload_partition(target timestamptz)
RETURNS text
LANGUAGE plpgsql
AS $$
DECLARE
  month_start date := date_trunc('month', target)::date;
  month_end   date := (date_trunc('month', target) + interval '1 month')::date;
  part_name   text := format('inbound_payloads_%s', to_char(month_start, 'YYYY_MM'));
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = part_name) THEN
    EXECUTE format(
      'CREATE TABLE %I PARTITION OF inbound_payloads FOR VALUES FROM (%L) TO (%L)',
      part_name, month_start, month_end
    );
  END IF;
  RETURN part_name;
END;
$$;

COMMENT ON FUNCTION ensure_inbound_payload_partition(timestamptz) IS
  'Creates the monthly inbound_payloads partition containing the given instant, if it does not exist. Idempotent; called by the partition-maintenance job.';

-- Three months back and twelve forward. Backwards is shorter than `activities`' twelve because a
-- payload's `received_at` is always now: only a replay of an old row could land behind, and the
-- default partition catches that.
DO $$
DECLARE
  offset_months int;
BEGIN
  FOR offset_months IN -3..12 LOOP
    PERFORM ensure_inbound_payload_partition(now() + (offset_months || ' months')::interval);
  END LOOP;
END;
$$;

CREATE TABLE inbound_payloads_default PARTITION OF inbound_payloads DEFAULT;

COMMENT ON TABLE inbound_payloads_default IS
  'Catch-all for instants outside the pre-created monthly partitions. Rows here block ATTACH of the overlapping month, so the maintenance job reports them.';

-- ── CHECK constraints ─────────────────────────────────────────────────────

-- A key with no scopes can do nothing, which is a key somebody will spend an afternoon debugging.
-- `cardinality`, not `array_length`: on an empty array `array_length` is NULL and a CHECK that
-- evaluates to NULL is satisfied — the trap `escalations_notified_somebody` paid for.
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_has_a_scope"
  CHECK (cardinality(scopes) >= 1);

ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_name_present"
  CHECK (length(btrim(name)) > 0);

-- The public half is a `pk_live_…` token, and the stored secret is an AES-GCM envelope.
--
-- The second check is the load-bearing one: this endpoint verifies an HMAC, so the secret has to
-- be **recoverable** rather than hashed — and the obvious mistake is then to store it as it was
-- generated. `api_keys_secret_is_encrypted` refuses a value that is not an `EncryptionService`
-- envelope, and refuses anything beginning `sk_`, which is exactly what a plaintext secret looks
-- like. A constraint is the right place for it because the service that writes this column is not
-- the only one that ever will (ADR-0030).
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_key_id_format"
  CHECK (key_id ~ '^pk_(live|test)_[A-Za-z0-9_-]{16,}$');

ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_secret_is_encrypted"
  CHECK (secret_encrypted LIKE 'v1.%' AND secret_encrypted NOT LIKE 'sk_%');

ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_prefix_matches_key"
  CHECK (key_id LIKE key_prefix || '%');

ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_rate_limit_positive"
  CHECK (rate_limit_per_min IS NULL OR rate_limit_per_min > 0);

-- A revoked key says who revoked it and when, or neither. Half a revocation is a key nobody can
-- account for.
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_revocation_is_accounted_for"
  CHECK ((revoked_at IS NULL) = (revoked_by IS NULL));

-- A `CASE`, not a biconditional: `status` has four values and only two of them mean a lead exists.
ALTER TABLE "inbound_payloads" ADD CONSTRAINT "inbound_payloads_outcome_has_a_lead"
  CHECK (CASE WHEN status IN ('processed', 'duplicate') THEN lead_id IS NOT NULL ELSE true END);

ALTER TABLE "inbound_payloads" ADD CONSTRAINT "inbound_payloads_failure_is_explained"
  CHECK (CASE WHEN status = 'failed' THEN error IS NOT NULL ELSE true END);

ALTER TABLE "inbound_payloads" ADD CONSTRAINT "inbound_payloads_body_is_an_object"
  CHECK (jsonb_typeof(raw_body) = 'object');

ALTER TABLE "inbound_payloads" ADD CONSTRAINT "inbound_payloads_headers_is_an_object"
  CHECK (jsonb_typeof(headers) = 'object');

-- The dedupe hash is a SHA-256 digest, and the idempotency key is never blank: without one there
-- is nothing to recognise a retry by, which is the guarantee this table exists for.
ALTER TABLE "inbound_payloads" ADD CONSTRAINT "inbound_payloads_dedupe_hash_format"
  CHECK (dedupe_hash ~ '^[0-9a-f]{64}$');

ALTER TABLE "inbound_payloads" ADD CONSTRAINT "inbound_payloads_idempotency_key_present"
  CHECK (length(btrim(idempotency_key)) > 0);

ALTER TABLE "inbound_payloads" ADD CONSTRAINT "inbound_payloads_attempts_positive"
  CHECK (attempts >= 1);

ALTER TABLE "ingestion_errors" ADD CONSTRAINT "ingestion_errors_stage_is_known"
  CHECK (stage IN ('authenticate', 'validate', 'normalize', 'duplicate_check', 'persist', 'assign', 'notify'));

ALTER TABLE "ingestion_errors" ADD CONSTRAINT "ingestion_errors_message_present"
  CHECK (length(btrim(message)) > 0);

ALTER TABLE "ingestion_errors" ADD CONSTRAINT "ingestion_errors_details_is_object"
  CHECK (jsonb_typeof(details) = 'object');

ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_key_present"
  CHECK (length(btrim(key)) > 0 AND length(btrim(endpoint)) > 0);

ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_request_hash_format"
  CHECK (request_hash ~ '^[0-9a-f]{64}$');

-- A stored response has to be one: a 500 is not an answer worth replaying, and a key recorded
-- against one would make a client’s retry return the failure it was retrying.
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_response_is_an_answer"
  CHECK (response_status BETWEEN 200 AND 299);

ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_expires_after_creation"
  CHECK (expires_at > created_at);

-- ── Partial indexes ──────────────────────────────────────────────────────

-- The only question the authenticator asks: "is there a live key with this id?" Partial on
-- `revoked_at IS NULL`, so a workspace's revoked keys never slow the hot path.
CREATE UNIQUE INDEX "api_keys_live_by_key_id" ON "api_keys" ("key_id") WHERE revoked_at IS NULL;

-- The operator's queue: payloads that never became a lead, newest first, across every tenant —
-- keyed on `received_at` alone and **not** prefixed by `organization_id`, because the platform-wide
-- sweep that reports them cannot use an index whose leading column it does not filter on.
CREATE INDEX "inbound_payloads_unresolved" ON "inbound_payloads" ("received_at" DESC)
  WHERE status IN ('received', 'failed');

-- Errors somebody could actually replay, which is a much smaller set than every error.
CREATE INDEX "ingestion_errors_replayable" ON "ingestion_errors" ("organization_id", "created_at" DESC)
  WHERE is_replayable = true AND replayed_at IS NULL;
