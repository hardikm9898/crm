-- Phase 4, step 4 — `api_logs`: one row per request a key made, partitioned **daily**.
--
-- Prisma's diff arrived with the same **fifteen** spurious statements as the last two migrations —
-- the two three-column composite FKs on `leads` and `deals`, and thirteen GIN, trigram and partial
-- indexes earlier migrations added by hand. Removed statement by statement, and only the
-- `-- DropForeignKey` and `-- DropIndex` sections, because Prisma puts `ADD COLUMN` in the same
-- region. `packages/db/src/schema-objects.int-spec.ts` is the only thing that catches the ones
-- missed.
--
-- What Prisma cannot express here, and will propose dropping on its next diff: the
-- `PARTITION BY RANGE (created_at)` below (edited into the generated `CREATE TABLE` by hand, as
-- `activities`, `inbound_payloads` and `webhook_deliveries` were), `ensure_api_log_partition`, and
-- every CHECK at the bottom.
--
-- Daily rather than monthly, which is the one difference from the three partitioned tables before
-- it: the retention window is thirty days, so a month-sized partition would be the whole table and
-- "drop the oldest partition" would mean dropping everything or nothing.

-- CreateEnum
CREATE TYPE "api_surface" AS ENUM ('rest', 'public_ingest');

-- CreateTable
CREATE TABLE "api_logs" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "api_key_id" UUID,
    "surface" "api_surface" NOT NULL,
    "method" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "status_code" INTEGER NOT NULL,
    "error_code" TEXT,
    "duration_ms" INTEGER NOT NULL,
    "bytes_in" INTEGER NOT NULL DEFAULT 0,
    "bytes_out" INTEGER NOT NULL DEFAULT 0,
    "request_id" TEXT NOT NULL,
    "ip" TEXT,
    "user_agent" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "api_logs_pkey" PRIMARY KEY ("id","created_at")
) PARTITION BY RANGE ("created_at");

-- CreateIndex
CREATE INDEX "api_logs_organization_id_created_at_idx" ON "api_logs"("organization_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "api_logs_organization_id_api_key_id_created_at_idx" ON "api_logs"("organization_id", "api_key_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "api_logs_organization_id_status_code_created_at_idx" ON "api_logs"("organization_id", "status_code", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "api_logs_organization_id_id_created_at_key" ON "api_logs"("organization_id", "id", "created_at");

-- AddForeignKey
ALTER TABLE "api_logs" ADD CONSTRAINT "api_logs_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_logs" ADD CONSTRAINT "api_logs_api_key_same_org_fk" FOREIGN KEY ("organization_id", "api_key_id") REFERENCES "api_keys"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ── Partitioning ──────────────────────────────────────────────────────────

-- One day per partition, created ahead by `maintenance.api-log-partitions`. Idempotent, so the
-- job, the seed and a test can all call it without checking first.
CREATE OR REPLACE FUNCTION ensure_api_log_partition(target timestamptz)
RETURNS text
LANGUAGE plpgsql
AS $$
DECLARE
  day_start date := (target AT TIME ZONE 'UTC')::date;
  partition_name text := format('api_logs_%s', to_char(day_start, 'YYYYMMDD'));
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = partition_name) THEN
    EXECUTE format(
      'CREATE TABLE %I PARTITION OF api_logs FOR VALUES FROM (%L) TO (%L)',
      partition_name,
      day_start,
      day_start + 1
    );
  END IF;
  RETURN partition_name;
END;
$$;

COMMENT ON FUNCTION ensure_api_log_partition(timestamptz) IS
  'Creates the daily api_logs partition containing `target` if it does not exist. Called by maintenance.api-log-partitions.';

-- The default partition exists for the same reason the other partitioned tables have one: a day
-- with no partition would refuse the write, and losing a request log is a worse answer than
-- stranding rows the maintenance job then reports. It is never where rows are meant to land.
CREATE TABLE "api_logs_default" PARTITION OF "api_logs" DEFAULT;

-- Yesterday (a log written while the clock crosses midnight) through a week ahead.
DO $$
DECLARE
  offset_days int;
BEGIN
  FOR offset_days IN -1..7 LOOP
    PERFORM ensure_api_log_partition(now() + make_interval(days => offset_days));
  END LOOP;
END;
$$;

-- ── CHECK constraints ─────────────────────────────────────────────────────

-- The verbs this API answers. A log row naming `TRACE` is a row nothing wrote.
ALTER TABLE "api_logs" ADD CONSTRAINT "api_logs_method_is_a_verb"
  CHECK (method IN ('GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'HEAD', 'OPTIONS'));

-- A path, not a URL: the query string is dropped before the row is written and the host is not
-- ours to record. Anything else means something other than `logPath` wrote this row.
ALTER TABLE "api_logs" ADD CONSTRAINT "api_logs_path_is_a_path"
  CHECK (path LIKE '/%' AND path NOT LIKE '%?%' AND length(path) BETWEEN 1 AND 512);

ALTER TABLE "api_logs" ADD CONSTRAINT "api_logs_status_is_http"
  CHECK (status_code BETWEEN 100 AND 599);

ALTER TABLE "api_logs" ADD CONSTRAINT "api_logs_measurements_sane"
  CHECK (duration_ms >= 0 AND bytes_in >= 0 AND bytes_out >= 0);

-- Only the direction that is a contradiction. "An answer below 400 carried an error code" cannot be
-- true. The mirror — "every refusal has a code" — reads just as sensibly and is **false**: a 404
-- from a path Fastify never routed has no envelope and therefore no code, and a CHECK that forbids
-- an honest state makes the writer lie instead (the lesson `webhook_deliveries_pending_is_untried`
-- paid for).
ALTER TABLE "api_logs" ADD CONSTRAINT "api_logs_success_has_no_error_code"
  CHECK (
    CASE
      WHEN status_code < 400 THEN error_code IS NULL
      ELSE true
    END
  );
