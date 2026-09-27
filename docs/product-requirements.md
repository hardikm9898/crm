# Product Requirements — Lead OS

**Version:** 0.1 (Phase 0) · **Status:** Baseline for implementation · **Owner:** Product Architecture

---

## 1. Problem statement

B2C businesses buy leads from many channels (Meta Lead Ads, Google Ads, website forms, landing
pages, WhatsApp, QR codes, marketplaces, referrals, walk-ins, imports) and then lose most of the
value of that spend for operational reasons, not marketing reasons:

| Failure | Root cause | What the product must do |
|---|---|---|
| Leads scattered across platforms | No common ingestion layer | One normalized `lead` per human, whatever the channel |
| Executives forget follow-ups | Work lives in memory and spreadsheets | A **Next Action** on every lead, and a "today" view that is the executive's whole job |
| Managers cannot see who handled what | No assignment history | Immutable assignment + activity history |
| WhatsApp on personal phones | No shared business inbox | Shared inbox on an official WhatsApp Business number |
| No lead timeline | Events written to different silos | A single append-only `activities` stream per lead |
| Nobody knows which channel makes money | Revenue not linked to touchpoints | Touchpoint capture + configurable attribution to revenue |
| Website behaviour invisible | No first-party analytics | Tracking script → events → rollups → funnels |
| Managers assign leads by hand | No rules engine | Declarative assignment rules (round-robin, geo, value, workload, availability) |
| Overdue work invisible | No SLA model | SLA clocks, ageing, escalation, manager alerts |

**Product loop:** `Capture → Normalize → Assign → Qualify → Communicate → Follow Up → Convert → Analyze → Retarget`

**Core principle:** *everything is designed around the lead.* If a feature produces an event that
a business owner would want to see when opening one lead, that event **must** be written to that
lead's timeline. This is a hard architectural rule, not a nice-to-have (see `FR-TL-*`).

---

## 2. Personas and the question each one opens the app to answer

| Persona | Opens the app asking | Primary surface |
|---|---|---|
| **Sales / Calling Executive** | "What do I need to do today?" | Mobile-first Today workspace: due now, overdue, new leads, unread WhatsApp |
| **Sales Manager** | "Which leads are being missed?" | Team SLA/overdue board, leaderboard, pipeline, conversation oversight |
| **Business Owner / Admin** | "Where do my leads come from and which source makes revenue?" | Source/campaign revenue attribution, pipeline value, team performance |
| **Marketing Manager** | "Where am I spending and what actually converts?" | Spend → leads → CPL → customers → CAC → revenue → ROAS, funnels, journeys |
| **Platform Super Admin** | "Which tenants are healthy, and is the SaaS operating correctly?" | Tenant list + health scores, MRR/ARR, usage, integration health, failed jobs |

Design acceptance test: each persona's primary question must be answered **above the fold, without
filtering or clicking**, on their default screen.

---

## 3. Scope model

Requirements are numbered `FR-<module>-<n>` (functional) and `NFR-<area>-<n>` (non-functional).
Each carries a target phase (see `implementation-roadmap.md`). `MUST` / `SHOULD` / `MAY` per RFC 2119.

---

## 4. Functional requirements

### 4.1 Tenancy & platform (`FR-TEN`) — Phase 1

- **FR-TEN-1** The platform MUST support many independent organizations (tenants) in one deployment.
- **FR-TEN-2** Hierarchy MUST be: Platform → Organization → Branch → Team → User; leads, customers, conversations, tasks and deals belong to exactly one organization and optionally to a branch/team.
- **FR-TEN-3** No request, job, report, export, search or webhook MAY return data belonging to another organization. Enforcement MUST be server-side and layered (repository scoping + database constraints + tests). Frontend filtering is never the control.
- **FR-TEN-4** Every tenant-scoped table MUST carry `organization_id`, and cross-row references MUST be constrained so a row cannot reference a row of another organization.
- **FR-TEN-5** Branch and team are *data scopes*, not separate tenants: a manager scoped to a branch MUST NOT see other branches' leads unless granted `all` scope.
- **FR-TEN-6** Organizations MUST have lifecycle states: `trialing`, `active`, `past_due`, `grace`, `suspended`, `cancelled`, `deleted (soft)`. State MUST gate access, never destroy data.
- **FR-TEN-7** Super Admin MAY impersonate a tenant user for support. Impersonation MUST be explicitly audited (actor, target, reason, start/end) and visibly banner-flagged in the UI. Impersonators MUST NOT perform destructive billing actions while impersonating.

### 4.2 Identity, roles & permissions (`FR-IAM`) — Phase 1

