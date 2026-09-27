# ADR-0003 — NestJS as the API framework

**Status:** Accepted · **Date:** 2026-09-27

## Context
We need enforced module boundaries, cross-cutting concerns applied uniformly (tenant context, RBAC,
entitlements, validation, audit), first-class OpenAPI, and a queue integration — across ~30 domain
modules.

## Decision
NestJS 11 on the Fastify adapter. Guards implement tenancy/permission/entitlement checks once and
apply everywhere; the module system maps 1:1 to our domain modules; `@nestjs/swagger` generates the
OpenAPI document from the same DTOs we validate with; DI makes provider adapters and repositories
swappable in tests.

## Consequences
**Positive:** uniform enforcement of the rules that matter most (no route can forget the tenant guard);
strong structure for a large surface; good testability; generated API docs stay truthful.
**Negative:** more boilerplate than Express; decorator/DI learning curve; Nest upgrades occasionally
require coordinated changes.

## Alternatives rejected
- **Express + hand-rolled structure:** every guard becomes a middleware someone can forget to add —
  unacceptable for tenant isolation.
- **Fastify alone:** fast, but no module/DI story for 30 modules.
- **tRPC:** excellent DX for our own frontend, but the product must expose a public REST API with
  OpenAPI to customers and integrators (`FR-API-*`), so REST is the primary contract.
