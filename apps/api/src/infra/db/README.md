# infra/db

`DbService` is the only database handle the application gets, and it is **already tenant-scoped**.

- `db.client` is a Prisma client wrapped by the extension in `packages/db/src/tenant-scope.ts`. Every
  query against a model in `TENANT_MODELS` gains the current organization's filter, and a query with
  **no** tenant context **throws** rather than returning everything.
- Cross-tenant work opts in explicitly: `withPlatformScope('why', …)`, which requires a stated
  reason and appears in the audit trail of the code itself.
- Importing `@prisma/client` anywhere outside `packages/db` fails lint, so there is no second handle.

**Two traps live here.** Prisma promises are lazy, so `tenantContext.run(ctx, () => db.x.find())`
loses the context — the callback must be `async`; there is a test for it in `@leados/shared`. And
Prisma 7 names generated row types `<Model>Model` (`SessionModel`, not `Session`), which makes an
import error look like a missing model.

Adding a tenant-scoped model means following the checklist in `packages/db/README.md` — composite
unique, composite FKs including `organization_id`, person-references through `Membership`, and
registration in `TENANT_MODELS`. CI fails if the registry drifts from the schema.
