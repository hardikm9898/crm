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
- **A service method may not share its name with an injected dependency.** `async timeline()` beside
  `private readonly timeline: TimelineService` type-checks, and then the method shadows the property
  on `this` — every `this.timeline.record(...)` inside the class calls the method. The symptom is a
  DI-shaped error on a class whose dependencies are fine. Customers and deals both expose
  `GET :id/timeline` and both name the service method `journey()`.
- **A `catch` that renders an empty state hides a 400 forever.** `loadProducts` sent
  `?active=` (an empty string the enum refuses) and its catch turned the 400 into "No products
  yet" — a permanent, silent, workspace-wide lie, on a screen whose entire job is to list products.
  A loader whose failure is indistinguishable from an empty result needs a throwing twin
  (`loadProductsOrThrow`) on any screen where "none" is itself information.
- **An activity type with no describer renders nothing.** The timeline registry falls back to the raw
  type, so `deal.won` appeared as a bare row and the amount and the note in its payload — the two
  things a business owner opened the page for — never reached the screen. Adding an activity type is
  two edits (the constant and the describer); the first one alone passes every test.
- **UUIDv7 ids minted in the same millisecond share their prefix.** A test fixture naming itself
  `` `Pipeline ${id.slice(0, 4)}` `` collided on a unique index the moment two were created in one
  tick. Use the tail (`id.slice(-8)`), which is the random half.
- **The spurious-DROP count grows with every hand-written object.** The deals migration arrived with
  **ten** `DROP`s at the top — every composite FK, partial index, trigger and GIN index the previous
  migrations added by hand. Read the generated SQL, delete the drops, and leave the note saying why;
  `packages/db/src/schema-objects.int-spec.ts` is the only thing that catches the ones you miss.
- **A board or a filtered list must total the set, not the page.** A pipeline board that sums the
  twenty cards it loaded tells a business owner their pipeline is worth a fifth of what it is. Each
  column's `count`/`valueMinor`/`weightedMinor` is a separate aggregate over the whole column, and a
  deal list returns `meta.totalValueMinor` for the whole filter.
- **A copy table that overrides the API's message turns every refusal into a dead end.**
  `ERROR_COPY` in `apps/web/src/lib/api.ts` mapped `BUSINESS_RULE_VIOLATION` to "That is not
  allowed." and `describeError` preferred it — so "This deal's value comes from its line items",
  "Deactivate it instead" and "The counter is already at 3, it can be moved forward but not back"
  were all discarded, product-wide, in favour of four words that tell nobody anything. The table is
  now two: `ERROR_OVERRIDES` (session and access codes, where the API's text is for an integrator
  and must not be shown) wins over the API, and `ERROR_FALLBACKS` is used **only when the API sent
  no message**. A refusal the API wrote for a person is the one thing not to paraphrase.
- **A `uppercase` class changes what `innerText` returns.** A browser check asserting
  `/Total ₹/` against a `StatCard` matched nothing, because the label renders as "TOTAL" — and the
  assertion that compared two totals for equality passed by comparing `''` to `''`. Stat values
  carry `data-stat-value="<label>"` for exactly this; and an equality check between two scraped
  strings needs a non-empty assertion beside it, or it passes hardest when the scrape is broken.
- **A draft's content is in form inputs, not in `innerText`.** Two checks asserting that a quotation
  kept its terms and gained a line read the page's text and found neither, because an editable
  screen renders its values as `value=` attributes. Read them with `inputValue()` or
  `evaluateAll(n => n.value)`.
- **`waitForFunction` on a condition that is already true returns immediately.** A browser check
  saved a prefix and waited for `/BR-\d{5}/`, which the _previous_ run had already left on the
  page — so the wait returned before the save landed and the next click raced it. Wait for something
  this run produced (a unique value, a success message), not for a shape the screen might already
  have.
- **A cross-tenant sweep that writes a timeline entry must enter each tenant's context.**
  `withPlatformScope` leaves `tenantContext.organizationId()` unset, and `TimelineService` takes the
  organization from the context by design — so the quotation expiry sweep threw
  `TenantContextMissingError` on its first row. Read across tenants under `withPlatformScope`, then
  write inside `tenantContext.run(systemPrincipal(row.organizationId, newId()), …)`.
- **The test database needs its own `prisma migrate deploy`.** A new table exists in `leados` and
  not in `leados_test`, so every integration test reports `The table … does not exist` while the
  app works perfectly by hand. `DATABASE_URL=$DATABASE_URL_TEST pnpm --filter @leados/db exec
prisma migrate deploy` after generating a migration.
- **A PDF's text is not in the file as text.** An embedded TrueType subset writes glyph ids, so
  grepping a rendered PDF for its own total finds nothing and proves nothing. What a check can
  assert is the `%PDF-` header, the byte length, and — by inflating the streams and reading the
  `ToUnicode` CMap's `beginbfrange` array — the set of characters the document actually contains.
  That is how `₹` (U+20B9) was confirmed to render rather than to be a box.
- **Two CHECK constraints can contradict each other, and the database will let you install both.**
  `payments_received_has_timestamp` as `(status = 'succeeded') = (paid_at IS NOT NULL)` and
  `payments_refund_was_received` as `refunded_at IS NULL OR paid_at IS NOT NULL` are each sensible
  and together make refunding **impossible** — every refund fails with a constraint name. Nothing
  catches that until something exercises the transition, because neither constraint is wrong on its
  own. A status/timestamp rule over more than two statuses wants a `CASE`, not a biconditional.
- **Adding a permission to the catalogue does not grant it to an existing workspace.**
  `SYSTEM_ROLE_TEMPLATES` is read when a workspace is **created**, so a new key reaches new
  workspaces and nothing else: `payment:read` answered 403 for the owner of a seeded workspace five
  minutes after being written. Every step that adds a permission ends with a data migration that
  inserts the grant for roles still marked `is_system`, matching the template's code and scope, only
  where it is absent. And then `PrincipalService` caches grants for five minutes, so the 403
  continues after the migration until the cache expires.
- **`prisma migrate reset` is not available unattended, and it is not needed.** A migration that
  half-applied leaves its tables created and an unfinished `_prisma_migrations` row; dropping the
  objects it created and deleting that row by hand restores the state without touching the seeded
  data. Resetting a development database is still a destructive action that needs the user's consent.
- **Prisma puts `AlterTable … ADD COLUMN` in the same region as the spurious `DROP`s.** Cutting
  "everything before the first `-- CreateTable`" deleted the two `ADD COLUMN` statements along with
  the drops, and the migration failed on `column "paid_minor" does not exist`. Remove the
  `-- DropForeignKey` and `-- DropIndex` sections **only**.
- **A `<select>` does not come back from a refused submission.** `state.values` restores text boxes
  through `defaultValue`, and restores a select through nothing: a controlled `value={methodId}` with
  `useState('')` lost the method somebody had picked, and because the method decides whether a
  reference is required, the commonest path through the form recorded the payment with **no method
  at all**, silently. A controlled `value` did not fix it either — React re-created the options in
  the same commit and the DOM kept `selectedIndex: 0`, so the screen said "Not recorded" while the
  component thought otherwise. What works is `key={`method-${echoed}`}` with `defaultValue={echoed}`:
  the select remounts exactly when the echo changes, and is left alone while somebody is typing.
- **A settings list whose values live only in inputs is unreadable and unassertable.** Seven editable
  rows rendered as seven identical "Name" labels, and a browser check asserting `/Cheque/` against
  the page passed off the page's own description sentence. Each row now prints its name as text
  (`data-method-name`) above the editor — better to read, and the only thing a check can trust.
- **Adding a form to a page makes other forms' field selectors ambiguous.** A payments panel with a
  `name="note"` input broke a deal browser check that had been filling `input[name="note"]` for two
  steps — it resolved to two elements and waited forever on the hidden one. Scope a field selector to
  its form (`form:has(button:text("Confirm won")) input[name="note"]`).
- **A test that hard-codes the length of a product list breaks when the product grows.**
  `onboarding.spec.ts` asserted `['done','done','current','todo']` against a four-step wizard; step
  10 added three steps and the assertion failed with nothing about the function having changed.
  Assert against the list's own length (`ONBOARDING_STEPS.length`) when the list is content.
- **`prisma migrate dev` refuses to run after a migration file is edited post-apply.** It compares a
  stored checksum, so fixing a constraint in an already-applied migration (and applying the fix by
  hand) leaves "the migration was modified after it was applied" and a demand to reset. The repair
  is to re-record the checksum — `sha256sum` of the file into `_prisma_migrations.checksum`, in every
  database that has it — not to reset anything.
- **`prisma format` writes the back-relation for you, without the `@map` or the `onDelete`.**
  Declaring `organizations Organization[]` on a new platform model made Prisma add
  `industryTemplateKey String?` to `Organization` with no `@map("industry_template_key")` and no
  referential action. Read what `format` added before generating the migration.
- **A service that returns `{ items }` without `pagination` is passed through as the whole `data`.**
  The envelope interceptor lifts `items` only when `pagination` is present, so the catalogue endpoint
  answered `data: { items: [...] }` — which a test checking only the status code reports as green and
  every client reports as broken. Return `{ items, pagination }` from a list, always.
