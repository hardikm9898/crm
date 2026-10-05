-- ── Deliberately NOT dropped (the same six, a third time) ──────────────────
-- `prisma migrate diff` proposed dropping `leads_stage_in_pipeline_fk`,
-- `pipeline_stages_pipeline_scoped_key`, `leads_search_vector_gin`, `leads_custom_values_gin`,
-- `leads_phone_e164_trgm` and `leads_full_name_trgm` — as it does on every diff, because none of
-- them can be expressed in `schema.prisma`. Deleted from the generated SQL.
-- `packages/db/src/schema-objects.int-spec.ts` is what fails if that is ever forgotten.

-- CreateTable
CREATE TABLE "documents" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "subject" TEXT NOT NULL,
    "file_key" TEXT NOT NULL,
    "file_name" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "checksum" TEXT NOT NULL,
    "scan_status" TEXT NOT NULL DEFAULT 'pending',
    "uploaded_by_id" UUID,
    "expires_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "import_jobs" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "entity_type" TEXT NOT NULL DEFAULT 'lead',
    "status" TEXT NOT NULL DEFAULT 'uploaded',
    "mapping" JSONB NOT NULL DEFAULT '{}',
    "mode" TEXT NOT NULL DEFAULT 'create_only',
    "delimiter" TEXT NOT NULL DEFAULT ',',
    "total_rows" INTEGER NOT NULL DEFAULT 0,
    "processed_rows" INTEGER NOT NULL DEFAULT 0,
    "created_count" INTEGER NOT NULL DEFAULT 0,
    "updated_count" INTEGER NOT NULL DEFAULT 0,
    "attached_count" INTEGER NOT NULL DEFAULT 0,
    "skipped_count" INTEGER NOT NULL DEFAULT 0,
    "failed_count" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "error_document_id" UUID,
    "requested_by_id" UUID,
    "started_at" TIMESTAMPTZ(6),
    "finished_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "import_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "import_rows" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "job_id" UUID NOT NULL,
    "row_number" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "errors" JSONB NOT NULL DEFAULT '[]',
    "raw" JSONB NOT NULL DEFAULT '{}',
    "lead_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "import_rows_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "export_jobs" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "entity_type" TEXT NOT NULL DEFAULT 'lead',
    "filters" JSONB NOT NULL DEFAULT '{}',
    "columns" JSONB NOT NULL DEFAULT '[]',
    "status" TEXT NOT NULL DEFAULT 'queued',
    "row_count" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "document_id" UUID,
    "expires_at" TIMESTAMPTZ(6),
    "includes_pii" BOOLEAN NOT NULL DEFAULT true,
    "requested_by_id" UUID,
    "started_at" TIMESTAMPTZ(6),
    "finished_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "export_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "documents_organization_id_subject_created_at_idx" ON "documents"("organization_id", "subject", "created_at");

