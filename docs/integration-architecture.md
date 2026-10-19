# Integration Architecture — Lead OS

**Principle:** the CRM core never imports a vendor SDK. Every external system is reached through a
**provider adapter** behind a domain interface, registered in a provider registry, configured per
tenant, with encrypted credentials, health monitoring and graceful failure.
Traces to: `FR-WA-*`, `FR-CALL-2`, `FR-MKT-2`, `FR-CAP-1`, `NFR-REL-3`, Rule 8

---

## 1. Why adapters, concretely

The brief demands WhatsApp today, telephony later, "additional advertising providers later", payment
providers, and swappable email. If `LeadsService` ever calls `metaClient.sendMessage()`, then adding
a second WhatsApp BSP or an IVR vendor becomes a rewrite. So:

```
domain module  ──depends on──▶  interface (packages/contracts + module port)
                                      ▲
                          ┌───────────┴────────────┐
                    MetaCloudAdapter        FutureBspAdapter
```

Rules: (1) capabilities are declared, not assumed — `adapter.capabilities.supportsInteractive` gates
UI, so a weaker provider degrades instead of throwing; (2) all provider errors are mapped to a
canonical `IntegrationError { code, retryable, providerCode, userMessage }`; (3) no adapter touches
the database — it speaks HTTP and returns domain-shaped results; the calling module persists.

---

## 2. Provider interfaces

```ts
// Channel (WhatsApp today; SMS/email/webchat later)
interface MessagingProvider {
  readonly key: 'whatsapp_cloud' | string;
  readonly capabilities: {
    templates: boolean; media: boolean; interactive: boolean; reactions: boolean;
    serviceWindowHours?: number; maxTextLength: number;
  };
  sendText(a: SendTextArgs): Promise<ProviderMessageRef>;
  sendMedia(a: SendMediaArgs): Promise<ProviderMessageRef>;
  sendTemplate(a: SendTemplateArgs): Promise<ProviderMessageRef>;
  sendInteractive?(a: SendInteractiveArgs): Promise<ProviderMessageRef>;
  markRead?(a: MarkReadArgs): Promise<void>;
  downloadMedia(mediaId: string, cred: Credentials): Promise<MediaStream>;
  listTemplates(cred: Credentials): Promise<TemplateSnapshot[]>;
  submitTemplate(t: TemplateDraft, cred: Credentials): Promise<TemplateSubmissionResult>;
  verifyWebhook(req: RawRequest, cred: Credentials): WebhookVerification;   // signature + challenge
  parseWebhook(req: RawRequest): NormalizedInboundEvent[];                  // → canonical events
  healthCheck(cred: Credentials): Promise<ProviderHealth>;
}

interface AdsProvider {          // meta | google | (tiktok, linkedin later)
  listAccounts(cred): Promise<AdAccount[]>;
  listCampaigns(accountId, cred, cursor?): Promise<Page<CampaignSnapshot>>;
  listEntities(campaignId, cred): Promise<AdEntitySnapshot[]>;    // ad sets / ads / keywords
  getDailyMetrics(accountId, range, cred): Promise<DailyMetric[]>; // spend, impressions, clicks
  fetchLead?(externalLeadId, cred): Promise<NormalizedLeadPayload>; // Meta leadgen retrieval
  subscribeLeadWebhook?(accountId, cred): Promise<void>;
}

interface TelephonyProvider {    // abstraction exists in Phase 3, implementations later (FR-CALL-2)
  capabilities: { clickToCall: boolean; recording: boolean; ivr: boolean; transcription: boolean };
  initiateCall(a: { fromUser, toE164, leadId }): Promise<ProviderCallRef>;
  getCall(id, cred): Promise<CallSnapshot>;
  parseWebhook(req): NormalizedCallEvent[];
}

interface PaymentProvider { createPaymentLink(...); getPayment(...); parseWebhook(...); refund?(...) }
interface EmailProvider   { send(...); parseWebhook(...) /* bounces, complaints → suppressions */ }
interface StorageProvider { putObject(...); getSignedUrl(...); deleteObject(...); }
interface AnalyticsProvider{ /* read-only: GA4, Search Console */ getMetrics(...); }
interface AiProvider      { complete(...); summarize(...); /* budget-capped, optional */ }
```

