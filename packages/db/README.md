# @leados/db

Owns the database schema, migrations, the generated Prisma client, and **isolation layer 2**
— the tenant-scoping client extension.

## Why this package exists

Both the API and the workers need the same database access with the same tenant guarantees.
Putting the scoped client here means there is exactly one implementation of
"every query is filtered by organization", and no process can accidentally skip it.

## Contents

| Path                      | Purpose                                                                                                             |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `prisma/schema.prisma`    | The schema. Conventions in `docs/database-design.md` §1                                                             |
| `prisma/migrations/`      | Forward-only migrations, including hand-written SQL Prisma cannot express                                           |
| `prisma/seed.ts`          | Development seed: platform catalogue + two demo tenants                                                             |
| `src/client.ts`           | `createDbClient` (scoped — what applications use) and `createUnscopedDbClient` (migrations, seeds, isolation tests) |
| `src/tenant-scope.ts`     | The `$extends` definition that filters/stamps `organizationId` and refuses to run without a tenant context          |
| `src/tenant-models.ts`    | The registry of tenant-scoped vs platform models                                                                    |
| `src/registry-check.ts`   | Fails CI if a model with `organizationId` is not registered                                                         |
| `src/audit-purge.ts`      | The only sanctioned path to delete audit rows                                                                       |
| `src/testing/fixtures.ts` | Two-tenant harness for the isolation suite                                                                          |

## The four isolation layers (docs/security.md §3)

1. **Tenant context** — `tenantContext` (in `@leados/shared`), set from a verified principal.
2. **Scoped client** — this package. No context ⇒ the query throws.
3. **Database constraints** — `UNIQUE (organization_id, id)` plus **composite foreign keys**
   on every child row, so a row cannot reference another tenant's row even if application
   code is wrong. 12 such constraints exist today.
4. **Row Level Security** — Phase 12; the schema and roles are built for it.

## Commands

```bash
pnpm db:generate        # regenerate the client (required after schema edits)
pnpm db:migrate         # create + apply a migration in development
pnpm db:deploy          # apply pending migrations (CI, staging, production)
pnpm db:seed            # idempotent development seed
pnpm --filter @leados/db test      # unit tests (no database)
pnpm --filter @leados/db test:int  # isolation suite (needs DATABASE_URL_TEST)
```

## Adding a tenant-scoped model — checklist

1. Add the model with `organizationId String @map("organization_id") @db.Uuid`.
2. Add `@@unique([organizationId, id])` — the anchor other tables' composite FKs need.
3. Reference parents with a **composite** relation:
   `@relation(fields: [organizationId, parentId], references: [organizationId, id])`.
   Use `Restrict`, not `SetNull`, on composite FKs: `SetNull` would try to null the
   NOT NULL `organization_id`.
4. Reference people through `Membership` (`[organizationId, userId]`), not the global
   `User` table — that is what makes "assigned to a user in another tenant" impossible.
5. Lead every index with `organizationId`.
6. Add the model name to `TENANT_MODELS` in `src/tenant-models.ts`.
   _Forgetting this is caught by `registry-check` in CI, not by review._
7. `pnpm db:migrate && pnpm db:generate`, then extend the isolation suite.
8. **Read the generated SQL before applying it.** `prisma migrate diff` proposes dropping every
   object it cannot see in `schema.prisma` — partitioning, three-column foreign keys, GIN and
   expression indexes, partial unique indexes, triggers, checks. Delete those drops.
9. **List any hand-written object you add in `src/schema-objects.int-spec.ts`.** That suite asserts
   each one exists against a real database, and it is the only thing that stops step 8 being
   forgotten once. An object missing from it will be removed by some later migration with every
   test still green.

## Gotcha: Prisma promises are lazy

The scoping extension runs when a query is **awaited**, not when it is created, so the
tenant context must still be active at that point:

```ts
✗ await tenantContext.run(ctx, () => db.team.findMany());        // context already gone
✓ await tenantContext.run(ctx, async () => db.team.findMany());  // correct
```

Request and job handlers wrap the whole unit of work, so this only bites in tests and
ad-hoc scripts. It is covered by a test in `@leados/shared`.