- **FR-IAM-1** Email + password authentication with strong hashing (Argon2id), email verification, password reset, and optional TOTP 2FA (2FA mandatory-capable per org policy).
- **FR-IAM-2** Short-lived access tokens + rotating refresh tokens with reuse detection and device/session listing + remote revoke.
- **FR-IAM-3** RBAC MUST be data-driven: permissions are rows, roles are rows, roles are per-organization, and system roles are seeded but editable clones. No role name MAY be hardcoded in business logic — code checks *permissions*, never role names.
- **FR-IAM-4** Permissions MUST carry a **data scope**: `own | team | branch | organization`. Example: `lead:read` with scope `team`.
- **FR-IAM-5** Seeded roles: Platform Super Admin, Platform Support, Org Owner, Org Admin, Sales Manager, Sales Executive, Marketing Manager, Read-only/Auditor.
- **FR-IAM-6** A user MAY belong to multiple organizations with different roles; the UI MUST offer an org switcher.
- **FR-IAM-7** Invitations by email with role + team + branch preassigned, expiry, and resend/revoke.
- **FR-IAM-8** Working hours, weekly off, holiday calendar and availability/leave status per user — consumed by assignment, SLA and automation.

### 4.3 Lead model & custom fields (`FR-LEAD`) — Phase 2

- **FR-LEAD-1** Standard fields: first/last/full name, phone, WhatsApp number, email, company, city, state, country, source, campaign, assigned user, assigned team, branch, status, pipeline, stage, priority, lead score, tags, created/updated, first contacted, last contacted, next follow-up, converted date, lost reason, consent flags.
- **FR-LEAD-2** Phone/WhatsApp numbers MUST be stored in normalized E.164 plus the raw input; a default country per organization resolves local formats.
- **FR-LEAD-3** Admins MUST be able to define custom fields of types: text, textarea, number, currency, date, datetime, select, multiselect, radio, checkbox, boolean, url, email, phone, file, image, user-reference, lead-reference.
- **FR-LEAD-4** Per field, admins configure: key, label, placeholder, help text, required, default, validation (min/max/regex/precision), options (with order + colour), section, sort order, visibility by role, show-in-list, searchable, filterable, and whether the field is PII.
- **FR-LEAD-5** Creating a custom field MUST NOT require a schema migration or a deploy.
- **FR-LEAD-6** Custom fields MUST be filterable, sortable on indexed fields, importable, exportable, usable in automation conditions, and mappable into WhatsApp template variables.
- **FR-LEAD-7** Statuses, priorities, lost reasons, tags and sources are tenant-configurable lists, not enums in code.
- **FR-LEAD-8** Soft delete with a restorable recycle bin and a retention-driven purge.
- **FR-LEAD-9** Bulk actions: assign, reassign, change stage/status, add/remove tag, set priority, create task, export, delete — executed as background jobs with a progress/result report above a configurable row threshold.

### 4.4 Lead capture (`FR-CAP`) — Phases 2 & 4

- **FR-CAP-1** Capture channels: dynamic forms, public lead API, generic inbound webhook, Meta Lead Ads, Google Ads lead forms (where supported), landing pages, website forms, WhatsApp inbound, QR codes, CSV/Excel import, manual creation.
- **FR-CAP-2** Admins MUST be able to build forms with dynamic fields (mapped to standard or custom lead fields), multi-step, consent checkboxes, honeypot + rate limit + optional CAPTCHA, redirect/thank-you config, and embeddable script/iframe.
- **FR-CAP-3** Every capture MUST persist the raw payload for replay and debugging, independent of whether lead creation succeeded.
- **FR-CAP-4** The ingestion pipeline MUST be one shared code path for all channels: `validate → resolve tenant → normalize → capture UTM/source/campaign/ad → duplicate check → score → assign → create first follow-up → emit events → notify → optional WhatsApp template → write timeline`.
- **FR-CAP-5** Ingestion MUST accept unknown/extra fields without failing; unmapped values land in a quarantined `raw_payload` and are surfaced to the admin as "unmapped fields" with a one-click "create custom field from this".
- **FR-CAP-6** Public ingestion MUST be authenticated per tenant (public key + secret/HMAC), rate limited, idempotent on a client-supplied or derived key, and observable (request log, error log, last-received timestamp, test-request tool, copyable docs/examples).
- **FR-CAP-7** Credentials MUST be generatable, rotatable and revocable by the tenant admin with the secret shown exactly once.

### 4.5 Duplicate detection & merge (`FR-DUP`) — Phase 2

- **FR-DUP-1** Configurable matching rules per organization: by phone, WhatsApp number, email, or a composite (e.g. email+name, phone+city), each rule orderable and toggleable, with a lookback window.
- **FR-DUP-2** Configurable outcome per rule: `attach_activity_to_existing` (default), `create_and_link_as_possible_duplicate`, `reject`, or `create_new`.
- **FR-DUP-3** When a duplicate is detected, source attribution MUST be preserved as an additional **touchpoint** on the existing lead — never overwritten. A lead can be "Facebook-originated, later re-engaged via website".
- **FR-DUP-4** Merge MUST let a human pick the surviving record and, per conflicting field, which value wins; it MUST union timelines, tasks, conversations, notes, documents, touchpoints and deals; it MUST be recorded in the audit log and be reversible for a bounded window.
- **FR-DUP-5** Same capabilities for customers.

