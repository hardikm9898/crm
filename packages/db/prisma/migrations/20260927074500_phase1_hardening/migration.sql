-- Phase 1 hardening: database-level guarantees the ORM cannot express.
-- See docs/database-design.md §16 and docs/security.md §10.

-- ── 1. audit_logs is append-only (FR-AUD-2) ──────────────────────────────────
-- Production also connects as a non-owner role holding only INSERT/SELECT here
-- (see infra/runbooks/db-roles.md). The trigger makes the guarantee hold in every
-- environment, including local development where the app owns its tables.
CREATE OR REPLACE FUNCTION audit_logs_append_only() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_logs is append-only: % is not permitted', TG_OP
    USING ERRCODE = 'restrict_violation',
          HINT = 'Audit history is immutable by design (FR-AUD-2).';
END;
$$;

CREATE TRIGGER audit_logs_no_mutation
  BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION audit_logs_append_only();

-- ── 2. Case-insensitive email uniqueness ─────────────────────────────────────
-- The application lowercases on write; this stops "User@x.com" ever coexisting
-- with "user@x.com" if a code path forgets.
CREATE UNIQUE INDEX users_email_lower_key ON users (lower(email));
CREATE UNIQUE INDEX platform_users_email_lower_key ON platform_users (lower(email));
CREATE INDEX invitations_email_lower_idx ON invitations (organization_id, lower(email));

-- ── 3. Value constraints (docs/database-design.md §16.7) ─────────────────────
ALTER TABLE plans
  ADD CONSTRAINT plans_currency_format_chk CHECK (currency ~ '^[A-Z]{3}$'),
  ADD CONSTRAINT plans_price_non_negative_chk CHECK (price_minor >= 0),
  ADD CONSTRAINT plans_trial_days_chk CHECK (trial_days >= 0);

ALTER TABLE organizations
  ADD CONSTRAINT organizations_currency_format_chk CHECK (default_currency ~ '^[A-Z]{3}$'),
  ADD CONSTRAINT organizations_country_format_chk CHECK (country ~ '^[A-Z]{2}$'),
  ADD CONSTRAINT organizations_slug_format_chk CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$');

ALTER TABLE working_hours
  ADD CONSTRAINT working_hours_day_chk CHECK (day_of_week BETWEEN 0 AND 6),
  ADD CONSTRAINT working_hours_range_chk CHECK (start_minute >= 0 AND end_minute <= 1440 AND start_minute < end_minute),
  -- A row scopes to the organization, one branch, or one user — not several at once.
  ADD CONSTRAINT working_hours_single_scope_chk CHECK (NOT (branch_id IS NOT NULL AND user_id IS NOT NULL));

ALTER TABLE usage_counters
  ADD CONSTRAINT usage_counters_used_chk CHECK (used >= 0),
  ADD CONSTRAINT usage_counters_period_chk CHECK (period_start < period_end);

ALTER TABLE subscriptions
  ADD CONSTRAINT subscriptions_period_chk CHECK (current_period_start < current_period_end),
  ADD CONSTRAINT subscriptions_seats_chk CHECK (seats >= 1);

-- ── 4. Partial indexes for the hot paths that filter soft-deleted rows ───────
CREATE INDEX organizations_active_idx ON organizations (status, created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX memberships_active_idx ON memberships (organization_id, user_id) WHERE deleted_at IS NULL;
CREATE INDEX outbox_events_unpublished_idx ON outbox_events (occurred_at) WHERE published_at IS NULL;

-- ── 5. Dispatcher notification (ADR-0006) ───────────────────────────────────
-- Lets the outbox dispatcher wake immediately on write instead of waiting for its
-- next poll, while polling remains the durable path.
CREATE OR REPLACE FUNCTION outbox_notify() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('outbox_event', NEW.event_id::text);
  RETURN NEW;
END;
$$;

CREATE TRIGGER outbox_events_notify
  AFTER INSERT ON outbox_events
  FOR EACH ROW EXECUTE FUNCTION outbox_notify();
