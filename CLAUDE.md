# Working in this repository

Lead OS — a multi-tenant lead management / CRM / WhatsApp / marketing-automation platform.
**`docs/` is the contract.** If code and docs disagree, one of them is a bug; fix both in the
same change. Start at [docs/README.md](./docs/README.md); decisions live in `docs/decisions/`.

## Commands

```bash
pnpm bootstrap      # .env + install + docker deps + migrate + seed (idempotent)
pnpm dev            # API + web in watch mode
pnpm dev:worker     # outbox dispatcher + queue workers (nothing sends mail without this)
pnpm dev:scheduler  # trial lifecycle, invitation expiry, pruning
pnpm lint | typecheck | test | test:int | build
pnpm db:migrate | db:generate | db:seed | db:deploy
```

`pnpm test` is unit only (no database). `pnpm test:int` needs `DATABASE_URL_TEST` and includes
the tenant-isolation suite. Regenerate the Prisma client (`pnpm db:generate`) after any schema
change, or typecheck will fail confusingly.

## The six rules that matter most here

1. **Never write an unscoped query on a tenant table.** Use the injected `DbService`; it is
   already tenant-scoped. Cross-tenant work opts in explicitly with
   `withPlatformScope('why', …)`. Importing `@prisma/client` outside `packages/db` fails lint.
2. **New tenant-scoped model ⇒ follow the checklist in `packages/db/README.md`** — composite
   unique, composite FKs including `organization_id`, person-references via `Membership`, and
   register it in `TENANT_MODELS`. CI fails if the registry drifts.
3. **Every route declares its authorization** — `@Public()`, `@RequirePermission(...)` or
   `@NoPermissionRequired(reason)`. Anything else fails at boot, by design. Add
   `@RequireFeature(key)` when a plan feature is needed, and use `DataScopeService` rather than
   filtering by hand. After changing roles, grants, teams or branches, call
   `PrincipalService.invalidateOrganization()` or the old grants stay cached for five minutes.
4. **Nothing about a tenant is hardcoded.** Statuses, sources, pipelines, task types, roles,
   plans and limits are rows, not enums or constants. Code checks _permissions_, never role names.
5. **Events leave through the outbox, inside the same transaction as the write.** Handlers never
   call an external API; consumers are idempotent on `eventId`.
6. **Anything a business owner would want to see on a lead must be written to the timeline.**
   A feature that skips it is unfinished.

## Traps already paid for (don't rediscover these)

- **`AsyncLocalStorage.enterWith` does not propagate out of an awaited callee.** A Nest guard
  is awaited by the framework, so a principal set with `enterWith` inside it is invisible to the
  route handler — silently. The request middleware opens an empty scope with
  `tenantContext.runEmpty()` and the guard fills it via `setPrincipal()`; the store object is
  shared by reference, which is what makes it visible.
- **A `@Global()` module's own provider shadows the root module's override for the same token.**
  That produced a worker injected with an empty processor list — no error, just silence. Background
  processors are therefore passed to `WorkerService.start()` from the bootstrap, listed once in
  `processor.registry.ts`.
- **BullMQ rejects a custom job id containing `:`** (it reserves the character for key names). Use
  `outboxJobId()`; never build the id inline.
- **Job processors read their subject from `payload.aggregateId`**, not from a field inside
  `payload`. The envelope is stable; payload bodies change, and events emitted by an older release
  still have to process.
- **Prisma promises are lazy.** `tenantContext.run(ctx, () => db.x.find())` loses the context —
  the callback must be `async`. Covered by a test in `@leados/shared`.
- **`import type` breaks NestJS DI.** Injected classes must be runtime imports;
  `consistent-type-imports` is off for `apps/api` for exactly this reason.
