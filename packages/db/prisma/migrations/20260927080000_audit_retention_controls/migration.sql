-- Audit trail lifecycle (docs/security.md §10, FR-PRV-3).
--
-- Two requirements are in tension: the audit log must be tamper-proof, and privacy law
-- must still allow erasure. Resolution:
--   • UPDATE is forbidden, always. History is never rewritten.
--   • DELETE is forbidden unless the transaction explicitly opts in by setting
--     `app.audit_purge = 'on'` — which only the retention/DSR purge path does, and which
--     is itself an auditable operation.
--   • The organization foreign key RESTRICTs instead of CASCADEs, so deleting an
--     organization can never silently erase its trail.

ALTER TABLE audit_logs DROP CONSTRAINT "audit_logs_organization_id_fkey";
ALTER TABLE audit_logs
  ADD CONSTRAINT "audit_logs_organization_id_fkey"
  FOREIGN KEY ("organization_id") REFERENCES organizations("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE OR REPLACE FUNCTION audit_logs_append_only() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('app.audit_purge', true) = 'on' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'audit_logs is append-only: % is not permitted (FR-AUD-2)', TG_OP;
END;
$$;