-- CreateIndex
CREATE INDEX "documents_organization_id_expires_at_idx" ON "documents"("organization_id", "expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "documents_organization_id_id_key" ON "documents"("organization_id", "id");

-- CreateIndex
CREATE INDEX "import_jobs_organization_id_status_created_at_idx" ON "import_jobs"("organization_id", "status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "import_jobs_organization_id_id_key" ON "import_jobs"("organization_id", "id");

-- CreateIndex
CREATE INDEX "import_rows_organization_id_job_id_status_idx" ON "import_rows"("organization_id", "job_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "import_rows_organization_id_id_key" ON "import_rows"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "import_rows_organization_id_job_id_row_number_key" ON "import_rows"("organization_id", "job_id", "row_number");

-- CreateIndex
CREATE INDEX "export_jobs_organization_id_status_created_at_idx" ON "export_jobs"("organization_id", "status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "export_jobs_organization_id_id_key" ON "export_jobs"("organization_id", "id");

-- AddForeignKey
ALTER TABLE "documents" ADD CONSTRAINT "documents_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "import_jobs" ADD CONSTRAINT "import_jobs_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "import_jobs" ADD CONSTRAINT "import_jobs_document_same_org_fk" FOREIGN KEY ("organization_id", "document_id") REFERENCES "documents"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "import_rows" ADD CONSTRAINT "import_rows_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "import_rows" ADD CONSTRAINT "import_rows_job_same_org_fk" FOREIGN KEY ("organization_id", "job_id") REFERENCES "import_jobs"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "import_rows" ADD CONSTRAINT "import_rows_lead_same_org_fk" FOREIGN KEY ("organization_id", "lead_id") REFERENCES "leads"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "export_jobs" ADD CONSTRAINT "export_jobs_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "export_jobs" ADD CONSTRAINT "export_jobs_document_same_org_fk" FOREIGN KEY ("organization_id", "document_id") REFERENCES "documents"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ═══════════════════════════════════════════════════════════════════════════
-- Hand-written: what Prisma cannot express
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. A document describes a file that exists ─────────────────────────────
ALTER TABLE documents
  ADD CONSTRAINT documents_size_positive CHECK (size_bytes > 0),
  ADD CONSTRAINT documents_name_present CHECK (length(btrim(file_name)) > 0),
  ADD CONSTRAINT documents_key_present CHECK (length(btrim(file_key)) > 0),
  -- SHA-256, lowercase hex. A checksum of a different length is a different algorithm, and a
  -- re-upload check that silently compared incomparable digests would never match.
  ADD CONSTRAINT documents_checksum_sha256 CHECK (checksum ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT documents_scan_status CHECK (scan_status IN ('pending', 'clean', 'infected')),
  ADD CONSTRAINT documents_subject CHECK (subject IN ('import', 'import_errors', 'export'));

-- The expiry sweep's own query: live documents with a deadline, soonest first (`FR-IO-3`).
CREATE INDEX documents_expiring
  ON documents (expires_at)
  WHERE expires_at IS NOT NULL AND deleted_at IS NULL;

-- ── 2. An import job's state and its counts ────────────────────────────────
ALTER TABLE import_jobs
  ADD CONSTRAINT import_jobs_status CHECK (
    status IN ('uploaded', 'mapped', 'validated', 'running', 'completed', 'failed', 'cancelled')
  ),
  ADD CONSTRAINT import_jobs_mode CHECK (mode IN ('create_only', 'skip_existing', 'update_existing')),
  ADD CONSTRAINT import_jobs_mapping_is_object CHECK (jsonb_typeof(mapping) = 'object'),
  ADD CONSTRAINT import_jobs_delimiter_single CHECK (length(delimiter) = 1),
  ADD CONSTRAINT import_jobs_counts_non_negative CHECK (
    total_rows >= 0 AND processed_rows >= 0 AND created_count >= 0 AND updated_count >= 0
    AND attached_count >= 0 AND skipped_count >= 0 AND failed_count >= 0
  ),
  -- The outcome counts must add up to what was processed. A job reporting "9 800 processed, 9 000
  -- created" with nothing accounting for the other 800 is a progress bar that lies, and the lie
  -- would only be noticed by the person whose rows went missing.
  ADD CONSTRAINT import_jobs_outcomes_account_for_processed CHECK (
    created_count + updated_count + attached_count + skipped_count + failed_count = processed_rows
  ),
  ADD CONSTRAINT import_jobs_processed_within_total CHECK (processed_rows <= total_rows);

-- ── 3. An import row cannot claim an outcome it does not have ──────────────
ALTER TABLE import_rows
  ADD CONSTRAINT import_rows_status CHECK (
    status IN ('created', 'updated', 'attached', 'skipped', 'failed')
  ),
  ADD CONSTRAINT import_rows_number_positive CHECK (row_number >= 1),
  ADD CONSTRAINT import_rows_errors_is_array CHECK (jsonb_typeof(errors) = 'array'),
  ADD CONSTRAINT import_rows_raw_is_object CHECK (jsonb_typeof(raw) = 'object'),
  -- A failed row with no error is a row nobody can fix, and a row claiming it created a lead with
  -- no lead to point at is a lie in the audit trail. Both are only reachable through a bug, and
  -- both would be invisible afterwards.
  ADD CONSTRAINT import_rows_failed_has_error CHECK (
    status <> 'failed' OR jsonb_array_length(errors) > 0
  ),
  ADD CONSTRAINT import_rows_outcome_has_lead CHECK (
    status NOT IN ('created', 'updated', 'attached') OR lead_id IS NOT NULL
  );

-- ── 4. An export job ───────────────────────────────────────────────────────
ALTER TABLE export_jobs
  ADD CONSTRAINT export_jobs_status CHECK (
    status IN ('queued', 'running', 'completed', 'failed', 'expired')
  ),
  ADD CONSTRAINT export_jobs_filters_is_object CHECK (jsonb_typeof(filters) = 'object'),
  ADD CONSTRAINT export_jobs_columns_is_array CHECK (jsonb_typeof(columns) = 'array'),
  ADD CONSTRAINT export_jobs_row_count_non_negative CHECK (row_count >= 0),
  -- A completed export without a file is a download button that 404s.
  ADD CONSTRAINT export_jobs_completed_has_document CHECK (
    status <> 'completed' OR document_id IS NOT NULL
  );
