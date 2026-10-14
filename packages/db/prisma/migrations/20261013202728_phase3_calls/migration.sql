-- Phase 3 step 6 — call logging and the click-to-call abstraction (`FR-CALL-1..3`).
--
-- Prisma generated **fifteen** spurious statements in the middle of this file: two composite
-- foreign keys spanning three columns and thirteen GIN, trigram and partial indexes, none of which
-- can be expressed in `schema.prisma`. All fifteen were deleted by hand. The cut is statement by
-- statement, not "everything before the first CREATE TABLE": the `CREATE TYPE`s above them are
-- real, and on an earlier step cutting by region deleted two `ADD COLUMN`s with the drops.
--
-- Everything hand-written at the bottom is listed in `packages/db/src/schema-objects.int-spec.ts`.

-- CreateEnum
CREATE TYPE "call_direction" AS ENUM ('outbound', 'inbound');

-- CreateEnum
CREATE TYPE "call_status" AS ENUM ('dialing', 'completed', 'no_answer', 'busy', 'failed');

-- CreateEnum
CREATE TYPE "call_outcome_category" AS ENUM ('connected', 'no_answer', 'busy', 'wrong_number', 'not_interested', 'callback');

-- CreateTable
CREATE TABLE "call_outcomes" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "category" "call_outcome_category" NOT NULL,
    "requires_note" BOOLEAN NOT NULL DEFAULT false,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "call_outcomes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "calls" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "lead_id" UUID,
    "task_id" UUID,
    "direction" "call_direction" NOT NULL,
    "status" "call_status" NOT NULL DEFAULT 'dialing',
    "from_e164" TEXT,
    "to_e164" TEXT,
    "outcome_id" UUID,
    "duration_seconds" INTEGER,
    "notes" TEXT,
    "recording_url" TEXT,
    "recording_document_id" UUID,
    "provider" TEXT,
    "provider_call_id" TEXT,
    "outcome_prompted_at" TIMESTAMPTZ(6),
    "agent_user_id" UUID NOT NULL,
    "started_at" TIMESTAMPTZ(6) NOT NULL,
    "ended_at" TIMESTAMPTZ(6),
    "branch_id" UUID,
    "team_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "calls_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "call_outcomes_organization_id_is_active_sort_order_idx" ON "call_outcomes"("organization_id", "is_active", "sort_order");

-- CreateIndex
CREATE UNIQUE INDEX "call_outcomes_organization_id_id_key" ON "call_outcomes"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "call_outcomes_organization_id_name_key" ON "call_outcomes"("organization_id", "name");

-- CreateIndex
CREATE INDEX "calls_organization_id_lead_id_started_at_idx" ON "calls"("organization_id", "lead_id", "started_at" DESC);

-- CreateIndex
CREATE INDEX "calls_organization_id_agent_user_id_started_at_idx" ON "calls"("organization_id", "agent_user_id", "started_at" DESC);

-- CreateIndex
CREATE INDEX "calls_organization_id_started_at_idx" ON "calls"("organization_id", "started_at" DESC);

-- CreateIndex
CREATE INDEX "calls_organization_id_outcome_id_idx" ON "calls"("organization_id", "outcome_id");

-- CreateIndex
CREATE INDEX "calls_organization_id_task_id_idx" ON "calls"("organization_id", "task_id");

-- CreateIndex
CREATE UNIQUE INDEX "calls_organization_id_id_key" ON "calls"("organization_id", "id");

