# ADR-0034 — A provider is a registry entry and an adapter, and its credential never leaves the vault

**Status:** Accepted · **Date:** 2026-10-19 · **Phase 4, step 6** · Traces to Phase 4's scope line
("integration framework: provider registry, credential vault, health checks, generic mapping
templates") and to `FR-CAP-3`, `FR-CAP-5`, `FR-NOT-2`

## Context

Phase 4's remaining work is two connectors — Meta Lead Ads and Google Ads lead forms — and both
need the same four things: a stored credential, a health check that surfaces a revoked token as a
reconnect prompt rather than as silence, a cursor that resumes, and a mapping from somebody else's
field names onto ours. Building the first connector without that framework is how the second one
becomes a copy of the first, and `docs/database-design.md` §8 has specified
`integration_connections`, `sync_cursors` and `integration_health_checks` since Phase 0 for exactly
this moment.

Three facts shaped the decision.

- **Nine provider names were specified as a Postgres enum.** `whatsapp_cloud`, `meta_ads`,
  `google_ads`, `google_analytics`, `search_console`, `razorpay`, `stripe`, `smtp`, `telephony_x` —
  on a table whose entire purpose is to be extended, which would make every new connector a
  migration.
- **This product already stores three kinds of secret**, each sealed with its own row's id as AAD:
  a TOTP secret, an API key's shared secret (ADR-0030), and a webhook endpoint's signing secret
  (ADR-0031). A fourth arrangement would be a fourth place to get the AAD wrong, and a wrong AAD
  still works on the happy path.
- **The capture pipeline already exists.** `IngestionService.capture` has the never-lose payload
  store, the idempotency guarantee, the duplicate rules, the SLA clock and the timeline. A second
  capture path for "a lead that arrived from an integration" would be a second answer to the
  question `FR-CAP-4` exists to have one answer to.

## Decision

### 1. A provider is a catalogue entry plus an adapter, reconciled at boot

`INTEGRATION_PROVIDERS` in `@leados/shared` is the catalogue: label, a summary written for the
person deciding whether to connect it, capabilities, auth kind, the settings its connect form asks
for, whether it maps fields, and how often it should be probed. `IntegrationRegistryService` pairs
each entry with the adapter that implements it and **throws on application bootstrap** if they
disagree — a provider with no adapter, an adapter with no catalogue entry, or a provider that
declares a probe cadence whose adapter cannot be probed.

That is the same stance as "every route declares its authorization or the app does not start". The
alternative is a connect button that answers 500 the first time somebody presses it, or a scheduled
sweep that looks scheduled and does nothing. Because the check runs inside `app.init()`, the e2e
harness runs it too.

`integration_connections.provider` is therefore `TEXT`, not an enum, checked against the registry by
the service and kept to a key shape by `integration_connections_provider_is_a_key`. **A new provider
needs no migration.**

### 2. `probe` is optional, and a provider that cannot be asked says so by not having it

`generic_webhook` has no `probe`. Its credential is a secret *we* generated; the sender holds it and
signs with it, so there is no endpoint of theirs to call. "Is this connection healthy" for an
inbound webhook means "has anything arrived", which is `last_success_at` and not a request.

A `probe` that returned `ok` without asking anything would be a green tick this product had not
earned; one that threw would be the lie in the contract `infra/mail/mailer.port.ts` already warns
about ("a port method one driver has to throw from is a lie in the contract"). So the capability is
the presence of the method, the catalogue's `probeEveryMinutes` is `null` for such a provider, and
the two are reconciled at boot. `POST /integrations/:id/check` refuses, naming the mapping preview
as the thing to use instead — an honest refusal rather than a fake tick.

### 3. Four standings, one transition table, and `unauthorized` has no grace period

`connected`, `degraded`, `error`, `revoked`. `nextStatus(current, outcome)` in `@leados/shared` is
the only thing that decides a move, because three callers would otherwise each decide and the
screen would disagree with itself.

- **`unauthorized` ⇒ `revoked`, immediately.** No number of retries fixes a credential somebody
  deleted in the provider's dashboard, and a week of `degraded` would be a week of email silently
  not sending.
- **`unreachable` and `degraded` escalate**: one is `degraded`, a second in a row is `error`. The
  difference between them is diagnostic, not a severity — `unreachable` is "nothing answered", so it
  carries no latency, and `degraded` is "it answered and refused", so it carries one. Treating
  "answered 500 all afternoon" as permanently recoverable would leave a connection reading "nothing
  to do yet".
- **Any `ok` recovers from any state**, including `revoked`: a fresh token that works is the end of
  the matter.

Only the **transition** into `revoked` notifies, not every probe that finds it there — a deleted
credential would otherwise produce one notification every ten minutes, which is the shape of alert
people mute and then stop reading. The type is `integration.revoked`, and it is **not opt-out**, for
the reason `webhook.disabled` and `trial.expired` are not: the thing it explains has stopped
silently, and the person who would have to fix it is the one who would have switched the notice off.
It declares the `connection_still_broken` staleness check, so a notice held by quiet hours is
dropped if somebody reconnected at 22:00.

### 4. The credential is sealed to its row, and no endpoint answers it

`IntegrationVaultService` is one service with one function that takes the connection's id, because
the AAD is the thing worth protecting from a call site: `integration:<id>`, the same construction as
`api_key:<id>`, `webhook:<id>` and `mfa:<userId>`. A ciphertext moved to another connection does not
decrypt.

`integration_connections_credentials_encrypted` refuses a value that is not an envelope, and refuses
one that still begins `sk_` or `whsec_` — which is what storing the token as the provider gave it
looks like. The presenter's `select` does not include the ciphertext at all, so it cannot reach a
response by somebody extending the presenter later.

The one secret that **is** answered is the one we mint, for a `shared_secret` provider, exactly once
by `connect` and by `rotateSecret`. A provider's own token is never echoed back: it was the caller's
to begin with, and echoing it would put their credential in our response log for no gain. A caller
who supplies a secret for a `shared_secret` provider is **refused**, not ignored: a connection whose
secret is not the one the sender was told about fails every signature check, and "it ignored what I
sent" is the worse surprise.

### 5. A disconnect is soft, and a reconnect is a new row

`inbound_payloads` references the connection that brought each lead in, so a hard delete would
either orphan that history or refuse the delete and make a mistyped connection permanent. The
partial unique index `integration_connections_live_provider (organization_id, provider) WHERE
disconnected_at IS NULL` is what makes "one live connection per provider, and as many disconnected
ones as a workspace has had" expressible — and `disconnected_at` is written in the same statement as
a status that is not `connected`, because a CHECK refuses a row that claims both.

### 6. A mapping is an array of three-part entries, and it is applied inside the capture pipeline

`{ source, target, transform? }`. `source` is a dot path, because every ad platform nests
(`field_data.full_name`, `answers.0.value`). `target` is a capture field or `custom.<key>`, from a
list taken from the **public capture schema** rather than from the lead table: those are the fields
a stranger's payload may set, and a mapping that could write `score` or `assignedUserId` would be an
integration overruling the workspace's own rules from somebody else's config file. The six
transforms (`trim`, `lowercase`, `digits`, `phone`, `boolean`, and `none`) each earn their place from
a real provider's habits; anything more is a transformation language, and a transformation language
in a JSONB column is a program nobody can review.

The mapping is applied **inside** `IngestionService.capture`, not by the controller, for two
reasons. The never-lose store must hold what arrived rather than our interpretation of it — a store
that holds our interpretation cannot answer "what did they actually send us", which is the only
question it exists for. And the mapped result then goes through the same `publicLeadSchema`, the same
mapper, the same duplicate rules, the same SLA clock and the same timeline as every other capture.

Two properties follow from the same place:

- **The keys no mapping entry named are kept**, under the mapped values, so `FR-CAP-5`'s one-click
  custom field still has something to see. Without that, the feature would be unreachable for every
  mapped provider.
- **The preview runs the step it is previewing.** `POST /integrations/:id/preview` applies the
  mapping *and* the capture's own normalisation, through the same two functions the write path uses,
  and answers the phone as it would be stored beside the phone as sent. A preview that echoed the
  mapping's output would be the import's lie in a third place.

### 7. The inbound door is the public lead API's authentication, minus the key

`POST /wh/{provider}/{connectionId}` — the path the webhooks module's note has promised since step
3. The signature is the authentication: HMAC-SHA256 over `"<timestamp>.<raw body>"`, five-minute
window, `verifySignature` and `IngestAuthService.signatureMessage` shared with the public lead API,
so an integrator who has wired one has wired the other and reads the same sentences when it is
wrong.

The connection id in the path is **not** a credential and is not treated as one: an unsigned request
is a 401 whatever id it carries, a wrong id is a 404, and a disconnected connection answers the same
404 as a made-up id. Because the route is `@Public()` there is no tenant context, so the lookup is
`withPlatformScope` with its reason written out — the URL is the only thing that says which
workspace a request belongs to, exactly as the public lead API's path key is.

## Consequences

**Good.** Adding a connector is a registry entry plus an adapter — no migration, no new screen, no
new vault code, no new schedule. A workspace can see what each integration is doing, when it last
worked, and what the provider said when it did not. A refused credential reaches the people who can
fix it once, with a link. An inbound integration's payload is captured by the one pipeline that
writes the timeline, the SLA clock and the outbox event.

**Costs, stated.** `sync_cursors` is built and **unused**: neither provider in this step syncs
anything on a cursor, and the table exists because the two ad connectors will and because its
composite FK and unique belong with the rest of this migration rather than in a later one. There is
no OAuth: nothing here performs an authorization-code exchange, so `INTEGRATION_AUTH_KINDS` has two
values rather than three, and an `oauth` kind no adapter implements would be a promise the connect
screen made on our behalf. `provider_events` stays specified and unbuilt — it is the ledger for a
provider that sends its own event ids, which neither of these does. And a connection's `scopes`
column is written empty: a provider that reports what its credential may do will fill it, and
inventing values for one that does not would be a column nobody could trust.

**What would change this decision.** A provider whose credential expires and refreshes — which is
every OAuth connector — needs a refresh path on the port and a sweep that renews before
`expires_at`. That is an addition to this framework, not a replacement: the vault, the registry, the
health history and the mapping all stand.