### 4.6 Assignment engine (`FR-ASG`) — Phase 2

- **FR-ASG-1** Ordered rule sets evaluated on lead creation and on explicit re-evaluation.
- **FR-ASG-2** Conditions MAY use source, campaign/ad, form, geography, product/service interest, language, lead score, value band, custom fields, time of day and day of week.
- **FR-ASG-3** Targets: specific user, team, branch, round-robin within a pool, weighted round-robin, least-open-leads (load balance), highest-performer, or manager fallback.
- **FR-ASG-4** Assignment MUST respect working hours, holidays, leave and capacity caps; if no one is eligible, the lead goes to a configurable fallback queue (unassigned pool) and MUST raise a manager notification rather than silently vanish.
- **FR-ASG-5** Every assignment/reassignment writes `lead_assignments` (from, to, by, reason, rule, at) and a timeline activity.
- **FR-ASG-6** Reassignment MUST support bulk, and MUST optionally transfer or reassign open tasks and conversation ownership.
- **FR-ASG-7** **Lead recycling:** leads untouched for N days, or lost for a configurable reason, MAY be returned to the pool or re-engaged by rule.

### 4.7 Lead scoring (`FR-SCR`) — Phase 2, extended in 8

- **FR-SCR-1** Admin-configurable additive/decay rules with weights over: source, form data (e.g. budget band), website behaviour (pricing page, checkout start, repeat visits), WhatsApp engagement, email engagement, response latency, conversation count, recency/inactivity decay, negative signals (no response, invalid number).
- **FR-SCR-2** Score MUST be recomputed on relevant events and on a schedule (for decay), and MUST be explainable: the UI shows which rules contributed how many points.
- **FR-SCR-3** Score bands (e.g. hot/warm/cold) are configurable thresholds and drive views, assignment and automation.

### 4.8 Pipelines (`FR-PIP`) — Phase 2

- **FR-PIP-1** Multiple pipelines per organization (e.g. New Sales, Site Visits, Renewals), each with ordered stages carrying name, colour, win/lose semantics, probability %, required fields, target duration (for ageing) and entry/exit automation hooks.
- **FR-PIP-2** Kanban with drag-and-drop, WIP counts, per-stage value totals, and virtualized/paged columns (never load all leads).
- **FR-PIP-3** Stage changes MUST be validated against required fields, logged to `lead_stage_history` with duration-in-stage, and emitted as events.

### 4.9 Tasks, follow-ups & SLA (`FR-TSK`) — Phase 3

- **FR-TSK-1** Tasks relate to lead, customer, deal or conversation; fields: title, description, type, due date/time, timezone, priority, assignee, reminder offsets, status, completion note, outcome, completed_at.
- **FR-TSK-2** Task types (configurable): call, WhatsApp, email, meeting, follow-up, demo, site visit, payment follow-up, document collection, custom.
- **FR-TSK-3** Statuses: pending, in_progress, completed, overdue (derived), cancelled, rescheduled.
- **FR-TSK-4** Every open lead SHOULD have exactly one **Next Action**; the system MUST warn on leads with no next action ("silent leads") and MAY auto-create one by rule.
- **FR-TSK-5** Reschedule MUST require new date, new time and a **reason** from a configurable list (customer requested later, customer busy, unavailable, price discussion pending, decision maker unavailable, callback requested, other + free text). Reschedule count per lead MUST be visible and reportable — chronic rescheduling is a coaching signal.
- **FR-TSK-6** Completing a task MUST prompt for outcome and offer "create next follow-up" in the same interaction.
- **FR-TSK-7** Today view: due now, due today, overdue, upcoming, completed, with counts, sorted by priority then due time; usable one-handed on mobile.
- **FR-TSK-8** **SLA:** per-source/priority first-response and next-response targets; SLA clocks respect working hours; breach and near-breach raise escalation to the manager and are reportable (first response time, time to first call, time to qualify).

### 4.10 Timeline & activities (`FR-TL`) — Phase 2 onward

- **FR-TL-1** One append-only timeline per lead containing, at minimum: creation, source/campaign/ad/landing page/form submission, assignment and every reassignment, calls, WhatsApp messages (both directions) with status, emails, notes, internal comments and mentions, tasks created/completed/rescheduled (with reason), status and stage changes, score changes, quotations, payments, website activity, marketing touchpoints, documents, automation events (including why an automation did or did not fire), merges, conversion and revenue.
- **FR-TL-2** Activities MUST be immutable, ordered by `occurred_at` with a deterministic tiebreak, filterable by type, and paginated.
- **FR-TL-3** Activities MUST be written by domain services/event handlers, never by ad-hoc controller code, so no channel can forget to log.

### 4.11 WhatsApp (`FR-WA`) — Phase 5