- **A `<label>`-wrapped controlled radio needs a moment before its button re-renders.** A browser
  check that `.check()`ed an option and immediately clicked "Set up <industry>" raced React: the
  button still carried the previous selection's name. Wait for the text the new selection produces.
- **`Detail` and `StatCard` labels are CSS-uppercased, and `innerText` returns the uppercase.** A
  check asserting `/Configuration/` against the custom-fields card found nothing while the card
  rendered perfectly — the second time this exact trap has cost a debugging session. Compare
  case-insensitively, or read a `data-` attribute.
- **The web app has no self-serve registration screen.** Sign-up is an API call; the screens begin at
  sign-in. A browser check that needs a fresh workspace registers over HTTP and then signs in through
  the form.
- **Inserting a child row takes a `FOR KEY SHARE` lock on its parent, so locking the parent
  afterwards deadlocks.** Two tasks created on the same lead at the same instant both held KEY SHARE
  on that lead (Postgres takes it for every FK, to stop the parent disappearing underneath the
  child), and then both asked for `FOR UPDATE` to recompute `leads.next_action_at` — a cycle, and
  Postgres killed one with a 500. Take the parent's `FOR UPDATE` **before** the insert, in a
  deterministic id order, and the second transaction queues instead. Every read-then-write on a
  denormalized parent column has this shape; `NextActionService.lockLeads` is the pattern.
- **`@leados/shared` may not be imported by `apps/web` runtime code at all.** Its entry point
  re-exports the tenant context, which reaches `node:async_hooks`, and a client component that
  transitively imports it fails `next build` with "the chunking context does not support external
  modules" — on whichever page happens to render it, not on the file that imported it. The same
  shape as the `next/headers` rule in the other direction. The web app hand-writes its own copy of
  a shared vocabulary (`TASK_BUCKETS` in `lib/tasks.ts`) and a **spec** reconciles the two, because
  a spec runs in Node and may import both.
- **A deep-linked panel must load its subject by id, not find it in the current page.**
  `/tasks?taskId=X` rendered its action panel by searching the loaded list, so the panel silently
  failed to open whenever the filter excluded the row — and the filter defaults to "mine", while the
  reminder notification that sends somebody there is often about a colleague's follow-up. A link
  into a filtered list has to fetch what it names.
- **`Number(null)` is 0, `Number('')` is 0, and 0 is often a meaningful value.** A JSONB array of
  reminder offsets that picked up a null, or a blank form field, silently became "remind me at the
  due moment" — the one time a spurious reminder is most confusing. A coercion used on untrusted
  input needs to refuse what `Number()` accepts, not reuse it.
- **A validation refusal is 400, not 422.** `AppError.validation` and a Zod schema failure both
  answer `400 VALIDATION_FAILED`; `AppError.businessRule` answers `422 BUSINESS_RULE_VIOLATION`. A
  test asserting 422 for a missing required field passes only by accident.
- **A CHECK constraint that evaluates to NULL is satisfied.** `escalations_notified_somebody` as
  `array_length(notified_user_ids, 1) >= 1` reads as "at least one recipient" and is not: on an
  **empty** array `array_length` returns NULL, the comparison is NULL, and Postgres lets the row in.
  An escalation claiming somebody was told when nobody was went straight through. `cardinality`
  returns 0 and is the function such a check always wants. The general rule is that every
  sub-expression of a CHECK has to be non-NULL for the check to bite — the same reason the
  status/timestamp pairs are written as `CASE`.
- **`working_hours` rows belong to a _person_ unless somebody writes workspace-wide ones.**
  Provisioning has written the owner's hours since Phase 1, and the assignment engine reads them to
  ask "is this person on shift". An SLA clock needs the **business's** hours, so
  `SlaCalendarService` filters `user_id IS NULL` — and found nothing, falling back to always-open
  and running every clock through the night. Silently: the feature looked built. `seedWorkingHours`
  writes the workspace-wide set and backfills existing workspaces.
- **Business-hours arithmetic must not truncate to the minute.** The day-walk clipped the first
  segment to the whole minute the lead arrived in, so a sixty-minute promise came due in
  fifty-nine — a business under-delivering against its own SLA, reaching a manager as a breach that
  arrived a minute early. Walk **instants**, clipped to the exact `from`, and convert each window
  boundary on its own local day (which is also what makes a DST day correct).
- **A test fixture shared between tests in one file trips the uniqueness rules it is not testing.**
  `sla_clock_subject_target_key` allows one clock per promise per lead, so a second test reusing the
  harness's lead failed on a constraint it had nothing to do with. Each test creates its own
  subject — the same lesson as "a test that finds its fixture passes for the wrong reason", one step
  earlier.
- **`psql` commits every statement as it goes.** A fixture script refused by a check constraint two
  thirds of the way down leaves the two thirds above it committed, and the next run inserts them
  again — `packages/db/perf/work-100k.sql` produced three copies of every follow-up that way, and
  the symptom was a row count three times what the script's own closing `SELECT` said it should be.
  `\set ON_ERROR_STOP on` stops the _script_, not the work it already did. Wrap a load script in
  `BEGIN; … COMMIT;` and guard its inserts with `NOT EXISTS` so a second run is a no-op.
- **A figure on a filtered screen that is not itself filtered is the recurring bug in this
  codebase.** `/oversight`'s headline median response time was raw SQL scoped only by
  `organization_id`, while every count beside it went through `DataScopeService` — so a branch
  manager would have read their branch's counts next to the whole workspace's median. The same
  shape as a board totalling its page, one layer down, and found the same way: by measuring on the
  100 k fixture and noticing the headline disagree with every row under it. Raw SQL does not pass
  through the tenant-scoping extension **or** the data scope; both have to be written out by hand.
- **A fixture with no _answered_ work exercises none of the arithmetic.** `work-100k.sql` created
  breached, at-risk and comfortable SLA clocks and nothing satisfied, so `/oversight`'s on-time rate
  and median — the only two numbers on that screen that cost anything — measured an empty set and
  came back `null` at a confident 118 ms. A fifth state was added. A performance fixture has to
  contain the rows the expensive query reads, not just the rows the cheap ones do.
- **A screen's figures and the links behind them belong in one definition.** "Every number has a
  drill-through to the filtered list behind it; a metric you cannot click is a dead end"
  (`frontend-architecture.md` §5.4), and a number rendered in one file with its destination written
  in another is a link that eventually shows a different count from the one that was clicked. The
  oversight columns carry label, hint, kind and an `href(person)` together, and a spec asserts every
  column produces one carrying that person's own id.
- **A column a feature reads has to be read by _one_ thing.** `notification_preferences` carried
  `quiet_hours` on a per-type row — one copy of the person's quiet hours per notification type,
  which is one copy per type that can disagree with the others. Quiet hours are a property of the
  **person**, so they live on `notification_settings` (one row per person per workspace) and the
  per-type row keeps only what is genuinely per-type. The contract said otherwise and the contract
  was the thing that was wrong; both were changed in the same commit.
- **A preference has to be enforced where every producer already goes**, which is one method, not
  five call sites. The quiet-hours and per-type gate lives inside `NotificationsService.create`
  because all five producers call it; a check in each would be five places to forget it and the
  sixth producer would ship without one. The cost is that `create` can answer `null`, which callers
  already had to handle for "not a member of this workspace".
- **Holding a notification creates a question that holding it cannot answer.** A warning written at
  21:40 about a follow-up finished at 08:15 must not arrive at 09:00 — it reads as the product being
  a day behind, which is worse than never having held it. So the release sweep re-checks each held
  row against its subject, by a `staleness` kind declared per type, and marks the ones that stopped
  mattering `superseded_at` rather than deleting them: "was I ever told?" then has an answer. A type
  with **no** registry entry is never stale, because a producer added without one should deliver and
  be noticed rather than disappear.
- **A deferred row's visibility must be a write, not the passage of time.** `deferred_until <= now()`
  as the inbox predicate makes a held notification visible _before_ anything has checked whether it
  still matters, so somebody opening the app at 07:00:10 reads the warning the 07:01 sweep was about
  to drop. The inbox filters `deferred_until IS NULL` and the sweep is the deliverer — which means a
  worker that is down holds notifications indefinitely, the same failure reminders and mail already
  have, and the reason that sweep runs every minute rather than every five.
- **An unread _count_ and the list it belongs to must share one predicate.** The inbox hides held
  and superseded rows; a `count` that forgot either would put a badge on a screen that shows nothing
  — the same shape as a board totalling its page, one layer down.
- **A reminder whose moment has already passed is dropped, not fired late**, and a fixture asking
  for one gets no row at all. `reminderInstants` filters on `remindAt > now`, so a task due in two
  minutes with a two-minute offset schedules **nothing** — the browser check waited 200 seconds for
  a notification that was never going to come. Give a reminder a moment genuinely in the future, and
  assert the `task_reminders` row exists before waiting on what it produces.
- **Postgres and Redis do not survive a long session.** Both went down mid-run with 14 GB of memory
  free and the whole integration suite reported as failed _suites_ — every spec failing in
  `beforeAll`, which looks like a code catastrophe and is a dead socket. `pg_isready` and
  `redis-cli ping` before concluding anything from a mass failure, and remember that the test
  harness needs Redis as much as Postgres (`REDIS_URL_TEST`).
