# Working in this repository

Lead OS — a multi-tenant lead management / CRM / WhatsApp / marketing-automation platform.
**`docs/` is the contract.** If code and docs disagree, one of them is a bug; fix both in the
same change. Start at [docs/README.md](./docs/README.md); decisions live in `docs/decisions/`.

## Commands

```bash
pnpm bootstrap      # .env + install + docker deps + migrate + seed (idempotent)
pnpm dev            # all processes in watch mode
pnpm lint | typecheck | test | test:int | build
pnpm db:migrate | db:generate | db:seed | db:deploy
```

`pnpm test` is unit only (no database). `pnpm test:int` needs `DATABASE_URL_TEST` and includes
the tenant-isolation suite. Regenerate the Prisma client (`pnpm db:generate`) after any schema
change, or typecheck will fail confusingly.

## The five rules that matter most here

1. **Never write an unscoped query on a tenant table.** Use the injected `DbService`; it is
   already tenant-scoped. Cross-tenant work opts in explicitly with
   `withPlatformScope('why', …)`. Importing `@prisma/client` outside `packages/db` fails lint.
2. **New tenant-scoped model ⇒ follow the checklist in `packages/db/README.md`** — composite
   unique, composite FKs including `organization_id`, person-references via `Membership`, and
   register it in `TENANT_MODELS`. CI fails if the registry drifts.
3. **Nothing about a tenant is hardcoded.** Statuses, sources, pipelines, task types, roles,
   plans and limits are rows, not enums or constants. Code checks _permissions_, never role names.
4. **Events leave through the outbox, inside the same transaction as the write.** Handlers never
   call an external API; consumers are idempotent on `eventId`.
5. **Anything a business owner would want to see on a lead must be written to the timeline.**
   A feature that skips it is unfinished.

## Traps already paid for (don't rediscover these)

- **Prisma promises are lazy.** `tenantContext.run(ctx, () => db.x.find())` loses the context —
  the callback must be `async`. Covered by a test in `@leados/shared`.
- **`import type` breaks NestJS DI.** Injected classes must be runtime imports;
  `consistent-type-imports` is off for `apps/api` for exactly this reason.
- **`SetNull` on a composite FK** would null the NOT NULL `organization_id`. Use `Restrict`.
- **Nest hides boot errors** behind `process.abort()`; tests pass `abortOnError: false`.
- **ESM:** relative imports need `.js` extensions; use `import.meta.dirname`, not `__dirname`.
- **`prisma@latest` is currently an 8.0 RC** — Prisma is pinned to 7.10 deliberately.

## Reporting work

Per `docs/implementation-roadmap.md`: what was completed, files changed, database changes, API
changes, UI changes, tests run, unresolved issues, and the single recommended next step. Never
report something as done that is not done.
