-- Phase 2 step 8 — quotations, their versions and the per-tenant number series.
--
-- FOURTEEN `DROP`s WERE DELETED FROM THE TOP OF THIS FILE. Prisma's diff compares the database
-- against `schema.prisma`, and every object that cannot be expressed there — the three-column
-- `leads_stage_in_pipeline_fk` and `deals_stage_in_pipeline_fk`, the twelve GIN, trigram and
-- partial indexes on `leads`, `customers`, `deals` and `pipeline_stages` — looks to it like
-- something to remove. Applying them would have cost full-text search on three tables and the two
-- constraints that make "a record in another pipeline's stage" unrepresentable, with every test
-- still green. `packages/db/src/schema-objects.int-spec.ts` is the only thing that catches this.


-- CreateTable
CREATE TABLE "number_series" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "prefix" TEXT NOT NULL DEFAULT '',
    "next_value" INTEGER NOT NULL DEFAULT 1,
    "padding" INTEGER NOT NULL DEFAULT 4,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "number_series_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quotations" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "deal_id" UUID,
    "lead_id" UUID,
    "customer_id" UUID,
    "branch_id" UUID,
    "team_id" UUID,
    "owner_user_id" UUID,
    "number" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "superseded_by_id" UUID,
    "superseded_at" TIMESTAMPTZ(6),
    "status" TEXT NOT NULL DEFAULT 'draft',
    "title" TEXT,
    "terms" TEXT,
    "valid_until" DATE,
    "gross_minor" BIGINT NOT NULL DEFAULT 0,
    "discount_minor" BIGINT NOT NULL DEFAULT 0,
    "tax_minor" BIGINT NOT NULL DEFAULT 0,
    "total_minor" BIGINT NOT NULL DEFAULT 0,
    "currency" CHAR(3) NOT NULL,
    "sent_at" TIMESTAMPTZ(6),
    "sent_via" TEXT,
    "sent_to" TEXT,
    "accepted_at" TIMESTAMPTZ(6),
    "rejected_at" TIMESTAMPTZ(6),
    "rejected_reason_id" UUID,
    "outcome_note" TEXT,
    "expired_at" TIMESTAMPTZ(6),
    "pdf_document_id" UUID,
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "quotations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quotation_items" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "quotation_id" UUID NOT NULL,
    "product_id" UUID,
    "position" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "quantity" DECIMAL(12,3) NOT NULL,
    "unit" TEXT,
    "unit_price_minor" BIGINT NOT NULL,
    "discount_minor" BIGINT NOT NULL DEFAULT 0,
    "tax_percent" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "gross_minor" BIGINT NOT NULL,
    "net_minor" BIGINT NOT NULL,
    "tax_minor" BIGINT NOT NULL,
    "total_minor" BIGINT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "quotation_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "number_series_organization_id_id_key" ON "number_series"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "number_series_organization_id_kind_key" ON "number_series"("organization_id", "kind");