- **An index keyed on a column an `OR` filters on is not used.** `/my/today` asks for "leads
  assigned to me **or** to nobody", and the obvious partial index —
  `(organization_id, assigned_user_id, created_at)` — was ignored outright: an `OR` cannot be a
  range scan, so with an `ORDER BY … LIMIT` the planner fell back to another index and removed
  eight thousand rows by filter. Keyed `(organization_id, created_at)` instead, the same partial
  index is an ordered scan the `LIMIT` stops early, and serves the plain equality an own-scoped
  caller produces as well. Both versions are correct; only one is fast, and nothing but
  `EXPLAIN ANALYZE` on the fixture says which.
- **A relative-time fixture drifts.** `work-100k.sql` writes due instants as `now() + 25 minutes`,
  so a measurement taken an hour after loading it finds nothing "due now" and an overdue section
  that has swallowed the lot — a different workload, measured confidently. Remove and reload before
  measuring; its inserts are guarded, so a bare re-run changes nothing.
- **A screen that is "mine" hides the rows nobody has claimed.** `/my/today` filtered on
  `assigned_user_id = me`, and a workspace with no assignment rule leaves every captured lead
  unassigned — so the new leads, and the first-response promises running out on them, appeared on
  **nobody's** Today. The leads at the greatest risk of never being called were the ones the screen
  hid. "Mine, plus anything unclaimed" is the predicate, and `applyScopeFilter` then narrows it
  correctly without a second rule: somebody scoped to their own rows cannot read an unclaimed row
  anyway. Found by the browser check — the only test that had not been handed an assignee, because
  every e2e fixture passes one.
- **Two `OR` keys at one level of a Prisma `where` silently replace each other.** An ownership
  predicate written as a bare `OR` and an SLA state predicate written as another both want the same
  key. Put one of them under `AND: [{ OR: [...] }]`; the planner does not care and the composition
  stops depending on which spread came last.
- **A sentence assembled from clauses needs a plural helper in every clause.** `/today`'s summary
  read "1 missed promises" in front of a browser check, because three of its four clauses used one
  and the fourth did not. A screen that cannot count to one reads as machine output, which is the
  one thing a hand-written sentence exists to avoid.
- **A section capped at ten rows needs somewhere to send the other nine thousand.** Today's
  new-leads list links to `/leads` — which does not read query parameters at all: that screen's
  state is the encoded filter DSL (`?f=firstContactedAt:is_null`) or a saved view id. Adding
  `?uncontacted=true` to `GET /leads` made the API agree and the screen ignore it. The field went
  into the **filter catalogue** instead, where it is also a saved view and a chip.
- **`lib/lead-format.ts` already has `telHref` and `whatsappHref`.** Both were written a second
  time, with different null-handling, in a new module forty lines long. The existing pair returns
  `null` for anything that is not E.164 — which is the behaviour a card wants, and not what a
  fresh implementation guesses.
- **`first_contacted_at` and `last_contacted_at` move in opposite directions.** Writing the first one
  only `WHERE first_contacted_at IS NULL` is right until somebody logs a backdated call: recording
  Monday's conversation on Wednesday has to _correct_ the column, or every "time to first response"
  figure says the business took two days longer than it did. So the first never moves **forwards**
  and the last never moves **backwards**, and both are written by `LeadContactService` — one writer,
  because a lead marked contacted by one channel with the promise still running from another is the
  silent version of the same bug.
- **A test built on a create response asserts against fields that are not there.** `POST /leads`
  answers the capture's own shape, which is not the detail presenter's, so
  `expect(created.firstContactedAt).toBeNull()` reads `undefined` — and on a column the create
  response _does_ happen to carry, the same test would pass for the wrong reason the day it stops.
  Read the resource back. The sibling of this is a **conditional assertion**: `if (clock) { expect(…) }`
  passes hardest on the day the clock is not created at all.
- **The route-authorization sweep's fixture has to be able to _reach_ the authorization check.** Its
  cross-tenant pass fails any parameterised route with no org-A id, which is the point — but an id
  pointed at a row whose state the endpoint refuses (`POST /calls/:id/outcome` on a call that is
  already settled) answers 422 before the guard matters, and the sweep records a refusal it never
  earned. Aim it at a row in the state the endpoint expects: a call that was _dialled_, not logged.
- **A cron does not fire with only the API and the worker running.** The repeatable jobs are
  registered by a **third** process — `pnpm dev:scheduler` — so a sweep verified by hand against an
  API and a worker alone waits for a tick that will never come, and the symptom is a feature that
  works in its integration test and appears dead over HTTP. The worker's own startup log lists the
  job names it will _consume_, which reads exactly like the job being scheduled.
- **`pnpm test:int -- calls` does not filter anything** — the argument lands past vitest's file
  pattern and the whole suite runs, which is three minutes before the first assertion you wanted.
  `cd apps/api && pnpm exec vitest run calls.e2e-spec` is the form that does.
- **Every registration sent two verification emails, for four phases, and nothing noticed.**
  `AuthService.register` emitted `user.registered` inside the transaction that creates the user —
  which is right, and the whole point of the outbox — and then called
  `requestEmailVerification`, which emits the same event again. Two links, the second superseding
  the first. It was invisible because **nothing recorded that a send had happened**: the delivery
  log added in step 7 found it on its first run against a real registration. The lesson is the
  general one, not the specific fix: a side effect with no record is a side effect nobody can count,
  and "it works" means "no one has looked".
- **A test that expects a captured lead to be unassigned depends on the clock.** The seeded
  round-robin rule assigns whoever is **on shift**, so a lead created inside the workspace's
  working hours comes back owned and one created at 06:00 IST does not. Two suites asserted
  `assignedUserId === null` straight after capture and passed for months because the runs happened
  to be outside business hours; they failed the first time the suite ran at midday. A test that
  needs an unclaimed lead has to _make_ one — `POST /leads/:id/assign` with `assignedUserId: null`
  is the real path and is time-independent.
