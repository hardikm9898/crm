# Open Questions, Assumptions & Deferred Decisions

Phase 0 found gaps in the brief that architecture cannot settle on its own. Each item below has a
**working assumption** so implementation is never blocked; the assumption is what we will build unless
the answer changes it. Items are grouped by when the answer is actually needed.

---

## A. Needed before Phase 1 ships

| # | Question | Working assumption | Impact if wrong |
|---|---|---|---|
| A1 | **Primary market and currency** — India-first (INR, `+91`, IST) or multi-region from day one? | India-first: INR default, `+91` default phone country, IST default timezone, English UI — but every one of these is org-level configuration, and money/time/phone are handled generically. | Low. Defaults change; no schema change. |
| A2 | **Pricing and plan structure** — plan names, prices, limits. | Seed three plans (Starter / Growth / Scale) with placeholder limits, entirely Super-Admin editable (Rule 7). | Low, by design. |
| A3 | **Payment gateway** — Razorpay, Stripe, both? | Build the `PaymentProvider` adapter; implement Razorpay first if India-first (UPI/mandates matter), Stripe second. | Medium: gateway-specific subscription semantics (mandates vs. cards) affect the dunning flow. |
| A4 | **Who owns the WhatsApp account** — each tenant brings their own WABA, or we onboard numbers under our BSP/partner account? | Tenant-owned WABA via Embedded Signup, with manual token entry as a fallback. | **High.** A platform-owned/BSP model changes billing (we resell conversations), onboarding, rate-limit pooling and support burden. Worth confirming early. |
| A5 | **Email sending domain** — our domain or per-tenant verified domains? | Platform domain for transactional mail in v1; per-tenant domain verification deferred to Phase 9. | Medium: deliverability and DMARC setup. |
| A6 | **Data residency** | Single region (India if A1 holds), documented plainly; `organizations.region` exists for a future second region. | Medium: enterprise deals may demand a region; the schema is ready, the ops work is not. |

---

## B. Needed before Phase 2–3 ships

| # | Question | Working assumption | Impact if wrong |
|---|---|---|---|
| B1 | **Which industries do we launch with?** The brief lists 14 website templates and 5+ CRM templates; building all at launch quality is a phase of its own. | Launch three CRM industry templates (real estate, education, clinic) and three website templates; the rest are content added later against the same schema. | Low (content, not architecture), but it changes Phase 2/7 sizing significantly. |
| B2 | **Default SLA targets** per source/priority. | 60 working minutes first response, 24 working hours next response; per-org editable. | Low. |
| B3 | **Lead recycling policy** — when does an untouched lead return to the pool? | 14 days with no activity → manager alert; 30 days → unassigned pool. Configurable, default **off** so we never surprise a tenant by moving their leads. | Medium: silently reassigning leads would damage trust. Default-off is the safe call. |
| B4 | **Does an executive see other executives' leads?** | No: `own` scope by default; managers get `team`/`branch`. Configurable per role. | Medium: affects default role seeds and what "team pipeline" shows. |
| B5 | **Can an executive delete a lead?** | No. Soft delete requires manager+; executives can mark lost with a reason. | Low. |
| B6 | **Quotation numbering and tax** — GST invoice compliance? | Quotations are commercial documents with configurable numbering, tax percentages and totals — **not** statutory GST invoices. Accounting-grade invoicing is out of scope (PRD §7). | Medium: if tenants expect compliant tax invoices, that is a separate module, not a field addition. |

---

## C. Needed before Phase 5–6 ships

| # | Question | Working assumption | Impact if wrong |
|---|---|---|---|
| C1 | **Bulk WhatsApp campaigns** — how aggressive a feature do we want to enable? | Consent-gated, template-only, throughput-capped, quiet-hours aware, fully audited, with per-tenant daily caps. We deliberately make spam hard. | **High.** A permissive design is the fastest route to tenants' numbers being banned and our platform app being restricted. |
| C2 | **Conversation ownership model** — hard lock (only the owner may reply) or soft lock (warning)? | Soft lock with a visible "X is replying" indicator plus explicit transfer. | Low-medium: affects inbox UX, not the data model. |
| C3 | **Does automation create tasks for unavailable users?** | No: assignment and task creation respect working hours, holidays and leave, with fallback to the manager. | Medium: a follow-up assigned to someone on leave is a missed lead. |
| C4 | **Automation limits per plan** (active workflows, actions/day). | Starter 3 workflows / 500 actions-day; Growth 20 / 5 000; Scale configurable. Entitlements, not constants. | Low. |

---

## D. Needed before Phase 8–9 ships

| # | Question | Working assumption | Impact if wrong |
|---|---|---|---|
| D1 | **Cookie consent for the tracker** — do we ship a consent banner with generated websites? | Yes: a configurable banner on our generated sites, and the tracker honours a consent signal (no tracking cookie before consent where required). First-party ids only; no cross-site tracking; IPs hashed. | **High** for tenants with EU/UK visitors. Cheaper to build in than to retrofit. |
| D2 | **Analytics retention by plan** | 90 days raw events (Starter) → 365 (Scale); rollups retained indefinitely, so history is never lost. | Low. |
| D3 | **Attribution default model** | Last touch, clearly labelled on every report, switchable per report. | Medium: changes headline ROAS numbers, so the label matters as much as the model. |
| D4 | **Multi-touch attribution** | Deferred (PRD §7). `lead_touchpoints` stores everything needed to add linear/position-based later without backfill. | Low. |

---

## E. Deliberately deferred (decisions recorded, work not scheduled)

| Item | Rationale |
|---|---|
| Visual drag-and-drop automation canvas | The Phase 6 engine stores a graph definition, and the registry-driven editor uses the same JSON. The canvas is a UI project over an unchanged backend. |
| Native mobile apps | The responsive web app covers the executive workflow; a PWA shell is the cheaper next step if push notifications become critical. |
| Multi-language UI | Copy is centralized for i18n from the start; no translations in v1. |
| White-label / reseller hierarchy | Would add a level above `organizations`. Not modelled now; would be a schema change, so it is flagged here explicitly as a *known future cost*. |
| ClickHouse for analytics | Behind `AnalyticsRepository` (ADR-0010). Triggered by event volume, not by calendar. |
| Read replica | Stage B of the scaling plan. |
| Row Level Security | Phase 12; the schema and roles are prepared, but it must not be the only isolation control. |
| Accounting/GST invoicing, full e-commerce checkout, SMS/IVR blast | Out of scope (PRD §7). We *track* commerce events; we do not run the store. |

---

## F. Architectural risks being watched

| Risk | Mitigation already in the design | Residual |
|---|---|---|
| A single application bug leaks cross-tenant data | Four isolation layers + generated tenancy test suite + 404-not-403 responses | Non-zero; this is the S1 in the incident runbook |
| A runaway automation messages a tenant's whole customer base | Caps, loop detection, per-org concurrency, kill switch, dry-run, consent checks at send time | Requires the guardrails to ship *with* Phase 6, never after |
| Meta policy or pricing change | Provider abstraction, usage metering, template-only discipline | Commercial exposure remains; metering makes it visible early |
| Analytics volume outgrowing Postgres | Daily partitions, rollups, retention, repository abstraction | Migration is scheduled work, not an emergency |
| Custom-field JSONB misuse (unindexed sorts, huge blobs) | Sorting restricted to indexed fields, validation against definitions, size caps | Needs review discipline |
| Scope creep across 12 phases | Phase exit criteria, numbered requirements, explicit out-of-scope list | The main project risk; the roadmap is the control |
