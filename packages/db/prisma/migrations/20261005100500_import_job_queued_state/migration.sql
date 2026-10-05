-- Adds `queued` to an import job's permitted states.
--
-- A separate migration rather than an edit to `20261005074959_phase2_import_export`, which has
-- already been applied: a migration that has run is append-only, and editing one leaves every
-- database that applied it reporting a checksum that no longer matches the file.
--
-- Why the state exists at all: `queued` is the gap between "the person pressed Start" and "a worker
-- picked the job up". Collapsing it into `running` would make a queue backlog look like an import
-- that has been running for twenty minutes without touching a single row — and the first thing
-- somebody does about an import that appears stuck is upload the file again.
ALTER TABLE import_jobs DROP CONSTRAINT import_jobs_status;

ALTER TABLE import_jobs
  ADD CONSTRAINT import_jobs_status CHECK (
    status IN (
      'uploaded', 'mapped', 'validated', 'queued', 'running', 'completed', 'failed', 'cancelled'
    )
  );