- **A nullable `organization_id` puts a table half inside the tenant registry, which is worse than
  either side of the choice.** `findRegistryDrift` requires any model carrying the column to be in
  `TENANT_MODELS`, where the scoping extension filters `organization_id = :current` — so the rows
  that legitimately have no workspace (a password reset's delivery record, a bounced mailbox) become
  invisible to every read. `email_messages` and `email_suppressions` are therefore platform tables
  with no such column at all. The registry does not model "a table with both tenant and platform
  rows" on purpose: such a table is two tables whose guarantees differ.
- **A CHECK that says what belongs in a table and a service that writes something else disagree
  silently until something exercises the path.** `email_suppressions_identifier_is_an_address` says
  the list holds mailboxes; the sender's first draft tried to put `not-an-address` on it with reason
  `invalid`, and every unit test passed. The e2e found it on the first send. When a constraint
  refuses what a service intends, one of them is wrong — here it was the service, and the honest
  answer was `failed` with the reason recorded rather than a list entry nothing could ever match.
- **Email suppression is not one rule, and treating it as one locks people out of their accounts.**
  A hard bounce stops everything (the mailbox is gone). A **complaint** is a request to stop being
  _contacted_ — not consent to be denied the password reset they ask for thirty seconds later. So
  `suppressionStops(reason, kind)` is the one decider, `email_verification`, `password_reset` and
  `security_notice` are exempt from the gentler reasons, and an unknown reason takes the gentler
  branch: a thing nobody classified should be noticed, not disappear.
- **A browser check must use `localhost`, not `127.0.0.1`.** Against `127.0.0.1:3000` the login form
  submitted as a native GET with the password in the query string — the client bundle had not
  hydrated — and the check failed with a URL that explains itself only if you read it closely.
- **A service handed an _unscoped_ transaction reads every workspace's rows.** `SlaService.startForLead`
  takes the `tx` its caller is already inside and reads the active SLA policies off it, which is
  right in production — the caller's transaction comes from the tenant-scoped `DbService`. A test
  that drove it through the e2e harness's **unscoped** client matched somebody else's policy and
  died on `sla_clocks_policy_same_org_fk`: the composite FK caught what the missing scope would
  otherwise have written. An integration test that calls a service directly has to enter the
  context _and_ use `ctx.app.get(DbService).client`, or it is testing a client the product never
  uses.
- **Tapping a `tel:` link wedges the tab in headless Chromium.** The navigation is aborted rather
  than handed to a dialler, and after that no click runs a React handler again — not after a
  reload, not after a fresh `goto`. A second tab in the same context is fine, which is how you know
  it is the harness and not the screen. A browser check that taps [Call] therefore continues in a
  new tab, which is also the honest stand-in for putting the phone down. The same will apply to
  `wa.me` and `mailto:`.
- **Prisma's interactive transactions time out after five seconds, and the capture transaction can
  reach it.** `LeadsService.create` does the whole of `FR-CAP-4` in one transaction — the insert,
  the touchpoint, two history rows, the assignment engine (which takes a row lock, so two
  simultaneous captures queue), the SLA clock, the timeline, the audit row and the outbox events.
  A cold process answering its first form submission took 5.8 s, Prisma aborted, and **the lead was
  lost with a 500**. It was visible only because `form_submissions` had already stored the payload,
  which is the whole argument for `FR-CAP-3`. Both capture transactions now pass
  `CAPTURE_TRANSACTION` (20 s, with the reason written beside it): a capture is the one write whose
  failure costs a lead the business has already paid for.
- **A browser-side `fetch` has to go through `apiBaseUrl()`.** The public form is the first thing
  in this app that calls the API from the **visitor's** browser, and it works because
  `NEXT_PUBLIC_API_URL` is public precisely for that: a value only the container network can
  resolve would fail, and inside an `<iframe>` on somebody else's domain there is no same-origin
  fallback worth guessing. Reaching for a second environment variable with a new name — the first
  draft invented `NEXT_PUBLIC_API_ORIGIN` — is how a deployment ends up with two answers to one
  question, one of them unset.
- **A stored option value is not the answer somebody gave.** The submissions list read "Which
  service: interiors" back to the person who had written that dropdown — the wire format of their
  own choice, the same mistake as a timeline reading "Changed billingLine1". Anywhere a `select`'s
  answer is displayed, map the value back to its label, from the form's own override or from the
  definition.
- **An HMAC cannot be verified against a hash of the secret.** The public lead API's first draft
  stored `sha256(secret)` by analogy with a password, and could not have worked: recomputing an
  HMAC needs the secret itself, which is what "shared secret" means. A receiver of signed requests
  stores the secret **encrypted** (`EncryptionService`, with the row's own id as AAD) and says so,
  rather than keeping a digest nothing can use. `api_keys_secret_is_encrypted` refuses a value that
  is not an envelope — and refuses one beginning `sk_`, which is exactly what the mistake looks
  like. `EncryptionService`'s envelope is dot-separated (`v1.1.iv.tag.ciphertext`), not
  colon-separated: a CHECK written for `v1:%` refused every row.
- **A unique constraint on a partitioned table cannot be the idempotency lookup.** It has to
  contain the partition key, so `inbound_payloads`' unique is
  `(organization_id, channel, idempotency_key, received_at)` — which makes it a race guard and not
  a point read: the same key next month would be allowed. The replay guarantee therefore lives in
  `idempotency_keys`, which is **not** partitioned and stores the first **response** so a client's
  retry gets the answer it missed, including the lead id.
- **Advice on a screen has to be shown when somebody can take it.** Today's summary offered "a good
  moment to call the leads nobody has reached" under the condition "no other clause is true" — and
  the uncalled-lead clause is itself one of those clauses, so the suggestion appeared **only** on
  days when there were none of them. The same sentence also read "0 follow-ups left today · 1
  overdue", a nought beside a contradiction, because the first clause was pushed unconditionally.
  Both were invisible to the existing browser check, whose "omits what is zero" assertion tested
  `/ 0 /` against a string whose zero was the first character. A sentence assembled from clauses
  needs a test per shape, not per clause.

- **A timestamp that is half of a key must be a precision the application can express.**
  `inbound_payloads` is partitioned by `received_at` (`timestamptz(6)`) and its primary key is
  `(id, received_at)`; a JavaScript `Date` is milliseconds. A row inserted by raw SQL — a fixture, a
  backfill — therefore carries microseconds the application can read but cannot write back, so
  `update({ where: { id_receivedAt } })` failed with "no record was found" on a row sitting in front
  of it. Postgres refuses to alter the type of a column named in a partition key, so the column is
  not the thing to change: a status update keyed on the **id alone** (`updateMany`, with the per-org
  unique making it the same row) cannot be defeated by a precision we do not control. The composite
  FK on `ingestion_errors` still needs the parent's exact instant, which is why the service is the
  only thing that writes `received_at`.
- **A recorder of failures must not be able to fail the request.** `recordFailure` wrote the
  `ingestion_errors` row and the payload's status — and when its own write threw, the throw replaced
  the 400 that said what was actually wrong with a **404 about the payload**, so the screen told
  somebody their stored payload did not exist. What a caller needs from such a method is the
  original error: the explanation is best-effort, its own failure is logged, and the diagnosis
  survives.
- **A form whose success removes its own row cannot report success from its own state.** The replay
  button's confirmation was never visible: a successful replay revalidates the screen, the payload
  leaves the "did not become leads" list, and the component is unmounted with its `useActionState`.
  The confirmation belongs in the re-rendered server tree — the payload's own row now reads "Tried
  again just now — it became a lead", which also survives a refresh and is the honest record. A
  refusal keeps the row, so its notice stays where it is.
- **A one-click "make this a field" is half a feature until something maps to it.** `FR-CAP-5`'s
  button creates a custom field from an unmapped payload key; an integration sending `propertyType`
  at the top level would then have gone on being unmapped forever, because the mapper only ever
  looked inside `customFields`. The button and the mapper now share one derivation
  (`customFieldKeyFor`), so the field somebody makes is the field the next payload fills in — and
  the value is validated against the definition first, because otherwise making it a `number` field
  turns every capture that worked yesterday into a 400.
- **A dry run has to run the step it is previewing.** The test tool echoed the phone number as sent,
  so a payload the endpoint would refuse for an unreadable number was shown as "what would be
  saved" — the import's lie in a new place. It now normalises through `normalizeContactNumbers` and
  refuses through `buildDisplayName`, the same two functions the write path uses, and answers
  `wouldCreate` honestly with the phone as stored beside the phone as sent.
- **A `@Public()` route may not read a tenant table with the scoped client.** The integration
  framework's inbound door (`POST /wh/:provider/:connectionId`) looked its connection up with
  `db.client`, which throws `TenantContextMissingError` when no principal has been set — so **every**
  inbound request answered 500, including the unsigned ones, before any signature was checked, and
  the generic `INTERNAL_ERROR` body said nothing about why. The URL is the only thing that says which
  workspace such a request belongs to, exactly as the public lead API's path key is, so the read is
  `withPlatformScope('why', …)` and the write that follows enters
  `tenantContext.run(systemPrincipal(organizationId, newId()), …)`.
- **`prisma format` writes a back-relation without its `@relation` name, and then refuses to
  validate the schema it just wrote.** Declaring `connectedIntegrations` on `Membership` for a named
  relation produced an unnamed `integrationConnections IntegrationConnection[]`, and the next
  `validate` failed on the relation it had added itself. Read what `format` added — it has done this
  twice now, the other time omitting an `@map` and an `onDelete`.
- **A partial unique is what lets something be reconnected.** `integration_connections_live_provider`
  is `(organization_id, provider) WHERE disconnected_at IS NULL`. A plain unique on
  `(organization_id, provider)` reads identically in a schema review and stops a workspace **ever**
  reconnecting a provider they disconnected, which is the commonest thing anybody does to an
  integration. Prisma cannot express it, so it is hand-written and therefore in
  `schema-objects.int-spec.ts`.
- **A permission in the catalogue since Phase 1 needs no backfill, and a migration that says it does
  is worse than none.** `integration:manage` was already granted in every workspace, because owner
  and admin templates grant the whole catalogue at creation — so the grant migration written out of
  habit inserted nothing and its comment claimed otherwise. Check
  `SELECT count(*) FROM role_permissions WHERE permission_key = '…'` before writing one; a verified
  no-op migration is removed (directory **and** its `_prisma_migrations` row in every database),
  not left in place.
- **A form whose fields repeat cannot echo its submission through `submittedValues`.** It keeps one
  value per name, so a mapping editor submitting `mapSource` once per row came back from a refusal
  with the last row and silently dropped the others — the same trap the webhook event picker paid
  for with checkboxes. Echo the whole collection explicitly (`values: { mapping: JSON.stringify(…) }`)
  and rebuild the rows from it.
- **A screen that shows only the API's summary message discards the sentence somebody can act on.**
  The mapping editor rendered "That field mapping cannot be used" and dropped the per-entry details —
  including "two fields both write to phone, the one lower down would quietly win", which is the
  problem a schema cannot see. Field errors arrive as `[{ field, code, message }]`; print each one
  against the row it names. Same lesson as `ERROR_COPY`, one layer in.
- **A CHECK that pairs an outcome with a measurement must be written in the one direction that is a
  contradiction.** `integration_health_checks_ok_was_timed` says a successful probe carries a
  latency. Its mirror ("a failed probe carries none") reads just as sensibly and is **false**: a
  provider that answered and refused is reached, timed and not working. That is why the outcome
  vocabulary has both `degraded` (answered, timed) and `unreachable` (nothing answered, no latency),
  and why the two escalate identically — the difference between them is diagnostic, not a severity.
- **An e2e assertion straight after a request can race a buffered writer.** `api_logs` is flushed
  after a second or a hundred rows, so a check reading it immediately passed or failed on how long
  the assertions above it happened to take. Call `ApiLogService.flush()` first; a buffer is a design
  decision, not something to sleep around.
- **A test that reaches for a fixture another test created depends on the order the file runs in.**
  The inbound-door tests used the connection a different `describe` had connected, so they passed in
  a full run and failed under `-t`. Three of them also read the "already connected" 422 instead of
  the refusal they were testing, because the workspace they used already had that provider. Give
  such a group its own workspace and its own subject.
- **The envelope lifts `items` into `data`, so a list's `data` is the array.** A test reading
  `data.items` from `GET /integrations` read `undefined` and failed with "cannot read properties of
  undefined" rather than with anything about the endpoint. `{ items, pagination }` becomes
  `data: [...]` with `meta.pagination` beside it.
- **A capability derived from a near-synonym is right until the provider that breaks the synonym
  arrives.** "Does this provider have an inbound door" was read off `authKind === 'shared_secret'`,
  which was true for both providers that existed — and Meta Lead Ads holds a token we **send** and
  also posts to us, so its own callback URL would have answered 404. The question is
  `inboundVerification`; the auth kind is a different fact that happened to correlate. A provider
  declares each capability separately and the registry's boot check reconciles the declaration
  against the adapter, so a mismatch is a failed startup rather than a 500 on the first delivery.
- **An ESM import cycle between two Nest services is a `ReferenceError` at boot, not a type
  error.** `integration-health.service.ts` imported one function from `integrations.service.ts`,
  which imports the health service, and the app died with "Cannot access 'IntegrationHealthService'
  before initialization" — nothing in either file looks wrong and `tsc` is silent. Shared constants
  and pure helpers belong in their own module (`adapters/secret-names.ts`), which is usually where
  they belonged anyway.
- **A secret that one half of the system generates and the other half verifies must have its name
  in one place.** The service mints a `shared_secret` provider's secret under a key and the adapter
  reads it under a key; two literals in two files is the shape of bug where rotating works,
  verifying does not, and neither file looks wrong. `sharedSecretField(provider)` is the one
  definition.
- **A connection that needs two secrets must not put the second one in `settings`.** Settings are
  rendered on the screen, echoed back on a refusal and written into the audit log — the three things
  a secret must never be. The vault holds a **set** as one JSON envelope under the row's own id, and
  one envelope rather than one column per secret is what keeps "the app secret was rotated and the
  page token was not" out of the schema.
- **A secret is the one field a refused form must not echo back.** `ActionState.values` restores
  text boxes so eight fields are not retyped — but a secret restored into an input is a secret in
  the page's HTML, on a screen somebody may be sharing. Echo the name, the ids and the settings;
  leave the secret boxes empty and let them be retyped.
- **A provider's verification challenge must be answered outside the response envelope.** Meta
  compares the body of the `hub.challenge` response to the challenge it sent, so
  `{"success":true,"data":"1158201444"}` never confirms the subscription. `@Res()` without
  `passthrough` is how a handler opts out of the interceptor; a mismatch answers **403** rather than
  404, because the connection exists and a 404 sends somebody checking a URL they pasted correctly.
- **A webhook must be acknowledged before the work, not after it.** A provider that waits for us is
  a provider that **retries**: a two-second capture becomes a second delivery, and the idempotency
  ledger then absorbs a problem we created. Insert the ledger row, enqueue, answer 200 — and the row
  is what a retry sweep reads, because a job lost while a worker was down must not be a lead lost.
- **An idempotency ledger is keyed on the provider's own id, never on a hash of the body.** Meta's
  retry carries a different `time`, so a body hash makes it a new event; Google's retry is
  byte-identical, so a hash would work by luck. And the table holding that unique must **not** be
  partitioned: a unique on a partitioned table has to contain the partition key, which makes it a
  race guard that would allow the same id again next month. `inbound_payloads` is the never-lose
  store and `provider_events` is the ledger, and they are two tables because they answer two
  questions.
- **A provider's own test delivery must be acknowledged and then dropped.** Google Ads sends
  `is_test: true` with the literal lead id `lead_id_123` when somebody presses "Send test data". A
  4xx teaches a provider to disable the endpoint — which stops the real leads, silently — and
  capturing it puts a test lead in somebody's pipeline. Record it, answer 200, capture nothing.
- **An array of question/answer pairs has to be flattened by name before a mapping can reach it.**
  Meta sends `[{ name: 'full_name', values: ['Asha'] }]`; mapping that as `field_data.0.values.0` is
  an index that moves the day somebody reorders the form's questions. Flattening by the question's
  own stable key is also what makes a provider's `defaultMapping` writable, and therefore what makes
  a connection work the moment it is made. A question answered twice keeps **both** answers — taking
  the first discards something a person said — and a Google column is keyed by `column_id` rather
  than `column_name`, because the name is the wording and changes when the form is edited.
- **A provider's timestamp is not a column we can sort by.** Meta's `timestamp` is in **whole
  seconds**, and the first version of the WhatsApp ingestion wrote it into `messages.created_at` —
  which is the partition key *and* the inbox's sort order. Two messages in one second then tie, and
  "the latest message" became whichever row the planner happened to return: the conversation list
  showed the previous message as its preview, found by a test that sent two messages in the same
  second. `created_at` is **ours** (when the delivery arrived), `sent_at` is **theirs**, and the
  24-hour window is measured from `sent_at` because Meta's clock is the one that closes it. A
  provider-supplied instant in a partition key is also a provider's clock deciding which partition a
  row lands in.
- **A delivery that contains nothing for us must be acknowledged, and which door decides that cannot
  be a near-synonym.** The branch between "ledger the events and queue them" and "the body is one
  lead, capture it in the request" was read off `deliveryIsAReference` — true for Meta Lead Ads and
  false for everything else, which happened to agree until WhatsApp, whose payload carries the
  message in full *and* names its own events. A status receipt about a message we sent therefore
  fell through to the single-lead path and answered **400**, which is how Meta learns to disable an
  endpoint and stop delivering the messages a business is paying for. `deliveryShape`
  (`events | single_lead | none`) is declared per provider and reconciled against the adapter at
  boot — the second time this registry has paid for a derived capability, after
  `authKind === 'shared_secret'` standing in for "has an inbound door".
- **A globally unique column cannot be checked for a collision with the scoped client.**
  `whatsapp_numbers.phone_number_id` has no `organization_id` on purpose: it is the only thing an
  inbound delivery carries, so it must resolve a workspace. The connect path's "is this number
  already somebody else's" check read it through the tenant-scoped client, which cannot see the row
  that would collide — so the branch was dead and the real answer was a raw unique violation, a 500
  on a mistake with a sentence somebody can act on. The read has to be `withPlatformScope`, and the
  refusal a 422.
- **A test fixture that connects a provider makes a real request to that provider.** Connecting
  probes immediately (`probeQuietly`), so the route-authorization sweep's new `whatsapp_cloud`
  connection called **graph.facebook.com** from the test run — with a token that is not a token.
  `test/setup.ts` now defaults `META_GRAPH_URL` to a closed loopback port, which fails locally in
  milliseconds; the two suites that need a Graph API run one in-process and override it.
- **A `<select>` in a client component needs `key` + `defaultValue`, not `value`.** Third time: the
  WhatsApp default-agent picker is the payment-method lesson again. `key={`agent-${echoed}`}` with
  `defaultValue={echoed}` remounts the select exactly when the echoed value changes and leaves it
  alone while somebody is choosing.
- **Postgres refuses a regex repetition count above 255.** A CHECK written
  `name ~ '^[a-z0-9_]{3,512}$'` — Meta's own limit for a template name — installs happily and then
  answers `invalid regular expression: invalid repetition count(s)` on every insert: a 500 on a
  feature whose unit tests all passed, because the rule they tested was the TypeScript one. Write
  the shape as a regex and the length as a `length()` test.
- **A read-then-write on a status column loses the race at queue concurrency, and a conditional
  `UPDATE` is cheaper than the row lock.** Meta sends `sent`, `delivered` and `read` for one
  message within a second, the three jobs run together, and the version that read `status`, decided
  with `statusAdvances` and then wrote it let a late `delivered` overwrite `read` about one time in
  three — found by running the HTTP check twice, not by the e2e suite, which drives the jobs one
  after another. `UPDATE … WHERE status IN (statusesBeatenBy(next))` is atomic, needs no
  transaction, and its row count is the answer to "did it advance". The scoring queue paid for the
  same lesson with `SELECT … FOR UPDATE`; this is the cheaper shape when the decision is expressible
  as a predicate.
- **A status is a summary; a timestamp is a fact.** The same receipt ordering that must not move
  `messages.status` backwards must still write `delivered_at`: a `delivered` receipt that arrives
  after `read` means the message *was* delivered at 11:02, and skipping the stamp because the
  summary had been overtaken left the column null on a message everybody could see was delivered.
  Two writes, one unconditional and one conditional.
- **A row with two presenters is a row whose two readings diverge.** The thread's message list and
  the send endpoint's own answer were two inline mappings of `messages`, and only the second carried
  `sendAttempts` — so "tried twice" was true in the database, true in the send's response and absent
  from the list the screen renders. Found by asserting the HTTP list rather than the row.
  `whatsapp-presenters.ts` is the one mapping both use, in its own file because an import between
  two Nest services is the ESM cycle that is a `ReferenceError` at boot.
- **`text(form, 'field')` answers `undefined` for a field the form does not have**, and a branch
  written for `null` or `''` takes the wrong side. The composer's template picker is absent entirely
  when a workspace has no approved template, so `templateId === null || templateId === ''` chose the
  **template** branch with no template and the API rightly refused it — a Send button that did
  nothing but print "some details need correcting". Normalise with `?? ''` before branching.
- **WhatsApp's profile name is a display name, not a first name.** Storing "Asha Rao" in
  `first_name` makes every template greet her "Hello Asha Rao" — invisible until a template
  renders, because the lead list shows the full name either way. Split on the first space, which is
  as much as a display name can honestly be read for.
- **`@leados/shared` is one barrel, so a generic type name is a collision.** A second
  `TemplateStatus` (the WhatsApp one, beside `industry-templates.ts`'s) turns the whole package into
  a `TS2308` whose message names neither file's author. Prefix a vocabulary that is one provider's
  (`WHATSAPP_TEMPLATE_STATUSES`).
- **A notification type that must not be held needs `respectsQuietHours: false`, and the reason
  written beside it.** A WhatsApp reply that failed at 23:00 and is not noticed until 07:00 is eight
  hours of a customer waiting for an answer that never came — the cost of holding it is paid by
  somebody who is not the person being spared the ping. It is the only work notification in this
  product with that flag, which is why it says so in the registry.
- **A `message` key returned inside a handler's payload is not the envelope's `message`.** Three
  assertions read `body.message` and got `undefined`, because the envelope only lifts what
  `withMessage()` sets. The public lead API's family of endpoints deliberately carries its sentence
  **inside** the payload; whichever a handler does, the test has to look where that handler put it.

## Reporting work

Per `docs/implementation-roadmap.md`: what was completed, files changed, database changes, API
changes, UI changes, tests run, unresolved issues, and the single recommended next step. Never
report something as done that is not done.

- **Writing a module into a directory that already exists can silently delete a route.**
  `modules/webhooks/` held the **inbound** email webhook controller since Phase 3 step 7; writing
  the outbound webhook module's `webhooks.module.ts` over it removed `POST /webhooks/email` from
  the app — no error, no failing unit test, just an endpoint the provider posts to that answers 404.
  The route-authorization sweep caught it, because its fixture enumerates every declared route and
  the count dropped. Before writing into an existing module directory, read what is already there;
  a module file is a registry, and overwriting a registry loses whatever it registered.
- **A CHECK's mirror can be false even when the constraint is right.**
  `webhook_deliveries_pending_is_untried` refuses `pending` with a non-zero attempt count, which is
  a contradiction. The mirror — "anything not pending has been attempted" — reads just as sensibly
  and is wrong: a delivery whose endpoint was switched off between the fan-out and the attempt is
  abandoned as `exhausted` having never been sent, and the first version of the constraint made that
  honest state unrepresentable, so the service had to write a lie or fail. Write the direction that
  is a contradiction, not the biconditional that merely sounds symmetrical — the same lesson as the
  two payments CHECKs that together made a refund impossible.
- **A closed `<details>` has no `innerText`.** A browser check asserting against the body a webhook
  delivery was signed with found an empty string, because the payload is behind a
  `<summary>`. Click the summary first (or read the node's `textContent` through
  `evaluate`); `innerText` is what is _rendered_, and a collapsed disclosure renders nothing.
- **`pkill`/`pgrep -f main.ts` matches the worker and the scheduler too.** `ROLE=worker` is in the
  parent shell's environment, not in the child's argv, so every one of the three dev processes
  appears as `node … src/main.ts` and a pattern kill aimed at the API takes all three down. The
  symptom is a feature that worked a minute ago answering as though the queue were empty. Capture
  each pid when starting it, or match on the full command line including the env the process was
  started with (`ps -eo pid,args` plus `/proc/<pid>/environ`), and restart all three after any kill.
- **A Fastify hook installed from `main.ts` is absent from every application the tests build.**
  The request-log `onResponse` hook was registered in the HTTP bootstrap, so the running product
  recorded every request and the e2e harness — which builds its own application from the same
  modules — recorded none: the suite whose job was to prove requests are logged passed on
  everything except that, and the feature would have looked built and been untested. Anything that
  must be true of every application built from these modules belongs **in the modules**
  (`ApiLogHookInstaller`, on `onApplicationBootstrap`, which Nest runs inside `app.init()` and
  therefore before Fastify's `ready`).
- **`request.ip` is the socket address unless Fastify is told to trust the proxy, and the test
  harness does not.** An IP allowlist checked against it refused a request from an address that
  _was_ on the list, and the test's other half — "a request from elsewhere is refused" — passed for
  the wrong reason. This product reads the proxy chain in exactly one place, the request-context
  middleware, so the client's address comes from `requestStore.get()?.ip`; anything else is a second
  answer to one question, and in production (`trustProxy: true`) the two agree, which is what makes
  the bug invisible until a test runs.
- **Provisioning a workspace does not fit in Prisma's five-second transaction.** A cold process
  answering its first registration took 5.04 s writing the organization, the owner's role, and every
  status, pipeline, stage, task type, outcome, score band and working-hours row — and the sign-up
  failed with a 500 having created nothing. The same defect as the capture transaction, in the one
  place where the cost is a customer who cannot get in at all, and the same fix:
  `PROVISIONING_TRANSACTION` (30 s) with the reason written beside it. Any transaction that writes a
  **catalogue** rather than a record needs an explicit timeout;
  `industry-templates.service.ts` is the next one of that shape.
- **A log row read by one permission must not carry data another permission guards.** `api_logs` is
  read by whoever holds `api_key:manage`, which is not `lead:read` — so `logPath` drops the query
  string (the filter DSL carries names, phone numbers and amounts) and no body is stored at all.
  `api_logs_path_is_a_path` refuses a value containing `?`, which makes "something other than
  `logPath` wrote this row" unrepresentable rather than merely unlikely.
- **`principal.actorId` is a **person**, including for an API key.** Every person-reference in this
  product is written from it — `created_by_id`, `changed_by_id`, `assigned_by_id`, a saved view's
  owner — so a key whose `actorId` was its own id wrote three leads claiming to have been created by
  a member who does not exist, and nothing objected: some of those columns carry a composite FK into
  `Membership` and some carry none at all. A key acts as the member who created it, and `apiKeyId`
  on the principal is how the audit row still says a credential did it.
- **A credential that carries a person's id must be refused on the routes about that person.**
  Once a key acts as its creator, `/auth/me` hands it their profile, their sessions, their MFA state
  and **the other workspaces they belong to** — a cross-workspace leak through a credential scoped
  to one. `@SessionOnly()` marks those routes, and the check belongs **above** the
  `@NoPermissionRequired` early return in `PermissionGuard`: a route about the caller is exactly the
  kind that declares it, so a check placed below that return never runs and the endpoint answers 200.
- **A backtick inside the CSS of a server-rendered page ends the template literal it lives in.**
  A comment reading "a `curl` line wraps" in the docs page's inline stylesheet turned the rest of
  the file into TypeScript, and the error pointed at the CSS rather than at the quote — while the
  dev API, mid-reload, simply stopped answering (`fetch failed` in a browser check, which reads as
  a network problem). Keep backticks out of anything inside a template literal, comments included.
- **A page with no `<link rel="icon">` makes every browser fetch `/favicon.ico`.** On an API that
  serves no static assets that is a 404 in the console of the first page a developer reads, and a
  404 in our own request log. `href="data:,"` costs nothing and asks for nothing.
- **A `<table>` cannot reflow, so it widens the page instead.** The API reference took 91 px of
  sideways scroll at 375 px, which no amount of reading the stylesheet would have shown — a browser
  check at phone width did. Wrap each table in an `overflow-x: auto` box and let long paths wrap
  (`overflow-wrap: anywhere`); the page scrolls inside the table, not the other way round.
- **The document that describes an endpoint should be the validator that guards it.** `ZodBody`
  exposes its schema and the OpenAPI generator reads it off the route's own argument metadata, so
  "documented" and "accepted" cannot drift. The alternative — `@ApiBody()` beside
  `@Body(zodBody(...))` — is two descriptions of one contract across 289 routes, and the one that
  is wrong is always the one nothing runs. The same reasoning makes the **routing table** the list
  of endpoints: a document assembled from decorators omits whatever nobody decorated.
- **A `@Global()`-style installer that reads the HTTP adapter must survive a context with no HTTP.**
  `MediaUploadInstaller` guarded with `httpAdapter === undefined`, and a **standalone** application
  context — which is what `scripts/write-openapi.ts` and the schema tooling build — has
  `httpAdapter === **null**`. The strict check read straight through it and the OpenAPI writer died
  with `Cannot read properties of null (reading 'useBodyParser')`, on a feature whose whole test
  suite was green. Anything on `onApplicationBootstrap` runs in every context Nest can build, so the
  guard is `== null`.
- **A browser check's `waitForFunction` on `body.innerText` matches the form it just submitted.**
  The attachment check waited for its unique filename to appear and resolved **immediately** — on
  the composer's own echo of the chosen file, not on the thread — so the assertion after it read the
  thread before the server tree had re-rendered and reported the file missing when it was there.
  Wait on the node only the destination can produce
  (`[data-attachment-download] [data-attachment-name]`), not on the page's text; the same trap as
  waiting for a shape the previous run already left on the screen.
- **A `<input type="file">` has an intrinsic width of its own.** The button plus the longest filename
  it has held, which at 375 px was **4 px** of sideways scroll on the whole inbox — invisible in any
  amount of stylesheet reading, and found only by a browser check measuring
  `scrollWidth - clientWidth` at phone width. `w-full min-w-0` on the input, `max-w-full` on an
  `<img>`, and `break-all` on anything printing a filename.
- **`whatsapp_numbers.phone_number_id` is globally unique, so a live HTTP check cannot reuse one.**
  The second run of the media checks was refused with "already connected to another workspace" —
  which is the cross-tenant guard working exactly as intended, and a fixture bug. A fake provider
  has to mint a fresh id per run and tell the check script what it chose, rather than both
  hard-coding the same literal.
- **A thumbnail that fails to load looks exactly like a feature that works.** A `<img>` whose bytes
  answer 422 renders as a broken image with no explanation, and a check asserting the element is
  *present* passes hardest when that is what happened. The API therefore answers `media.available`
  as a field rather than leaving the screen to read a status word, the thread renders a **sentence**
  for anything not stored, and the browser check asserts `naturalWidth > 0` — "it is there" and "it
  loaded" are two different claims.
- **Two features cannot both register a parser for one content type, and the second one kills the
  app at boot.** Adding `application/vnd.ms-excel` to `MEDIA_CONTENT_TYPES` — reasonably, since
  WhatsApp accepts old Excel files — collided with the CSV import, which already claims that type
  because it is what Excel calls a CSV. The whole application died with
  `Content type parser 'application/vnd.ms-excel' already present`: every route gone, from a
  one-line change that type-checked, that lint passed, and that no unit test touched.
  `media-body.spec.ts` now asserts the two lists are disjoint. The general lesson is the one this
  file keeps paying for — **a content-type parser is global** — and the specific one is that
  "which types may carry a raw body" is a single registry across the product, not a list per
  feature.
- **A verification run started before an edit does not verify that edit.** `pnpm test:int` was
  launched, came back green at 1 489, and was reported — while the parser collision above had been
  written into the tree after the run began. The suite had never seen it. A green result is only
  evidence about the tree the run actually read, so a change made during a run means the run is
  spent: start it again, or name exactly which suites were re-run against the final tree.
- **A shared inbox whose scope is "own" is a shared inbox nobody can read.** `conversations` has no
  branch or team column, so every data scope narrower than the workspace resolves to
  `assigned_user_id = me` — and a seeded **sales executive** holds `conversation:read` and
  `conversation:reply` at `own` scope, in a workspace where nothing assigns conversations. A new
  customer's first WhatsApp message was therefore visible to nobody but an owner or an admin: the
  conversations most at risk of never being answered were the ones the inbox hid. The same shape as
  `/my/today` filtering on `assigned_user_id = me`, one module later, and the file's own comment had
  already claimed the right behaviour while the code did the other thing. `conversationScopeWhere`
  adds `OR assigned_user_id IS NULL` for every service that touches a conversation. Found by an e2e
  test driving a **second real member** — a lock, a scope and a transfer are all invisible to a
  suite with one caller.
- **A `dedupeKey` with anything random in it is not a dedupe key.** The first draft of the
  conversation-assigned notification built one from the type, the conversation and
  `newId().slice(0, 8)` — which can never match, so it was a key that read as a guarantee and
  provided none. Either the event has an id to key on (a note's own id does) or it does not, in
  which case the honest answer is **no key** plus a guard where the duplicate would come from:
  `assign` returns early when the assignee has not changed, and the sweep's conditional `UPDATE`
  row count is what stops two wakes.
- **A biconditional CHECK is right exactly when both directions are contradictions.** This file
  distrusts them for good reason — the two payments constraints that together made a refund
  impossible — but `conversations_lock_is_whole` as
  `(lock_user_id IS NULL) = (lock_expires_at IS NULL)` is correct: a holder with no expiry is a lock
  that never lapses, which is the one failure the five-minute TTL exists to prevent, and an expiry
  with no holder is an expiry for nobody. The test is not "does it sound symmetrical" but "is the
  mirror a state anything could honestly be in".
- **An opt-out keyword list is a list of ways to silence a customer invisibly.** `no`, `cancel`,
  `end` and `quit` each appear on somebody's published `STOP` list, and each is a word a customer
  writes mid-conversation: "no" answers "would Saturday suit?" and "cancel" is about an appointment
  far more often than about marketing. A false positive leaves nothing on any screen to explain why
  somebody stopped getting messages, and the only person who could explain it is the customer. Match
  the **whole** message, keep the list short, and keep a test per word that is deliberately not on
  it.
- **A column a doc says exists, and does not, is worse than one it admits is missing.** The step-1
  amendment in `database-design.md` listed `conversations.lock_user_id`, `lock_expires_at` and
  `snoozed_until` as "columns with no writer" — they had never been created. Two steps later the
  work that needed them started by planning around columns that were not there. When a doc says a
  column exists, `grep` the schema before believing it, and when a step adds the column the doc
  claimed, correct the old amendment rather than only writing a new one.
- **`prisma migrate dev --create-only` puts the `ADD COLUMN` among the spurious drops, every time.**
  Fifteen drops again this step — two composite FKs, four GIN, four trigram, two expression, a
  partial unique and a partial index. Delete the `-- DropForeignKey` and `-- DropIndex` sections
  **only**; the `-- AlterTable … ADD COLUMN` block sits in the same region and cutting "everything
  before the first CreateTable" once removed two of them.
- **An entry added to a list that a lint rule and a registry both read can land in the wrong one.**
  Appending `ConversationSweepProcessor` to `processor.registry.ts` by matching two adjacent
  processor names put it in the **import** block, where those same two names also appear together —
  so lint reported an unused import and the processor was absent from `PROCESSOR_TYPES`. The
  integration suite would have caught it (every schedule must have a processor), but lint was
  cheaper. When two blocks in one file share a shape, anchor on something only one of them has.
- **"Own scope" makes a colleague's conversation invisible, and a browser check aimed at one reads
  as a missing feature.** The two-agent lock check timed out waiting for the banner, because the
  conversation had been assigned to the owner and the colleague is a `sales_executive` with
  `conversation:read` at `own` scope — a 404, which is the scope working exactly as it should. The
  case the lock exists for is the **unassigned** conversation both agents can see, so that is what
  the fixture has to use. The general shape: when a permission check and a feature meet, a check
  aimed at the wrong fixture fails in a way that looks like the feature, and the only clue is the
  status code.
- **A list that answers `hasMore: false` on every page is a list whose other rows are unreachable.**
  `GET /conversations` returned `nextCursor: null, hasMore: false` beside a `total` of 4 000, so a
  workspace was told its inbox held the 50 rows it had loaded. With one conversation the response is
  **correct**, which is why four steps of review and a full e2e suite never saw it — only the 100 k
  fixture did. Two rules came out of it: `hasMore` is read from `limit + 1` rows rather than inferred
  from a full page (which is wrong exactly when the total is a multiple of the limit), and a keyset
  cursor carries **both** halves of its sort key, because `last_message_at` ties and an instant alone
  skips whatever shares it.
- **A performance fixture may be artificial; it may not be impossible.** `inbox-100k.sql` first
  dated messages by adding 37-minute steps to each conversation's `created_at` — and for the
  conversations created "now" that put every message in the **future**, so "the latest message" was
  one that had not happened, the list's preview showed it, and a browser check asserting on the
  newest message read a row the product could never produce. It also guessed `last_message_at`
  rather than computing it from the messages it wrote, so the sort order under measurement was one
  no real workspace has. Offset the whole thing into the past and derive the summary columns from
  the rows they summarise.
- **Two columns with no reader are the same class of defect as a column with no writer.**
  `messages.billable` and `conversation_category` were written from Meta's receipts for three steps
  and read by nothing, which looks exactly like metering that exists. The meter that reads them
  **counts rows** rather than keeping a running total: a counter incremented on every receipt would
  be a second answer to a question the messages already answer, and the first time the two disagreed
  nobody would know which to believe.
- **A product that reports somebody else's prices will report them wrong, silently.** The usage
  meter deliberately answers counts and no cost: Meta's WhatsApp prices are per-country and Meta
  changes them, so a rate card in this codebase would be out of date within a quarter — and out of
  date on an invoice, where nobody would catch it. The response carries the sentence that says so,
  rather than leaving the screen to invent an explanation for a missing number.
- **A usage figure must exclude what has not happened.** `messagesSent` counts `accepted`, `sent`,
  `delivered` and `read` — not `queued`, and not `failed`. A message still in the queue is not one
  that was sent, and a meter that counted it would flatter the figure an owner reconciles against a
  bill. The e2e asserts the **zero** this produces in a suite that never drives the send job,
  because seeing why it is zero is the point.
- **A counter incremented by a user action should count the action that matters, not the click.**
  `canned_replies.usage_count` counts **sends**: the picker is ordered by it, so a count of clicks
  would promote whatever is easiest to misclick. The send carries the id, the message keeps it in a
  column, and the body that goes out is what the agent typed — an agent edits a saved reply before
  sending more often than not, and substituting the stored text would put words in their mouth.
- **A partial unique is what lets something be retired and its name reused.**
  `canned_replies_live_shortcut` is `(organization_id, owner_user_id, shortcut) WHERE deleted_at IS
  NULL`. The owner is in the key because a private reply is somebody's own — two agents may each
  keep their own `/thanks` — and the `WHERE` is what lets a workspace reuse a shortcut it retired. A
  plain unique reads identically in review and makes that impossible for ever, which
  `integration_connections_live_provider` already paid for once.
- **A value normalised by the API must not also be normalised by the screen.** The canned-reply
  shortcut box sends what somebody typed and the API adds the slash and hyphenates it. A screen
  doing its own cleaning would be a second answer to one question, and the two would eventually
  disagree about what `Price List` becomes — the `ERROR_COPY` shape, in a field rather than a
  message.
- **A trigger a screen offers with no event behind it is a feature that can never run, and looks
  built.** The automation registry declared `whatsapp.received` with the event
  `whatsapp.message_received`, which **nothing in the product emitted** — a workflow somebody could
  write, publish and watch do nothing for ever. It is the `WEBHOOK_EVENT_TYPES` lesson in a third
  place, so the check is now the same one: `event-subscriptions.spec.ts` asserts every
  `WORKFLOW_TRIGGERS[].event` is a key of `EVENT_SUBSCRIPTIONS`, which is also the registry of
  *known* events — and listing an event there with `[]` subscribers is the honest way to say "the
  consumer arrives next step", because an unlisted name reads identically to a typo.
- **A declaration a screen cannot act on is half a feature.** A parameter saying `reference:
  'lead_status'` is right — rule 4 forbids naming a workspace's statuses — but a picker with no
  list behind it renders empty, which looks exactly like a workspace with no statuses. So the kind
  and the **endpoint** behind it are declared together (`REFERENCE_SOURCES`), the same reasoning as
  "a screen's figures and the links behind them belong in one definition", and the e2e calls every
  path in that table. The one thing such a declaration cannot carry is which field of the answer is
  the *name*, which is a fact about `/users` rather than about automation — so a new **kind** costs
  one label function while a new **action** costs nothing, and that is the honest boundary of "no
  frontend release".
- **An empty value is "not chosen yet", not "unknown".** A new workflow starts with
  `trigger: { type: '' }`, and the validator read that as an unknown key: “There is nothing called
  “” that can start a workflow”, in front of somebody who had not filled the field in. The Zod-copy
  lesson in a hand-written sentence. Found by an e2e that created a workflow and read its own
  problem list back.
- **A biconditional CHECK is right when both directions are contradictions, and one-way when only
  one is.** `workflows_cooldown_matches_policy` is a `CASE` biconditional — a cooldown policy with
  no cooldown cannot be evaluated, and hours on any other policy are a number nothing reads — while
  `workflow_versions_publisher_published_it` is one-way on purpose: a publisher implies a
  publication, and the mirror would make a version published by the **system** (an industry
  template's starter workflow) unrepresentable, which is `webhook_deliveries_pending_is_untried`'s
  mirror all over again. The test is never "does it sound symmetrical" but "is the mirror a state
  anything could honestly be in".
- **A projection may be an index; it may not be a copy.** `workflow_triggers` exists because
  dispatch asks "which workflows listen to `lead.created` here" on every event and digging that out
  of JSONB is a scan — so it is derived from the published definition by one writer, inside the
  publish transaction. What it deliberately does **not** carry is `status` or `kill_switch`: those
  live on `workflows` and dispatch joins them, because a projection holding a copy of them is two
  answers to "is this live". The same reasoning killed `workflow_steps`, which `database-design.md`
  §9 had sketched **beside** `definition JSONB` — the graph described twice, which is
  `notification_preferences`' quiet-hours defect arriving as a plan. When a doc describes one thing
  twice, one of the two is the bug.
- **A form whose fields repeat cannot echo its submission, so a graph travels as one field.** The
  workflow editor holds the definition in React state and submits a single hidden JSON string.
  `submittedValues` keeps one value per name, which is how the mapping editor came back from a
  refusal having silently dropped every row but the last; one field means a refusal echoes the
  whole graph.
- **Saving is not publishing, and an editor that refuses to save loses an afternoon.**
  `PUT :id/definition` records whatever parses as an object and answers the problem list beside it;
  `POST :id/publish` is where that list becomes a refusal. The corollary is that the problems have
  to be printed **against the rows they name** (`[{ field: 'definition.steps[0].params.body' }]`),
  not only as a summary — the mapping editor's lesson, which this screen inherited rather than
  re-paid.
- **A controlled input filled before React has hydrated keeps its value in the DOM and not in the
  component's state.** The sign-in form posted two empty strings and answered "Enter your email and
  password" while the boxes visibly held an email and a password — the `127.0.0.1` trap's quieter
  cousin, and wide enough to lose against a dev server compiling `/login` on demand. Wait for
  hydration (React attaches a `__react*` property to each node) before filling anything
  controlled.
- **A `<select>` the rest of a form depends on must be reactive, which is the opposite of the
  payment-method rule.** `key` + `defaultValue` is right for a select whose value only has to
  survive a refusal; it is **wrong** when choosing an option should reveal another field. The
  guardrails form reused that shape, so picking "Again after a wait" revealed no hours box and
  saving answered "Say how long to wait before a lead can enter again" with nowhere to say it.
  Hold such a value in state, seed it from the echo, and reset it in render when the echo changes.
  Found by the browser check, which is the only thing that would have.
- **`findMany` with no `orderBy` plus an assertion on `.at(-1)` is an order-dependent test.**
  `flushSends()` drains every queued message and a check read "the last thing sent", which is a
  different message the moment an earlier test leaves one queued — green on its own and red in a
  full run, which is the shape that looks like a flake and is not. Order the drain, and assert on
  the request that names **this** test's subject rather than on whichever was last.
- **A principal with no permissions is not a principal with full ones, and the symptom is a 404.**
  The automation engine's first draft ran its steps as `automationPrincipal` with an empty
  permission set, so every action that went through a service answered **"Lead not found"**:
  `canAct` returns false for a permission the principal lacks, and `filterFor` defaults an absent
  **scope** to `own`, which compares the row against `actorId` — and a workflow has none. Nothing in
  the engine looked wrong; the data scope was working exactly as designed against a caller who is
  nobody. The answer was to say what a workflow *is*: permissions at **organization** scope, because
  it is the workspace's standing instruction, and the permissions **enumerated** in one file rather
  than granted wholesale, so adding an action is a moment where somebody decides what it may do.
- **Threading a value through every service is one call site away from not being threaded.**
  Loop detection needs every event an automation step causes to carry `causation_depth + 1` — and a
  step's effects go through `LeadsService`, `TasksService`, the WhatsApp send, each emitting its own
  outbox events. A parameter on every method would be forgotten once and a workflow would trigger
  itself for ever. The depth lives on `TenantPrincipal.automation` and `OutboxService.emit` defaults
  from it, which is the same argument `actorType` already made for living there: a service that has
  never heard of automation produces a correctly attributed event. Assert the **emitted event**, not
  the engine's own bookkeeping.
- **A test whose fixture is a *listener* leaks into every later test.** Each test in the engine
  suite published a workflow triggered by `lead.created`, and nothing unpublished them — so the
  fifth test's lead started eight runs, `dispatch` answered `started: 8` where the assertion said 1,
  and the daily-cap test's cap of one was eaten by somebody else's workflow before its own first
  step. Every count in the file was suite-wide and three failures looked like three bugs. Archive
  the subscription in `afterEach`; "a test that reaches for a fixture another test created" one
  layer along, where the shared fixture is the thing listening.
- **A shared counter window needs clearing before the test that sets a cap, not after.** The
  guardrail counter is keyed `(organization_id, scope_key, day)`, so a test that sets the cap to one
  and cleans up afterwards still starts with the whole file's actions already counted. Clear it
  first; a `finally` that tidies up protects the next test and not this one.
- **A control shape and a handler are different kinds of thing, and the registry has to say which.**
  `wait`, `branch`, `stop` and `enroll` change the *shape* of a run — a branch carries nested steps,
  a wait suspends it — so they are the executor's own vocabulary, and `control: true` is what keeps
  "adding an action needs no engine change" a claim about the other kind. The boot check reconciles
  both directions: a declared action with no handler is a workflow that publishes and does nothing,
  and a handler nothing declares is dead code that looks like a feature.
- **A list endpoint that omits the thing its screen exists to show renders an empty disclosure.**
  `GET /automation/runs` answered run summaries without their steps, and `RunList` renders steps
  only when it has them — so the lead's Automation tab and the workflow's run log both drew a
  `<details>` with nothing behind it, on the two panels whose entire job is answering "why did this
  customer get this message?". It looked exactly like a run that had not done anything. The list
  carries the steps (bounded by its own `limit`, not by an N+1 detail request per row), the web
  type makes them **required** so a screen cannot silently render none, and the e2e asserts the
  list's own `steps`. Found by a browser check waiting for a `summary` that was never drawn.
- **A combined locator's `.first()` reads whichever element is earlier in the DOM, not the one you
  meant.** `page.locator('[data-shortcut-error], main [role="alert"]').first()` read the **summary**
  notice rather than the field error, and reported "a taken shortcut says whose it is" as failing
  while the product was rendering both correctly. Worse, the same locator written the other way
  round would have *passed* on a screen that had lost the field error entirely. Assert on the
  specific node, and assert the summary separately — the two carry different sentences on purpose.
