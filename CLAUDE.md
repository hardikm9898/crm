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
- **Zod's default messages are written for a developer, and they reached users.** "Too small:
  expected string to have >=4 characters" appeared under the phone box on the lead form, because the
  validation pipe maps `issue.message` straight onto the field-error contract. `installValidationCopy()`
  registers a global Zod error map that supplies human sentences; a schema that passes its own
  message still wins, which is why this is an error map rather than a rewrite of every DTO.
- **A server action resets every uncontrolled input in its form.** The action re-renders the server
  tree, the client form remounts, and a refused submission comes back empty — eight fields to retype.
  Echo the submission back in `ActionState.values` (`submittedValues(form)`) and set `defaultValue`
  from it.
- **An unindexed foreign key makes deletes quadratic.** Postgres indexes the _referenced_ side of an
  FK, never the referencing side. `leads.is_duplicate_of_id` and `leads.merged_into_id` point back at
  `leads` with `ON DELETE RESTRICT`, so every lead deletion scanned the whole table twice — invisible
  at demo scale, and a statement that never finished on the 100 k-lead fixture. Any new FK whose
  referencing columns are not already the prefix of an index needs one (`leads_duplicate_of`,
  `leads_merged_into`).

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
- **A browser check must wait for the right thing.** `waitForLoadState('networkidle')` returns
  immediately after a client-side navigation, so an assertion on `page.url()` reads the old URL —
  use `waitForURL`. And `waitForSelector('[role="alert"]')` matches Next's always-empty route
  announcer and resolves before the error has rendered, which is the same trap as reading it:
  scope it to `main [role="alert"]`.

- **The platform catalogue is reference data, not fixtures.** Without `permissions` and a plan,
  creating an organization fails on a foreign key. `seedPlatformCatalogue()` is called by both
  the dev seed and the test harness.

- **A cache generation keyed by `INCR` starts at 0, not 1.** `PrincipalService` caches a person's
  grants under `v<version>`, and `invalidateOrganization()` invalidates by `INCR`-ing that version —
  but `INCR` on a missing key produces **1**, so while the default for an absent key was also 1, the
  very first role change in a workspace's life wrote the version it was already caching under and
  the stale grants stayed live for the full five-minute TTL. Every later change worked. A
  once-per-workspace misfire, on the change somebody makes while setting the workspace up, is
  exactly the shape of bug that reaches production.