-- AddForeignKey
ALTER TABLE "call_outcomes" ADD CONSTRAINT "call_outcomes_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "calls" ADD CONSTRAINT "calls_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "calls" ADD CONSTRAINT "calls_lead_same_org_fk" FOREIGN KEY ("organization_id", "lead_id") REFERENCES "leads"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "calls" ADD CONSTRAINT "calls_task_same_org_fk" FOREIGN KEY ("organization_id", "task_id") REFERENCES "tasks"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "calls" ADD CONSTRAINT "calls_outcome_same_org_fk" FOREIGN KEY ("organization_id", "outcome_id") REFERENCES "call_outcomes"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "calls" ADD CONSTRAINT "calls_agent_same_org_fk" FOREIGN KEY ("organization_id", "agent_user_id") REFERENCES "memberships"("organization_id", "user_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "calls" ADD CONSTRAINT "calls_branch_same_org_fk" FOREIGN KEY ("organization_id", "branch_id") REFERENCES "branches"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "calls" ADD CONSTRAINT "calls_team_same_org_fk" FOREIGN KEY ("organization_id", "team_id") REFERENCES "teams"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ── Hand-written: what a logged call has to be able to say ──────────────────
--
-- Every check is written so that no sub-expression can be NULL while the row is accepted: a CHECK
-- that evaluates to NULL is *satisfied*, which is how an escalation claiming somebody was told when
-- nobody was once went straight in.

-- A call has to have been with *somebody*. Both numbers are nullable because which end is "us"
-- depends on the direction and a provider may not report its own, but a call with neither is a row
-- about nothing.
ALTER TABLE "calls"
  ADD CONSTRAINT "calls_has_a_number" CHECK (
    from_e164 IS NOT NULL OR to_e164 IS NOT NULL
  );

-- E.164 on both ends, the same shape `leads_phone_e164_format` uses — so a call logged against a
-- lead's phone can be matched to it, and a provider sending a national number is refused rather
-- than stored as a number nothing will ever join on.
ALTER TABLE "calls"
  ADD CONSTRAINT "calls_from_e164_format" CHECK (
    from_e164 IS NULL OR from_e164 ~ '^\+[1-9][0-9]{6,19}$'
  );
ALTER TABLE "calls"
  ADD CONSTRAINT "calls_to_e164_format" CHECK (
    to_e164 IS NULL OR to_e164 ~ '^\+[1-9][0-9]{6,19}$'
  );

-- Eight hours, as a typo guard rather than a business rule: somebody typing seconds into a minutes
-- box, or a provider reporting milliseconds, produces a call that reads as three weeks long and
-- poisons every average built on it.
ALTER TABLE "calls"
  ADD CONSTRAINT "calls_duration_sane" CHECK (
    duration_seconds IS NULL OR (duration_seconds >= 0 AND duration_seconds <= 28800)
  );

-- Time only runs forwards.
ALTER TABLE "calls"
  ADD CONSTRAINT "calls_ended_after_started" CHECK (
    ended_at IS NULL OR ended_at >= started_at
  );

-- A call that is over says when it ended; one still dialing cannot. A `CASE` rather than a
-- biconditional, because `status` has five values and only one of them is the open state.
ALTER TABLE "calls"
  ADD CONSTRAINT "calls_settled_has_ended" CHECK (
    CASE WHEN status = 'dialing' THEN ended_at IS NULL ELSE ended_at IS NOT NULL END
  );

-- A duration belongs to a call that connected. A no-answer lasting four minutes is a contradiction
-- somebody would later average into a report.
ALTER TABLE "calls"
  ADD CONSTRAINT "calls_duration_needs_completion" CHECK (
    duration_seconds IS NULL OR status = 'completed'
  );

-- A provider call id without a provider is unattributable, and a provider is the only thing that
-- makes the id unique.
ALTER TABLE "calls"
  ADD CONSTRAINT "calls_provider_pair" CHECK (
    provider_call_id IS NULL OR provider IS NOT NULL
  );

-- One recording, in one place. Both set is two answers to "where is it".
ALTER TABLE "calls"
  ADD CONSTRAINT "calls_one_recording" CHECK (
    recording_url IS NULL OR recording_document_id IS NULL
  );

ALTER TABLE "call_outcomes"
  ADD CONSTRAINT "call_outcomes_name_present" CHECK (length(btrim(name)) > 0);

-- ── Hand-written: the idempotency gate for a provider ──────────────────────
--
-- A telephony webhook is at-least-once like every other, so the same call event will arrive twice.
-- Partial, because every call logged by hand has no provider id at all and a complete unique index
-- would allow exactly one of them per workspace.
CREATE UNIQUE INDEX calls_provider_call_unique
  ON calls (organization_id, provider, provider_call_id)
  WHERE provider_call_id IS NOT NULL;

-- ── Hand-written: the lead's own call list, and "what did I do today" ──────
--
-- Partial on the live rows, because both screens filter deleted calls out and the Prisma-generated
-- indexes do not.
CREATE INDEX calls_live_by_lead
  ON calls (organization_id, lead_id, started_at DESC)
  WHERE deleted_at IS NULL AND lead_id IS NOT NULL;

CREATE INDEX calls_live_by_agent
  ON calls (organization_id, agent_user_id, started_at DESC)
  WHERE deleted_at IS NULL;

-- "Which inbound calls has nobody linked to a lead?" — the queue that exists because `lead_id` is
-- nullable, and the reason it is worth a partial index is that the answer should always be small.
CREATE INDEX calls_unlinked
  ON calls (organization_id, started_at DESC)
  WHERE deleted_at IS NULL AND lead_id IS NULL;

-- ── Hand-written: the nudge sweep's predicate ──────────────────────────────
--
-- `call.outcome-sweep` asks one question across every tenant: which calls were dialled from the
-- product and never had an outcome recorded? So it is keyed on `started_at` alone and **not**
-- prefixed by `organization_id`, unlike every other index on this table: a platform-wide sweep
-- cannot use an index whose leading column it does not filter on. Partial on `status = 'dialing'`,
-- which is what keeps it tiny — the set it indexes is the work that is outstanding right now, not
-- the call history, and `outcome_prompted_at IS NULL` narrows it further to the calls nobody has
-- been asked about yet — which is what makes a tick that finds nothing an indexed read of nothing.
CREATE INDEX calls_awaiting_outcome
  ON calls (started_at)
  WHERE deleted_at IS NULL AND status = 'dialing' AND outcome_prompted_at IS NULL;

-- ═══════════════════════════════════════════════════════════════════════════
-- `call:read` and `call:log` for the workspaces that already exist.
--
-- `SYSTEM_ROLE_TEMPLATES` is read when a workspace is *created*, so a new permission key reaches
-- new workspaces and nothing else — the trap `payment:read` paid for and `sla:read` repeated. This
-- inserts both grants for roles still marked `is_system`, at the scope the template gives them,
-- only where they are absent. `PrincipalService` then caches grants for five minutes, so a 403
-- continues until that expires.
--
-- The auditor gets `call:read` and **not** `call:log`: a read-only role that can dial a customer
-- is not read-only.
-- ═══════════════════════════════════════════════════════════════════════════

INSERT INTO "permissions" ("key", "module", "description", "supports_scope")
VALUES
  ('call:read', 'calls', 'View logged calls and their outcomes', true),
  ('call:log', 'calls', 'Log calls and dial from the product', true)
ON CONFLICT ("key") DO NOTHING;

INSERT INTO "role_permissions" ("id", "organization_id", "role_id", "permission_key", "scope")
SELECT gen_random_uuid(), r."organization_id", r."id", g.permission, g."scope"::"data_scope"
  FROM "roles" r
  JOIN (VALUES
          ('owner', 'call:read', 'organization'),
          ('owner', 'call:log', 'organization'),
          ('admin', 'call:read', 'organization'),
          ('admin', 'call:log', 'organization'),
          ('sales_manager', 'call:read', 'branch'),
          ('sales_manager', 'call:log', 'branch'),
          ('sales_executive', 'call:read', 'own'),
          ('sales_executive', 'call:log', 'own'),
          ('auditor', 'call:read', 'organization')
       ) AS g(code, permission, scope) ON g.code = r."code"
 WHERE r."is_system" = true
   AND r."deleted_at" IS NULL
   AND NOT EXISTS (
     SELECT 1 FROM "role_permissions" rp
      WHERE rp."organization_id" = r."organization_id"
        AND rp."role_id" = r."id"
        AND rp."permission_key" = g.permission
   );

-- ═══════════════════════════════════════════════════════════════════════════
-- The six call outcomes, for the workspaces that already exist.
--
-- Same reasoning as the grants above, and the same shape as `seedWorkingHours`' backfill: a
-- workspace created before this step has no outcome list at all, and a "log a call" form with an
-- empty required dropdown is a feature that looks broken.
-- ═══════════════════════════════════════════════════════════════════════════

INSERT INTO "call_outcomes" ("id", "organization_id", "name", "category", "sort_order", "created_at", "updated_at")
SELECT gen_random_uuid(), o."id", d.name, d.category::"call_outcome_category", d.sort_order, now(), now()
  FROM "organizations" o
  JOIN (VALUES
          ('Spoke — interested', 'connected', 10),
          ('Spoke — not interested', 'not_interested', 20),
          ('Asked to call back', 'callback', 30),
          ('No answer', 'no_answer', 40),
          ('Line busy', 'busy', 50),
          ('Wrong number', 'wrong_number', 60)
       ) AS d(name, category, sort_order) ON true
 WHERE o."deleted_at" IS NULL
   AND NOT EXISTS (
     SELECT 1 FROM "call_outcomes" c
      WHERE c."organization_id" = o."id" AND c."name" = d.name
   );
