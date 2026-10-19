# `integrations` — the integration framework

Phase 4's own words for this module's scope: **provider registry, credential vault, per-connection
health checks, generic mapping templates**. It is the layer every later connector sits on — Meta
Lead Ads and Google Ads lead forms arrive as two more entries in the registry and two more
adapters, not as two more modules with their own idea of where a credential lives.

## What is here

| File | What it decides |
| --- | --- |
| `integration.port.ts` | What an adapter is: `validate`, and an **optional** `probe`. |
| `integration-registry.service.ts` | Which providers exist, paired with their adapters. Fails at boot if they disagree. |
| `integration-vault.service.ts` | The credential, sealed to its own row. Plaintext never leaves this module. |
| `integration-health.service.ts` | One probe, recorded and acted on — for the sweep and for the button. |
| `integrations.service.ts` | Connect, edit, rotate, disconnect, preview, and the inbound door's lookup. |
| `integrations.controller.ts` | `/integrations`, all of it behind `integration:manage`. |
| `integration-inbound.controller.ts` | `POST /wh/{provider}/{connectionId}` — somebody else's server posting leads. |
| `integrations.processor.ts` | `integration.health-check`, every ten minutes. |
| `integration-inbound.service.ts` | A delivery → the ledger → a queued capture. |
| `adapters/secret-names.ts` | The names each provider's secrets are filed under, in one place. |
| `adapters/postmark.adapter.ts` | A token we send, probed with `GET /server`. |
| `adapters/generic-webhook.adapter.ts` | A secret we generate, signed by the sender. No probe, on purpose. |
| `adapters/meta-lead-ads.adapter.ts` | Meta's handshake, its signature, its batches, and the lead fetch. |
| `adapters/google-ads-leads.adapter.ts` | A key inside the body, compared in constant time. No probe. |

The vocabulary — the provider catalogue, the four statuses, the mapping engine, the transition
table — is in `@leados/shared/src/integrations.ts`, because the web app renders the same catalogue
and the same sentences and a second copy would drift from the first.

## The decisions worth knowing before changing anything

**A provider with no adapter fails at boot.** `IntegrationRegistryService.onApplicationBootstrap`
throws, like a route with no authorization declaration. The alternative is a connect button that
answers 500 the first time somebody presses it. So does a provider that declares
`probeEveryMinutes` with an adapter that cannot be probed: the sweep would look scheduled and do
nothing.

**`probe` is optional, and `generic_webhook` does not have one.** The credential is a secret *we*
generated; there is no endpoint of theirs to call. "Is this connection healthy" for an inbound
webhook means "has anything arrived", which is `last_success_at`. A `probe` returning `ok` without
asking anything would be a green tick we had not earned — the lie in the contract
`infra/mail/mailer.port.ts` warns about.

**The credential is sealed with the row's own id as AAD** (`integration:<id>`), like
`api_keys.secret_encrypted` and `webhook_endpoints.secret_encrypted`. A ciphertext moved to another
connection does not decrypt. `integration_connections_credentials_encrypted` refuses a value that
is not an envelope, and refuses one that still looks like a `whsec_` or `sk_` secret.

**No endpoint answers a credential.** `PUBLIC_COLUMNS` in `integrations.service.ts` does not select
the ciphertext, so it cannot reach a response by somebody extending the presenter. The one
exception is the secret *we* mint, answered exactly once by `connect` and `rotateSecret`.

**A disconnect is soft and a reconnect is a new row.** `inbound_payloads` references the connection
that brought each lead in. The partial unique index
`integration_connections_live_provider (organization_id, provider) WHERE disconnected_at IS NULL`
is what makes "one live connection per provider, and as many disconnected ones as a workspace has
had" expressible at all.

**The inbound capture goes through `IngestionService.capture`.** The mapping is applied *inside*
that pipeline, not before it, for two reasons: the never-lose store must hold what arrived rather
than our interpretation of it, and the mapped result then goes through the same `publicLeadSchema`,
the same mapper, the same duplicate rules, the same SLA clock and the same timeline as every other
capture. A second capture path here would be a second answer to "what happens when a lead arrives".

**The inbound route is `@Public()`, so its lookup is `withPlatformScope`.** The URL is the only
thing that says which workspace a request belongs to. Reading it with the tenant-scoped client
throws before any signature is checked — every inbound request a 500 — which is exactly what the
first draft did.

**A health check on the scheduled sweep enters each tenant's context.** `withPlatformScope` leaves
`tenantContext.organizationId()` unset, and the health row, the status update and the notification
all take the workspace from the context. Read across tenants, write inside
`tenantContext.run(systemPrincipal(...), …)` — the quotation-expiry sweep's lesson.

## The inbound ledger (step 7)

A provider that sends its **own** event id gets `provider_events`, whose
`UNIQUE (organization_id, provider, external_event_id)` *is* the "a duplicate delivery produces one
lead" guarantee. The insert comes **before** any work and its unique violation is the normal case:
a retry is counted and answered 200. The table is deliberately not partitioned — a unique on a
partitioned table must contain the partition key, which makes it a race guard rather than the point
read this needs.

A provider with **no** event id of its own (the generic webhook) does not touch the ledger: a key
we invented would make every distinct lead look like a replay. That door stays synchronous, answers
the lead id, and deduplicates on `Idempotency-Key` through `idempotency_keys`.

The webhook answers 200 and the lead is made by `integration.ingest-event`, because a provider that
waits for us is a provider that **retries**: a two-second capture would become a second delivery.
`maintenance.integration-retry` re-queues what the ledger still owes, three attempts at most.

## Adding a provider

1. An entry in `INTEGRATION_PROVIDERS` (`@leados/shared`): label, a summary written for the person
   deciding whether to connect it, its capabilities, its auth kind, **the secrets it needs by name**
   (`credentialFields`), the settings its connect form asks for, whether it maps fields, its probe
   cadence, how it verifies an inbound delivery, and whether that delivery is only a reference to
   the lead.
2. An adapter in `adapters/`, registered in `IntegrationRegistryService`'s constructor. Omit any
   method there is genuinely nothing to do — `probe` for a provider that posts to us, `fetchLead`
   for one that sends the answers — and the boot check will tell you if the registry entry and the
   adapter disagree about which.
3. A `defaultMapping` of the provider's own standard field names, and whatever flattening makes
   those names reachable by a dot path (`flattenMetaFieldData`, `flattenGoogleColumnData` in
   `@leados/shared`). This is what makes a connection work the moment it is made.
4. Nothing else. The screen renders the form from the registry, the vault seals whatever the
   adapter accepts, the sweeps pick it up from its declared cadence, and the boot check tells you
   if you have forgotten half of it.

A new provider needs **no migration**: `integration_connections.provider` is a string checked
against the registry, because a Postgres enum would make every connector a migration.
