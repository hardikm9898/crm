# Glossary

Use these words consistently in code, database, API, UI and documentation. Where the industry uses
several words for one thing, the **canonical** term is given and the others are listed as aliases we
do *not* use in code.

| Term | Meaning |
|---|---|
| **Platform** | The SaaS product as a whole, operated by us. |
| **Organization** (`organization`) | A tenant: one business using the product. Canonical term — not "account", "company", "workspace" or "client". |
| **Branch** | A physical or logical location of an organization. A data scope, not a tenant. |
| **Team** | A group of users inside an organization, usually with a manager. A data scope. |
| **User** | A person who logs into a tenant (owner, admin, manager, executive). |
| **Platform user** | Our own staff (Super Admin, support). A separate auth realm from `users`. |
| **Lead** | A potential customer captured from any channel. The central entity of the product. |
| **Customer** | A lead that converted (bought). The same person, a different lifecycle state — conversion preserves the lead's timeline. |
| **Touchpoint** | One ordered marketing/behavioural interaction on a lead (ad click, landing page, form, session). Many per lead. The basis of attribution. |
| **Source** | Where a lead came from (website, Facebook, WhatsApp, referral…). Tenant-configurable. |
| **Campaign** | A marketing effort, usually synced from an ad platform, with spend and metrics. |
| **Status** | The tenant-defined state of a lead (New, Contacted, Qualified…). Independent of pipeline stage. |
| **Pipeline / Stage** | A tenant-defined sales process and its ordered steps. A lead sits in exactly one stage of one pipeline. |
| **Lead score** | A configurable numeric signal of lead quality, with an explainable breakdown. |
| **Score band** | A named score range (hot/warm/cold). Tenant-configurable thresholds. |
| **Next Action** | The single open task that tells the owner what to do next on a lead. A lead without one is a "silent lead" and is surfaced as a problem. |
| **Task** | A unit of work on a lead/customer/deal/conversation (call, WhatsApp, meeting, follow-up…). |
| **Follow-up** | A task of the follow-up kind. Not a separate entity. |
| **Reschedule** | Moving a task's due time; always requires a reason (tenant-configurable list). |
| **SLA** | A response-time target (first response, next response) measured against working hours; can be at risk or breached. |
| **Activity** | One immutable entry on the lead timeline. The user-facing history. |
| **Domain event** | An internal fact published via the outbox to trigger side effects. Not the same as an activity: events drive behaviour, activities are read by humans. |
| **Timeline** | The ordered stream of activities for a lead. |
| **Conversation** | A messaging thread between a customer contact and one of the organization's channel accounts (e.g. a WhatsApp number). |
| **Message** | One inbound or outbound message inside a conversation. |
| **Shared inbox** | The multi-agent workspace over conversations on one business number. |
| **Service window** | WhatsApp's 24-hour period after a customer message during which free-form replies are allowed. |
| **Template** | A pre-approved WhatsApp message with variables; required outside the service window. |
| **Workflow** | An automation definition (trigger → conditions → actions → delays), versioned. |
| **Run** | One execution of a workflow version against one entity. |
| **Enrollment** | An entity's entry into a workflow, governed by the re-entry policy. |
| **Guardrail** | A limit that contains automation blast radius (caps, loop detection, kill switch). |
| **Custom field** | A tenant-defined field: a *definition* (metadata) plus *values* stored in the entity's JSONB column. |
| **Saved view** | A stored filter + column + sort configuration over a list. |
| **Filter DSL** | The one expression language shared by list filters, saved views, segments and automation conditions. |
| **Capture** | The act of a lead entering the system from any channel, through one shared pipeline. |
| **Ingestion** | The backend processing of a capture (normalize → dedupe → score → assign → follow-up → events). |
| **Duplicate rule** | Tenant configuration that decides when two captures are the same person, and what to do about it. |
| **Merge** | Combining two lead (or customer) records, unioning their history and preserving attribution. |
| **Assignment rule** | Declarative configuration that decides who owns a new lead. |
| **Entitlement** | What a plan permits: a boolean feature or a numeric limit, overridable per organization. |
| **Usage counter** | Metered consumption of an entitlement in a period. |
| **Trial** | A time-boxed subscription state with full or limited entitlements; expiry restricts access but never deletes data. |
| **Grace period** | The window after expiry or a failed payment during which access is limited but restorable. |
| **Service subscription** | A paid marketing/development service (SEO, ads management, website), billed separately from the SaaS subscription. |
| **Provider adapter** | Our implementation of a domain interface over an external vendor API. |
| **Integration connection** | A tenant's configured link to a provider, with encrypted credentials and health state. |
| **Provider event** | A raw inbound webhook event from a provider, recorded for idempotency. |
| **Outbox** | The table where domain events are written inside the business transaction before dispatch. |
| **DLQ** | Dead-letter queue: where jobs go after exhausting retries, visible and retryable by platform staff. |
| **Rollup** | A pre-aggregated daily metrics table that dashboards read instead of raw events. |
| **Attribution model** | The rule deciding which touchpoint gets credit for revenue (first touch, last touch, lead source, campaign). |
| **Identity stitching** | Linking an anonymous website visitor to a lead once they identify themselves. |
| **Data scope** | How far a permission reaches: `own`, `team`, `branch`, `organization`. |
| **Tenant context** | The request/job-scoped object carrying organization, user, permissions and scope. Absence of it is an error, never a default. |
| **Impersonation** | Platform staff acting as a tenant user for support, banner-visible and fully audited. |
| **Consent** | A recorded permission to contact a person on a channel, checked at send time. |
| **Suppression** | A block on contacting an identifier on a channel (opt-out, bounce, complaint). |
| **DSR** | Data subject request: export, delete/anonymize, or rectify a person's data. |
| **PII** | Personal data, tagged in the schema; drives redaction, export gating and anonymization. |