All adapters live in `apps/api/src/infra/providers/<provider-key>/` and are registered into a
`ProviderRegistry` keyed by provider key; the registry resolves `(organizationId, capability)` →
adapter + decrypted credentials, and is the only component that can decrypt.

> **Amendment, 2026-10-14 (implementation, Phase 3 step 6).** `TelephonyPort` is built, in
> `apps/api/src/infra/telephony/`, with one driver — `ManualTelephony` — and it is **narrower** than
> the sketch above. The contract is written from what the CRM needs rather than from what a provider
> offers ([ADR-0027](./decisions/ADR-0027-calls-sit-behind-a-port-and-an-attempt-is-not-a-contact.md)):
>
> ```ts
> export interface TelephonyPort {
>   readonly driver: string;
>   readonly placesCalls: boolean;
>   dial(request: { to: string; from?: string; callId: string }): Promise<DialOutcome>;
> }
> type DialOutcome =
>   | { mode: 'device'; href: string }
>   | { mode: 'provider'; provider: string; providerCallId: string };
> ```
>
> - **`dial` answers how the call will be placed, not that it was.** A cloud provider rings both
>   parties server-side; the manual driver hands the number to the device. Those are genuinely
>   different outcomes, so the port says which happened — a port that pretended otherwise would make
>   every caller guess. `placesCalls` is what lets the screen say "this opens your phone" instead of
>   implying the product is dialling.
> - **`getCall` and `parseWebhook` are not on it.** A webhook arrives on a call that already exists,
>   so it is an **update to a row** — and the row, its provider columns and the partial unique index
>   that makes an at-least-once delivery idempotent are already in place for it. Pulling a snapshot
>   through the port would put the webhook's work in two places.
> - **There is no hangup.** Nothing in this product can end a call it did not place, and the manual
>   driver could never implement one. A port method a driver has to throw from is a lie in the
>   contract.
> - **`capabilities` collapsed to `placesCalls`.** A four-flag capability object invites callers to
>   branch on flags nothing reads; the one flag the product actually behaves differently on is
>   whether the call is placed here or on the device.
>
> It is **not** in `infra/providers/` and not in the `ProviderRegistry`: there are no stored
> credentials to decrypt yet. `TelephonyModule` is `@Global()`, like storage and mail, so the Phase 4
> webhook controller needs no wiring to reach it.

> **Amendment, 2026-10-14 (implementation, Phase 3 step 7).** `EmailProvider` above is built as
> `MailerPort` in `apps/api/src/infra/mail/`, with two drivers — the development logger and
> **Postmark** — and it is narrower and wider than the sketch in two specific ways
> ([ADR-0028](./decisions/ADR-0028-email-sits-behind-a-port-and-a-bounce-is-a-fact-about-a-mailbox.md)):
>
> ```ts
> interface MailerPort {
>   readonly driver: string;
>   readonly sends: boolean;
>   send(email: OutboundEmail): Promise<{ providerMessageId: string | null }>;
>   parseEvent(body: unknown): readonly ParsedEmailEvent[];
> }
> ```
>
> - **`send` answers with the provider's message id.** A `void` send makes a bounce unattributable,
>   and an unattributable bounce is a suppression list that can never be filled from the one source
>   that knows. `EmailSenderService` writes the row before and after asking, so a provider failure
>   leaves a record of the attempt rather than nothing.
> - **`parseEvent` is on the port**, because the vocabulary is the provider's: Postmark says
>   `HardBounce` and `SpamComplaint`, SES says `Bounce` with a `bounceType`. Above the port there
>   are four words, and the distinction that matters is hard versus soft — a full mailbox is
>   `failed` and suppresses nothing.
> - **Templates are not on it.** A provider's template store is a second place for the copy to live,
>   and the two would drift. Nor are scheduled sends: the queue already does that, and better.
> - **Postmark is chosen for its shape, not its features**: one JSON POST, so there is no SDK inside
>   the thing that sends password resets, and a webhook that carries the message id it was given.
>
> The webhook lives in `modules/webhooks`, not here: a public HTTP route has an authentication story
> and a contract with somebody else's system, which makes it a product surface. It presents
> `EMAIL_WEBHOOK_SECRET`, which the configuration schema requires the moment a real driver is set.

