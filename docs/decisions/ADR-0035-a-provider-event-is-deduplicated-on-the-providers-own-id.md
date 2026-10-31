# ADR-0035 — A provider event is deduplicated on the provider's own id, and fetched before it is captured

**Status:** Accepted · **Date:** 2026-10-19 · **Phase 4, step 7** · Traces to Phase 4's fifth exit
criterion ("Meta Lead Ads: duplicate webhook delivery ⇒ one lead; token revocation surfaces as a
reconnect prompt"), `FR-CAP-1`, `FR-CAP-4`, `FR-WA-6`

## Context

Phase 4's last exit criterion is two connectors. [ADR-0034](./ADR-0034-a-provider-is-a-registry-entry-and-an-adapter.md)
built the framework they sit on — a registry reconciled against its adapters at boot, a credential
vault, health checks, field mappings — and left four things for the connectors themselves. Each of
the four is a property of how a real provider works, and none of them has a sensible general answer:

- **Meta retries.** A delivery it does not get a 200 for comes again, and the brief's headline test
  is that the second one produces no second lead. `inbound_payloads` cannot settle that: it is
  partitioned, so its unique has to contain the partition key, which makes it a race guard rather
  than a point read — the same event id next month would be allowed.
- **Meta sends an id, not the answers.** The lead is a second request, with a different credential
  from the one that signed the delivery.
- **Google Ads does not sign anything.** It echoes a key _inside_ the body, which it asked you for
  when you configured the lead form.
- **Meta will not deliver anything** until the callback URL answers a `hub.challenge` echo.

## Decision

### 1. `provider_events` is the ledger, keyed on the provider's own id

`UNIQUE (organization_id, provider, external_event_id)` on a table that is **not partitioned**.
That unique _is_ the guarantee: the second insert fails, and "a duplicate webhook delivery produces
exactly one lead" is a database constraint rather than a check somebody remembered to write. The
service treats the violation as the **normal case**, counts it, and answers 200.

Two things follow from where the key comes from:

- **It is the provider's id, never a hash of the body.** Meta's retry carries a different `time`, so
  a body hash would make it a new event; Google's retry is byte-identical, so a hash would work by
  luck. `leadgen_id` and `lead_id` are what both providers promise to repeat.
- **A provider with no event id of its own does not use the ledger at all.** The generic webhook has
  nothing to deduplicate on, and a key _we_ invented would make every distinct lead look like a
  replay. That door keeps `Idempotency-Key` and `idempotency_keys`, which is what `FR-API-5` already
  specifies, and stays synchronous so it can answer the lead id. One table per guarantee, rather
  than one table pretending to offer both.

A delivery Google Ads marks `is_test` is **recorded and acknowledged but never captured**: a
provider that gets a 4xx from its own test disables the endpoint, and a test lead in somebody's
pipeline is worse than no test at all.

### 2. The provider is acknowledged before the work, not after it

Insert the ledger row, enqueue, answer 200 — which is §7 of `api-architecture.md`'s "enqueue → 200
in < 1 s", and which matters because **a provider that waits for us is a provider that retries**. A
capture that takes two seconds would become a second delivery, and the ledger would then be
absorbing a problem we had created.

The row is the durable record, so a worker restart costs a job rather than a lead, and
`maintenance.integration-retry` re-queues what is owed — bounded at three attempts, because a lead
Meta will not hand over is a credential problem and re-asking forever earns a rate limit.

### 3. The port grew by four optional methods, each a statement

```ts
verifyInbound?(…): VerificationResult;   // three real shapes, so it cannot be one
challenge?(…): string | null;            // only Meta does this
parseDelivery?(body): ProviderDelivery[];// one request is zero or more events
fetchLead?(…): Promise<Record<…>>;       // only when the delivery is a reference
```

The provider **declares** which of these it needs — `inboundVerification`, `deliveryIsAReference` —
and `IntegrationRegistryService` reconciles the declaration against the adapter **at boot**. A
provider that claims `hmac_header` with no `verifyInbound`, or `deliveryIsAReference` with no
`fetchLead`, fails startup rather than answering 500 on its first real delivery. That is the same
stance as "every route declares its authorization or the app does not start", and it is what makes
the optionality safe rather than a hole.

`inboundVerification` is a property of the **provider**, not of its auth kind. An earlier draft
decided "does this provider have an inbound door" from `authKind === 'shared_secret'`, which was
right for the two providers that existed and wrong for Meta — which holds a token we send _and_
posts to us, and would have been given a 404 on its own callback URL.

### 4. A connection holds a **set** of secrets, in one envelope

Meta needs two doing two jobs: an app secret to prove a delivery is Meta's, and a page access token
to fetch the lead it refers to. A single `credential` column would have forced the second one into
`settings`, and settings are rendered on the screen, echoed back on a refusal and written into the
audit log — the three things a secret must never be. So `credentialFields` is a list on the provider
and the vault seals the whole set as one JSON envelope under the row's own id.

**One envelope, not one per field**, because the set is what a connection _is_: two columns would
make "the app secret was rotated and the page token was not" a state the schema allowed and nothing
checked, which is exactly the half-reconnection that looks fine and fails on the next delivery. The
API accepts `credentials` as all-or-nothing for the same reason.

The cost is an API change to an endpoint shipped in the step before this one: `credential` became
`credentials`. The breaking-change classifier flagged it, which is the system working, and the
alternative — a second credential column, or an app secret in `settings` — is worse than a rename in
the same phase.

### 5. The answers are flattened by **name** before the mapping runs

Meta sends `[{ name: 'full_name', values: ['Asha Rao'] }]` and Google sends
`[{ column_id: 'FULL_NAME', string_value: 'Asha Rao' }]`. Neither is addressable by a dot path, and
mapping them as `field_data.0.values.0` would be an index that moves the day somebody reorders the
form's questions. Flattening by the question's own stable key is what makes each provider's
`defaultMapping` writable at all — and therefore what makes a connection **work the moment it is
made**, with nobody editing a mapping.

Two details that are not arbitrary: a question answered more than once keeps **all** its values
joined by a comma, because taking the first silently discards an answer somebody gave; and a Google
column is keyed by `column_id` rather than `column_name`, because the name is the question's wording
and changes when the form is edited. A custom question has no id, so its name is used — the one case
where editing a form can break a mapping, and the one Google gives no alternative for.

## Consequences

**Good.** Both connectors are a registry entry and an adapter: no new module, no new screen, no new
vault code, no new schedule. A delivery either provider retries produces one lead, proven by a
constraint rather than by a code path. A revoked token becomes one reconnect prompt with the
provider's own words. And the delivery ledger answers "why did that lead not appear" without anybody
reading our logs — the provider said something, and either it became a lead or here is their reason.

**Costs, stated.** There is still **no OAuth**: both connectors take a long-lived credential that
somebody pastes, which is what Meta's Page tokens and Google's webhook keys actually are, but an
app that wants to connect a Page in two clicks needs an authorization-code exchange and a refresh
sweep. `INTEGRATION_AUTH_KINDS` therefore still has two values. The **ads insight syncs** (campaign
and metric pulls, which are what `sync_cursors` is for) are Phase 9 and remain unbuilt. Google Ads
deliveries are **replayable by anybody who has ever seen one** — there is no signature over the
bytes and no timestamp to bound — so the ledger's unique is the only thing standing between a
captured payload and a duplicate lead; that is Google's design, not ours, and it is why this
connector could not have been built before the ledger. And `provider_events` is pruned by nothing
until Phase 9's retention sweep.

**What would change this decision.** A provider that sends the lead _and_ an id would make
`deliveryIsAReference` a per-payload question rather than a per-provider one. The honest answer then
is two registry entries, not a conditional: a provider that sometimes sends the answers and
sometimes a pointer is two providers wearing one name.
