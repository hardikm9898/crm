# ADR-0002 — Modular monolith with a separate worker fleet

**Status:** Accepted · **Date:** 2026-09-27

## Context
The product spans CRM, WhatsApp, automation, website builder, analytics and billing. That breadth
invites a microservice split, but the value of the product is in the *joins*: a lead's messages,
tasks, website events and campaign data are queried and transacted together.

## Decision
A single API codebase organized into strict domain modules, plus worker processes that import the same
modules and consume queues. Module boundaries are enforced now (public `index.ts` only, no cross-module
table access, communication via domain events, no import cycles — checked by `dependency-cruiser` and
lint). The `collector` role is deployed separately from the same image for ingestion isolation.

## Consequences
**Positive:** transactional consistency across the domain; one deploy, one migration path; no
distributed tracing archaeology to answer "why did this lead not get assigned"; fast iteration.
**Negative:** one process class can be starved by another (mitigated by separate worker deployments and
the split collector role); discipline is required to keep boundaries honest (hence CI enforcement);
scaling is coarser-grained than per-service.

## Alternatives rejected
- **Microservices from day one:** distributed transactions for lead capture, 10× ops burden, no
  team-size justification.
- **Serverless functions:** cold starts hurt the executive workspace; long-running queue workers and
  Socket.IO fit poorly; per-invocation cost is unpredictable at analytics volume.

## Extraction plan
When justified, `collector`, `analytics` and `whatsapp` extract first: they already communicate only
through events and provider adapters and own their tables exclusively.