> **Amendment, 2026-10-19 (implementation, Phase 4 step 6 — the integration framework).** The
> **registry** and the **port** are built, and the port is two methods rather than the dozen §2
> sketches ([ADR-0034](./decisions/ADR-0034-a-provider-is-a-registry-entry-and-an-adapter.md)):
>
> ```ts
> interface IntegrationAdapter {
>   readonly provider: string;
>   validate(input: { credential: string; settings: Record<string, unknown> }): void | Promise<void>;
>   probe?(context: AdapterContext): Promise<ProbeResult>;
> }
> ```
>
> - **`probe` is optional**, and that absence is the design. `generic_webhook` is authenticated by a
>   secret *we* generated, so there is no endpoint of theirs to call — "is this healthy" means "has
>   anything arrived". A `healthCheck` that returned `ok` without asking anything would be a green
>   tick this product had not earned, and one that threw would be the lie in the contract the
>   telephony amendment above already names. The catalogue's `probeEveryMinutes` and the presence of
>   this method are **reconciled at boot**, so a provider that claims a cadence it cannot serve fails
>   startup rather than producing a sweep that looks scheduled and does nothing.
> - **`validate` runs before anything is stored**, with the credential in hand: a token that is not
>   a token, or a from-address the provider will refuse, is a 400 at connect time rather than a
>   connection whose first real send fails at 3am.
> - **`capabilities` is on the provider, not the adapter.** The registry entry
>   (`INTEGRATION_PROVIDERS` in `@leados/shared`) carries the label, the sentence somebody reads
>   before connecting it, its capabilities, its auth kind, the settings its connect form asks for,
>   whether it maps fields and its probe cadence — because the **screen** needs all of that and the
>   web app may not import an adapter. A capability object on the adapter would be the same facts in
>   a place the UI cannot reach.
> - **`listTemplates`, `sendText`, `getDailyMetrics` and the rest are not on this port**, and will
>   not be: those are *channel* and *ads* interfaces, which §2 is right to keep separate. This port
>   is the framework's own — "is this credential still good" — and an adapter implements it beside
>   whichever domain interface it also serves.
> - **No adapter touches the database**, as §1 requires: `AdapterContext` hands it the decrypted
>   credential, the settings and the ids, and the service persists.
>
> `ProviderRegistry` is built as `IntegrationRegistryService`, and `infra/providers/<key>/` is
> `modules/integrations/adapters/<key>.adapter.ts`: an adapter here is a provider of the integrations
> module rather than global infrastructure, because the vault it needs is deliberately reachable only
> from inside that module.


---

## 3. Connection lifecycle

```
connect  → tenant admin supplies credentials / completes OAuth
         → adapter.healthCheck() must pass BEFORE we store (no broken connections saved)
         → credentials encrypted (§5) → integration_connections(status=connected)
         → register webhooks where applicable → initial sync enqueued → audit log
verify   → scheduled healthCheck every 10 min → integration_health_checks
degrade  → transient failures: status=degraded, UI banner, retries continue
error    → auth failure / revoked token: status=error, tenant admin notified with the exact reason
           and a "reconnect" CTA; platform alerted if many tenants fail at once (provider outage)
refresh  → OAuth refresh ahead of expiry; failure escalates to error, never silent
disconnect→ unregister webhooks, revoke tokens where supported, soft-delete the connection,
            retain historical data (messages/campaign metrics stay — deleting a connection must not
            erase business history)
```

`integration_connections.status` drives a single UI component ("Integrations health") and the
`FR-SA-4` platform view. A connection in `error` disables only the features that need it —
`EntitlementGate`/`IntegrationGate` renders an explanation, the rest of the CRM keeps working.

