-- Phase 4, step 3 — outbound webhooks: `webhook_endpoints`, `webhook_deliveries` (partitioned
-- monthly) and `webhook_attempts`.
--
-- Prisma's diff arrived with **fifteen** spurious statements again — the two three-column composite
-- FKs on `leads` and `deals`, and thirteen GIN, trigram and partial indexes earlier migrations
-- added by hand. Removed statement by statement, and only the `-- DropForeignKey` and
-- `-- DropIndex` sections, because Prisma puts `ADD COLUMN` in the same region.
-- `packages/db/src/schema-objects.int-spec.ts` is the only thing that catches the ones missed.
--
-- What Prisma cannot express here, and will propose dropping on its next diff: the
-- `PARTITION BY RANGE (created_at)` on `webhook_deliveries` (edited into the generated
-- `CREATE TABLE` by hand, as `activities` and `inbound_payloads` were), the partial index the retry
-- sweep reads, and every CHECK below.

-- CreateEnum
CREATE TYPE "webhook_delivery_status" AS ENUM ('pending', 'succeeded', 'failed', 'exhausted');


-- CreateTable
CREATE TABLE "webhook_endpoints" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "url" TEXT NOT NULL,
    "description" TEXT,
    "secret_encrypted" TEXT NOT NULL,
    "event_types" TEXT[],
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "failure_count" INTEGER NOT NULL DEFAULT 0,
    "last_success_at" TIMESTAMPTZ(6),
    "last_failure_at" TIMESTAMPTZ(6),
    "last_status_code" INTEGER,
    "disabled_at" TIMESTAMPTZ(6),
    "disabled_reason" TEXT,
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "webhook_endpoints_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_deliveries" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "endpoint_id" UUID NOT NULL,
    "event_id" UUID NOT NULL,
    "event_type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "webhook_delivery_status" NOT NULL DEFAULT 'pending',
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMPTZ(6),
    "last_status_code" INTEGER,
    "last_response_body" TEXT,
    "last_error" TEXT,
    "delivered_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "webhook_deliveries_pkey" PRIMARY KEY ("id","created_at")
) PARTITION BY RANGE ("created_at");

-- CreateTable
CREATE TABLE "webhook_attempts" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "delivery_id" UUID NOT NULL,
    "delivery_created_at" TIMESTAMPTZ(6) NOT NULL,
    "attempt_no" INTEGER NOT NULL,
    "status_code" INTEGER,
    "duration_ms" INTEGER NOT NULL,
    "response_body" TEXT,
    "error" TEXT,
    "attempted_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "webhook_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "webhook_endpoints_organization_id_is_active_idx" ON "webhook_endpoints"("organization_id", "is_active");

-- CreateIndex
CREATE UNIQUE INDEX "webhook_endpoints_organization_id_id_key" ON "webhook_endpoints"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "webhook_endpoints_organization_id_url_key" ON "webhook_endpoints"("organization_id", "url");

