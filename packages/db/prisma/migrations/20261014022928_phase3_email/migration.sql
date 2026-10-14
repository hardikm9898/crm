-- Phase 3, step 7 — outbound email: the delivery log and the suppression list.
--
-- Prisma's diff arrived with **fifteen** spurious statements at the top: two three-column composite
-- FKs and thirteen GIN, trigram and partial indexes that earlier migrations added by hand. They are
-- objects `schema.prisma` cannot express, so `migrate diff` sees them in the database, does not see
-- them in the schema, and drops them. They have been removed statement by statement — and only the
-- `-- DropForeignKey` and `-- DropIndex` sections, because Prisma puts `ADD COLUMN` in the same
-- region and cutting the whole region once deleted two of those with it.
-- `packages/db/src/schema-objects.int-spec.ts` is the only thing that catches the ones missed.

-- CreateTable
CREATE TABLE "email_messages" (
    "id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "to" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "provider" TEXT,
    "provider_message_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "error" TEXT,
    "suppression_id" UUID,
    "queued_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sent_at" TIMESTAMPTZ(6),
    "delivered_at" TIMESTAMPTZ(6),
    "failed_at" TIMESTAMPTZ(6),

    CONSTRAINT "email_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email_suppressions" (
    "id" UUID NOT NULL,
    "identifier" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "detail" TEXT,
    "source_message_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_suppressions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "email_messages_to_queued_at_idx" ON "email_messages"("to", "queued_at" DESC);

-- CreateIndex
CREATE INDEX "email_messages_status_queued_at_idx" ON "email_messages"("status", "queued_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "email_suppressions_identifier_key" ON "email_suppressions"("identifier");

-- CreateIndex
CREATE INDEX "email_suppressions_created_at_idx" ON "email_suppressions"("created_at" DESC);

-- AddForeignKey
ALTER TABLE "email_messages" ADD CONSTRAINT "email_messages_suppression_id_fkey" FOREIGN KEY ("suppression_id") REFERENCES "email_suppressions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ═══════════════════════════════════════════════════════════════════════════
-- Hand-written: the webhook's idempotency gate.
--
-- A provider webhook is at-least-once like every other, and every event it sends names the
-- provider's own message id. Partial, because a send that was **suppressed** never reached a
-- provider and has no id at all — a complete unique index would allow exactly one of those
-- per provider, which is to say one in the platform's lifetime.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE UNIQUE INDEX email_messages_provider_message_unique
  ON email_messages (provider, provider_message_id)
  WHERE provider_message_id IS NOT NULL;

-- "What is still waiting to hear back?" — the operator's question, and the one a stuck provider
-- shows up in. Partial on the two live statuses, so the index is the outstanding work rather than
-- the whole history.
CREATE INDEX email_messages_in_flight
  ON email_messages (queued_at)
  WHERE status IN ('queued', 'sent');

-- ═══════════════════════════════════════════════════════════════════════════
-- Hand-written CHECKs.
--
-- Every one is written so that no sub-expression can be NULL while the row is accepted: a CHECK
-- that evaluates to NULL is *satisfied*, which is how an escalation claiming somebody was told
-- when nobody was once went straight in. The status rules are `CASE` expressions rather than
-- biconditionals, because `status` has seven values and a biconditional over more than two is how
-- two sensible constraints once made refunding a payment impossible.
-- ═══════════════════════════════════════════════════════════════════════════

-- The normalisation is enforced, not hoped for. `normaliseEmailAddress` lower-cases every address
-- before it is stored or compared; a row that skipped it would be a row the suppression list can
-- never match, and the mail would keep going out.
ALTER TABLE "email_messages"
  ADD CONSTRAINT "email_messages_to_normalised" CHECK (
    length(btrim("to")) > 0 AND "to" = lower("to")
  );

ALTER TABLE "email_suppressions"
  ADD CONSTRAINT "email_suppressions_identifier_normalised" CHECK (
    length(btrim(identifier)) > 0 AND identifier = lower(identifier)
  );

-- A shape check, not a validator: only the provider knows whether a mailbox exists. It is here so
-- a webhook that reports a bounce for something that is not an address cannot put it on the list
-- and quietly block nothing.
ALTER TABLE "email_suppressions"
  ADD CONSTRAINT "email_suppressions_identifier_is_an_address" CHECK (
    identifier ~ '^[^[:space:]@]+@[^[:space:]@.]+[.][^[:space:]@]+$'
  );

-- Something a provider accepted has a provider and an instant it was accepted at. A `failed` row
-- may have neither (the request itself was refused) which is why it is not in the list.
ALTER TABLE "email_messages"
  ADD CONSTRAINT "email_messages_sent_has_a_provider" CHECK (
    CASE
      WHEN status IN ('sent', 'delivered', 'bounced', 'complained')
        THEN provider IS NOT NULL AND sent_at IS NOT NULL
      ELSE true
    END
  );

-- A send we refused names the suppression that refused it, and did not happen. Both halves matter:
-- the first is what makes "why did this never arrive" answerable, and the second is what stops a
-- `suppressed` row from also claiming to have been sent.
ALTER TABLE "email_messages"
  ADD CONSTRAINT "email_messages_suppressed_is_explained" CHECK (
    CASE
      WHEN status = 'suppressed' THEN suppression_id IS NOT NULL AND sent_at IS NULL
      ELSE true
    END
  );

-- Time only runs forwards, and nothing is delivered before it is sent.
ALTER TABLE "email_messages"
  ADD CONSTRAINT "email_messages_delivered_after_sent" CHECK (
    delivered_at IS NULL OR (sent_at IS NOT NULL AND delivered_at >= sent_at)
  );
