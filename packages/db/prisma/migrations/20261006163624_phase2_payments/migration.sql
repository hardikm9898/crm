-- Phase 2 step 9 — the payments ledger, and the revenue columns it finally lets exist.
--
-- FOURTEEN `DROP`s WERE DELETED FROM THE TOP OF THIS FILE — the same fourteen as the quotations
-- migration: the two three-column stage FKs and the twelve GIN, trigram and partial indexes on
-- `leads`, `customers`, `deals` and `pipeline_stages`. Prisma's diff sees every object that cannot
-- be expressed in `schema.prisma` as something to remove. Applying them would cost full-text search
-- on three tables and the constraints that make "a record in another pipeline's stage"
-- unrepresentable, with every test still green.
--
-- Cut carefully: Prisma puts its `AlterTable … ADD COLUMN` statements in this same region, and the
-- first attempt at this migration deleted them along with the drops, which failed loudly on
-- `column "paid_minor" does not exist`. Remove the `DropForeignKey` and `DropIndex` sections only.
-- `packages/db/src/schema-objects.int-spec.ts` is the guard for the rest.

-- AlterTable
ALTER TABLE "customers" ADD COLUMN     "first_purchase_at" TIMESTAMPTZ(6),
ADD COLUMN     "last_purchase_at" TIMESTAMPTZ(6),
ADD COLUMN     "lifetime_value_minor" BIGINT NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "deals" ADD COLUMN     "paid_minor" BIGINT NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "payment_methods" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "requires_reference" BOOLEAN NOT NULL DEFAULT false,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "payment_methods_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payments" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "deal_id" UUID,
    "quotation_id" UUID,
    "lead_id" UUID,
    "customer_id" UUID,
    "branch_id" UUID,
    "team_id" UUID,
    "owner_user_id" UUID,
    "number" TEXT NOT NULL,
    "amount_minor" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "method_id" UUID,
    "reference" TEXT,
    "status" TEXT NOT NULL DEFAULT 'succeeded',
    "paid_at" TIMESTAMPTZ(6),
    "failed_at" TIMESTAMPTZ(6),
    "refunded_at" TIMESTAMPTZ(6),
    "outcome_note" TEXT,
    "provider" TEXT,
    "provider_payment_id" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "payment_methods_organization_id_is_active_sort_order_idx" ON "payment_methods"("organization_id", "is_active", "sort_order");

-- CreateIndex
CREATE UNIQUE INDEX "payment_methods_organization_id_id_key" ON "payment_methods"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "payment_methods_organization_id_name_key" ON "payment_methods"("organization_id", "name");

-- CreateIndex
CREATE INDEX "payments_organization_id_paid_at_idx" ON "payments"("organization_id", "paid_at" DESC);

-- CreateIndex
CREATE INDEX "payments_organization_id_deal_id_idx" ON "payments"("organization_id", "deal_id");

-- CreateIndex
CREATE INDEX "payments_organization_id_customer_id_idx" ON "payments"("organization_id", "customer_id");

-- CreateIndex
CREATE INDEX "payments_organization_id_lead_id_idx" ON "payments"("organization_id", "lead_id");

-- CreateIndex
CREATE INDEX "payments_organization_id_quotation_id_idx" ON "payments"("organization_id", "quotation_id");

-- CreateIndex
CREATE INDEX "payments_organization_id_status_paid_at_idx" ON "payments"("organization_id", "status", "paid_at" DESC);

-- CreateIndex
CREATE INDEX "payments_organization_id_method_id_idx" ON "payments"("organization_id", "method_id");

-- CreateIndex
CREATE UNIQUE INDEX "payments_organization_id_id_key" ON "payments"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "payments_organization_id_number_key" ON "payments"("organization_id", "number");

-- AddForeignKey
ALTER TABLE "payment_methods" ADD CONSTRAINT "payment_methods_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_deal_same_org_fk" FOREIGN KEY ("organization_id", "deal_id") REFERENCES "deals"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_quotation_same_org_fk" FOREIGN KEY ("organization_id", "quotation_id") REFERENCES "quotations"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_lead_same_org_fk" FOREIGN KEY ("organization_id", "lead_id") REFERENCES "leads"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_customer_same_org_fk" FOREIGN KEY ("organization_id", "customer_id") REFERENCES "customers"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_branch_same_org_fk" FOREIGN KEY ("organization_id", "branch_id") REFERENCES "branches"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_team_same_org_fk" FOREIGN KEY ("organization_id", "team_id") REFERENCES "teams"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_owner_same_org_fk" FOREIGN KEY ("organization_id", "owner_user_id") REFERENCES "memberships"("organization_id", "user_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_method_same_org_fk" FOREIGN KEY ("organization_id", "method_id") REFERENCES "payment_methods"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ──────────────────────────────────────────────────────────────────────────────
-- Hand-written objects. Prisma's next diff will propose dropping every one of
-- these; they are asserted present by packages/db/src/schema-objects.int-spec.ts.
-- ──────────────────────────────────────────────────────────────────────────────

-- A provider's payment id is the idempotency key for its webhook (CLAUDE.md
-- rule 12), for the phase that adds an adapter. Partial, because every manually
-- recorded payment has neither column — a plain unique index would have allowed
-- exactly one cash receipt per workspace.
CREATE UNIQUE INDEX payments_provider_payment_key
  ON payments (organization_id, provider, provider_payment_id)
  WHERE provider IS NOT NULL AND provider_payment_id IS NOT NULL;