- **A dry run that only re-checks the schema lies.** The import's pre-flight validated each row with
  `createLeadSchema`, which knows a phone is 4–32 characters and nothing else — normalization needs
  the organization's country. So a column of `not-a-phone` reported "5 rows ready to import" and then
  failed all five. Anything the write path validates with information a schema does not have
  (the tenant's country, its statuses, its members) has to be checked by the **mapper**, which has
  that information, or the preview is a promise the import breaks.
- **A Fastify content-type parser is global, and the body is parsed before any guard runs.** Giving
  `text/csv` a 20 MB limit for the import upload therefore gave _every_ route a 20 MB sink, reachable
  unauthenticated by claiming that content type. `allowCsvUpload()` adds an `onRequest` hook that
  refuses CSV content types outside the import paths — before a byte of body is read. `text/plain` is
  deliberately not in the list: too many clients default to it.
- **Rendering a page must never run a mutation.** The wizard's screen showed the dry run by calling
  `POST /imports/:id/validate`, so every refresh re-ran a state transition — a state machine driven
  by the browser's reload button. The dry run has a read-only twin (`GET /imports/:id/check`) and the
  page uses that; the POST stays as the step a person takes.
- **`node --watch` reloads the API, not a worker you started separately.** A background run then
  executes the code you had before the fix, and the symptom is a result that contradicts the source
  in front of you — an error message from a layer you just changed, in a file written seconds ago.
  Restart the worker after touching anything a processor reaches. (And `pkill -f` on the worker
  pattern kills the shell chain it is part of; `kill <pid>` from `pgrep -af main.ts` does not.)
- **Excel executes a cell beginning `+`, so every exported phone number is tab-guarded.** `csvCell`
  prefixes a tab and quotes the value — visible in the file and deliberate, because `+919845012345`
  would otherwise be evaluated as a formula. `unguardCell` is its exact inverse, which is what makes
  "export, fix, re-import" work, and the pair is covered by a round-trip test.
- **An export's timestamps are rendered in the workspace's timezone, in `YYYY-MM-DD HH:mm`.** An ISO
  UTC string reads as a bug to everyone who is not a programmer, and a locale format with slashes is
  ambiguous. The chosen format is also one `parseSpreadsheetDate` accepts, so export → edit →
  re-import does not move every date; that function had to learn to drop a trailing time, because
  `14/02/2026 10:30` previously fell through to `new Date()`, which reads a day-first date as invalid
  and failed every dated row of a file a spreadsheet had written.
- **A non-UUID `:id` reached Prisma and came back as a 500.** `GET /leads/not-a-uuid` answered
  `invalid input syntax for type uuid` — on every `:id` route in the product, so a crawler or a stale
  bookmark filled the log with internal errors and hid the real ones. `UuidParamPipe` is a **global**
  pipe (not seventy-two `@Param('id', ParseUUIDPipe)` edits, so a route added later is covered) and
  it answers **404**: a malformed id and another tenant's id must be indistinguishable, or the shape
  of an id becomes an oracle.
- **A `?flag=true` query parameter cannot be `z.boolean()`.** A query string carries strings. The
  existing convention, `z.enum(['true','false']).optional().transform(v => v === 'true')`, also folds
  an absent parameter to `false` — right for `deleted`, wrong for any three-way filter, where absent
  means "both" and `false` silently returned only half the list. Keep `undefined` as `undefined`.
- **Two timeline entries written at the same instant need different types.** A converted person's
  history is the union of their lead's entries and their customer's (`FR-DEAL-4`), so
  `lead.converted` on one side and `customer.created` on the other — the same type twice reads as a
  duplicated row rather than as a handover. It also keeps the direct-creation case honest: somebody
  who was never a lead did not convert. Borrowing the lead vocabulary for customer edits
  (`lead.field_updated` on a customer) is the same mistake in a quieter form.
- **`humanise` has to split camelCase, not only snake_case.** An edit entry's `fields` list carries
  the API's property names, so a timeline read "Changed JobTitle" and "Changed billingLine1" — the
  field name a developer wrote, shown to a business owner. Found by asserting the sentence rather
  than the type.
- **A Playwright `waitForURL('**/customers/**')` also matches `/customers/new`.** The wait resolved
  before the form had been submitted, and every assertion after it read the form instead of the
  record it was supposed to have created — three checks passing for the wrong reason. Match the shape
  that distinguishes them (`/\/customers\/[0-9a-f]{8}-/`).
- **A Playwright locator handle goes stale the moment the page navigates.** `locator(...).all()` then
  iterating with `getAttribute` inside the loop times out on the second item. Collect the values
  first (`evaluateAll((nodes) => nodes.map(...))`), then navigate.
- **Subscription state and entitlements are cached in Redis for five minutes.** Editing
  `subscriptions` directly — which is the only way to un-expire a dev trial — changes nothing until
  `org:<id>:subscription-state` and `org:<id>:entitlements` are deleted. Writes answer
  `TRIAL_EXPIRED` in the meantime, which looks like a product bug and is the cache doing its job.
- **The storage port takes a `Buffer`, so a generated file is held in memory.** That is why the
  export row ceiling is 100 000 and the CSV is appended a page at a time (`csvRow`) rather than built
  from a 2D array of every cell. Streaming an object into storage is a port change that belongs with
  the S3 driver — not a limit to raise by editing the constant.

## Reporting work

Per `docs/implementation-roadmap.md`: what was completed, files changed, database changes, API
changes, UI changes, tests run, unresolved issues, and the single recommended next step. Never
report something as done that is not done.
