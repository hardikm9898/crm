# @leados/api

The HTTP API: NestJS 12 on Fastify, ESM, one process image with several roles.

## Running

```bash
pnpm bootstrap     # first time: .env, install, docker deps, migrate, seed
pnpm dev           # watch mode
pnpm --filter @leados/api test      # unit
pnpm --filter @leados/api test:int  # e2e (boots the app, needs a database)
pnpm --filter @leados/api build && node apps/api/dist/main.js
```

`ROLE` selects what the process does (`api`, `collector`, `worker`, `scheduler`) —
see `docs/system-architecture.md` §2.

## Structure

```
src/
├── main.ts                     bootstrap: envelope, filters, CORS, shutdown hooks
├── app.module.ts               composition root; domain modules are added per phase
├── infra/
│   ├── config/                 boot-time env validation (the process refuses to start
│   │                           on a bad or missing variable, incl. production safety net)
│   ├── db/                     the tenant-scoped Prisma client as an injectable service
│   ├── http/                   request context + id, response envelope, exception filter
│   └── observability/          pino logger with PII/credential redaction
└── modules/
    └── health/                 live / ready / deep probes
```

## Contract every endpoint inherits

Success `{ success: true, data, message?, meta: { requestId, pagination? } }`;
failure `{ success: false, error: { code, message, details?, requestId } }`.
Applied globally, so no controller invents its own shape (`docs/api-architecture.md` §2).
`raw()` opts out for bodies whose shape an external caller dictates (probes, webhook acks).

## Things worth knowing before editing

- **Do not import `@prisma/client` or the generated client directly.** Use `DbService`
  (already tenant-scoped). Lint enforces this.
- **`import type` breaks dependency injection.** NestJS resolves constructor dependencies
  from decorator metadata, which needs a _runtime_ import. `consistent-type-imports` is
  therefore disabled for this app — see the comment in `eslint.config.mjs`.
- **Tests use `abortOnError: false`.** Otherwise Nest calls `process.abort()` on a wiring
  error, killing the worker and hiding the cause.
- **`build` uses SWC, `typecheck` uses tsc.** SWC emits the decorator metadata; tsc never
  emits, it only checks.

## Not here yet (Phase 1, step 2+)

Authentication, guards (tenant status, permission, data scope, entitlements), the outbox
dispatcher, audit-log writer, organizations/users/roles endpoints, onboarding.
`docs/implementation-roadmap.md` has the order and the exit criteria.