-- What every revenue figure in the product reads: the succeeded payments of a
-- workspace, newest first. Partial, because failed and refunded rows accumulate
-- forever and belong in no total.
CREATE INDEX payments_received
  ON payments (organization_id, paid_at DESC)
  WHERE status = 'succeeded' AND deleted_at IS NULL;

-- The collections question — "what is still owed on the deals we expect to
-- close" — reads this.
CREATE INDEX deals_part_paid
  ON deals (organization_id, expected_close_date)
  WHERE won_at IS NULL AND lost_at IS NULL AND deleted_at IS NULL AND paid_minor < value_minor;

ALTER TABLE "payments"
  ADD CONSTRAINT payments_has_subject
    CHECK (
      deal_id IS NOT NULL OR quotation_id IS NOT NULL
      OR lead_id IS NOT NULL OR customer_id IS NOT NULL
    ),
  ADD CONSTRAINT payments_status
    CHECK (status IN ('pending', 'succeeded', 'failed', 'refunded')),
  ADD CONSTRAINT payments_number_present CHECK (length(btrim(number)) > 0),
  ADD CONSTRAINT payments_currency_format CHECK (currency ~ '^[A-Z]{3}$'),
  -- A receipt for nothing is not a receipt, and a negative payment is a refund
  -- pretending to be one. `refunded` is a status precisely so this can hold.
  ADD CONSTRAINT payments_amount_positive CHECK (amount_minor > 0),
  -- Money that arrived has a date; money that has not arrived does not.
  --
  -- NOT a biconditional on `succeeded`: a **refunded** payment did arrive, and
  -- `payments_refund_was_received` below requires it to keep the date it arrived
  -- on. Writing this as `(status = 'succeeded') = (paid_at IS NOT NULL)` made the
  -- two constraints contradict each other and refunding anything impossible —
  -- found by refunding something, not by reading the SQL.
  ADD CONSTRAINT payments_received_has_timestamp
    CHECK (
      CASE
        WHEN status IN ('pending', 'failed') THEN paid_at IS NULL
        ELSE paid_at IS NOT NULL
      END
    ),
  ADD CONSTRAINT payments_failed_has_timestamp
    CHECK ((status = 'failed') = (failed_at IS NOT NULL)),
  ADD CONSTRAINT payments_refunded_has_timestamp
    CHECK ((status = 'refunded') = (refunded_at IS NOT NULL)),
  -- A refund reverses something that arrived, so it keeps its original date.
  ADD CONSTRAINT payments_refund_was_received
    CHECK (refunded_at IS NULL OR paid_at IS NOT NULL),
  ADD CONSTRAINT payments_metadata_is_object
    CHECK (jsonb_typeof(metadata) = 'object');

ALTER TABLE "payment_methods"
  ADD CONSTRAINT payment_methods_name_present CHECK (length(btrim(name)) > 0);

ALTER TABLE "deals"
  ADD CONSTRAINT deals_paid_non_negative CHECK (paid_minor >= 0);

ALTER TABLE "customers"
  ADD CONSTRAINT customers_lifetime_value_non_negative CHECK (lifetime_value_minor >= 0),
  -- Both dates or neither, and the first purchase cannot follow the last.
  ADD CONSTRAINT customers_purchase_dates_pair
    CHECK ((first_purchase_at IS NULL) = (last_purchase_at IS NULL)),
  ADD CONSTRAINT customers_purchase_dates_ordered
    CHECK (first_purchase_at IS NULL OR first_purchase_at <= last_purchase_at);

-- ──────────────────────────────────────────────────────────────────────────────
-- Granting the two new permissions to the system roles that should already have
-- them.
--
-- A permission added to the catalogue reaches a NEW workspace through
-- `SYSTEM_ROLE_TEMPLATES`, and reaches an EXISTING one through nothing at all:
-- its roles were seeded before the key existed, so the feature is invisible
-- until somebody edits a role by hand. That is how `payment:read` 403'd for the
-- owner of a seeded workspace five minutes after being written.
--
-- So every step that adds a permission ends with a data migration like this one.
-- It is deliberately narrow: only roles still marked `is_system`, only the codes
-- the templates name, only where the grant is absent, and with the scope the
-- template specifies. A workspace that has customised a role keeps its
-- customisation — the INSERT cannot overwrite an existing row.
-- ──────────────────────────────────────────────────────────────────────────────

INSERT INTO role_permissions (id, organization_id, role_id, permission_key, scope)
SELECT gen_random_uuid(), r.organization_id, r.id, g.permission_key, g.scope::data_scope
  FROM roles r
  JOIN (
    VALUES
      ('owner',           'payment:read',   'organization'),
      ('owner',           'payment:record', 'organization'),
      ('admin',           'payment:read',   'organization'),
      ('admin',           'payment:record', 'organization'),
      ('sales_manager',   'payment:read',   'branch'),
      ('sales_manager',   'payment:record', 'branch'),
      ('sales_executive', 'payment:read',   'own'),
      ('sales_executive', 'payment:record', 'own'),
      ('auditor',         'payment:read',   'organization')
  ) AS g(code, permission_key, scope) ON g.code = r.code
 WHERE r.is_system = true
   AND r.deleted_at IS NULL
   AND NOT EXISTS (
     SELECT 1 FROM role_permissions existing
      WHERE existing.organization_id = r.organization_id
        AND existing.role_id = r.id
        AND existing.permission_key = g.permission_key
   );
