-- Phase 3, step 2 — a corrective migration, written by hand.
--
-- `escalations_notified_somebody` shipped as `array_length("notified_user_ids", 1) >= 1`, which
-- does **not** do what it reads as: `array_length` on an empty array returns **NULL**, not 0, so
-- the CHECK evaluated to NULL — and a CHECK that evaluates to NULL is *satisfied*. An escalation
-- claiming somebody was told when nobody was went straight in.
--
-- `cardinality` returns 0 for an empty array, which is the function this constraint always wanted.
--
-- A separate migration rather than an edit to `20261007063218_phase3_sla`: that one has been
-- applied, and editing an applied migration leaves `prisma migrate dev` demanding a reset over a
-- checksum mismatch. Correcting forward is cheaper and leaves the history honest about the mistake.

ALTER TABLE "escalations" DROP CONSTRAINT "escalations_notified_somebody";
ALTER TABLE "escalations"
  ADD CONSTRAINT "escalations_notified_somebody"
    CHECK (cardinality("notified_user_ids") >= 1);
