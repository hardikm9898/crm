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
- **A browser check must use `localhost`, not `127.0.0.1`.** Against `127.0.0.1:3000` the login form
  submitted as a native GET with the password in the query string — the client bundle had not
  hydrated — and the check failed with a URL that explains itself only if you read it closely.

## Reporting work

Per `docs/implementation-roadmap.md`: what was completed, files changed, database changes, API
changes, UI changes, tests run, unresolved issues, and the single recommended next step. Never
report something as done that is not done.