-- CreateIndex
CREATE INDEX "webhook_deliveries_organization_id_created_at_idx" ON "webhook_deliveries"("organization_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "webhook_deliveries_organization_id_endpoint_id_created_at_idx" ON "webhook_deliveries"("organization_id", "endpoint_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "webhook_deliveries_organization_id_status_created_at_idx" ON "webhook_deliveries"("organization_id", "status", "created_at" DESC);

-- CreateIndex
CREATE INDEX "webhook_deliveries_organization_id_endpoint_id_event_id_idx" ON "webhook_deliveries"("organization_id", "endpoint_id", "event_id");

-- CreateIndex
CREATE UNIQUE INDEX "webhook_deliveries_organization_id_id_created_at_key" ON "webhook_deliveries"("organization_id", "id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "webhook_deliveries_organization_id_endpoint_id_event_id_cre_key" ON "webhook_deliveries"("organization_id", "endpoint_id", "event_id", "created_at");

-- CreateIndex
CREATE INDEX "webhook_attempts_organization_id_delivery_id_attempt_no_idx" ON "webhook_attempts"("organization_id", "delivery_id", "attempt_no");

-- CreateIndex
CREATE UNIQUE INDEX "webhook_attempts_organization_id_id_key" ON "webhook_attempts"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "webhook_attempts_organization_id_delivery_id_attempt_no_key" ON "webhook_attempts"("organization_id", "delivery_id", "attempt_no");

-- AddForeignKey
ALTER TABLE "webhook_endpoints" ADD CONSTRAINT "webhook_endpoints_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhook_endpoints" ADD CONSTRAINT "webhook_endpoints_creator_same_org_fk" FOREIGN KEY ("organization_id", "created_by_id") REFERENCES "memberships"("organization_id", "user_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_endpoint_same_org_fk" FOREIGN KEY ("organization_id", "endpoint_id") REFERENCES "webhook_endpoints"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhook_attempts" ADD CONSTRAINT "webhook_attempts_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhook_attempts" ADD CONSTRAINT "webhook_attempts_delivery_same_org_fk" FOREIGN KEY ("organization_id", "delivery_id", "delivery_created_at") REFERENCES "webhook_deliveries"("organization_id", "id", "created_at") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── The monthly partitions ────────────────────────────────────────────────
--
-- Prisma cannot create a partitioned table, so the `PARTITION BY RANGE` above is hand-written and
-- so is everything in this section. `webhook_deliveries` is the fastest-growing table in the
-- product — one row per event per subscribed endpoint — and §15's retention is 90 days, which a
-- partition drop satisfies without deleting a row.

CREATE OR REPLACE FUNCTION ensure_webhook_delivery_partition(target timestamptz)
RETURNS text
LANGUAGE plpgsql
AS $$
DECLARE
  month_start date := date_trunc('month', target)::date;
  month_end   date := (date_trunc('month', target) + interval '1 month')::date;
  part_name   text := format('webhook_deliveries_%s', to_char(month_start, 'YYYY_MM'));
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = part_name) THEN
    EXECUTE format(
      'CREATE TABLE %I PARTITION OF webhook_deliveries FOR VALUES FROM (%L) TO (%L)',
      part_name, month_start, month_end
    );
  END IF;
  RETURN part_name;
END;
$$;

COMMENT ON FUNCTION ensure_webhook_delivery_partition(timestamptz) IS
  'Creates the monthly webhook_deliveries partition containing the given instant, if it does not exist. Idempotent; called by the partition-maintenance job.';

-- One month back and twelve forward: a delivery is created now, and only a delivery the sweep is
-- still retrying could sit behind — which is hours, not months.
DO $$
DECLARE
  offset_months int;
BEGIN
  FOR offset_months IN -1..12 LOOP
    PERFORM ensure_webhook_delivery_partition(now() + (offset_months || ' months')::interval);
  END LOOP;
END;
$$;

CREATE TABLE webhook_deliveries_default PARTITION OF webhook_deliveries DEFAULT;

COMMENT ON TABLE webhook_deliveries_default IS
  'Catch-all for instants outside the pre-created monthly partitions. Rows here block ATTACH of the overlapping month, so the maintenance job reports them.';

-- ── The index the retry sweep reads ───────────────────────────────────────
--
-- The sweep asks one question, across every workspace: "which deliveries are due now". A partial
-- index keyed on `next_attempt_at` alone answers it as an ordered scan the LIMIT stops early —
-- keyed on `(status, next_attempt_at)` it could not be, because the status predicate is an `IN`
-- over two values and an `IN` is not a range scan (the lesson `/my/today`'s `OR` paid for).
CREATE INDEX "webhook_deliveries_due" ON "webhook_deliveries" ("next_attempt_at")
  WHERE "next_attempt_at" IS NOT NULL AND "status" IN ('pending', 'failed');

-- ── CHECK constraints ─────────────────────────────────────────────────────

-- An endpoint has to be somewhere we could post to. The full SSRF classification lives in
-- `@leados/shared` (scheme, port, credentials, literal address) and the resolved addresses are
-- re-checked at send time; this is the floor beneath both, so a row written by anything other than
-- the service is still a URL and not a `file://` path.
ALTER TABLE "webhook_endpoints" ADD CONSTRAINT "webhook_endpoints_url_is_http"
  CHECK (url ~ '^https?://[^[:space:]]+$');

-- An endpoint subscribed to nothing receives nothing, which is somebody's afternoon. `cardinality`,
-- not `array_length`: on an empty array `array_length` is NULL and a CHECK that evaluates to NULL
-- is satisfied — the trap `escalations_notified_somebody` paid for.
ALTER TABLE "webhook_endpoints" ADD CONSTRAINT "webhook_endpoints_has_event_types"
  CHECK (cardinality(event_types) >= 1);

-- Signing needs the secret itself, so it is encrypted rather than hashed (ADR-0030's lesson in the
-- other direction) — and the obvious mistake is then to store it exactly as it was generated. This
-- refuses anything that is not an `EncryptionService` envelope, and anything that still looks like
-- the `whsec_…` value a workspace was shown.
ALTER TABLE "webhook_endpoints" ADD CONSTRAINT "webhook_endpoints_secret_is_encrypted"
  CHECK (secret_encrypted LIKE 'v1.%' AND secret_encrypted NOT LIKE 'whsec_%');

ALTER TABLE "webhook_endpoints" ADD CONSTRAINT "webhook_endpoints_failure_count_sane"
  CHECK (failure_count >= 0);

-- Written as a CASE rather than a biconditional, for the reason the payments pair paid for: every
-- sub-expression has to be non-NULL for a CHECK to bite, and two sensible biconditionals can
-- contradict each other. Disabled means inactive, with a reason; active means neither.
ALTER TABLE "webhook_endpoints" ADD CONSTRAINT "webhook_endpoints_disabled_is_accounted_for"
  CHECK (
    CASE
      WHEN disabled_at IS NULL THEN disabled_reason IS NULL
      ELSE is_active = false AND disabled_reason IS NOT NULL
    END
  );

-- `succeeded` is the only status with a delivery instant, and the only one that has one.
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_delivered_has_timestamp"
  CHECK (
    CASE
      WHEN status = 'succeeded' THEN delivered_at IS NOT NULL
      ELSE delivered_at IS NULL
    END
  );

-- A finished delivery has nothing due. Without this, an `exhausted` row with a `next_attempt_at`
-- would be picked up by the sweep forever — the quiet kind of failure.
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_finished_has_nothing_due"
  CHECK (
    CASE
      WHEN status IN ('succeeded', 'exhausted') THEN next_attempt_at IS NULL
      ELSE true
    END
  );

ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_attempts_sane"
  CHECK (attempt_count >= 0);

-- `pending` means "written, not attempted": a pending row with a count is one the sweep already
-- tried, which is `failed`.
--
-- Only that direction. The mirror ("anything not pending has been attempted") reads just as
-- sensibly and is **false**: a delivery whose endpoint was switched off between the fan-out and the
-- attempt is abandoned as `exhausted` having never been sent, and a CHECK that forbids an honest
-- state is a CHECK that makes the service lie instead.
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_pending_is_untried"
  CHECK (
    CASE
      WHEN status = 'pending' THEN attempt_count = 0
      ELSE true
    END
  );

ALTER TABLE "webhook_attempts" ADD CONSTRAINT "webhook_attempts_number_positive"
  CHECK (attempt_no >= 1);

ALTER TABLE "webhook_attempts" ADD CONSTRAINT "webhook_attempts_duration_sane"
  CHECK (duration_ms >= 0);

-- Every attempt has an outcome: a status code from the endpoint, or an error saying why there was
-- none. A row with neither is an attempt nobody can read.
ALTER TABLE "webhook_attempts" ADD CONSTRAINT "webhook_attempts_has_an_outcome"
  CHECK (status_code IS NOT NULL OR error IS NOT NULL);