- **FR-WA-1** Official **Meta WhatsApp Cloud API** only. No unofficial automation, no browser/desktop scraping. Messaging MUST honour the 24-hour customer-service window and template rules.
- **FR-WA-2** Per organization: connect WABA, manage phone numbers, store tokens encrypted, verify webhook, display connection health and the reason for any failure.
- **FR-WA-3** Send/receive text, image, video, audio, document, location, contacts, stickers, reactions, interactive buttons and list messages; media stored in our object storage with provider media ids retained.
- **FR-WA-4** Track message status transitions (accepted → sent → delivered → read → failed) with error codes surfaced in the UI.
- **FR-WA-5** Templates: create/submit, sync status (approved/pending/rejected with reason), categories (marketing/utility/authentication), languages, header/body/footer/buttons, variable mapping to lead fields (standard **and** custom), live preview, and a per-template send test.
- **FR-WA-6** Webhooks MUST be signature-verified, tenant-resolved by phone number id, **idempotent on provider message/event id**, and processed asynchronously with retry. Meta retries MUST never create duplicate messages or duplicate automation runs.
- **FR-WA-7** **Shared inbox:** many agents on one business number, conversation list with filters (unread, mine, unassigned, priority, tag, SLA breaching), conversation assignment and ownership lock, transfer, close/reopen, internal notes, @mentions, tags, canned replies, search across message bodies, typing/read state, and realtime updates.
- **FR-WA-8** The inbox MUST show the lead context beside the conversation: lead fields, status, stage, score, owner, open tasks, previous conversations, and quick actions (change stage, add note, create follow-up, call).
- **FR-WA-9** Outbound sending MUST be queued per phone number with provider rate limiting and backoff; a failure MUST be visible, retryable and never silent.
- **FR-WA-10** Bulk/campaign sending MUST enforce opt-in consent, template-only content, per-number throughput limits, quiet hours, and per-recipient audit. Consent revocation (`STOP`-style keywords) MUST immediately suppress marketing sends.

### 4.12 Calls & telephony (`FR-CALL`) — Phase 3 (abstraction), later (providers)

- **FR-CALL-1** Click-to-call, call tasks, manual call logging with outcome, duration, notes and optional recording URL.
- **FR-CALL-2** Telephony MUST sit behind a provider abstraction so cloud telephony, IVR, dialer, recording, transcription and AI summary can be added without touching CRM core.
- **FR-CALL-3** Call outcomes are a configurable list and feed scoring, SLA and reports.

### 4.13 Automation (`FR-AUT`) — Phase 6

- **FR-AUT-1** Rule-based workflows first, visual builder later, on the same engine and the same stored definition format.
- **FR-AUT-2** Triggers: lead created, lead assigned, field changed, status changed, stage changed, tag added, task created/completed/overdue, WhatsApp message received/replied/failed, email event, website event (incl. checkout abandoned), payment completed, lead inactive for N days, SLA breached, schedule/cron, manual run.
- **FR-AUT-3** Conditions: field comparisons on standard + custom fields, score band, source/campaign, tag membership, time/working-hours, assignee attributes, and AND/OR groups.
- **FR-AUT-4** Actions: assign user/team (incl. round-robin), create task, send WhatsApp template, send email, change stage/status/priority, add/remove tag, update field, add note, notify user/manager (in-app/email/WhatsApp), call outbound webhook, wait/delay (absolute or relative, working-hours aware), branch on condition, stop automation, enroll in another workflow.
- **FR-AUT-5** Workflows MUST be versioned; a running instance keeps executing the version it started on.
- **FR-AUT-6** Guardrails MUST exist: per-lead re-entry rules, max runs per lead per window, loop detection, per-org concurrency and daily action caps, and a global kill switch per workflow.
- **FR-AUT-7** Every run MUST log every step with input, output, decision taken and error, be inspectable per lead, and be retryable from the failed step.
- **FR-AUT-8** Adding a new trigger or action type MUST NOT require changing the engine — both are registry entries with a schema.

### 4.14 Websites & landing pages (`FR-WEB`) — Phase 7

- **FR-WEB-1** Industry website templates (restaurant, salon, clinic, real estate, education, travel, fitness, automobile, jewellery, retail, electronics, professional services, e-commerce, local services), selectable and then customizable.
- **FR-WEB-2** Editable: logo, favicon, colours, fonts, pages, hero, services/products, pricing, gallery, testimonials, FAQ, contact, forms, WhatsApp CTA, social links, footer.
- **FR-WEB-3** SEO: per-page title/description/slug/canonical, Open Graph + Twitter cards, `robots.txt`, XML sitemap, structured data (LocalBusiness/Product), redirects.
- **FR-WEB-4** Custom domain connection with verification and automated TLS; a platform subdomain until then.
- **FR-WEB-5** Draft/publish with version history and rollback; published output MUST be fast (statically rendered/cached, CDN-friendly, image-optimized).
- **FR-WEB-6** Every form on a generated site is wired to CRM ingestion **automatically** — zero manual integration — capturing page, referrer, UTM, campaign, session and device.