- **`SetNull` on a composite FK** would null the NOT NULL `organization_id`. Use `Restrict`.
- **Nest hides boot errors** behind `process.abort()`; tests pass `abortOnError: false`.
- **ESM:** relative imports need `.js` extensions; use `import.meta.dirname`, not `__dirname`.
- **`prisma@latest` is currently an 8.0 RC** — Prisma is pinned to 7.10 deliberately.
- **Prisma 7 names generated row types `<Model>Model`** (`SessionModel`, not `Session`).
- **Integration tests need their own Postgres _and_ Redis database** (`DATABASE_URL_TEST`,
  `REDIS_URL_TEST`): rate-limit counters have 15-minute windows and outlive a test run.
- **Next injects a global, always-empty `<div role="alert" id="__next-route-announcer__">`.** An
  unscoped `[role="alert"]` locator in a browser check is ambiguous and may read the empty one, which
  looks exactly like an error notice that failed to render. Scope it (`main [role="alert"]`).
- **The dev loop needs SWC's ESM loader, not a require hook and not tsx.** NestJS DI reads
  `design:paramtypes`, which only exists with `emitDecoratorMetadata`. SWC emits it (see `.swcrc`);
  **esbuild, and therefore tsx, does not** — under tsx every constructor-injected dependency arrives
  `undefined` and the app dies with `Nest can't resolve dependencies of …`. And `-r @swc-node/register`
  is a CJS require hook that never applies to this ESM workspace at all. The working form is
  `node --watch --import @swc-node/register/esm-register src/main.ts`.
- **`apps/web` resolves imports like a bundler, not like Node ESM.** Relative imports there must
  have **no** `.js` extension — the exact opposite of every other package. `next build` fails with
  `Can't resolve './session.js'`; `tsc --noEmit` does not, so typecheck alone will not catch it.
- **A client component may not transitively import `next/headers`.** Server-action helpers and the
  `ActionState` type therefore live in two files: `lib/server-action.ts` (server) and
  `lib/action-state.ts` (client-safe). Importing the wrong one fails the build, not the typecheck.
- **The API's refresh cookie is scoped `Path=/api/v1/auth`.** Relayed through the web app unchanged,
  the browser stores a cookie it can never send back and every session dies after fifteen minutes,
  silently. `apps/web/src/lib/refresh-cookie.ts` rewrites the path; nothing else about it is touched.
- **The dev mailer logs at `debug`.** Boot the worker with `LOG_LEVEL=debug` or the invitation,
  verification and reset links are simply not in the log — and the flow looks broken when it worked.
- **Mail is only sent by a `ROLE=worker` process.** The outbox dispatcher lives with the workers, so
  an API-only process queues nothing: a manual test of any email flow needs the worker running too.
- **`pkill -f <pattern>` matches its own shell.** It kills the command chain it is part of (exit
  144), so anything after it in the same invocation never runs. Match on the child's own name
  (`pgrep -a next-server | … | xargs kill`) instead.
- **Fastify rejects an empty body when `content-type: application/json` is set**, with "Body cannot be
  empty…" — a 400 on every action endpoint that takes no payload, from any client that sets a default
  content-type. `allowEmptyJsonBody()` parses an empty body as `{}`. It must use Nest's
  `adapter.useBodyParser`, which also marks parsers as registered: Nest registers its own during
  `listen()`, _after_ bootstrap code runs, so `addContentTypeParser` — with or without
  `removeContentTypeParser` or `removeAllContentTypeParsers` first — loses the race and the app dies
  with `FST_ERR_CTP_ALREADY_PRESENT`.
- **The response envelope drops a paginated payload's sibling keys.** `{ items, pagination }` becomes
  `{ data, meta.pagination }`, and anything else the handler returned is silently discarded. Return a
  `meta` object for extra context; it is merged into the envelope's `meta`.
- **A queue processor that reads-then-writes one row needs the row lock.** The scoring queue runs at
  concurrency 10 and the same lead has several events in flight; two jobs read `score = 0` and both
  wrote `15`, leaving two score events worth 30 under a cached 15. Everything derived from existing
  rows — a running total, a `maxApplications` count, how much decay is already applied — must be read
  _after_ `SELECT … FOR UPDATE`, not before.
