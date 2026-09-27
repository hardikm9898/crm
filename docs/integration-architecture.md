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