### 4.15 Website & product analytics (`FR-ANL`) — Phase 8

- **FR-ANL-1** A lightweight first-party tracking script usable on generated sites **and** on a tenant's own site.
- **FR-ANL-2** Events: `visitor`, `session_start`, `page_view`, `product_view`, `form_view`, `form_submit`, `whatsapp_click`, `cta_click`, `scroll_depth`, `add_to_cart`, `checkout_start`, `purchase`, plus custom events.
- **FR-ANL-3** Dimensions: traffic source/medium/campaign/term/content, referrer, landing page, exit page, device, browser, OS, and **coarse geography only** (country/region/city-level, no precise location), with IP handled per `FR-PRV-*` (hashed/truncated, not stored raw beyond the processing window).
- **FR-ANL-4** Funnel reporting (visitors → product views → add to cart → checkout → purchase) with conversion rates at each step, plus revenue.
- **FR-ANL-5** Dashboards MUST read pre-aggregated rollups, never scan raw event tables. Raw events are for drill-down and re-aggregation only.
- **FR-ANL-6** Event ingestion MUST be idempotent on a client event id, tolerate clock skew, and drop bot traffic.
- **FR-ANL-7** Anonymous website activity MUST be stitched to a lead when the same visitor later identifies (form submit / WhatsApp click with tracked id), and that activity MUST appear on the lead timeline.

### 4.16 Customer journey & attribution (`FR-ATT`) — Phase 9

- **FR-ATT-1** Every marketing/behavioural interaction MUST create an ordered **touchpoint** on the lead.
- **FR-ATT-2** A visual journey per lead: ad → landing page → site visit → product view → form → CRM → WhatsApp → calls → follow-ups → checkout → payment → customer.
- **FR-ATT-3** Attribution models MUST be configurable per organization and per report: first touch, last touch, lead source, campaign-based; multi-touch (linear/position-based) designed for but deferred.
- **FR-ATT-4** Revenue MUST come from actual deals/payments, never from lead counts. ROAS/CAC MUST be computed from attributed revenue, with the model named on the report.

### 4.17 Marketing (`FR-MKT`) — Phase 9

- **FR-MKT-1** Campaign registry: name, platform, objective, dates, budget, spend, impressions, clicks, leads, qualified leads, customers, revenue, CPL, CPQL, CAC, ROAS.
- **FR-MKT-2** Connectors for Meta Ads and Google Ads (spend/impressions/clicks/lead sync), Google Analytics and Search Console (read), designed as adapters so more ad platforms can be added.
- **FR-MKT-3** Marketing dashboard tying spend to leads to customers to revenue, by channel, campaign, ad set and creative where available.
- **FR-MKT-4** Audience/segment builder over lead + behaviour data, for re-engagement and (subject to consent) retargeting exports.
- **FR-MKT-5** SEO module: tracked keywords, ranking snapshots, Search Console metrics, on-page issues, and per-client task reporting.

### 4.18 Deals, quotations & revenue (`FR-DEAL`) — Phase 2/3

- **FR-DEAL-1** Deals with value, currency, expected close, probability (from stage), products/line items, won/lost with reason.
- **FR-DEAL-2** Quotations with line items, taxes, discounts, validity, PDF generation, versioning and send-via-WhatsApp/email.
- **FR-DEAL-3** Payments recorded manually or via a payment provider adapter, partial payments supported; payment events feed automation and attribution.
- **FR-DEAL-4** Conversion: lead → customer, preserving the full timeline and all touchpoints (never a fresh record).

### 4.19 Search, filters & views (`FR-VIEW`) — Phase 2

- **FR-VIEW-1** Global search across leads, customers, phone (partial, E.164-aware), email, WhatsApp number, conversations, message bodies, deals, tasks and notes — scoped to the tenant and to the user's data scope, returning in <500 ms p95.
- **FR-VIEW-2** Lead filters over all standard fields, custom fields, date ranges (created, last activity, next follow-up, converted), source, campaign, status, stage, assignee, team, branch, score band, priority, tags, SLA state, ageing.
- **FR-VIEW-3** Saved views, shareable to team or private, with column selection, sort and default per role ("Hot Leads", "Overdue", "My Follow-ups", "Facebook Leads", "High Value", "No Next Action").

### 4.20 Import / export (`FR-IO`) — Phase 2

- **FR-IO-1** Import wizard: upload (CSV/XLSX) → detect columns → map to standard/custom fields (with remembered mappings per template) → validate → preview → background import → per-row error report → downloadable failed-rows file → re-import corrected file.
- **FR-IO-2** Import MUST apply duplicate rules (never blind-create), and MUST be able to run in "update existing" or "skip existing" mode.
- **FR-IO-3** Exports run as background jobs producing a downloadable, expiring, access-controlled file; exports of PII MUST require permission and be audit-logged.