> **Amendment, 2026-10-19 (implementation, Phase 4 step 6).** The lifecycle is built as described
> with three changes, each of which the sketch gets the wrong way round:
>
> - **The probe runs *after* the row is stored, not before it.** "`healthCheck()` must pass BEFORE
>   we store (no broken connections saved)" cannot be implemented as written: the credential's
>   ciphertext is bound to the connection's **own id** as AAD, so the row has to exist before a
>   probe can decrypt what it is probing with. And it should not be implemented as written either —
>   a provider having a bad minute would make connecting impossible, and the person pasting the
>   token would read a 500 as "it did not save". So `connect` stores, probes immediately, swallows
>   the probe's own failure, and answers the connection with the outcome already on it. A workspace
>   therefore *can* hold a connection that has never worked, which is the honest state and the one
>   the screen says out loud ("Never worked — last failed …").
> - **A revoked credential is `revoked`, not `error`.** §3 maps "auth failure / revoked token" to
>   `status=error`, which leaves the enum's fourth value unused and conflates "somebody must
>   reconnect this" with "the provider is having a bad hour". Built: `unauthorized` ⇒ `revoked`
>   immediately with no grace period, and `error` is what two consecutive transient failures
>   produce. `needsReconnect(status)` is the single predicate the screen and the notification both
>   read.
> - **The notification fires on the transition, once.** "tenant admin notified with the exact
>   reason and a reconnect CTA" is built as `integration.revoked` — not opt-out, with the provider's
>   own words, a link to `/settings/integrations`, and the connection id in its data so the
>   quiet-hours release sweep can drop it if somebody reconnected overnight. Notifying on **every**
>   probe that finds a connection revoked would be six notices an hour, which is the shape of alert
>   people mute. The platform-wide "many tenants at once" alert is not built: there is no alerting
>   pipeline yet, and the sweep logs a count at `warn`.
>
> `refresh` is **not** built, because no provider here uses OAuth. `register webhooks where
> applicable` is not built either: the one inbound provider's URL is handed to the person to paste
> into the sending system, which is what "generic" means.


---

## 4. WhatsApp Cloud API (the reference implementation)

**Model:** one `integration_connection` (WABA-level) → `whatsapp_accounts` → `whatsapp_numbers`.
Tenant-level connection (each tenant brings their own WABA / phone numbers) with our Meta App as the
platform app; Embedded Signup (OAuth) is the preferred flow, manual token entry supported as a
fallback for tenants who already have a WABA.

**Outbound path**

```
UI / automation → MessagesService.send()
  ├ authorize (permission + conversation ownership)
  ├ policy check: inside 24 h service window? → free-form allowed
  │                outside window            → template only, else 422 OUTSIDE_SERVICE_WINDOW
  ├ consent + suppression check (marketing category)            (FR-PRV-2, FR-WA-10)
  ├ entitlement + usage check (messages/month)                  (FR-BIL-4)
  ├ persist message (status=queued) [TX + outbox]
  └ queue whatsapp-out (rate-limited per phone_number_id, idempotency key = message.id)
        → adapter.sendTemplate/sendText → provider_message_id stored (status=accepted)
        → status webhooks advance sent → delivered → read
        → failure: error_code + user-readable reason on the message, timeline entry,
          agent notification, integration health updated  (never silent — NFR-REL-3)
```

**Inbound path** — see `system-architecture.md` §8.2. Key guarantees: signature verified over the raw
body; tenant resolved from `metadata.phone_number_id` **and** cross-checked against the path's
connection id; `provider_events` unique constraint is the dedupe gate; media downloaded to our S3
asynchronously with the provider media id retained; conversation window/unread/SLA updated; unknown
payload shapes are stored and acknowledged, never 4xx'd.

**Templates (`FR-WA-5`)**: drafts are authored locally, submitted through the adapter, and
reconciled by a `wa.sync-templates` job (status, rejection reason, quality). Variable mapping is
stored per template (`{{1}} → lead.full_name`, `{{2}} → cf.course`) and resolved at send time by the
same template resolver the automation engine uses; a missing/blank variable is a hard failure before
the send, not a message reading "Hi undefined".

