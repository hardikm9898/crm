-- Phase 3 step 3 — `/my/today`, the executive workspace (`FR-TSK-7`).
--
-- HAND-WRITTEN, and there is nothing generated in it: the screen reads rows that already exist and
-- stores nothing of its own, so `schema.prisma` is unchanged and `prisma migrate diff` had nothing
-- to propose — and therefore no spurious DROPs to strip this time.
--
-- What it adds is one partial index, which Prisma has no syntax for and will propose dropping on
-- every future diff. `packages/db/src/schema-objects.int-spec.ts` lists it; that suite is the only
-- thing standing between this index and the next generated migration.

-- "Which of the leads I can see has nobody spoken to yet?" — the Today screen's third section, and
-- the question behind every first-response SLA promise in the product.
--
-- Partial because the answer is a small, *shrinking* slice of a large table while the contacted
-- population it would otherwise be read past only grows. On the 100 k fixture the section's query
-- is 3.4 ms with this index and 10.7 ms without, and the gap widens with every lead somebody calls.
--
-- **`assigned_user_id` is deliberately not in the key**, although the query filters on it. The
-- screen asks for "mine, or whatever nobody has claimed" — an `OR` — and an `OR` cannot be a range
-- scan, so an index keyed on the assignee is simply not used for it: the planner falls back to
-- `leads_live_created_at` and filters eight thousand rows. Keyed on `created_at` instead, this one
-- is an ordered scan the `LIMIT` stops early, for both that shape and the plain equality an
-- own-scoped executive's data scope produces. Measured, not assumed.
CREATE INDEX leads_awaiting_first_contact
  ON leads (organization_id, created_at)
  WHERE deleted_at IS NULL
    AND first_contacted_at IS NULL
    AND converted_at IS NULL
    AND lost_at IS NULL;