- **A `currency` custom field is stored as `{ currency, amountMinor }`, not a number.** Filtering
  `custom.budget` against a number compares an object and matches nothing, silently. The comparable
  sub-path is declared per type in `CUSTOM_FIELD_SPECS.comparablePath`; money filters take **minor
  units**, which the filter catalogue states per field.

- **A unique constraint on a partitioned table must contain the partition key.** `activities` is
  partitioned by `occurred_at`, so its primary key is `(id, occurred_at)` and its idempotency key is
  `(organization_id, source_event_id, occurred_at)`. That only works because `occurred_at` comes from
  the event — `TimelineService` requires it as an argument so no caller can pass `now()` on a retry.
  A cursor over `activities` must carry both halves of the key; an id alone selects the wrong page.
- **A month with no partition is worse than an error.** Rows land in `activities_default`, work fine,
  and then **block attaching the real partition** until they are moved. The
  `maintenance.activity-partitions` job creates months ahead and reports anything stranded.
- **Prisma cannot create a partitioned table.** Generate the migration with `--create-only`, then edit
  the `CREATE TABLE` by hand to add `PARTITION BY RANGE (...)`. Prisma's later diffs do not notice.
- **Prisma's next diff _deletes_ every hand-written database object.** Anything that cannot be
  expressed in `schema.prisma` — a composite FK spanning three columns, a GIN or expression index, a
  partial unique index, a trigger — is something `migrate diff` sees in the database, does not see in
  the schema, and drops. The step-2 migration was generated with six such `DROP`s at the top and they
  were applied: lead search fell back to sequential scans and the FK that makes "a lead in another
  pipeline's stage" unrepresentable was simply gone, with every test still green. **Read the
  generated SQL and delete the spurious drops**, then check
  `packages/db/src/schema-objects.int-spec.ts` covers the object — that suite is the only guard, and
  a new hand-written object that is not listed there is one Prisma will quietly remove later.
- **`prisma migrate dev` prompts and hangs in a non-interactive shell.** Use `prisma migrate deploy`
  (or `--create-only` then `deploy`) from scripts and agents.
- **Rebuild `@leados/db` and `@leados/shared` after editing them**, not just `db:generate`: the API
  typechecks against their `dist`, so a new model or export is invisible until `pnpm --filter … build`.
- **Every new tenant table needs its composite FK _and_ its own cross-tenant test.** The registry check
  catches an unregistered model; it cannot catch a missing composite FK. `leads_stage_in_pipeline_fk`
  also shows the other use for these: a composite FK on `(organization_id, pipeline_id, stage_id)`
  makes "a lead in another pipeline's stage" unrepresentable, which no application check can guarantee.
- **A test that names a model as a hypothetical breaks when the model becomes real.**
  `registry-check.spec.ts` asserted that `Lead` was unregistered; the day `Lead` was added, the test
  passed for the wrong reason. Use a deliberately fictional name.
- **A test that _finds_ its fixture instead of creating it passes for the wrong reason.** Two
  cross-tenant checks did `findFirstOrThrow` for "some other organization" and "a user who is not a
  member" — true only because earlier runs had left rows behind. On a freshly migrated database they
  failed, having never really tested anything. Create what a test needs.
- **A setup call whose status nobody asserts fails silently and takes the assertion with it.** A
  PATCH switching a rule to `round_robin` before it had a pool was rightly refused with a 422; the
  test ignored the response, asserted against the _old_ rule, and read a plausible wrong answer.
  Setup calls go through a helper that throws on a non-2xx.

- **The platform catalogue is reference data, not fixtures.** Without `permissions` and a plan,
  creating an organization fails on a foreign key. `seedPlatformCatalogue()` is called by both
  the dev seed and the test harness.

## Reporting work

Per `docs/implementation-roadmap.md`: what was completed, files changed, database changes, API
changes, UI changes, tests run, unresolved issues, and the single recommended next step. Never
report something as done that is not done.
