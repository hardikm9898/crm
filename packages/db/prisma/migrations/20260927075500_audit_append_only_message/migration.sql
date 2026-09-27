-- The previous version raised with ERRCODE 'restrict_violation' (23001). Prisma maps
-- the 23xxx class to "Foreign key constraint violated", which hides the real reason and
-- would send anyone debugging this on a chase through the schema. Using the default
-- raise_exception code (P0001) surfaces our message verbatim instead.
CREATE OR REPLACE FUNCTION audit_logs_append_only() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_logs is append-only: % is not permitted (FR-AUD-2)', TG_OP;
END;
$$;