### 4.21 Notifications (`FR-NOT`) — Phase 3

- **FR-NOT-1** Channels: in-app (realtime), email, WhatsApp where policy-appropriate; web push designed for, later.
- **FR-NOT-2** Types: new lead, lead assigned, new WhatsApp message, mention, follow-up due, follow-up overdue, SLA breach, task assigned/overdue, payment received, trial expiring, subscription expiring, integration failure, import/export complete.
- **FR-NOT-3** Per-user, per-type, per-channel preferences with quiet hours and digest options; system/security notices are not opt-out.

### 4.22 Billing & subscriptions (`FR-BIL`) — Phase 1 (model), Phase 10 (admin UI)

- **FR-BIL-1** Plans with monthly/annual pricing, currency, trial length, visibility and ordering — all Super-Admin editable, never hardcoded, never priced in the frontend.
- **FR-BIL-2** Feature limits and entitlements per plan: users, leads, WhatsApp numbers, WhatsApp messages/month, automations, active workflows, websites, domains, storage, API calls/min & /month, integrations, analytics retention, plus boolean feature flags. Per-org overrides MUST be possible.
- **FR-BIL-3** 7-day free trial by default (length configurable) with start/end, remaining-days display, expiry warnings (in-app + email + optional WhatsApp), grace period, then restricted mode. **Data MUST be preserved**, not deleted.
- **FR-BIL-4** Usage metering with counters per metric per period; soft warnings at configurable thresholds, then hard enforcement with a clear upgrade path and a machine-readable `LIMIT_EXCEEDED` error.
- **FR-BIL-5** Invoices, payments, failed-payment dunning, plan change with proration, cancellation and reactivation. Payment gateway behind an adapter (Razorpay/Stripe-class).
- **FR-BIL-6** **Service subscriptions** (SEO, Meta Ads management, Google Ads management, website development, landing page, content, social media) are tracked separately from the SaaS subscription, with their own packages, pricing, billing cycle, deliverables and status.

### 4.23 Super Admin (`FR-SA`) — Phase 10 (core parts earlier)

- **FR-SA-1** Manage organizations: create, view, edit, suspend, activate, extend trial, change plan, set overrides, soft-delete, restore.
- **FR-SA-2** Platform dashboard: total/active/trial/paid/expired orgs, users, leads (total + today), WhatsApp messages, website visitors, MRR, ARR, failed payments, API usage, storage; charts for new orgs, trial→paid conversion, churn, revenue, leads, active users, WhatsApp/website usage.
- **FR-SA-3** Manage plans, limits, feature flags, pricing, coupons, industry templates, website templates, service packages, global settings, notification templates and system automation.
- **FR-SA-4** Operational visibility: system health, integration health, webhook health (in + out), API usage, WhatsApp usage, storage usage, queue depth, failed jobs with retry, audit logs, impersonation logs, support tickets.
- **FR-SA-5** Automated alerts to platform staff: trial expiring, subscription expiring, failed payments, API/webhook failure spikes, WhatsApp integration failures, high usage, storage pressure, suspicious activity, job failures.
- **FR-SA-6** Tenant product analytics + **customer health score** (login frequency, active users, leads created, follow-up completion, WhatsApp usage, automation usage, website traffic, feature breadth, subscription age, support load) to flag churn risk.
- **FR-SA-7** Routine platform operations MUST NOT require a developer or a database console.

### 4.24 Audit & compliance (`FR-AUD`) — Phase 1

- **FR-AUD-1** Audit every security-, money-, permission-, integration- and data-significant action with actor, organization, action, resource type/id, before/after values (PII-redacted where needed), IP, user agent, request id and timestamp.
- **FR-AUD-2** Audit logs MUST be append-only and MUST NOT be editable or deletable from any tenant or admin UI; retention and export are policy-driven.

### 4.25 Privacy & consent (`FR-PRV`) — Phase 1 model, ongoing

- **FR-PRV-1** Consent capture per channel (WhatsApp, email, SMS, calls) with source, text shown, timestamp, IP and proof of capture; withdrawal at any time.
- **FR-PRV-2** Marketing sends MUST check consent and suppression lists at send time, not at enrollment time.
- **FR-PRV-3** Data subject workflows: export a person's data, delete/anonymize on request (with legal-hold and audit-retention exceptions clearly modelled), and per-entity retention policies with automated purge.
- **FR-PRV-4** PII fields are tagged as such, redacted in logs, and gated by permission in exports.
- **FR-PRV-5** The product provides **configurable privacy controls**; it MUST NOT claim legal compliance (e.g. GDPR/DPDP certification) in UI copy or docs.

### 4.26 Developer platform (`FR-API`) — Phase 4

