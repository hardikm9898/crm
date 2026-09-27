# ADR-0005 — Custom fields as definition metadata + JSONB values

**Status:** Accepted · **Date:** 2026-09-27 · Relates to `FR-LEAD-3..6`, Rule 5

## Context

Every tenant needs different lead fields (budget/property type; course/qualification; treatment/
appointment). Creating a field must not require a migration or a deploy, yet fields must be
filterable, sortable, searchable, importable, exportable, usable in automation conditions and mappable
into WhatsApp template variables — and a 30-field list view must stay fast.

## Decision

`custom_field_definitions` (+ options, sections) holds the metadata; values live in a `custom_values
JSONB` column on the owning row, with a GIN (`jsonb_path_ops`) index for filtering and a
`custom_search_text` column folded into the search vector. Definitions marked `is_indexed` get a
concurrently-created **expression index** via a controlled admin job. All writes are validated against
the active definitions; unknown keys are rejected (or quarantined on ingestion).

## Consequences

**Positive:** zero DDL per tenant field; one row fetch returns the lead with all its custom values (no
joins); filtering works generically; the same metadata drives forms, imports, views, templates and
automation — one source, six consumers.
**Negative:** no database-level type enforcement (the application is the guardian, so its validation
must be airtight); sorting on non-indexed fields must be blocked to prevent table scans; JSONB is
slightly larger on disk; renaming a field key is a data migration (hence keys are immutable after
creation, labels are editable).

## Alternatives rejected

- **DDL per tenant field:** unbounded schema growth, lock risk on hot tables, violates Rule 5.
- **Classic EAV:** one join per displayed field; a 30-column list view becomes 30 joins — verified
  killer at this scale.
- **Typed value tables per type:** same join problem plus more code paths.
- **Document database for leads:** loses the relational integrity, composite-FK tenant isolation and
  reporting joins the rest of the product depends on.
