# ADR-0011 — ESM-first workspace, and the version pins reality forced

**Status:** Accepted · **Date:** 2026-09-27 · Supersedes the version table in
`system-architecture.md` §3 · Discovered during Phase 1 step 1

## Context

Phase 0 specified "NestJS 11, Prisma 6, TypeScript 5.x, CommonJS" from memory. Building the
foundation against the actual registry produced four surprises, each of which changes how
the code must be written:

1. **NestJS 12 is ESM-only.** With `module: commonjs`, every `@nestjs/*` import fails
   (`TS1479: … referenced file is an ECMAScript module and cannot be imported with require`).
2. **Prisma 7 removed `url` from `schema.prisma`.** Migrations read the connection string
   from `prisma.config.ts`, and the runtime client requires a **driver adapter**
   (`@prisma/adapter-pg` + `pg`). The generator is now `prisma-client`, emitting TypeScript.
3. **TypeScript 7.0.2 is current, but `typescript-eslint` peer-caps at `<6.1.0`.** Choosing
   TS 7 means no type-aware linting.
4. **TypeScript 6 deprecated `moduleResolution: node10` and `baseUrl`**, which the Phase 0
   sketch used.

## Decision

- **The whole workspace is ESM**: `"type": "module"` in every package, `module`/`moduleResolution`
  `nodenext`, relative imports carry explicit `.js` extensions, `import.meta.dirname` instead
  of `__dirname`.
- **TypeScript 6.0.3** — the newest release still inside `typescript-eslint`'s supported range.
  Toolchain coherence beats having the newest major; TS 7 is a tracked follow-up, blocked on
  the ecosystem, not on us.
- **NestJS 12.1** on Fastify 5. **Prisma 7.10** (stable — note `prisma@latest` is currently an
  8.0 release candidate, so both `prisma` and `@prisma/client` are pinned explicitly) with
  `@prisma/adapter-pg`, which has the side benefit that the pg pool is ours to size per
  process class.
- **SWC compiles; tsc only checks.** `emitDecoratorMetadata` (which NestJS DI depends on) is
  produced by SWC for both the build and the test transform; `tsc --noEmit` does typechecking.
- **`@typescript-eslint/consistent-type-imports` is disabled for `apps/api`.** Its autofix
  rewrites injected classes to `import type`, erasing the runtime import and breaking DI at
  boot with no compile-time signal. It stays enabled in `packages/*`, where there is no DI.

## Consequences

**Positive:** current, supported versions; ESM is where the ecosystem is going; the driver
adapter gives explicit pool control; the SWC/tsc split avoids depending on any one compiler
for both correctness and emit.

**Negative:** `.js` extensions on relative imports look odd in TypeScript source; CJS-only
libraries need interop care; `type: module` means `require` is unavailable in app code;
`consistent-type-imports` being off in the API is a real (if small) loss, mitigated by the
fact that the e2e suite boots the whole application and therefore catches DI regressions.

**Guardrail added:** the e2e suite boots the real Nest application, so the class of failure
that motivated the lint exception (DI wiring) is caught by tests rather than by reading diffs.

## Alternatives rejected

- **NestJS 11 (CJS) to avoid the ESM migration.** Starting a greenfield platform on the
  `legacy` dist-tag to dodge a mechanical import rewrite is a bad trade.
- **TypeScript 7 with no type-aware lint.** Lint rules are part of how tenant isolation is
  enforced (`no-restricted-imports` on the Prisma client); losing the tooling is worse than
  being one major behind for a few months.
- **Prisma 8 RC.** Release candidates do not belong under a product's foundation.