- **FR-API-1** Versioned REST API (`/api/v1`) covering leads, customers, tasks, activities, conversations, messages, templates, campaigns, forms, websites, analytics, users and webhooks, with a consistent response envelope.
- **FR-API-2** API keys with scopes, expiry, IP allowlist, rotation and revocation; per-key rate limits and usage logs.
- **FR-API-3** OpenAPI 3.1 spec generated from code, published as interactive docs, with copy-paste examples per endpoint.
- **FR-API-4** Outbound webhooks for `lead.created|updated|assigned|converted`, `task.created|completed`, `conversation.created`, `message.received|sent`, `deal.won|lost`, `payment.completed`, plus signing secret, retries with exponential backoff, delivery log with response body/status, failure alerts and manual retry.
- **FR-API-5** Mutating endpoints MUST support `Idempotency-Key`.

### 4.27 AI layer (`FR-AI`) — Phase 11, strictly optional

- **FR-AI-1** AI MUST be an optional layer. Core CRM MUST function fully with AI disabled or the provider down.
- **FR-AI-2** Features: lead summary, conversation summary, suggested reply (human sends, never auto-send by default), next best action with stated reasoning, AI-assisted qualification/classification, and later call transcription/summary/sentiment.
- **FR-AI-3** Output MUST be labelled as AI-generated, editable by a human, and never a hidden authority: score/stage changes proposed by AI require either human action or an explicit tenant opt-in rule.
- **FR-AI-4** Per-org opt-in, data-use disclosure, token/cost metering, and the ability to exclude PII fields from prompts.

### 4.28 Onboarding & industry templates (`FR-ONB`) — Phase 1/2

- **FR-ONB-1** Guided wizard: business info → industry → branches/teams → lead fields → pipeline → lead sources → WhatsApp → website/form → automation → invite employees → finish, resumable, skippable, with progress persisted.
- **FR-ONB-2** Industry templates (real estate, education, clinic/healthcare, automobile, e-commerce, fitness, salon/spa, travel, professional services, home services) seeding custom fields, pipeline + stages, statuses, lost reasons, task types, sources, saved views, starter automations and WhatsApp template drafts — all then editable.
- **FR-ONB-3** After onboarding, show "Your CRM is ready" with 3 concrete next actions, and keep a checklist with adoption nudges.

---

## 5. Non-functional requirements

### Performance (`NFR-PERF`)
- **NFR-PERF-1** API p95 < 300 ms for reads, < 500 ms for writes, excluding third-party latency.
- **NFR-PERF-2** Dashboards p95 < 1 s, served from rollups/cache.
- **NFR-PERF-3** No endpoint may return an unbounded collection; default page 25, max 100 (max 1000 for API-key exports via cursor).
- **NFR-PERF-4** The client MUST never receive more than one page of leads at a time; long lists are virtualized.
- **NFR-PERF-5** Webhook receipt (WhatsApp, ads, tracking) MUST acknowledge in < 1 s by persisting and queueing, never by processing inline.

### Scalability (`NFR-SCALE`)
- **NFR-SCALE-1** Milestones: 100 orgs → 1,000 orgs → 10,000+ orgs, with the same architecture and no rewrite.
- **NFR-SCALE-2** API and workers MUST be stateless and horizontally scalable; no in-process schedulers, no in-memory session or rate-limit state, no sticky routing requirement (realtime uses a Redis adapter).
- **NFR-SCALE-3** High-volume tables (activities, messages, website_events, api_logs, webhook_deliveries, automation_run_steps) MUST be time-partitioned with a retention policy from day one of their introduction.
- **NFR-SCALE-4** Analytics MUST be able to move to a columnar store (ClickHouse) without changing the collector API or dashboard contracts.

### Availability & correctness (`NFR-REL`)
- **NFR-REL-1** Target 99.9% monthly availability for API and inbox; ingestion endpoints are the highest-priority tier and degrade last.
- **NFR-REL-2** **A lead is never lost.** If downstream processing fails, the raw payload is persisted and replayable.
- **NFR-REL-3** All external calls: timeouts, bounded retries with jittered backoff, circuit breaker, and a visible failure state. Never fail silently.
- **NFR-REL-4** All inbound webhooks idempotent; all jobs idempotent and retryable; DLQ for anything that exhausts retries.
- **NFR-REL-5** Nightly automated backups with documented, *tested* restore (PITR); quarterly restore drill.

### Security (`NFR-SEC`) — detail in `security.md`
- **NFR-SEC-1** Tenant isolation is the highest-severity class of bug; a dedicated automated test suite must attempt cross-tenant access on every endpoint in CI.
- **NFR-SEC-2** OWASP ASVS L2-aligned controls: authn, authz, validation, output encoding, rate limiting, secure headers, CSRF where cookies are used, upload validation.
- **NFR-SEC-3** Integration credentials encrypted with envelope encryption; plaintext never logged, never returned by any API, never rendered in the frontend.
- **NFR-SEC-4** All webhook receivers verify signatures; all webhook senders sign.