**Policy compliance (`FR-WA-1`)**: template-only outside the window; marketing templates require
consent; opt-out keywords (configurable per org, default `STOP`/`UNSUBSCRIBE`) write a suppression
and revoke consent immediately; per-number throughput respects the messaging tier; quiet hours for
bulk sends; every bulk recipient is audited. We do not build, document or support any unofficial
WhatsApp automation path.

---

## 5. Credential vault (`NFR-SEC-3`)

Envelope encryption: a KMS-held (or env-held in dev) **master key** encrypts per-organization **data
keys**; data keys encrypt credential blobs with **AES-256-GCM** (random 96-bit IV, auth tag stored,
AAD = `organizationId|provider|keyVersion` so a blob cannot be replayed into another tenant's row).

```
integration_connections.credentials_encrypted = ciphertext || iv || tag
integration_connections.key_version           = 3
```

Rules: plaintext exists only inside API/worker process memory for the duration of a call; credentials
are **never** returned by any endpoint (the API returns `{ connected: true, accountName, maskedId, expiresAt }`);
never logged (a pino redaction list plus a lint rule on logger calls); never included in audit
`before/after` values; rotated via `key_version` with a background re-encrypt job; access to
decryption is confined to `ProviderRegistry` and is audit-logged with the calling context.

> **Amendment, 2026-10-19 (implementation, Phase 4 step 6).** The vault is built, with **one**
> master key rather than per-organization data keys, and a different AAD
> ([ADR-0034](./decisions/ADR-0034-a-provider-is-a-registry-entry-and-an-adapter.md)):
>
> ```
> integration_connections.credentials_encrypted = 'v1.1.<iv>.<tag>.<ciphertext>'   -- dot-separated base64url TEXT
> integration_connections.key_version           = 1
> AAD                                           = 'integration:<connection id>'
> ```
>
> - **The AAD is the row's own id**, not `organizationId|provider|keyVersion`. It is strictly
>   narrower: the id implies the workspace and the provider, and it also stops a ciphertext being
>   moved between **two connections of the same workspace to the same provider** — which the
>   sketch's AAD would have allowed. It is the construction `api_keys.secret_encrypted`,
>   `webhook_endpoints.secret_encrypted` and the MFA secret already use, which is the point: a
>   fourth arrangement would be a fourth place to get the AAD wrong, and a wrong AAD still works on
>   the happy path.
> - **The envelope is `TEXT`, not `ciphertext || iv || tag` bytes**, and carries its own format and
>   key version so a rotation can find the rows it has not re-wrapped.
>   `integration_connections_credentials_encrypted` refuses a value that is not an envelope and
>   refuses one that still begins `sk_` or `whsec_` — which is exactly what storing the token as the
>   provider gave it looks like.
> - **Per-organization data keys are deferred, not forgotten.** Envelope encryption with a data key
>   per tenant is a KMS story and a key table; the format already carries the version field it
>   needs, and nothing in the application changes when it arrives.
> - **The read is confined to one service with one function.** `IntegrationVaultService.open(id, …)`
>   takes the connection's id and nothing else, so a call site cannot pass the wrong AAD; it is not
>   exported from the integrations module. Plaintext is never returned by any endpoint, never
>   logged, and never in an audit `before/after` — and the presenter's `select` does not include the
>   ciphertext either, so it cannot reach a response by somebody extending the presenter later.
> - **What an endpoint answers is not `{ connected: true, … }`** but the connection's own standing,
>   the provider's last words, its last success and its recent probes — the things somebody opening
>   the screen is actually asking about. The decryption audit log is **not** built: every read is
>   from the probe or the inbound door, both of which already record what they did.


---

## 6. Inbound integration catalogue

| Integration                         | Direction | Mechanism                                                                                                                        | Phase |
| ----------------------------------- | --------- | -------------------------------------------------------------------------------------------------------------------------------- | ----- |
| Website forms (ours)                | in        | Direct API call from the generated site                                                                                          | 7     |
| Public lead API                     | in        | `POST /api/public/v1/leads/{publicKey}` + HMAC + idempotency                                                                     | 4     |
| Generic inbound webhook             | in        | Per-connection URL + a stored **field-mapping template** (JSONPath → lead field) so a new lead vendor is configuration, not code | 4     |
| Meta Lead Ads                       | in        | Webhook `leadgen` → fetch by `leadgen_id` → normalize → capture pipeline                                                         | 4     |
| Google Ads lead forms               | in        | Webhook + shared secret → capture pipeline                                                                                       | 4     |
| WhatsApp inbound                    | in/out    | Cloud API webhooks + Graph sends                                                                                                 | 5     |
| Meta Ads insights                   | in        | Scheduled pull (campaigns, ad sets, ads, daily spend)                                                                            | 9     |
| Google Ads insights                 | in        | Scheduled pull                                                                                                                   | 9     |
| Google Analytics 4 / Search Console | in        | Scheduled pull (read-only)                                                                                                       | 9     |
| Payment provider                    | in/out    | Payment links + webhooks (`payment.completed`)                                                                                   | 3/9   |
| Telephony                           | in/out    | Click-to-call + call webhooks (abstraction in 3)                                                                                 | later |
| Email (transactional)               | out       | Provider adapter; bounce/complaint webhooks → suppressions                                                                       | 3     |
| Outbound webhooks                   | out       | Signed, retried, logged (`api-architecture.md` §8)                                                                               | 4     |
| CSV/Excel import                    | in        | Import wizard through the same capture pipeline                                                                                  | 2     |
| Zapier/Make                         | in/out    | Falls out of the public API + outbound webhooks; no bespoke work                                                                 | 4     |

**The generic mapping template is the strategic piece**: `{"phone": "$.contact.mobile", "cf.budget": "$.answers[?(@.q=='budget')].value"}`.
Most "integrate with lead platform X" requests become a saved mapping plus a webhook URL — no
deploy, no code (Rule 1, Rule 4).

> **Amendment, 2026-10-19 (implementation, Phase 4 step 6).** The **generic inbound webhook** row is
> built, and the mapping template is dot paths with a declared transform rather than JSONPath:
>
> ```json
> [
>   { "source": "contact.full_name", "target": "name", "transform": "trim" },
>   { "source": "contact.mobile", "target": "phone", "transform": "phone" },
>   { "source": "answers.0.value", "target": "custom.budget" }
> ]
> ```
>
> - **An array of entries, not an object keyed by target.** `mappingProblems` can then say "two
>   fields both write to `phone` — the one lower down would quietly win", which is the mistake an
>   object literal makes unrepresentable by silently discarding one of them, and which a schema
>   cannot see.
> - **Dot paths, not JSONPath.** `$.answers[?(@.q=='budget')].value` is a filter expression, which
>   is a query language in a JSONB column — a program nobody reviews, stored per tenant. Dot paths
>   with numeric segments reach everything the providers this product sees actually send
>   (`field_data.full_name`, `answers.0.value`), and what they cannot reach is a mapping somebody
>   would have to debug anyway.
> - **Six transforms, each earning its place from a real provider's habit**: `trim`, `lowercase`,
>   `digits`, `phone`, `boolean`, and `none`. Ad platforms send `Full Name` as one field, phone
>   numbers arrive with brackets, and a "yes"/"no" answer is a string that means a boolean.
> - **`cf.budget` is spelled `custom.budget`**, the same prefix the public capture endpoint and the
>   one-click custom field already use, and the key is checked against the workspace's own
>   definitions by the mapper rather than by the schema.
> - **The target list comes from the public capture schema, not the lead table.** A mapping may not
>   write `score`, `assignedUserId` or `status`: those are the workspace's own rules, and an
>   integration overruling them from somebody else's config file is the one thing this feature must
>   not allow.
> - **"No deploy, no code" is now true**, and the rest of the claim with it: a new lead vendor is a
>   connection, a secret, a URL and a saved mapping. Meta Lead Ads and Google Ads lead forms remain
>   Phase 4 and remain unbuilt — both need OAuth and Meta needs `provider_events`, which is the
>   ledger for a provider that sends its own event ids.


---

## 7. Resilience for every outbound call

Mandatory wrapper for all provider calls (`NFR-REL-3`):

| Control         | Setting                                                                                                                                             |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Timeout         | connect 3 s, total 10 s (media: 30 s)                                                                                                               |
| Retries         | 3 in-process for idempotent GETs; writes are retried by the **queue**, never in-process (avoids duplicate sends)                                    |
| Backoff         | exponential + full jitter; `Retry-After` honoured                                                                                                   |
| Circuit breaker | per `(provider, organizationId)`: open after 5 consecutive failures for 60 s, half-open probe; open circuit → jobs delayed, not failed              |
| Bulkhead        | per-provider concurrency caps so one provider's slowness cannot exhaust the worker pool                                                             |
| Rate limits     | per-provider token buckets in Redis, aligned to documented quotas (WhatsApp per number tier, Meta/Google per app)                                   |
| Observability   | every call emits a span + metric (`provider`, `operation`, `status`, `duration`) and a redacted debug log behind a per-connection "debug mode" flag |
| Error mapping   | provider code → canonical `IntegrationError` with `retryable` and a `userMessage` written for a small-business owner, not a developer               |
| Degradation     | UI shows the degraded feature with the reason; core CRM unaffected                                                                                  |

---

## 8. Adding a provider (the checklist that keeps this true)

1. Implement the interface in `infra/providers/<key>/`, including `capabilities` and error mapping.
2. Register it in `ProviderRegistry` with its credential schema (Zod) and required scopes.
3. Add a connect flow (OAuth or form) — generic UI driven by the credential schema, no bespoke screen.
4. Implement `healthCheck` and `parseWebhook` (if inbound).
5. Contract tests against recorded provider fixtures (happy path, auth failure, rate limit, malformed payload, duplicate delivery).
6. Add the provider to the integration-health view and the platform alert rules.
7. Document it: auth model, scopes, webhooks, rate limits, failure modes, example payloads (brief §68; see also `NFR-MNT`).

No changes to domain modules should be required. If a domain module must change to add a provider,
the abstraction is wrong and the PR is rejected.


> **Amendment, 2026-10-19 (implementation, Phase 4 step 6).** The checklist as it actually stands,
> now that the framework exists:
>
> 1. **An entry in `INTEGRATION_PROVIDERS`** (`@leados/shared`): label, the sentence somebody reads
>    before connecting it, capabilities, auth kind, the settings its connect form asks for, whether
>    it maps fields, and its probe cadence.
> 2. **An adapter** in `modules/integrations/adapters/`, registered in
>    `IntegrationRegistryService`'s constructor. `validate` always; `probe` only if there is
>    something to ask.
> 3. **Nothing else** for the parts this step built: the screen renders the connect form from the
>    entry, the vault seals whatever the adapter accepts, the sweep picks the provider up from its
>    declared cadence, and the boot check fails the application if half of it is missing. A new
>    provider needs **no migration** — `provider` is a string checked against the registry — and no
>    new screen.
> 4. Steps 5 and 6 of the list above stand: contract tests against the provider's own failures
>    (auth failure, rate limit, malformed payload, duplicate delivery) and a place in the health
>    view — which is now `/settings/integrations` and `GET /integrations/health` rather than
>    something to add per provider.
> 5. Step 7 stands, and is this file.
>
> Steps 1–4 of the original list describe a provider that also serves a **channel** or **ads**
> interface; those interfaces are unbuilt, so "implement the interface in `infra/providers/<key>/`"
> arrives with the first one that does. The resilience wrapper in §7 is **not** built as a shared
> wrapper: each adapter sets its own timeout (`AbortSignal.timeout`), and the circuit breaker,
> bulkhead and token buckets wait for a provider whose quota makes them necessary. What exists
> instead is the thing a failed probe produces — a standing, a recorded reason, and one notification
> — which is the degradation §7's last row asks for.
