-- Phase 7 step 1 - the two website permissions reach workspaces that already exist.
--
-- Adding a key to PERMISSION_CATALOGUE grants it to NEW workspaces, because
-- SYSTEM_ROLE_TEMPLATES is read when a workspace is created and never again. Without this
-- migration, `website:read` answers 403 for the owner of every workspace provisioned before this
-- release - which is what `payment:read` did for five minutes once.
--
-- The check this file is required to have done first: `website:read` and `website:manage` are new
-- in this step and appear in no earlier migration, so unlike `integration:manage` (which had been
-- in the catalogue since Phase 1 and was therefore already granted in every workspace) this is NOT
-- a no-op. It was verified by seeding a workspace, deleting the grants, running this, and counting
-- them back.
--
-- PrincipalService caches a person's grants for five minutes, so a 403 can outlive this migration
-- by that much. That is the cache doing its job, not a failed migration.

-- The catalogue rows first: role_permissions.permission_key references permissions(key), so the
-- grants below cannot exist without them. seedPlatformCatalogue upserts the same two rows, which is
-- why this is ON CONFLICT DO UPDATE rather than DO NOTHING - whichever runs second should leave the
-- description the code states, not whichever text happened to land first.
INSERT INTO "permissions" ("key", "module", "description", "supports_scope") VALUES
  ('website:read', 'websites', 'View websites, their pages and their version history', false),
  ('website:manage', 'websites', 'Create and edit websites, publish them and roll them back', false)
ON CONFLICT ("key") DO UPDATE
  SET "module" = EXCLUDED."module", "description" = EXCLUDED."description";

-- Reading, for every system role whose template grants it: owner and admin get the whole catalogue,
-- marketing_manager builds the campaigns these sites are for, and auditor exists to read everything
-- and change nothing.
INSERT INTO "role_permissions" ("id", "organization_id", "role_id", "permission_key", "scope", "created_at")
SELECT gen_random_uuid(), r."organization_id", r."id", 'website:read', 'organization', now()
FROM "roles" r
WHERE r."is_system"
  AND r."code" IN ('owner', 'admin', 'marketing_manager', 'auditor')
  AND NOT EXISTS (
    SELECT 1 FROM "role_permissions" rp
    WHERE rp."role_id" = r."id" AND rp."permission_key" = 'website:read'
  );

-- Managing. Not auditor, by definition of the role.
INSERT INTO "role_permissions" ("id", "organization_id", "role_id", "permission_key", "scope", "created_at")
SELECT gen_random_uuid(), r."organization_id", r."id", 'website:manage', 'organization', now()
FROM "roles" r
WHERE r."is_system"
  AND r."code" IN ('owner', 'admin', 'marketing_manager')
  AND NOT EXISTS (
    SELECT 1 FROM "role_permissions" rp
    WHERE rp."role_id" = r."id" AND rp."permission_key" = 'website:manage'
  );
