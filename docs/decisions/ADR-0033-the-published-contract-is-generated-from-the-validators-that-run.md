# ADR-0033 — The published contract is generated from the validators that run, and the committed copy is the check

**Status:** Accepted · **Date:** 2026-10-19 · **Phase 4, step 5** · Traces to `FR-API-3`

## Context

`FR-API-3` asks for OpenAPI 3.1 generated from code, published as interactive docs with
copy-paste examples per endpoint, and **diffed in CI so an unintended breaking change fails the
build**. §11 of `api-architecture.md` sketched `@nestjs/swagger` decorators plus Zod-to-JSON-Schema,
a Scalar or Redoc page at `/docs`, and a generated TypeScript client in `packages/contracts`.

By the time this step arrived, the shape of the problem had changed in three ways.

- **There are 289 routes.** Annotating each with `@ApiOperation`, `@ApiBody` and `@ApiResponse` is
  a day's typing and then a second description of every endpoint, maintained by hand, next to the
  Zod schema that actually decides what is accepted. The two disagree the first week, and the one
  that is wrong is the one nobody runs.
- **Every route already declares what it needs.** `RouteAuditService` enumerates the whole routing
  table and **fails startup** if a route declares no authorization, so the product already has one
  authoritative list of endpoints with their permission, their plan feature and now their
  `@SessionOnly` marker.
- **Every validated route already carries its schema.** `@Body(zodBody(createLeadSchema))` puts the
  schema on a pipe instance that Nest stores in the route's own argument metadata, and Zod 4 renders
  JSON Schema itself.

## Decision

### 1. The document is generated from the routing table and the pipes

`OpenApiService` builds the document from `RouteAuditService.collect()`: paths and methods from
Nest's metadata, the permission and the feature from the decorators the guards read, the success
status from `@HttpCode` or the convention, and the request and query schemas **read off each
route's own `ZodBody` pipes**.

Nothing is annotated for documentation. Two properties follow, and they are the point:

- **Every route is in the document**, because the source is the list that fails startup when a
  route is undeclared. A document assembled from decorators silently omits whatever nobody
  decorated, and the endpoints nobody documents are the endpoints nobody tests.
- **"Documented" and "accepted" cannot drift**, because the schema in the document is the object
  that refuses a bad request. There is no second description to keep in step.

What the generator cannot know it does not invent: a summary is the handler's name said as a
sentence, and a body example carries only the schema's **required** fields with placeholder values.
A fabricated example with plausible names in it reads as real data and gets copied into production.

### 2. `/docs` is rendered on the server, with no CDN and no JavaScript

Scalar and Redoc are better-looking. Both also mean the docs page is blank on a deployment that
cannot reach a CDN — which is exactly the deployment whose operator most needs to read it — and
that a developer's first impression of this API is a spinner. The page is one function that renders
the document the API just built: it works offline, it is readable in a terminal browser, it can be
diffed, and it costs no dependency. `/docs/errors` is the errors page the brief asks for, rendered
from `ERROR_CATALOGUE`, which is a `Record<ErrorCode, …>` so a new code cannot be added without
describing it.

Both pages and `/openapi.json` are **public**, and sit outside the version. A spec behind a
credential is a spec nobody evaluating the product can read, and it discloses nothing a caller could
not learn by trying every path. It contains no workspace's data, no credential, and not the platform
admin surface — those controllers are not in this application.

### 3. `docs/openapi.json` is committed, and an integration test is the diff check

The committed artifact is the **baseline**, not the source: the server always builds the document
from the live routing table, because a file can be stale and the one thing this document must never
be is a description of a previous release. `openapi.e2e-spec.ts` regenerates and compares, and when
they differ it fails with a **classified** diff rather than a byte diff — `diffDocuments` says which
changes break a client:

- a removed path or operation, a changed permission, a newly required plan feature, a route closed
  to API keys, a body field or parameter that became required, a success status no longer answered;
- against additive ones: a new path, a new operation, a new optional parameter.

The classifier is deliberately conservative — a change it cannot reason about is reported as
breaking — because the two mistakes do not cost the same. A false alarm is a sentence in a commit
message; a missed one is somebody's integration failing in production on a release that was green.

### 4. No generated client package yet

§11 promises `packages/contracts`. It is not built here. A client generated from a document that
changed this morning is a package that has to be versioned, published and consumed, and the web app
does not need it: it calls the API through its own typed loaders, and the **spec** that reconciles
its hand-written vocabulary with `@leados/shared` is what keeps it honest. Named as outstanding
rather than quietly dropped.

## Consequences

- Adding an endpoint publishes it. Nothing has to be remembered, and the author finds out at test
  time that the artifact needs regenerating — one command, in the same commit as the change.
- Changing a permission, gating a route behind a plan feature, or marking one `@SessionOnly` now
  **fails the build** until somebody says they meant it. That is the point, and it will be annoying
  exactly once per intentional breaking change.
- A hand-written summary or description per endpoint is not possible without introducing the
  annotation this decision avoids. The document says what each endpoint needs, what it accepts and
  how to call it; it does not explain _why_ the endpoint exists. The module READMEs do that.
- The errors page is now part of the contract: `ERROR_CATALOGUE` has a compile-time obligation to
  describe every code, with a status, a meaning, a next step and a retry rule.
- The docs page's styling is ours to maintain. It is 60 lines of CSS, and it will never be as
  pretty as Scalar.

## Alternatives rejected

- **`@nestjs/swagger` decorators.** 289 routes × three decorators, maintained by hand beside the
  schemas that actually run. Rejected for the reason this codebase keeps relearning: two
  descriptions of one fact, and the one that is wrong is the one nothing executes.
- **A build-time file the server serves.** Then `/openapi.json` can describe a release that is not
  running. The file exists, but as the baseline a test compares against.
- **Scalar or Redoc from a CDN.** An external request on the one page an operator reads when
  nothing else works. Reconsider if the docs are ever served from the marketing site, where a CDN
  is already assumed.
- **A byte diff in CI.** It fails on every reordering and says nothing about severity, so it gets
  skipped — the check that always shouts is the check nobody reads.