### Usability (`NFR-UX`)
- **NFR-UX-1** Mobile-first for executive surfaces (today, lead list, lead detail, tasks, WhatsApp, call, notes); fully responsive elsewhere.
- **NFR-UX-2** A small-business user must be able to use the executive workspace without training; advanced features are progressively disclosed.
- **NFR-UX-3** Every screen has designed empty, loading (skeleton), error and permission-denied states.
- **NFR-UX-4** Destructive actions confirm and, where feasible, are undoable.
- **NFR-UX-5** WCAG 2.1 AA: keyboard operability, focus visibility, contrast, labels, reduced-motion respect.
- **NFR-UX-6** Modern SaaS aesthetic: clean sidebar, card-based information hierarchy, restrained colour used for meaning, no decorative gradients.

### Observability (`NFR-OBS`)
- **NFR-OBS-1** Structured JSON logs with request id, org id, user id, route and duration; PII redacted.
- **NFR-OBS-2** Error tracking, distributed tracing, RED/USE metrics, queue depth/latency/failure dashboards, integration health checks, DB/Redis/worker health endpoints, and a Super Admin system-health page.

### Maintainability (`NFR-MNT`)
- **NFR-MNT-1** TypeScript strict everywhere; no `any` in domain code; runtime validation at every boundary.
- **NFR-MNT-2** Domain-module structure; no god controllers/services; shared logic in services, not copy-paste.
- **NFR-MNT-3** Tests required for: ingestion, duplicate detection, assignment, scoring, follow-up/reschedule, SLA, WhatsApp webhook (incl. duplicate delivery), automation execution, tenant isolation, permissions, trial/subscription transitions, webhook retry, import.
- **NFR-MNT-4** Lint, typecheck, test and build gate every merge.

---

## 6. Gap analysis — requirements added beyond the brief

Identified during Phase 0 as necessary for this product class; accepted into scope at the phase noted.

| Added requirement | Why it is necessary | Phase |
|---|---|---|
| E.164 normalization + duplicate matching on normalized numbers | Duplicate detection is meaningless if `+91 98…`, `098…` and `98…` are different strings | 2 |
| Touchpoint table separate from `lead.source` | Attribution and duplicate-merge both need *many* sources per lead; a single `source` column cannot express "Facebook first, website later" | 2 |
| SLA + first-response-time model | "Which leads are being missed" is unanswerable without a clock | 3 |
| "No next action" detection | The brief's follow-up discipline goal fails silently without it | 3 |
| Working hours / holiday / leave calendars | Assignment, SLA and delays are wrong without them | 1–3 |
| Transactional outbox | Otherwise events are lost on crash between commit and enqueue — silent lead loss | 1 |
| Idempotency keys on public writes | Retrying clients would duplicate leads | 4 |
| Raw payload store for every capture | Required to honour "never lose a lead" and to debug tenant integrations | 4 |
| Consent + suppression enforced at send time | WhatsApp policy and privacy risk; enrollment-time checks are stale | 5 |
| Automation guardrails (loop detection, caps, kill switch) | A bad workflow could message thousands of customers and get the WABA banned | 6 |
| Workflow versioning | Editing a live workflow must not corrupt in-flight runs | 6 |
| Visitor → lead identity stitching | Website analytics is only valuable on the lead timeline | 8 |
| Rollup tables + aggregation workers | Dashboards over raw events do not survive 1,000 tenants | 8 |
| Per-org feature-flag/entitlement overrides | Sales will promise exceptions; hardcoding them violates Rule 4 | 1 |
| Recycle bin + restore for soft-deleted business data | Rule 15 needs a UI, not just a column | 2 |
| Cost metering for AI | Optional AI with unbounded cost is a business risk | 11 |
| Data-scope model (`own/team/branch/org`) on permissions | Roles alone cannot express "manager sees their branch" | 1 |

Open decisions requiring business input are tracked in [open-questions.md](./open-questions.md).

---

## 7. Explicitly out of scope for v1

Unofficial WhatsApp automation of any kind; SMS/IVR blast; full e-commerce checkout/payments engine (we *track* commerce events, we do not run a store); accounting/GST invoicing beyond quotations and payment records; native mobile apps (responsive PWA-capable web instead); multi-touch attribution beyond first/last/lead-source/campaign; visual drag-and-drop automation canvas (engine is built for it in Phase 6, canvas is post-v1); AI as a required dependency; self-serve white-label reseller hierarchy (single platform → org hierarchy only).

---

## 8. Success metrics

**Product:** % leads with a next action; median first-response time; follow-up completion rate; % leads with ≥1 timeline activity in 24 h; duplicate rate; lead→customer conversion by source; WhatsApp median response time.
**Business:** trial→paid conversion; time-to-first-lead-captured for a new org (< 30 min target); WAU/MAU per tenant; churn; expansion from service packages.
**Engineering:** zero cross-tenant incidents; ingestion success rate ≥ 99.9%; webhook processing success ≥ 99.5% after retries; DLQ backlog at zero daily; p95 latency within `NFR-PERF`.