-- CreateIndex
CREATE INDEX "quotations_organization_id_created_at_idx" ON "quotations"("organization_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "quotations_organization_id_deal_id_idx" ON "quotations"("organization_id", "deal_id");

-- CreateIndex
CREATE INDEX "quotations_organization_id_lead_id_idx" ON "quotations"("organization_id", "lead_id");

-- CreateIndex
CREATE INDEX "quotations_organization_id_customer_id_idx" ON "quotations"("organization_id", "customer_id");

-- CreateIndex
CREATE INDEX "quotations_organization_id_status_valid_until_idx" ON "quotations"("organization_id", "status", "valid_until");

-- CreateIndex
CREATE INDEX "quotations_organization_id_owner_user_id_idx" ON "quotations"("organization_id", "owner_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "quotations_organization_id_id_key" ON "quotations"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "quotations_organization_id_number_version_key" ON "quotations"("organization_id", "number", "version");

-- CreateIndex
CREATE INDEX "quotation_items_organization_id_quotation_id_idx" ON "quotation_items"("organization_id", "quotation_id");

-- CreateIndex
CREATE INDEX "quotation_items_organization_id_product_id_idx" ON "quotation_items"("organization_id", "product_id");

-- CreateIndex
CREATE UNIQUE INDEX "quotation_items_organization_id_id_key" ON "quotation_items"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "quotation_items_organization_id_quotation_id_position_key" ON "quotation_items"("organization_id", "quotation_id", "position");

-- AddForeignKey
ALTER TABLE "number_series" ADD CONSTRAINT "number_series_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotations" ADD CONSTRAINT "quotations_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotations" ADD CONSTRAINT "quotations_deal_same_org_fk" FOREIGN KEY ("organization_id", "deal_id") REFERENCES "deals"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotations" ADD CONSTRAINT "quotations_lead_same_org_fk" FOREIGN KEY ("organization_id", "lead_id") REFERENCES "leads"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotations" ADD CONSTRAINT "quotations_customer_same_org_fk" FOREIGN KEY ("organization_id", "customer_id") REFERENCES "customers"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotations" ADD CONSTRAINT "quotations_branch_same_org_fk" FOREIGN KEY ("organization_id", "branch_id") REFERENCES "branches"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotations" ADD CONSTRAINT "quotations_team_same_org_fk" FOREIGN KEY ("organization_id", "team_id") REFERENCES "teams"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotations" ADD CONSTRAINT "quotations_owner_same_org_fk" FOREIGN KEY ("organization_id", "owner_user_id") REFERENCES "memberships"("organization_id", "user_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotations" ADD CONSTRAINT "quotations_rejected_reason_same_org_fk" FOREIGN KEY ("organization_id", "rejected_reason_id") REFERENCES "lost_reasons"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotations" ADD CONSTRAINT "quotations_pdf_document_same_org_fk" FOREIGN KEY ("organization_id", "pdf_document_id") REFERENCES "documents"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotations" ADD CONSTRAINT "quotations_superseded_by_same_org_fk" FOREIGN KEY ("organization_id", "superseded_by_id") REFERENCES "quotations"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotation_items" ADD CONSTRAINT "quotation_items_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotation_items" ADD CONSTRAINT "quotation_items_quotation_same_org_fk" FOREIGN KEY ("organization_id", "quotation_id") REFERENCES "quotations"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotation_items" ADD CONSTRAINT "quotation_items_product_same_org_fk" FOREIGN KEY ("organization_id", "product_id") REFERENCES "products"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ──────────────────────────────────────────────────────────────────────────────
-- Hand-written objects. Prisma's next diff will propose dropping every one of
-- these; they are asserted present by packages/db/src/schema-objects.int-spec.ts.
-- ──────────────────────────────────────────────────────────────────────────────

-- `documents` learns a fourth subject. The CHECK is the reason this has to be an
-- explicit migration step rather than a new string a service happens to pass.
ALTER TABLE "documents" DROP CONSTRAINT "documents_subject";
ALTER TABLE "documents"
  ADD CONSTRAINT "documents_subject"
  CHECK (subject IN ('import', 'import_errors', 'export', 'quotation'));

-- The referencing side of the version self-FK. Postgres indexes only the referenced
-- side, and the same omission on `leads.merged_into_id` made deletion quadratic.
CREATE INDEX quotations_superseded_by
  ON quotations (organization_id, superseded_by_id)
  WHERE superseded_by_id IS NOT NULL;

-- Every list screen asks for the *current* version of each quotation. A full index
-- on a table whose superseded rows accumulate forever answers that question worse
-- every month.
CREATE INDEX quotations_current
  ON quotations (organization_id, created_at DESC)
  WHERE superseded_at IS NULL AND deleted_at IS NULL;

-- The expiry sweep's own index: sent quotations whose validity has run out. Partial,
-- because that is a handful of rows out of everything ever quoted.
CREATE INDEX quotations_awaiting_expiry
  ON quotations (organization_id, valid_until)
  WHERE status = 'sent' AND valid_until IS NOT NULL AND deleted_at IS NULL;

-- The protocol. A quotation's lifecycle is not a tenant's vocabulary — unlike a
-- lead's status, which is a row — so it is a constraint.
ALTER TABLE "quotations"
  ADD CONSTRAINT quotations_has_subject
    CHECK (deal_id IS NOT NULL OR lead_id IS NOT NULL OR customer_id IS NOT NULL),
  ADD CONSTRAINT quotations_status
    CHECK (status IN ('draft', 'sent', 'accepted', 'rejected', 'expired')),
  ADD CONSTRAINT quotations_sent_via
    CHECK (sent_via IS NULL OR sent_via IN ('email', 'whatsapp', 'link', 'manual')),
  ADD CONSTRAINT quotations_number_present CHECK (length(btrim(number)) > 0),
  ADD CONSTRAINT quotations_version_positive CHECK (version >= 1),
  ADD CONSTRAINT quotations_currency_format CHECK (currency ~ '^[A-Z]{3}$'),
  -- A status and its timestamp are one fact. `sent_at` without `sent` would make
  -- "when did this go out?" answerable and "has it gone out?" not.
  ADD CONSTRAINT quotations_sent_has_timestamp
    CHECK ((status = 'draft') = (sent_at IS NULL)),
  ADD CONSTRAINT quotations_accepted_has_timestamp
    CHECK ((status = 'accepted') = (accepted_at IS NOT NULL)),
  ADD CONSTRAINT quotations_rejected_has_timestamp
    CHECK ((status = 'rejected') = (rejected_at IS NOT NULL)),
  ADD CONSTRAINT quotations_expired_has_timestamp
    CHECK ((status = 'expired') = (expired_at IS NOT NULL)),
  ADD CONSTRAINT quotations_reason_needs_rejection
    CHECK (rejected_reason_id IS NULL OR rejected_at IS NOT NULL),
  -- A draft has no PDF: a file of a document that is still being written is a file
  -- somebody will send.
  ADD CONSTRAINT quotations_pdf_needs_sending
    CHECK (pdf_document_id IS NULL OR status <> 'draft'),
  ADD CONSTRAINT quotations_superseded_pair
    CHECK ((superseded_by_id IS NULL) = (superseded_at IS NULL)),
  ADD CONSTRAINT quotations_not_superseded_by_self
    CHECK (superseded_by_id IS NULL OR superseded_by_id <> id),
  ADD CONSTRAINT quotations_money_non_negative
    CHECK (gross_minor >= 0 AND discount_minor >= 0 AND tax_minor >= 0 AND total_minor >= 0),
  -- The same arithmetic the application computes, checked by the database (ADR-0018).
  ADD CONSTRAINT quotations_totals_add_up
    CHECK (total_minor = gross_minor - discount_minor + tax_minor),
  ADD CONSTRAINT quotations_discount_within_gross
    CHECK (discount_minor <= gross_minor);

ALTER TABLE "quotation_items"
  ADD CONSTRAINT quotation_items_name_present CHECK (length(btrim(name)) > 0),
  ADD CONSTRAINT quotation_items_position_positive CHECK (position >= 1),
  ADD CONSTRAINT quotation_items_quantity_positive CHECK (quantity > 0),
  ADD CONSTRAINT quotation_items_tax_percent_range CHECK (tax_percent BETWEEN 0 AND 100),
  ADD CONSTRAINT quotation_items_money_non_negative
    CHECK (
      unit_price_minor >= 0 AND discount_minor >= 0 AND gross_minor >= 0
      AND net_minor >= 0 AND tax_minor >= 0 AND total_minor >= 0
    ),
  ADD CONSTRAINT quotation_items_net_is_gross_less_discount
    CHECK (net_minor = gross_minor - discount_minor),
  ADD CONSTRAINT quotation_items_total_is_net_plus_tax
    CHECK (total_minor = net_minor + tax_minor),
  ADD CONSTRAINT quotation_items_discount_within_gross
    CHECK (discount_minor <= gross_minor);

ALTER TABLE "number_series"
  ADD CONSTRAINT number_series_kind_present CHECK (length(btrim(kind)) > 0),
  ADD CONSTRAINT number_series_next_value_positive CHECK (next_value >= 1),
  ADD CONSTRAINT number_series_padding_range CHECK (padding BETWEEN 0 AND 12);
