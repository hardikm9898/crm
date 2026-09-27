# ADR-0012 — Global user identity, tenant-scoped membership

**Status:** Accepted · **Date:** 2026-09-27 · Resolves an inconsistency in
`database-design.md` §4 · Discovered during Phase 1 step 1

## Context

Phase 0 described two incompatible things at once: a `users` table with
`UNIQUE (organization_id, lower(email))` (a user belongs to one organization) **and** a
`memberships` join table plus `FR-IAM-6` ("a user MAY belong to multiple organizations with
different roles; the UI MUST offer an org switcher"). Implementation forced the choice.

Making `users` tenant-scoped satisfies isolation neatly but cannot express multi-org
membership without duplicating people and their credentials. Making `users` global satisfies
`FR-IAM-6` but appears to weaken isolation: tenant rows would reference a global table, so a
composite foreign key could no longer prove that "the user this lead is assigned to belongs
to this organization".

## Decision

`users` is **global** (identity, credentials, MFA, sessions — a platform table), and
`memberships` is **tenant-scoped**, carrying per-organization state (status, default branch,
ownership).

The isolation problem is solved by making `memberships` the referent: it holds
`@@unique([organizationId, userId])`, and **every tenant row that points at a person points at
the membership**, not at the user:

```prisma
membership Membership @relation(
  fields: [organizationId, userId],
  references: [organizationId, userId],
  map: "team_members_membership_same_org_fk"
)
```

Assigning a lead, a task or a conversation to someone who is not a member of that
organization is therefore rejected by the database, not merely by a validation rule. Proven
by `tenant-isolation.int-spec.ts` ("blocks a team member whose membership belongs to another
tenant").

## Consequences

**Positive:** `FR-IAM-6` works with one account per person and one password to manage; the
isolation guarantee for person-references is _stronger_ than a plain `assigned_user_id` FK
would give; suspending a membership removes access to one organization without touching the
account; global email uniqueness makes login unambiguous.

**Negative:** one extra hop to resolve a user's name for a tenant row (mitigated by the
denormalized display fields the read models will carry); `users` holds cross-tenant PII, so
it is a platform table with the corresponding care in exports and DSR handling; deleting a
person means deleting memberships and, separately, the identity.

## Consequential doc changes

`database-design.md` §4 now describes `users` as global with `memberships` as the tenant
anchor, and the "Adding a tenant-scoped model" checklist in `packages/db/README.md` requires
person-references to target `Membership`.
