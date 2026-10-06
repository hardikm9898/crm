# Database Design — Lead OS

**Engine:** PostgreSQL 16 · **Access:** Prisma 6 (+ typed raw SQL for analytics) ·
Traces to: `FR-TEN-4`, `FR-LEAD-*`, `FR-DUP-*`, `FR-TL-*`, `NFR-SCALE-3`, `NFR-PERF-3`

---

## 1. Conventions (apply to every table)

| Rule              | Detail                                                                                                                                                                                                                                              |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Primary key       | `id UUID` generated as **UUIDv7** in the app (time-ordered ⇒ index locality, no enumerable ints, safe for distributed/offline generation)                                                                                                           |
| Tenant column     | `organization_id UUID NOT NULL` on **every** tenant-scoped table                                                                                                                                                                                    |
| Tenant uniqueness | `UNIQUE (organization_id, id)` on every tenant table — the anchor for composite FKs                                                                                                                                                                 |
| Composite FKs     | Child references use `(organization_id, parent_id) → parent(organization_id, id)`; cross-tenant references become impossible (`FR-TEN-4`)                                                                                                           |
| Timestamps        | `created_at timestamptz NOT NULL DEFAULT now()`, `updated_at timestamptz NOT NULL` (trigger-maintained); business time is always `timestamptz` (UTC stored, org timezone for display/working-hours logic)                                           |
| Soft delete       | `deleted_at timestamptz NULL` on business data (leads, customers, tasks, deals, notes, documents, forms, websites, workflows, users). Partial indexes `WHERE deleted_at IS NULL`. Hard delete only via retention purge or DSR (`FR-PRV-3`, Rule 15) |
| Actor columns     | `created_by_id`, `updated_by_id` (nullable — system/automation writes are `NULL` + `source` enum)                                                                                                                                                   |
| Money             | `amount_minor BIGINT` + `currency CHAR(3)`. **No floats for money, ever**                                                                                                                                                                           |
| Phones            | `phone_e164 VARCHAR(20)` (normalized, indexed) + `phone_raw VARCHAR(32)` (as received)                                                                                                                                                              |
| Enums             | Postgres enums **only** for developer-owned, code-branching values (e.g. `task_status`). Anything a tenant can rename/extend is a **table** (statuses, sources, lost reasons, task types, outcomes, reschedule reasons) — Rules 5–8                 |
| JSONB             | For open-ended structures: custom field values, payloads, configs, metadata. Always validated in the app against a stored schema; never used to dodge modelling a real relationship                                                                 |
| Naming            | `snake_case`, plural tables, `<table>_<cols>_idx` / `_uq` / `_fk`, `_at` for timestamps, `_id` for keys                                                                                                                                             |
| Index prefix      | Every tenant-table index starts with `organization_id` (except global-unique lookups such as `provider_message_id`)                                                                                                                                 |
| Migrations        | Forward-only, reviewed SQL; additive then backfill then switch; no destructive change without a written rollback note                                                                                                                               |

---

## 2. Entity-relationship overview

```mermaid
erDiagram
  PLANS ||--o{ SUBSCRIPTIONS : "sold as"
  ORGANIZATIONS ||--|| SUBSCRIPTIONS : has
  ORGANIZATIONS ||--o{ BRANCHES : has
  ORGANIZATIONS ||--o{ TEAMS : has
  ORGANIZATIONS ||--o{ MEMBERSHIPS : has
  USERS ||--o{ MEMBERSHIPS : "joins via"
  ROLES ||--o{ USER_ROLES : grants
  USERS ||--o{ USER_ROLES : has
  ROLES ||--o{ ROLE_PERMISSIONS : includes
  PERMISSIONS ||--o{ ROLE_PERMISSIONS : "listed in"

  ORGANIZATIONS ||--o{ LEADS : owns
  LEAD_SOURCES ||--o{ LEADS : "origin of"
  CAMPAIGNS ||--o{ LEADS : "attributed to"
  PIPELINES ||--o{ PIPELINE_STAGES : has
  PIPELINE_STAGES ||--o{ LEADS : "current stage"
  LEAD_STATUSES ||--o{ LEADS : "current status"
  USERS ||--o{ LEADS : "assigned to"

  LEADS ||--o{ LEAD_TOUCHPOINTS : accumulates
  LEADS ||--o{ LEAD_ASSIGNMENTS : history
  LEADS ||--o{ LEAD_STAGE_HISTORY : history
  LEADS ||--o{ ACTIVITIES : timeline
  LEADS ||--o{ TASKS : "next actions"
  LEADS ||--o{ NOTES : has
  LEADS ||--o{ DOCUMENTS : has
  LEADS ||--o{ CONVERSATIONS : "talks in"
  LEADS ||--o{ CALLS : has
  LEADS ||--o{ DEALS : "may become"
  LEADS ||--o{ CONSENTS : grants
  LEADS ||--o{ LEAD_DUPLICATES : "flagged with"
  LEADS ||--o| CUSTOMERS : "converts to"

  CONVERSATIONS ||--o{ MESSAGES : contains
  WHATSAPP_NUMBERS ||--o{ CONVERSATIONS : "hosted on"
  WHATSAPP_ACCOUNTS ||--o{ WHATSAPP_NUMBERS : has
  WHATSAPP_TEMPLATES ||--o{ MESSAGES : "rendered into"
  MESSAGES ||--o{ MESSAGE_STATUS_EVENTS : tracked
  MESSAGES ||--o{ MESSAGE_MEDIA : carries

  DEALS ||--o{ DEAL_ITEMS : "lines"
  DEALS ||--o{ QUOTATIONS : quoted
  DEALS ||--o{ PAYMENTS : "paid by"
  CUSTOMERS ||--o{ DEALS : buys

  FORMS ||--o{ FORM_FIELDS : has
  FORMS ||--o{ FORM_SUBMISSIONS : receives
  FORM_SUBMISSIONS ||--o| LEADS : creates
  INBOUND_PAYLOADS ||--o| LEADS : "may create"

  WORKFLOWS ||--o{ WORKFLOW_VERSIONS : versioned
  WORKFLOW_VERSIONS ||--o{ WORKFLOW_STEPS : contains
  WORKFLOW_VERSIONS ||--o{ AUTOMATION_RUNS : executes
  AUTOMATION_RUNS ||--o{ AUTOMATION_RUN_STEPS : logs

  WEBSITES ||--o{ WEBSITE_PAGES : has
  WEBSITES ||--o{ WEBSITE_DOMAINS : "served at"
  WEBSITES ||--o{ WEBSITE_EVENTS : generates
  ANALYTICS_VISITORS ||--o{ ANALYTICS_SESSIONS : has
  ANALYTICS_SESSIONS ||--o{ WEBSITE_EVENTS : contains
  ANALYTICS_VISITORS ||--o{ VISITOR_IDENTITIES : "stitched to"
  VISITOR_IDENTITIES }o--|| LEADS : identifies

  AD_ACCOUNTS ||--o{ CAMPAIGNS : syncs
  CAMPAIGNS ||--o{ AD_ENTITIES : "ad sets/ads"
  CAMPAIGNS ||--o{ CAMPAIGN_DAILY_METRICS : "spend/impr/clicks"
  LEAD_TOUCHPOINTS }o--|| CAMPAIGNS : "attributes to"

  INTEGRATION_CONNECTIONS ||--o{ PROVIDER_EVENTS : receives
  WEBHOOK_ENDPOINTS ||--o{ WEBHOOK_DELIVERIES : sends
  WEBHOOK_DELIVERIES ||--o{ WEBHOOK_ATTEMPTS : retries
  OUTBOX_EVENTS }o--|| ORGANIZATIONS : "emitted by"
```

Full table list follows, grouped by module. Column lists are abbreviated to keys, discriminators and
anything architecturally meaningful; exhaustive columns live in `packages/db/prisma/schema/*.prisma`
once Phase 1 begins.

---

## 3. Platform (non-tenant) tables

These have **no** `organization_id` and are unreachable from tenant routes.

| Table                                | Purpose                          | Key columns / notes                                                                                                     |
| ------------------------------------ | -------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `plans`                              | SaaS plans                       | `code UQ`, name, description, `interval (month                                                                          | year)`, `price_minor`, `currency`, `trial_days`, `is_public`, `sort_order`, `is_active` |
| `plan_features`                      | Limits & flags per plan          | `(plan_id, feature_key) UQ`, `limit_value BIGINT NULL` (NULL = unlimited), `is_enabled BOOL`, `overage_policy`          |
| `features`                           | Catalogue of entitlement keys    | `key UQ`, name, `unit (count                                                                                            | per_month                                                                               | bytes      | bool)`, description — Super Admin editable (`FR-BIL-2`) |
| `platform_settings`                  | Singleton-ish config             | `key UQ`, `value JSONB`, `is_secret`                                                                                    |
| `platform_users`                     | Platform staff                   | Separate from tenant `users`; own MFA requirement                                                                       |
| `industry_templates`                 | Onboarding seeds                 | `code UQ`, industry, `definition JSONB` (fields, pipeline, statuses, sources, views, automations, WA template drafts)   |
| `website_templates`                  | Site templates                   | `code UQ`, industry, thumbnail, `schema JSONB`, `is_active`                                                             |
| `service_packages`                   | Marketing/dev services catalogue | `code`, type (`seo                                                                                                      | meta_ads                                                                                | google_ads | website                                                 | landing_page | content | social`), `price_minor`, `billing_cycle`, `deliverables JSONB` |
| `coupons`                            | Discounts                        | code, type, value, limits, validity                                                                                     |
| `platform_audit_logs`                | Platform-actor audit             | append-only                                                                                                             |
| `impersonation_sessions`             | Support impersonation            | `platform_user_id`, `organization_id`, `target_user_id`, reason, `started_at`, `ended_at`, `actions_count` (`FR-TEN-7`) |
| `support_tickets`, `ticket_messages` | Support                          | org, reporter, status, priority, SLA                                                                                    |
| `feature_flags`                      | Platform/tenant rollout          | `key`, `scope (global                                                                                                   | org)`, `rules JSONB`, percentage rollout                                                |
| `job_failures`                       | DLQ mirror for Super Admin       | queue, job name, payload (redacted), error, attempts, `retried_at` (`FR-SA-4`)                                          |
| `system_health_checks`               | Probe results                    | component, status, latency_ms, checked_at, detail                                                                       |

---

## 4. Organization, identity & access

| Table                                    | Purpose                                                | Key columns / notes                                                                                                                                                                                                                                                                           |
| ---------------------------------------- | ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `organizations`                          | Tenant root                                            | `slug UQ`, name, legal_name, industry, `country`, `timezone`, `default_currency`, `default_phone_country`, `status (trialing                                                                                                                                                                  | active | past_due                                                                       | grace                                   | suspended                                                                                                                                                                                                                                                                                                                                                                                               | cancelled)`, `public_key UQ`, `logo_url`, `settings JSONB`, `onboarding_state JSONB`, `deleted_at` |
| `branches`                               | Locations                                              | org, name, code, address, timezone, `is_default`                                                                                                                                                                                                                                              |
| `teams`                                  | Groups                                                 | org, name, `manager_id`, `branch_id`                                                                                                                                                                                                                                                          |
| `team_members`                           | Membership                                             | `(organization_id, team_id, user_id) UQ`, `is_lead`                                                                                                                                                                                                                                           |
| `users`                                  | **Global identity** (platform table, ADR-0012)         | `email` (`UNIQUE (organization_id, lower(email))`), `password_hash` (Argon2id), name, `phone_e164`, avatar, `status (invited                                                                                                                                                                  | active | disabled)`, `timezone`, `locale`, `last_login_at`, `mfa_enabled`, `deleted_at` |
| `memberships`                            | **Tenant anchor for a person** (multi-org, `FR-IAM-6`) | `(organization_id, user_id) UQ`, `(organization_id, id) UQ`, status, `default_branch_id`, `is_owner`, `joined_at`. Every tenant row referencing a person references **this** by `(organization_id, user_id)`, so work cannot be assigned to a non-member — the database rejects it (ADR-0012) |
| `roles`                                  | Per-org roles                                          | `(organization_id, code) UQ`, name, `is_system`, `is_editable`, description                                                                                                                                                                                                                   |
| `permissions`                            | Catalogue (platform-level)                             | `key UQ` e.g. `lead:read`, `module`, `description`, `supports_scope BOOL`                                                                                                                                                                                                                     |
| `role_permissions`                       | Grants                                                 | `(role_id, permission_key) UQ`, `scope (own                                                                                                                                                                                                                                                   | team   | branch                                                                         | organization)` (`FR-IAM-4`)             |
| `user_roles`                             | Assignment                                             | `(organization_id, user_id, role_id) UQ`                                                                                                                                                                                                                                                      |
| `invitations`                            | Onboarding                                             | email, role, team, branch, `token_hash`, `expires_at`, `accepted_at`                                                                                                                                                                                                                          |
| `sessions`                               | Refresh sessions                                       | `user_id`, `refresh_token_hash`, `family_id`, `prev_id` (rotation/reuse detection), device, ip, ua, `expires_at`, `revoked_at`                                                                                                                                                                |
| `password_resets`, `email_verifications` | Token flows                                            | `token_hash`, `expires_at`, `used_at`                                                                                                                                                                                                                                                         |
| `mfa_secrets`, `mfa_recovery_codes`      | TOTP                                                   | encrypted secret, `code_hash`                                                                                                                                                                                                                                                                 |
| `working_hours`                          | Per org/branch/user                                    | `scope`, `owner_id`, `day_of_week`, `start_time`, `end_time`, timezone                                                                                                                                                                                                                        |
| `holidays`                               | Calendar                                               | org/branch, date, name, `is_working`                                                                                                                                                                                                                                                          |
| `user_availability`                      | Leave/status                                           | user, `state (available                                                                                                                                                                                                                                                                       | busy   | leave                                                                          | offline)`, from/to, reason (`FR-IAM-8`) |
| `audit_logs`                             | Tenant audit, append-only                              | org, `actor_type (user                                                                                                                                                                                                                                                                        | system | automation                                                                     | platform                                | api_key)`, actor_id, action, `resource_type`, `resource_id`, `before JSONB`, `after JSONB`, ip, user_agent, request_id, `created_at`. Append-only **enforced by trigger**: UPDATE always rejected, DELETE only inside a transaction setting `app.audit_purge='on'`(the retention/DSR path,`withAuditPurge()`). Organization FK is `RESTRICT` so no cascade can erase the trail (`FR-AUD-2`, `FR-PRV-3`) |

---

## 5. Custom fields (the metadata engine)

**Decision (ADR-0005): JSONB-on-row, driven by a definition table.** Rejected: per-tenant columns
(violates Rule 5, unbounded DDL), classic EAV (one join per displayed field; 30-field list view =
unusable), separate table per type (same join problem).

| Table                      | Purpose       | Key columns                                                         |
| -------------------------- | ------------- | ------------------------------------------------------------------- |
| `custom_field_sections`    | UI grouping   | org, `entity_type`, name, sort_order, `collapsed_by_default`        |
| `custom_field_definitions` | The metadata  | org, `entity_type (lead                                             | customer | deal | task | conversation)`, `key` (`UNIQUE (organization_id, entity_type, key)`, immutable after create), `label`, `type`, `placeholder`, `help_text`, `is_required`, `default_value JSONB`, `validation JSONB`(min/max/regex/precision/maxLength/fileTypes/maxSizeKb),`section_id`, `sort_order`, `visibility JSONB`(role/stage conditions),`show_in_list`, `is_searchable`, `is_filterable`, `is_indexed`, `is_pii`, `is_active`, `deleted_at` |
| `custom_field_options`     | Choice values | `(definition_id, value) UQ`, label, colour, sort_order, `is_active` |

Values live on the owning row:

```sql
ALTER TABLE leads ADD COLUMN custom_values     JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE leads ADD COLUMN custom_search_text TEXT;  -- concatenated searchable values

CREATE INDEX leads_custom_values_gin
  ON leads USING GIN (custom_values jsonb_path_ops);

-- Hot-path fields get a real index, created by a controlled admin job when
-- is_indexed = true on the definition (expression index, no schema change to the table shape):
CREATE INDEX leads_cv_budget_idx
  ON leads ((custom_values->>'budget')) WHERE deleted_at IS NULL;
```

Rules:

- The API **never** trusts client-sent keys: the values object is validated against active
  definitions; unknown keys are rejected (or quarantined on ingestion, `FR-CAP-5`).
- Types are stored canonically inside JSONB: numbers as JSON numbers, dates as ISO-8601 strings,
  currency as `{ "amount_minor": 500000000, "currency": "INR" }`, files as `{ documentId, name, size, mime }`.
- `is_indexed = true` triggers an admin job that creates the expression index concurrently; the
  definition records the index name so it can be dropped on deactivation. Filterable-but-unindexed
  fields still work via the GIN index.
- Deleting a definition is a soft delete; values are retained until retention purge so history and
  audit remain truthful.
- `custom_search_text` is maintained on write and included in the search `tsvector`.

---

## 6. Leads & CRM core

### 6.1 `leads`

```
id, organization_id, branch_id?, team_id?, assigned_user_id?,
first_name, last_name, full_name (application-maintained*), company, job_title?,
phone_e164?, phone_raw?, whatsapp_e164?, email?,
city?, state?, country?, postal_code?, timezone?,
lead_source_id?, campaign_id?, ad_entity_id?, form_id?, website_id?, landing_page_url?,
utm JSONB,                       -- source/medium/campaign/term/content/gclid/fbclid
status_id, pipeline_id, stage_id, priority (enum: low|medium|high|urgent),
score INT DEFAULT 0, score_band?,
value_minor BIGINT?, currency CHAR(3)?,
custom_values JSONB, custom_search_text TEXT, search_vector tsvector,
first_contacted_at?, last_contacted_at?, last_activity_at?,
next_action_at?, next_action_task_id?,       -- denormalized for the Today view
open_tasks_count INT, reschedule_count INT, touch_count INT,
sla_first_response_due_at?, sla_first_response_at?, sla_state (ok|at_risk|breached),
converted_at?, customer_id?, lost_reason_id?, lost_note?,
is_duplicate_of_id?, merged_into_id?,
consent_whatsapp BOOL, consent_email BOOL, consent_calls BOOL,
created_by_id?, created_via (manual|form|api|webhook|import|whatsapp|meta_ads|google_ads|website),
created_at, updated_at, deleted_at
```

\* _Deviation:_ `full_name` is maintained by the application rather than being a generated column, for
the same reason `updated_at` is not a trigger (§16.10) — Prisma sends every column it knows about and
would fight a generated one. It is derived in one place (`buildFullName`) and falls back to the company,
the email, then the phone number, because an unnamed enquiry from a phone number is still a lead.

**Columns deferred to the step that brings their table.** `customer_id`, `campaign_id`, `ad_entity_id`,
`form_id`, `website_id`, `next_action_task_id`, `is_duplicate_of_id`, `merged_into_id`,
`sla_first_response_*` and `sla_state` are absent from the Phase 2 step-1 schema rather than present as
unconstrained uuids: a nullable id with no foreign key is a column nothing can trust. They arrive with
`customers`, `campaigns`, `forms`, `websites`, `tasks`, `lead_duplicates` and `sla_policies`
respectively. `score` and `score_band` **are** present, because the columns are scalars and the scoring
engine writes them without a new table.

Indexes (all `WHERE deleted_at IS NULL` where applicable):

```sql
UNIQUE (organization_id, id)                                    -- composite-FK anchor
(organization_id, created_at DESC)                              -- default list
(organization_id, assigned_user_id, next_action_at)             -- executive Today view
(organization_id, stage_id, updated_at DESC)                    -- kanban columns
(organization_id, status_id)
(organization_id, phone_e164)          -- duplicate detection + search
(organization_id, whatsapp_e164)
(organization_id, lower(email))
(organization_id, lead_source_id, created_at)                   -- source reports
(organization_id, campaign_id, created_at)                      -- campaign reports
(organization_id, score DESC)
(organization_id, sla_state, sla_first_response_due_at)         -- SLA board
(organization_id, last_activity_at)                             -- ageing / recycling
GIN (search_vector)                                             -- global search
GIN (custom_values jsonb_path_ops)
Partial: (organization_id, assigned_user_id) WHERE next_action_at IS NULL AND status open
                                                                -- "no next action" detection
```

### 6.2 Supporting lead tables

| Table                                       | Purpose                 | Notes                                                                                                                                                                                                                                                                                                         |
| ------------------------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lead_statuses`                             | Tenant-defined statuses | org, name, colour, `category (open                                                                                                                                                                                                                                                                            | won    | lost                                        | invalid)`, sort_order, `is_default` |
| `lead_sources`                              | Tenant-defined sources  | org, name, `type`, `integration_connection_id?`, `cost_model`, `is_active`; reports join cost & revenue (`FR-LEAD-7`, §8 of PRD)                                                                                                                                                                              |
| `lost_reasons`                              | Tenant-defined          | org, name, sort_order, `requires_note`                                                                                                                                                                                                                                                                        |
| `tags`, `lead_tags`                         | Free tagging            | `(organization_id, lead_id, tag_id) UQ`                                                                                                                                                                                                                                                                       |
| `lead_touchpoints`                          | **Attribution spine**   | org, lead_id, `sequence INT`, `occurred_at`, `channel`, `lead_source_id?`, `campaign_id?`, `ad_entity_id?`, `form_id?`, `website_id?`, `landing_page_url?`, `utm JSONB`, `session_id?`, `cost_attributable BOOL`, `metadata JSONB`. **Never overwritten** — a second capture appends (`FR-DUP-3`, `FR-ATT-1`) |
| `lead_assignments`                          | Assignment history      | org, lead_id, `from_user_id?`, `to_user_id?`, `to_team_id?`, `assigned_by_id?`, `assignment_rule_id?`, `reason`, `created_at` (`FR-ASG-5`)                                                                                                                                                                    |
| `lead_status_history`, `lead_stage_history` | Transitions             | from, to, `changed_by_id?`, `duration_seconds` (time spent in previous), `created_at`                                                                                                                                                                                                                         |
| `lead_score_events`                         | Score explainability    | rule_id, delta, reason, `score_after`, created_at (`FR-SCR-2`)                                                                                                                                                                                                                                                |
| `lead_duplicates`                           | Detected candidates     | org, `lead_id`, `duplicate_lead_id`, `rule_id`, `match_fields JSONB`, `confidence`, `status (open                                                                                                                                                                                                             | merged | dismissed)`                                 |
| `lead_merges`                               | Merge record            | org, `surviving_lead_id`, `merged_lead_id`, `field_choices JSONB`, `performed_by_id`, `undone_at?`, snapshot for reversal (`FR-DUP-4`)                                                                                                                                                                        |
| `duplicate_rules`                           | Matching config         | org, name, `match_on JSONB` (fields/composites), `lookback_days`, `action`, `priority`, `is_active`                                                                                                                                                                                                           |
| `customers`                                 | Converted               | Moved to [§6.7](#67-customers-and-conversion), with the conversion rules it is inseparable from                                                                                                                                                                                                               |
| `saved_views`                               | Filters/views           | org, owner_id?, `entity_type`, name, `filters JSONB`, `columns JSONB`, `sort JSONB`, `visibility (private                                                                                                                                                                                                     | team   | org)`, `is_default_for_role?` (`FR-VIEW-3`) |

> **Amendment, 2026-09-30 (implementation).** `saved_views` also carries `team_id` and
> `default_for_role_id`. `visibility = 'team'` is meaningless without naming _which_ team, and
> `is_default_for_role` as a boolean cannot say which role — both are foreign keys, composite and
> tenant-scoped like every other reference. Uniqueness is partial rather than absolute: one view name
> per owner, one per name among the views everyone can see, one landing view per role per entity,
> each `WHERE deleted_at IS NULL` so a deleted view's name is reusable.

### 6.3 Pipelines, assignment, scoring

| Table                        | Key columns                                                                                                                                                            |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pipelines`                  | org, name, `entity_type (lead                                                                                                                                          | deal)`, `is_default`, is_active |
| `pipeline_stages`            | org, pipeline_id, name, colour, `sort_order`, `probability SMALLINT`, `is_won`, `is_lost`, `required_fields JSONB`, `target_duration_hours?`, `automation_hooks JSONB` |
| `assignment_rules`           | org, name, `priority INT`, `is_active`, `strategy (specific_user                                                                                                       | team                            | round_robin | weighted_round_robin | least_open_leads | top_performer)`, `target JSONB`, `respect_working_hours BOOL`, `capacity_cap?`, `fallback JSONB` |
| `assignment_rule_conditions` | rule_id, `field_path`, `operator`, `value JSONB`, `group_index` (AND within group, OR across groups)                                                                   |
| `assignment_pool_members`    | rule_id, user_id, `weight`, `is_active`                                                                                                                                |
| `round_robin_state`          | `(organization_id, rule_id) UQ`, `cursor_index`, `last_assigned_user_id`, `updated_at` (Redis is the fast path; this row is the durable truth)                         |
| `scoring_rules`              | org, name, `trigger_event`, `conditions JSONB`, `points INT`, `max_applications?`, `decay JSONB?`, is_active                                                           |
| `score_bands`                | org, name, `min_score`, `max_score`, colour                                                                                                                            |

> **Amendment, 2026-10-05 (implementation).** Postgres indexes the **referenced** side of a foreign
> key, never the referencing side. `leads.is_duplicate_of_id` and `leads.merged_into_id` point back
> at `leads` with `ON DELETE RESTRICT`, so before `leads_duplicate_of` and `leads_merged_into`
> existed, deleting a lead scanned the whole `leads` table twice — once per constraint. Invisible at
> demo scale; on the 100 k-lead fixture in `packages/db/perf` the statement was still running after
> three minutes, and with the indexes it takes five seconds. **Every new FK whose referencing
> columns are not already the prefix of an index needs one**, and a cascade or a retention purge is
> where its absence surfaces.

> **Amendment, 2026-09-30 (implementation).** Three refinements, each forced by a silent failure:
>
> - **Bands are a partition of 0–1000, enforced by an exclusion constraint** (`score_bands_no_overlap`,
>   which needs `btree_gist`). An overlap would make a lead's band depend on evaluation order; a gap
>   would leave a lead with a score and no band, missing from every band-filtered view. The
>   application refuses both with a readable message; the constraint is what holds when two band
>   replacements interleave.
> - **`scoring_rules` ties `decay` to the trigger**: `(trigger_event = 'schedule.decay') = (decay IS
NOT NULL)`. An additive rule on the sweep never fires and a decay spec on `lead.created` is never
>   swept — both are misconfigurations nothing would report.
> - **`lead_score_events` is the authoritative score** ([ADR-0015](./decisions/ADR-0015-score-as-event-sum.md)):
>   `leads.score` caches its sum, idempotency is `UNIQUE (organization_id, lead_id, rule_id,
source_event_id) WHERE source_event_id IS NOT NULL`, and `delta <> 0` keeps rows that changed
>   nothing out of an explanation meant to read as arithmetic.

### 6.4 Tasks, SLA, activities

| Table                | Key columns                                                                                                                                                                                                                                  |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tasks`              | org, `lead_id?`, `customer_id?`, `deal_id?`, `conversation_id?`, title, description, `task_type_id`, `due_at timestamptz`, `due_date date` + `due_time time` (for org-timezone day grouping), priority, `assigned_user_id`, `status (pending | in_progress                                                                                        | completed                                                                                                        | cancelled | rescheduled)`, `completed_at?`, `outcome_id?`, `completion_note?`, `reminder_offsets JSONB`, `created_via`, `automation_run_id?`, `rescheduled_from_task_id?`, `reschedule_count`, deleted_at |
| `task_types`         | org, name, icon, `default_duration_minutes`, `default_reminder_offsets`, is_active                                                                                                                                                           |
| `task_reschedules`   | org, task_id, `from_due_at`, `to_due_at`, `reason_id`, `reason_note?`, `rescheduled_by_id`, created_at (`FR-TSK-5`)                                                                                                                          |
| `reschedule_reasons` | org, name, sort_order, `requires_note`, is_active (seeded with the brief's list, editable)                                                                                                                                                   |
| `task_reminders`     | task_id, `remind_at`, `channel`, `sent_at?`, `job_id?`                                                                                                                                                                                       |
| `sla_policies`       | org, name, `applies_to JSONB` (source/priority/pipeline/score band), `first_response_minutes`, `next_response_minutes?`, `resolution_minutes?`, `business_hours_only BOOL`, `escalate_to JSONB`, is_active                                   |
| `sla_clocks`         | org, `subject_type (lead                                                                                                                                                                                                                     | conversation                                                                                       | task)`, `subject_id`, `policy_id`, `started_at`, `due_at`, `paused_ms`, `satisfied_at?`, `breached_at?`, `state` |
| `escalations`        | org, subject, `policy_id`, `level`, `notified_user_ids`, `created_at`, `acknowledged_at?`                                                                                                                                                    |
| `activities`         | **Append-only timeline.** org, `lead_id?`, `customer_id?`, `deal_id?`, `conversation_id?`, `type` (see §6.5), `actor_type`, `actor_id?`, `occurred_at timestamptz`, `payload JSONB`, `visibility (all                                        | internal)`, `source_event_id?`(idempotency),`created_at`. **Partitioned monthly by `occurred_at`** |
| `notes`              | org, subject, `body`, `is_internal`, `mentions UUID[]`, author, deleted_at                                                                                                                                                                   |
| `mentions`           | org, note_id/message_id, `mentioned_user_id`, `read_at?`                                                                                                                                                                                     |

`documents` moved to [§6.8](#68-files-imports-and-exports), where it sits with the import and export
jobs that are its only writers today.

`activities` indexes: `(organization_id, lead_id, occurred_at DESC)`,
`(organization_id, type, occurred_at DESC)`, `(organization_id, actor_id, occurred_at DESC)`,
`UNIQUE (organization_id, source_event_id)` (nulls allowed) — the last one is what makes timeline
writes idempotent under job retries (`FR-TL-1`, `NFR-REL-4`).

### 6.5 Activity type registry (code constant, not a DB enum)

`lead.created`, `lead.source_captured`, `lead.assigned`, `lead.reassigned`, `lead.status_changed`,
`lead.stage_changed`, `lead.score_changed`, `lead.field_updated`, `lead.merged`, `lead.duplicate_detected`,
`lead.converted`, `lead.lost`, `lead.recycled`,
`task.created|completed|rescheduled|cancelled|overdue`,
`call.logged|missed`, `whatsapp.sent|received|failed|template_sent|read`,
`email.sent|opened|clicked|bounced`, `note.added`, `mention.created`, `document.uploaded`,
`quotation.sent`, `deal.created|won|lost`, `payment.received`,
`website.session|page_view|product_view|cta_click|whatsapp_click|checkout_started|purchase`,
`marketing.touchpoint_added`, `automation.enrolled|action_executed|skipped|failed|exited`,
`sla.at_risk|breached`, `consent.granted|revoked`, `conversation.assigned|transferred|closed|reopened`,
`ai.summary_generated|suggestion_generated`.

Adding a type = adding a constant + a renderer in the UI registry. No migration (`FR-TL-3`).

### 6.6 Deals, quotations, payments

| Table             | Key columns                                                                                                                                                                                                 |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `deals`           | org, `lead_id?`, `customer_id?`, pipeline_id, stage_id, name, `value_minor`, currency, `probability`, `expected_close_date?`, `won_at?`, `lost_at?`, `lost_reason_id?`, owner_id, custom_values, deleted_at |
| `deal_items`      | deal_id, `product_id?`, name, qty, `unit_price_minor`, `discount_minor`, `tax_percent`, `total_minor`                                                                                                       |
| `products`        | org, sku, name, `price_minor`, currency, `category`, is_active                                                                                                                                              |
| `quotations`      | org, deal_id?, lead_id?, `number` (`UNIQUE (organization_id, number)`), `version`, status (`draft                                                                                                           | sent      | accepted | rejected                                                                                                                                                            | expired`), `valid_until`, totals, `pdf_document_id?`, `sent_at?`, `sent_via` |
| `quotation_items` | as `deal_items`                                                                                                                                                                                             |
| `payments`        | org, `deal_id?`, `lead_id?`, `customer_id?`, `amount_minor`, currency, `method`, `status (pending                                                                                                           | succeeded | failed   | refunded)`, `provider`, `provider_payment_id?`, `paid_at?`, `attributed_touchpoint_id?`, `metadata JSONB`. **Revenue for attribution comes from here** (`FR-ATT-4`) |

> **Amendment, 2026-10-06 (implementation).** `products`, `deals` and `deal_items` are built; the
> `quotations`, `quotation_items` and `payments` rows above remain a sketch. The deviations are
> deliberate — see [ADR-0018](./decisions/ADR-0018-money-arithmetic-in-one-place.md).
>
> - **A deal's money is four columns, not one.** `gross_minor`, `discount_minor`, `tax_minor` and
>   `value_minor` together, because a header that carries only a total cannot be reconciled against
>   its lines and "where did the tax go?" becomes a code-reading exercise. `deal_items` carries the
>   same four per line (`gross_minor`, `discount_minor`, `tax_minor`, `net_minor`, `total_minor`),
>   all `BIGINT` **minor units** — never a float, never a `Decimal` the application rounds.
> - **`quantity` is `DECIMAL(12,3)`**, so 2.5 hours and 1.25 kg are expressible, while the
>   arithmetic stays integral: the quantity is scaled to thousandths and the product divided back
>   once (`QUANTITY_SCALE` in `@leados/shared/line-items`). `MAX_QUANTITY` is 1 000 000.
> - **`products.tax_percent` and `products.currency` are nullable defaults, not requirements.** A
>   catalogue entry is a convenience that pre-fills a line; the line owns its own numbers once
>   written, so re-pricing a product never silently re-prices a deal that was already agreed.
> - **`deals` gained `activities.deal_id`**, with its own per-tenant index. A deal's history is its
>   own rows, and an event that matters to the party (a win, a loss) is written **twice** — once
>   against the deal and once against the lead or customer — because a business owner reading a
>   lead must see that it was won without opening anything.
> - **`deals.lead_id` and `deals.customer_id` are both nullable**, with `deals_has_subject` requiring
>   at least one. A deal belongs to whoever it is being sold to, and that is a lead before conversion
>   and a customer after; a converted person's deals point at both.
>
> Hand-written objects carrying guarantees the application cannot (all listed in
> `packages/db/src/schema-objects.int-spec.ts`, which is the only thing stopping Prisma's next diff
> from dropping them):
>
> - **`deals_stage_in_pipeline_fk`**, a three-column FK on `(organization_id, pipeline_id, stage_id)`
>   — the same device `leads` uses. "A deal in another pipeline's stage" is unrepresentable, which no
>   application check can guarantee under concurrency.
> - **`deals_totals_add_up`**, `value_minor = gross_minor - discount_minor + tax_minor`, and the two
>   per-line twins `deal_items_net_is_gross_less_discount` and `deal_items_total_is_net_plus_tax`.
>   This is the half of ADR-0018 that the database owns: if a future writer — a quotation, an
>   invoice, a migration backfill — computes money its own way and gets it wrong, the write fails
>   rather than persisting a document whose lines do not add up to its own total.
> - **`deals_discount_within_gross`** and `deal_items_discount_within_gross`, so a discount cannot
>   exceed what it discounts and a negative total cannot exist.
> - **`deals_not_won_and_lost`**, `deals_lost_reason_needs_loss`, `deals_lost_note_needs_loss` — an
>   outcome is one outcome, and a reason for a loss that did not happen is not storable.
> - **`products_sku_key`**, a partial unique index on `(organization_id, sku) WHERE sku IS NOT NULL
AND deleted_at IS NULL`. SKUs are unique when present; a product without one is fine, and a
>   deleted product does not hold its SKU hostage.
> - **`deals_open_close_date`**, `deals_won` and `deals_live_created_at` — partial indexes, because
>   every screen that matters asks about _open_ deals (a forecast), _won_ deals (revenue) or _live_
>   ones (the board), and a full index on a table whose closed rows accumulate forever answers none
>   of them well.
> - **`deals_search_vector_trg`** plus the GIN, JSONB and trigram indexes, mirroring `leads` and
>   `customers`. Same weights, same refresh-on-write trigger; if it is dropped a deal simply stops
>   appearing in search and nothing else looks broken.

> **Amendment, 2026-10-06 (implementation, step 8).** `quotations`, `quotation_items` and
> `number_series` are built; the `payments` row above remains a sketch. The reasoning is
> [ADR-0019](./decisions/ADR-0019-quotation-versions-are-immutable.md).
>
> - **A version is a row, not an edit.** `number` identifies the quotation and
>   `UNIQUE (organization_id, number, version)` identifies the document; a revision inserts a new
>   row with the same number and sets `superseded_by_id` / `superseded_at` on the one it replaces.
>   Nothing about a sent version is ever updated again — which is the only way "what did we send
>   them on the 14th?" has an answer that can be read out on the phone.
> - **`number_series` is new**, one row per `(organization, kind)`, holding `prefix`, `padding` and
>   `next_value`. It is read with `SELECT … FOR UPDATE` inside the transaction that inserts the
>   document. `MAX(number) + 1` is a read-then-write race that hands two people the same number; a
>   Postgres sequence is global, so one workspace's quotations would advance another's and leak how
>   much business the platform is doing. `kind` is `quotation` today and is what an invoice series
>   will use.
> - **The money columns are a deal's four**, `BIGINT` minor units, computed by the same
>   `documentTotals()` and checked by the same shape of constraint
>   ([ADR-0018](./decisions/ADR-0018-money-arithmetic-in-one-place.md)).
> - **`status` is a CHECK, not a row.** A lead's status is the tenant's vocabulary; a document's
>   lifecycle (`draft | sent | accepted | rejected | expired`) is a protocol the application
>   depends on, so it is a constraint.
> - **`activities` gained no `quotation_id`.** A quotation's events are written on the **deal** and
>   on the **party**, because those are the screens somebody opens; the document's own lifecycle is
>   already in its columns.
> - **`documents.subject` gained `quotation`.** A rendered PDF is a `documents` row with **no
>   expiry**: an export is a convenience that goes stale, a quotation is a record.
>
> Hand-written objects carrying guarantees the application cannot (all in
> `packages/db/src/schema-objects.int-spec.ts`):
>
> - **`quotations_current`**, a partial index on `superseded_at IS NULL AND deleted_at IS NULL`.
>   Every list reads it: "the quotations" means the current version of each number, and a full index
>   on a table whose superseded rows accumulate forever answers that worse every month.
> - **`quotations_awaiting_expiry`**, partial on `status = 'sent' AND valid_until IS NOT NULL` — the
>   handful of rows the daily sweep scans, out of everything ever quoted.
> - **`quotations_superseded_by`**, the referencing side of the version self-FK. Postgres indexes
>   only the referenced side, and the same omission on `leads.merged_into_id` made deletion
>   quadratic.
> - **The four status/timestamp pairs** — `quotations_sent_has_timestamp` (`(status = 'draft') =
(sent_at IS NULL)`), and the same shape for accepted, rejected and expired. A status and its
>   timestamp are one fact: a `sent_at` with no send would make "when did this go out?" answerable
>   and "has it gone out?" not. The draft pair also makes an accepted-but-never-sent quotation
>   unrepresentable.
> - **`quotations_pdf_needs_sending`**, so a draft cannot carry a rendered PDF. A file of a
>   document that is still being written is a file somebody sends by mistake.
> - **`quotations_superseded_pair`** and **`quotations_not_superseded_by_self`**: both halves of a
>   supersession or neither, and a version cannot replace itself.
> - **`quotations_totals_add_up`**, plus `quotation_items_net_is_gross_less_discount` and
>   `quotation_items_total_is_net_plus_tax` — the same three the deal tables carry, so a second
>   implementation of the arithmetic fails the write instead of persisting a document whose lines do
>   not add up to its own total.
> - **`quotations_reason_needs_rejection`**, so a rejection reason for a rejection that did not
>   happen is not storable.

> **Amendment, 2026-10-06 (implementation, step 9).** `payments` is built, and `payment_methods` is
> new. The reasoning is
> [ADR-0020](./decisions/ADR-0020-derived-money-is-recomputed.md).
>
> - **Partial payments are rows, not a column.** Three instalments against one deal are three rows,
>   each with its own date, method and reference. Nothing caps the total at the deal's value: an
>   advance and an overpayment are both real.
> - **A refund is a status, not a negative row.** `payments_amount_positive` makes a negative payment
>   unrepresentable; reversing one sets `refunded_at` and takes it out of every total while leaving
>   the record of having received it. **Partial refunds are deliberately not representable** — a half
>   refund is a credit note, which belongs with the GST surface.
> - **`payment_methods` is a table, not a CHECK.** A reconciliation report groups by it and a
>   dropdown offers it, and the right answers differ per business — cash and UPI for a retailer,
>   cheque and NEFT for a builder (`CLAUDE.md` rule 4). `requires_reference` is the tenant saying
>   that a payment by this method cannot be reconciled without a transaction id or cheque number.
> - **A receipt gets a `number` from `number_series`**, under `kind = 'payment'` with its own prefix
>   (`RCPT-`): the receipt a customer is handed is counted and quoted independently of the quotation
>   series.
> - **`attributed_touchpoint_id` is absent.** The Phase 0 sketch has it; nothing writes it until
>   Phase 9's attribution, and a column nothing can trust does not exist yet. Attribution will reach
>   a payment's touchpoints through its lead or customer, which is one join away.
> - **`provider` / `provider_payment_id` exist with no adapter behind them**, because
>   `payments_provider_payment_key` is the idempotency key a provider webhook needs (rule 12) and
>   adding it later would mean a migration over live money.
>
> **`deals.paid_minor` and the three `customers` columns are now real.** `lifetime_value_minor`,
> `first_purchase_at` and `last_purchase_at` were carried as deliberately absent from step 6 to step
> 9 for want of a writer; all four are **recomputed from `payments`** after any write that could
> change them, inside the same transaction and after `SELECT … FOR UPDATE`, by one service. Never
> incremented: a reversal path that forgets its compensating decrement drifts silently and forever,
> and there is nothing left to compare the column against.
>
> Hand-written objects carrying guarantees the application cannot:
>
> - **`payments_received`**, partial on `status = 'succeeded' AND deleted_at IS NULL` — what every
>   revenue figure reads, out of a table whose failed and refunded rows accumulate forever.
> - **`payments_provider_payment_key`**, a partial unique index on
>   `(organization_id, provider, provider_payment_id)`. Partial because every manually recorded
>   payment has neither column; a plain unique index would have allowed exactly one cash receipt per
>   workspace.
> - **`deals_part_paid`**, partial on open deals where `paid_minor < value_minor` — the collections
>   question, which is a handful of rows out of every deal ever opened.
> - **`payments_received_has_timestamp`**: money that arrived has a date, money that has not arrived
>   does not. Deliberately **not** a biconditional on `succeeded` — a refunded payment _did_ arrive
>   and keeps its date, and writing it the obvious way made it contradict
>   `payments_refund_was_received` and refunding anything impossible. Found by refunding something.
> - **`payments_amount_positive`**, `payments_has_subject`, `payments_status`,
>   `payments_failed_has_timestamp`, `payments_refunded_has_timestamp`,
>   `payments_refund_was_received`, `payments_metadata_is_object`.
> - **`deals_paid_non_negative`**, `customers_lifetime_value_non_negative`, and the pair
>   `customers_purchase_dates_pair` / `customers_purchase_dates_ordered`: both dates or neither, and
>   a first purchase cannot follow a last one.
>
> One more thing this migration does, which every future step that adds a permission must copy: it
> **grants the new permissions to the system roles that should already have them.** A permission
> added to the catalogue reaches a new workspace through `SYSTEM_ROLE_TEMPLATES` and an existing one
> through nothing at all, so `payment:read` answered 403 for the owner of a seeded workspace five
> minutes after being written. The data migration is narrow on purpose: only roles still marked
> `is_system`, only the codes the templates name, only where the grant is absent.

### 6.7 Customers and conversion

| Table       | Purpose             | Key columns                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ----------- | ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `customers` | Somebody who bought | org, `lead_id?` + `converted_at?` (the two are null or set together), `branch_id?`, `team_id?`, `owner_user_id?` (through `Membership`), identity (`first_name`, `last_name`, `full_name`, `company`, `job_title`), contact (`phone_e164`, `phone_raw`, `whatsapp_e164`, `email`, `timezone`), billing (`billing_line1/2`, `city`, `state`, `country`, `postal_code`, `tax_id`), `custom_values JSONB` + `custom_search_text` + `search_vector`, three consent flags, `last_activity_at?`, `merged_into_id?`, `created_by_id?`, `deleted_at?` |

> **Amendment, 2026-10-06 (implementation).** Three deviations from the Phase 0 sketch, each
> deliberate — see [ADR-0017](./decisions/ADR-0017-customer-is-a-second-record.md).
>
> - **`activities` gained `customer_id`**, with its own per-tenant index. A converted person's
>   history is read as the **union** of their lead's entries and their customer's, so an entry names
>   whichever subject it actually happened to. Nothing is copied or re-parented: that is what makes
>   conversion unable to lose a touchpoint, and it is why the two subjects get _different_ activity
>   types (`lead.converted` and `customer.created`) at the same instant.
> - **`lifetime_value_minor`, `first_purchase_at` and `last_purchase_at` are absent.** Their only
>   writer is the payments ledger, which arrives with deals and quotations. A money column that is
>   always zero lies to every report that reads it, and the schema's own principle — a column nothing
>   can trust does not exist yet — applies to more than foreign keys.
>   **_Added in step 9_**, once `payments` existed to write them. All three are recomputed from the
>   ledger rather than incremented, and a customer's lifetime value is the **union** of their own
>   payments and their lead's — conversion re-parents nothing, so a deposit taken before the sale
>   closed is still on the lead and still this customer's money
>   ([ADR-0020](./decisions/ADR-0020-derived-money-is-recomputed.md)).
> - **`customer_merges` is not created.** `FR-DUP-5` wants the lead merge machinery for customers;
>   `customers.merged_into_id` exists so that arrives without a migration, and
>   `customers_not_merged_into_self` already makes a one-cycle unrepresentable.
>
> Four hand-written objects carry guarantees the application cannot:
>
> - **`customers_lead_unique`**, a partial unique index on `(organization_id, lead_id) WHERE lead_id
IS NOT NULL`. A lead converts at most once — two clicks or a retried request cannot produce two
>   customers — while any number of customers who were never leads remain representable. A plain
>   unique index would have allowed exactly one walk-in per workspace.
> - **`customers_converted_has_lead`**, `(lead_id IS NULL) = (converted_at IS NULL)`. Neither half of
>   a provenance claim can be made without the other: a conversion date with no lead is a claim about
>   a capture that never happened.
> - **`customers_merged_into`**, the referencing side of the self-FK. Postgres indexes only the
>   referenced side, and the same omission on `leads` made deletion quadratic.
> - **`customers_search_vector_trg`** plus the GIN and trigram indexes, mirroring `leads` exactly —
>   same weights, same digits-only phone handling — so one search box ranks both tables consistently.
>   If this trigger is ever dropped, a converted customer simply stops appearing in search and
>   nothing else looks broken.

### 6.8 Files, imports and exports

| Table         | Purpose                     | Key columns                                                                                                                                                                                                                                                                                                          |
| ------------- | --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `documents`   | The index of object storage | org, `subject (import \| import_errors \| export)`, `file_key`, `file_name`, `mime_type`, `size_bytes`, `checksum` (SHA-256), `scan_status (pending \| clean \| infected)`, `uploaded_by_id?`, `expires_at?`, deleted_at                                                                                             |
| `import_jobs` | One run of the wizard       | org, `document_id`, `entity_type`, `status (uploaded \| mapped \| validated \| queued \| running \| completed \| failed \| cancelled)`, `mapping JSONB`, `mode (create_only \| skip_existing \| update_existing)`, `delimiter`, seven counters, `error?`, `error_document_id?`, `requested_by_id?`, started/finished |
| `import_rows` | What became of each row     | org, `job_id`, `row_number` (1-based, header is row 1), `status (created \| updated \| attached \| skipped \| failed)`, `errors JSONB`, `raw JSONB`, `lead_id?`                                                                                                                                                      |
| `export_jobs` | A background export         | org, `entity_type`, `filters JSONB` (view id or the filter DSL), `columns JSONB`, status, `row_count`, `document_id?`, `expires_at?`, `includes_pii`, `requested_by_id?`, started/finished                                                                                                                           |

> **Amendment, 2026-10-05 (implementation).** Four decisions in these tables are load-bearing, and
> each is enforced by a constraint rather than by application code:
>
> - **An import's outcomes must add up.** `created + updated + attached + skipped + failed =
processed_rows`, and `processed_rows <= total_rows`. A resumable run recomputes its counters from
>   `import_rows` rather than trusting the job, and these two checks are what makes that
>   reconstruction verifiable instead of hopeful. A progress bar that disagrees with the row records
>   is a bug nobody notices until somebody counts.
> - **A failed row carries a reason and an outcome row carries its lead.**
>   `status <> 'failed' OR jsonb_array_length(errors) > 0`, and
>   `status NOT IN ('created','updated','attached') OR lead_id IS NOT NULL`. A failed row with no
>   error is a row a person cannot fix; a `created` row with no lead is provenance that leads
>   nowhere. (`skipped` **may** carry a lead id, and does — "this row is already lead X" is the
>   answer to "why did my re-upload import nothing".)
> - **A document's checksum is a SHA-256 or the row does not exist** (`checksum ~ '^[0-9a-f]{64}$'`),
>   its size is positive, and its subject is one of three known values. A zero-byte file with a
>   plausible row is how an import reports "0 rows" for a file somebody can see has 4 000.
> - **An export that says it is finished has a file** (`status <> 'completed' OR document_id IS NOT
NULL`), and `documents_expiring` — a partial index on `expires_at WHERE expires_at IS NOT NULL
AND deleted_at IS NULL` — is what makes the hourly expiry sweep a bounded index scan rather than
>   a table scan of every file the workspace has ever produced.
>
> `import_rows.lead_id` and both `document_id` references are composite FKs with `ON DELETE
RESTRICT`, like every other cross-table reference here: `SetNull` and `SetDefault` would each try
> to clear the NOT NULL `organization_id`. The consequence is deliberate — a purge that really must
> remove a lead clears its import rows first, deciding to lose that provenance explicitly rather
> than silently. An **expired export is soft-deleted and its bytes are dropped, but the row stays**:
> who exported what, and when, is audit history, and deleting the evidence with the file would
> defeat the audit entry that `FR-IO-3` requires.

---

## 7. Conversations, messages, WhatsApp

| Table                       | Key columns / notes                                                                                                                                                                                                                            |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `whatsapp_accounts`         | org, `integration_connection_id`, `waba_id`, `business_name`, `status`, `verified_at`, `last_error?`                                                                                                                                           |
| `whatsapp_numbers`          | org, account_id, `phone_number_id UQ` (Meta), `display_phone_e164`, `verified_name`, `quality_rating`, `messaging_limit_tier`, `is_active`, `default_agent_user_id?`                                                                           |
| `whatsapp_templates`        | org, account_id, `name`, `language`, `category (marketing                                                                                                                                                                                      | utility                 | authentication)`, `status (draft        | pending                                                                                                                                                       | approved       | rejected                               | paused                                                                                                                                                                                                                                                                                      | disabled)`, `rejection_reason?`, `components JSONB`, `variable_map JSONB` (`{{1}} → lead.full_name`), `provider_template_id?`, `synced_at`. `UNIQUE (organization_id, account_id, name, language)` |
| `conversations`             | org, `channel (whatsapp                                                                                                                                                                                                                        | email                   | sms                                     | webchat)`, `channel_account_id`(e.g. whatsapp_number_id),`contact_e164?`, `lead_id?`, `customer_id?`, `assigned_user_id?`, `assigned_team_id?`, `status (open | pending        | snoozed                                | closed)`, `priority`, `last_message_at`, `last_inbound_at`, `last_outbound_at`, `unread_count`, `first_response_at?`, `window_expires_at?`(24 h service window),`snoozed_until?`, `closed_at?`, `closed_by_id?`, `tags`, `lock_user_id?`, `lock_expires_at?`(soft ownership lock,`FR-WA-7`) |
| `conversation_participants` | conversation_id, `user_id`, `role (owner                                                                                                                                                                                                       | collaborator            | observer)`, `joined_at`, `last_read_at` |
| `messages`                  | org, conversation_id, `direction (inbound                                                                                                                                                                                                      | outbound)`, `type (text | image                                   | video                                                                                                                                                         | audio          | document                               | location                                                                                                                                                                                                                                                                                    | contacts                                                                                                                                                                                           | sticker | template | interactive | reaction | system)`, `body?`, `payload JSONB`, `template_id?`, `provider (whatsapp_cloud | …)`, `provider_message_id` (**`UNIQUE (provider, provider_message_id)`globally** — the idempotency gate,`FR-WA-6`), `reply_to_message_id?`, `sender_user_id?`, `status (queued | accepted | sent | delivered | read | failed)`, `error_code?`, `error_message?`, `sent_at?`, `delivered_at?`, `read_at?`, `failed_at?`, `billable`, `conversation_category?`, `created_at`. **Partitioned monthly by `created_at`** |
| `message_media`             | message_id, `file_key`, `provider_media_id?`, mime, size, `caption?`, `download_status`, `sha256`                                                                                                                                              |
| `message_status_events`     | message_id, `status`, `occurred_at`, `provider_event_id`, `raw JSONB` — full status history, dedup on provider event id                                                                                                                        |
| `canned_replies`            | org, `shortcut`, body, `visibility`, usage_count                                                                                                                                                                                               |
| `calls`                     | org, lead_id?, `direction`, `from_e164`, `to_e164`, `status`, `outcome_id?`, `duration_seconds`, `recording_url?`, `recording_document_id?`, `provider?`, `provider_call_id?`, `notes?`, `task_id?`, `agent_user_id`, `started_at`, `ended_at` |
| `call_outcomes`             | org, name, `category (connected                                                                                                                                                                                                                | no_answer               | busy                                    | wrong_number                                                                                                                                                  | not_interested | callback)`, `score_delta?`, sort_order |

Indexes: `(organization_id, channel_account_id, status, last_message_at DESC)` for the inbox list;
`(organization_id, assigned_user_id, status, last_message_at DESC)` for "my conversations";
`(organization_id, conversation_id, created_at DESC)` for message paging;
`(organization_id, status, unread_count)` partial for unread badges; GIN `tsvector` on `body` for
message search (`FR-VIEW-1`).

---

## 8. Capture: forms, ingestion, API, webhooks

| Table                       | Key columns / notes                                                                                                                                                                                                                           |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `forms`                     | org, name, `slug UQ per org`, `type (embed                                                                                                                                                                                                    | landing   | popup)`, `pipeline_id?`, `lead_source_id?`, `assignment_rule_id?`, `settings JSONB`(redirect, thank-you, captcha, honeypot, consent text),`is_active`, `submission_count`, deleted_at |
| `form_fields`               | form_id, `custom_field_definition_id?` **or** `standard_field_key`, label override, required override, `sort_order`, `step_index`, `options_override JSONB`                                                                                   |
| `form_submissions`          | org, form_id, `lead_id?`, `raw_payload JSONB`, `utm JSONB`, `session_id?`, `visitor_id?`, ip_hash, user_agent, `page_url`, `referrer`, `status (processed                                                                                     | duplicate | rejected                                                                                                                                                                              | error)`, `error?`, created_at                                                                                                            |
| `inbound_payloads`          | **Never-lose-a-lead store.** org?, `channel (public_api                                                                                                                                                                                       | webhook   | meta_ads                                                                                                                                                                              | google_ads                                                                                                                               | form           | whatsapp | import)`, `integration_connection_id?`, `raw_body JSONB`, headers (redacted), `signature_valid BOOL`, `idempotency_key?`, `dedupe_hash`, `status (received | processed | duplicate                                                                                                        | failed)`, `lead_id?`, `error?`, `attempts`, `received_at`. `UNIQUE (organization_id, channel, idempotency_key)`. Partitioned monthly (`FR-CAP-3`, `NFR-REL-2`) |
| `ingestion_errors`          | payload_id, `stage`, `error_code`, `message`, `details JSONB`, `is_replayable`, `replayed_at?`                                                                                                                                                |
| `api_keys`                  | org, name, `key_prefix` (shown), `key_hash`, `secret_hash`, `scopes TEXT[]`, `ip_allowlist INET[]`, `rate_limit_per_min`, `expires_at?`, `last_used_at?`, `created_by_id`, `revoked_at?` (`FR-API-2`)                                         |
| `api_logs`                  | org, `api_key_id?`, method, path, `status_code`, `duration_ms`, `request_id`, `ip`, `bytes_in/out`, `error_code?`, created_at. Partitioned daily, short retention (`FR-SA-4`)                                                                 |
| `webhook_endpoints`         | org, url, `description`, `signing_secret_encrypted`, `event_types TEXT[]`, `is_active`, `failure_count`, `disabled_at?`, `disabled_reason?`                                                                                                   |
| `webhook_deliveries`        | org, endpoint_id, `event_type`, `event_id`, `payload JSONB`, `status (pending                                                                                                                                                                 | succeeded | failed                                                                                                                                                                                | exhausted)`, `attempt_count`, `next_attempt_at?`, `last_status_code?`, `last_response_body` (truncated), created_at. Partitioned monthly |
| `webhook_attempts`          | delivery_id, `attempt_no`, `status_code?`, `duration_ms`, `error?`, `attempted_at`                                                                                                                                                            |
| `provider_events`           | **Inbound idempotency ledger.** org, `provider`, `external_event_id`, `event_type`, `received_at`, `processed_at?`, `status`, `raw JSONB`. `UNIQUE (organization_id, provider, external_event_id)` (`FR-WA-6`)                                |
| `integration_connections`   | org, `provider (whatsapp_cloud                                                                                                                                                                                                                | meta_ads  | google_ads                                                                                                                                                                            | google_analytics                                                                                                                         | search_console | razorpay | stripe                                                                                                                                                     | smtp      | telephony_x)`, `external_account_id`, `credentials_encrypted BYTEA`, `key_version`, `scopes`, `status (connected | degraded                                                                                                                                                       | error | revoked)`, `last_success_at`, `last_error_at`, `last_error`, `expires_at?`, `connected_by_id`, `settings JSONB` |
| `sync_cursors`              | connection_id, `resource`, `cursor`, `last_synced_at`, `state JSONB`                                                                                                                                                                          |
| `integration_health_checks` | connection_id, `checked_at`, `status`, `latency_ms`, `detail JSONB`                                                                                                                                                                           |
| `outbox_events`             | **Transactional outbox.** org?, `event_name`, `event_id UUID UQ`, `aggregate_type`, `aggregate_id`, `payload JSONB`, `occurred_at`, `published_at?`, `attempts`, `error?`. Index `(published_at NULLS FIRST, occurred_at)` for the dispatcher |
| `idempotency_keys`          | org, `key`, `endpoint`, `request_hash`, `response_status`, `response_body JSONB`, `expires_at`. `UNIQUE (organization_id, endpoint, key)` (`FR-API-5`)                                                                                        |

---

## 9. Automation

| Table                           | Key columns / notes                                                                                                                                                       |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `workflows`                     | org, name, description, `is_active`, `current_version_id?`, `entity_type`, `kill_switch BOOL`, `max_runs_per_entity?`, `reentry_policy (once                              | cooldown  | always)`, `cooldown_hours?`, created_by, deleted_at |
| `workflow_versions`             | workflow_id, `version INT`, `definition JSONB` (normalized graph snapshot), `published_at?`, `published_by_id?`, `is_draft`. `UNIQUE (workflow_id, version)` (`FR-AUT-5`) |
| `workflow_steps`                | version_id, `step_key`, `kind (trigger                                                                                                                                    | condition | action                                              | delay                                                                                                                                                                               | branch                                                                                             | exit)`, `type`(registry key, e.g.`action.send_whatsapp_template`), `config JSONB`, `sort_order`, `parent_step_key?`, `branch_label?` |
| `workflow_triggers`             | version_id, `event_name`, `filters JSONB`, `schedule_cron?`, `is_active` — indexed by `(organization_id, event_name)` so dispatch is a single lookup                      |
| `automation_enrollments`        | org, workflow_id, `version_id`, `entity_type`, `entity_id`, `status (active                                                                                               | completed | exited                                              | failed)`, `enrolled_at`, `completed_at?`. `UNIQUE (organization_id, workflow_id, entity_id, enrollment_cycle)` enforces re-entry policy                                             |
| `automation_runs`               | org, workflow_id, version_id, enrollment_id, `trigger_event_id?`, `entity_type`, `entity_id`, `status (running                                                            | waiting   | completed                                           | failed                                                                                                                                                                              | cancelled)`, `current_step_key?`, `resume_at?`, `context JSONB`, started_at, finished_at, `error?` |
| `automation_run_steps`          | run_id, `step_key`, `attempt`, `status (pending                                                                                                                           | succeeded | skipped                                             | failed)`, `input JSONB`, `output JSONB`, `decision?`, `error?`, `started_at`, `finished_at`, `idempotency_key UQ per (run_id, step_key, attempt)`. Partitioned monthly (`FR-AUT-7`) |
| `automation_guardrail_counters` | org, `scope_key` (workflow/entity/day), `count`, `window_start` — cheap counters backing caps (`FR-AUT-6`)                                                                |

Waiting runs are resumed by BullMQ delayed jobs _and_ a reconciliation sweep over
`status='waiting' AND resume_at <= now()`, so a lost Redis job cannot strand a workflow.

---

## 10. Websites & analytics

| Table                | Key columns / notes                                                                                                                                                                                                                                                                                                                                                                                     |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `websites`           | org, `template_code`, name, `subdomain UQ`, `theme JSONB` (colours/fonts/logo), `seo_defaults JSONB`, `status (draft                                                                                                                                                                                                                                                                                    | published)`, `published_version_id?`, `tracking_site_id UQ` |
| `website_pages`      | website_id, `path`, title, `blocks JSONB`, `seo JSONB`, `is_home`, sort_order, `status`. `UNIQUE (organization_id, website_id, path)`                                                                                                                                                                                                                                                                   |
| `website_versions`   | website_id, `version`, `snapshot JSONB`, published_at, published_by (rollback, `FR-WEB-5`)                                                                                                                                                                                                                                                                                                              |
| `website_domains`    | website_id, `domain UQ`, `verification_token`, `verified_at?`, `ssl_status`, `is_primary`                                                                                                                                                                                                                                                                                                               |
| `website_forms`      | Join of `websites`↔`forms` with placement metadata                                                                                                                                                                                                                                                                                                                                                      |
| `analytics_visitors` | org, `site_id`, `visitor_id` (first-party cookie/localStorage id), `first_seen_at`, `last_seen_at`, `first_utm JSONB`, `first_landing_page`, `device JSONB`, `country`, `region`, `city`, `sessions_count`, `is_bot`. `UNIQUE (organization_id, site_id, visitor_id)`                                                                                                                                   |
| `analytics_sessions` | org, site_id, visitor_id, `session_id`, `started_at`, `ended_at?`, `duration_seconds`, `page_views`, `entry_page`, `exit_page`, `referrer`, `utm JSONB`, `device`, `browser`, `os`, `country/region/city`, `converted BOOL`, `lead_id?`                                                                                                                                                                 |
| `visitor_identities` | org, `visitor_id`, `lead_id`, `identified_at`, `method (form_submit                                                                                                                                                                                                                                                                                                                                     | whatsapp_click                                              | link_click | api)` — the stitch that puts web behaviour on the timeline (`FR-ANL-7`) |
| `website_events`     | org, site_id, `event_id` (client-generated), `visitor_id`, `session_id`, `type`, `occurred_at`, `page_url`, `page_path`, `referrer`, `properties JSONB` (product_id, value_minor, currency, cart_id, scroll %, cta id), `utm JSONB`, `device`, `country`, `ip_hash`, `received_at`. `UNIQUE (organization_id, site_id, event_id)`. **Partitioned daily**, retention by plan (`FR-ANL-6`, `NFR-SCALE-3`) |

### Rollups (dashboards read these only)

| Table                    | Grain               | Contents                                                                                                          |
| ------------------------ | ------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `daily_website_metrics`  | org, site, date     | visitors, new visitors, sessions, page views, avg duration, bounce rate, whatsapp clicks, form views/submits      |
| `daily_funnel_metrics`   | org, site, date     | visitors, product_views, add_to_cart, checkout_start, purchases, revenue_minor + step conversion rates            |
| `daily_source_metrics`   | org, source, date   | leads, qualified, customers, revenue_minor, cost_minor, CPL, conversion rate                                      |
| `daily_campaign_metrics` | org, campaign, date | spend, impressions, clicks, leads, qualified, customers, attributed_revenue_minor, CPL, CAC, ROAS                 |
| `daily_user_metrics`     | org, user, date     | leads assigned, contacted, calls, WA sent/received, tasks due/completed/overdue, avg first response, won, revenue |
| `daily_org_metrics`      | org, date           | leads, by-stage counts, conversions, revenue, active users, WA volume, automation runs, API calls, storage bytes  |
| `daily_platform_metrics` | date                | orgs by status, users, leads, messages, visitors, MRR, ARR, failed payments, API calls, storage                   |

All rollups: `UNIQUE (organization_id, …, date)`, upserted idempotently by the aggregation worker,
recomputable from raw data for a rolling window (late events are handled by re-aggregating the
affected day, not by mutating counters).

---

## 11. Marketing

| Table                    | Key columns                                                                                                                                                                                                               |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ad_accounts`            | org, `integration_connection_id`, `platform (meta                                                                                                                                                                         | google)`, `external_account_id`, name, currency, `is_active`         |
| `campaigns`              | org, `ad_account_id?`, `platform`, `external_id?`, name, `objective`, `status`, `started_at`, `ended_at?`, `budget_minor`, currency, `utm_campaign`, `lead_source_id?`. `UNIQUE (organization_id, platform, external_id)` |
| `ad_entities`            | org, campaign_id, `level (ad_set                                                                                                                                                                                          | ad                                                                   | keyword)`, `external_id`, name, `parent_external_id?`, `creative JSONB` |
| `campaign_daily_metrics` | org, campaign_id, `ad_entity_id?`, date, `spend_minor`, impressions, clicks, `platform_leads`, `synced_at`. `UNIQUE (organization_id, campaign_id, ad_entity_id, date)`                                                   |
| `attribution_settings`   | org, `model (first_touch                                                                                                                                                                                                  | last_touch                                                           | lead_source                                                             | campaign)`, `lookback_days`, `include_channels JSONB` (`FR-ATT-3`) |
| `segments`               | org, name, `definition JSONB` (filter DSL), `is_dynamic`, `member_count`, `last_computed_at`                                                                                                                              |
| `segment_members`        | segment_id, `lead_id                                                                                                                                                                                                      | customer_id`, `added_at` (materialized for static/dynamic snapshots) |
| `seo_keywords`           | org, website_id?, keyword, country, device, `target_url?`, is_active                                                                                                                                                      |
| `seo_rankings`           | keyword_id, date, `position?`, `url?`, `impressions`, `clicks`, `ctr`, `source (search_console                                                                                                                            | provider)`                                                           |
| `service_subscriptions`  | org, `service_package_id`, status, `started_at`, `ends_at?`, `price_minor`, `billing_cycle`, `assigned_manager_id?`, `deliverables JSONB` (`FR-BIL-6`)                                                                    |

---

## 12. Subscriptions, billing, usage

| Table                   | Key columns                                                                                                                                                                  |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `subscriptions`         | org, `plan_id`, `status (trialing                                                                                                                                            | active | past_due | grace | cancelled | expired)`, `started_at`, `trial_ends_at?`, `current_period_start/end`, `cancel_at?`, `cancelled_at?`, `grace_ends_at?`, `provider?`, `provider_subscription_id?`, `seats` |
| `subscription_items`    | subscription_id, `feature_key`, `quantity`, `unit_price_minor`                                                                                                               |
| `entitlement_overrides` | org, `feature_key`, `limit_value?`, `is_enabled?`, `reason`, `expires_at?`, `set_by_platform_user_id` (`FR-BIL-2`)                                                           |
| `usage_counters`        | org, `metric_key`, `period_start`, `period_end`, `used BIGINT`, `limit_snapshot BIGINT?`, `warned_at?`, `exceeded_at?`. `UNIQUE (organization_id, metric_key, period_start)` |
| `usage_events`          | org, `metric_key`, `quantity`, `occurred_at`, `reference` — append-only source for counters, partitioned monthly                                                             |
| `invoices`              | org, `number UQ`, status, `subtotal/tax/total_minor`, currency, `period`, `due_at`, `paid_at?`, `pdf_document_id?`, `provider_invoice_id?`                                   |
| `invoice_items`         | invoice_id, description, qty, `unit_price_minor`, `total_minor`, `feature_key?`                                                                                              |
| `payment_methods`       | org, provider, `provider_method_id`, brand, last4, `expires`, `is_default`                                                                                                   |
| `billing_payments`      | org, invoice_id?, `amount_minor`, status, provider, `provider_payment_id`, `failure_code?`, `paid_at?`                                                                       |
| `dunning_attempts`      | invoice_id, `attempt_no`, `attempted_at`, `result`, `next_attempt_at?`                                                                                                       |
| `tenant_health_scores`  | org, `computed_at`, `score`, `band`, `signals JSONB`, `churn_risk` (`FR-SA-6`)                                                                                               |

---

## 13. Notifications & privacy

| Table                                     | Key columns                                                                                                                                                                         |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `notifications`                           | org, `user_id`, `type`, `title`, `body`, `data JSONB`, `link`, `read_at?`, `created_at`. Index `(organization_id, user_id, read_at, created_at DESC)`; partitioned monthly at scale |
| `notification_deliveries`                 | notification_id, `channel (in_app                                                                                                                                                   | email                                        | whatsapp                                                                                    | push)`, `status`, `provider_message_id?`, `error?`, `sent_at?` |
| `notification_preferences`                | org, user_id, `type`, `channels JSONB`, `quiet_hours JSONB`, `digest (off                                                                                                           | daily                                        | weekly)`. `UNIQUE (organization_id, user_id, type)`                                         |
| `notification_templates`                  | org?/platform, `type`, `channel`, `locale`, subject, body, `variables JSONB`                                                                                                        |
| `consents`                                | org, `subject_type (lead                                                                                                                                                            | customer)`, `subject_id`, `channel (whatsapp | email                                                                                       | sms                                                            | calls)`, `granted BOOL`, `source`, `text_shown`, `ip_hash?`, `evidence JSONB`, `granted_at?`, `revoked_at?` (`FR-PRV-1`) |
| `suppressions`                            | org, `channel`, `identifier` (e164/email hash), `reason (opt_out                                                                                                                    | bounce                                       | complaint                                                                                   | manual                                                         | invalid)`, `created_at`. `UNIQUE (organization_id, channel, identifier)` — checked at send time (`FR-PRV-2`)             |
| `dsr_requests`                            | org, `subject`, `type (export                                                                                                                                                       | delete                                       | rectify)`, `status`, `requested_by`, `verified_at?`, `completed_at?`, `result_document_id?` |
| `retention_policies`                      | org, `entity_type`, `retain_days`, `action (purge                                                                                                                                   | anonymize)`, `is_active`, `last_run_at?`     |
| `ai_requests` / `ai_outputs` / `ai_usage` | org, feature, `entity`, `prompt_hash`, model, `tokens_in/out`, `cost_minor`, latency, `output JSONB`, `accepted_by_user_id?`, `edited BOOL` (`FR-AI-4`)                             |

`import_jobs`, `import_rows`, `export_jobs` and `documents` are defined in
[§6.8](#68-files-imports-and-exports). A DSR export (`dsr_requests.result_document_id`) will be a
`documents` row like any other, which is the reason that table is not private to the import module.

---

## 14. Partitioning & retention

| Table                                | Partition                 | Default retention            | Notes                                                                                                                                                                                                                    |
| ------------------------------------ | ------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `activities`                         | monthly (`occurred_at`)   | 24 months, plan-configurable | Older months detached to cold storage before drop                                                                                                                                                                        |
| `messages` + `message_status_events` | monthly (`created_at`)    | 24 months                    | Legal/consent records survive in `consents`                                                                                                                                                                              |
| `website_events`                     | **daily** (`occurred_at`) | 90 days (plan-based)         | Rollups are permanent, so history is not lost                                                                                                                                                                            |
| `api_logs`                           | daily                     | 30 days                      |                                                                                                                                                                                                                          |
| `webhook_deliveries` / `_attempts`   | monthly                   | 90 days                      |                                                                                                                                                                                                                          |
| `inbound_payloads`                   | monthly                   | 90 days (errors 365)         | Errors retained longer for replay                                                                                                                                                                                        |
| `automation_run_steps`               | monthly                   | 180 days                     |                                                                                                                                                                                                                          |
| `usage_events`                       | monthly                   | 13 months                    | Counters are permanent                                                                                                                                                                                                   |
| `notifications`                      | monthly (at scale)        | 180 days                     |                                                                                                                                                                                                                          |
| `documents`                          | —                         | per-row `expires_at`         | The row survives; the **bytes** are dropped by the hourly `maintenance.document-expiry` sweep. An export defaults to `EXPORT_RETENTION_HOURS` (72), an import's error file to 7 days, an uploaded source file to 30 days |

`pg_partman`-style maintenance job: pre-create the next N partitions, detach+drop expired ones,
`ANALYZE` after attach. Retention is per-plan (`analytics retention` entitlement) and enforced by a
nightly job that respects `retention_policies` and legal holds.

---

## 15. Search strategy

- `search_vector tsvector` on `leads` (name, company, phone digits, email, city, `custom_search_text`), maintained by trigger, GIN-indexed.
- `pg_trgm` GIN on `phone_e164`, `email`, `full_name` for partial/fuzzy matches ("last 4 digits of the number").
- Message body search: `tsvector` on the current + previous message partitions (older partitions searched on demand).
- Global search fans out across leads / customers / conversations / tasks / deals with per-entity `LIMIT`, always `organization_id`-scoped and data-scope filtered, results merged and ranked in the API.
- Behind `SearchRepository`, so OpenSearch can replace Postgres in stage C without touching callers (ADR-0007).

---

## 16. Data integrity rules enforced in the database

1. Composite FKs on every tenant child row (`FR-TEN-4`).
2. `CHECK (status_id IS NOT NULL)` style guards plus FK to tenant config tables — a lead cannot hold another tenant's status.
3. `UNIQUE (provider, provider_message_id)` on `messages`; `UNIQUE (organization_id, provider, external_event_id)` on `provider_events` — duplicate webhooks are impossible, not merely unlikely.
4. `UNIQUE (organization_id, source_event_id, occurred_at)` on `activities` — duplicate timeline entries impossible under retry. _Deviation, forced by PostgreSQL:_ a unique constraint on a partitioned table must contain the partition key, so `occurred_at` is part of it and the primary key is `(id, occurred_at)`. The guarantee holds because `occurred_at` comes from the event, never from `now()` — see [ADR-0009](./decisions/ADR-0009-append-only-timeline.md#amendment-2026-09-27-implementation).
5. `UNIQUE (organization_id, channel, idempotency_key)` on `inbound_payloads` and `idempotency_keys` — duplicate lead creation impossible under client retry.

> **Every guarantee on this page that Prisma cannot express is deleted by the next generated
> migration unless somebody stops it.** `prisma migrate diff` compares the database to
> `schema.prisma`; a partitioned table, a three-column foreign key, an expression or GIN index, a
> partial unique index, a trigger and a check constraint are all invisible to the schema, so the
> diff proposes dropping them. That is not hypothetical — it happened between Phase 2 step 1 and
> step 2 and was applied. Two rules follow: read every generated migration before applying it and
> delete the spurious `DROP`s, and keep `packages/db/src/schema-objects.int-spec.ts` current, since
> it is the only thing that turns such a deletion into a test failure rather than a silent loss.

6. `EXCLUDE`/partial unique on `sla_clocks` so one subject has at most one active clock per policy.
7. `CHECK (amount_minor >= 0)` on money; `CHECK (currency ~ '^[A-Z]{3}$')`.
8. `audit_logs` is append-only by trigger (UPDATE always rejected; DELETE only under the explicit `app.audit_purge` flag used by the retention/DSR path), **and** production connects as a role without UPDATE/DELETE on it (`FR-AUD-2`).
9. All `ON DELETE` behaviour explicit: `CASCADE` only where the child is meaningless alone (lead_tags, form_fields, run_steps); otherwise `RESTRICT` + soft delete.
10. `updated_at` is maintained by Prisma's `@updatedAt` for client writes. _Deviation from the original design:_ a database trigger was not added, because Prisma sends the column explicitly and the two mechanisms would fight. Tables later written by raw SQL get a trigger at that point.

---

## 17. Seed data (per new organization)

Created transactionally at signup from the chosen industry template, all editable afterwards:
default branch + team; roles (Owner/Admin/Manager/Executive) with permission grants; lead statuses;
lost reasons; task types; reschedule reasons; call outcomes; one default pipeline with stages; lead
sources (website, facebook, google, whatsapp, referral, walk-in, manual, api); industry custom
fields; saved views (Today's Follow-ups, Overdue, New Leads, Hot Leads, No Next Action); one
duplicate rule (phone, 365-day lookback, attach-to-existing — the rule names `phoneE164` and the
field registry makes that match a WhatsApp number carrying the same digits, on either side, so the
seeded `match_on` is one set rather than two); one assignment rule (round-robin over
the default team); a default SLA policy (first response 60 working minutes); starter automation
(welcome WhatsApp draft + day-1 call task) left **inactive** until WhatsApp is connected.

> **Amendment, 2026-10-06 (implementation, step 10).** The sentence above says "from the chosen
> industry template", and that is not when it happens. The reasoning is
> [ADR-0021](./decisions/ADR-0021-industry-templates-replace.md).
>
> - **Provisioning seeds the industry-neutral set**, because a workspace has to work on first login
>   — a lead needs a default status to go into and a pipeline to go on — and the industry is chosen
>   in the wizard, which is after signup.
> - **A template is applied later, and it replaces.** `POST /organization/industry-template` deletes
>   the statuses, lead pipeline stages, sources, lost reasons, tags and custom field definitions and
>   writes the template's. Merging would leave twelve statuses, two of which mean the same thing.
> - **It is refused once the workspace holds a lead, a customer, a deal or a quotation**, naming
>   what it found. `leads.status_id` is `Restrict`, so the delete would fail at the database anyway;
>   refusing up front with a sentence that says what to do instead is the honest version of the same
>   guarantee.
> - **`Manual entry` and `API` survive the replacement.** They are not marketing channels — the
>   capture paths look them up by name — and deleting them would break lead creation right after
>   onboarding.
> - **`industry_templates` is a new platform table** (not tenant-scoped), one row per industry,
>   upserted from `INDUSTRY_TEMPLATES` in `@leados/shared` by `seedPlatformCatalogue`. The constant
>   is the definition; the table exists so `organizations.industry_template_key` can reference it and
>   so the Super Admin console can manage templates without a deploy. Its `definition` JSONB carries
>   the whole template, because a column per concern would be eleven columns nothing joins on.
> - **`organizations.industry_template_key`** records which one was applied, with `SetNull` on
>   delete: retiring a template must not be blocked by the workspaces that once used it. **Nothing
>   in the product branches on it** — every row a template writes is an ordinary editable row, which
>   is what rule 4 requires.
> - **Task types, starter automations and WhatsApp drafts are not seeded by a template**, because
>   those tables arrive in Phases 3, 6 and 5. The template shape is per concern precisely so adding
>   `taskTypes` is then a content change.
>
> Hand-written objects: `industry_templates_key_format` (a key is a slug, because it is stored on
> every organization that applied it), `industry_templates_name_present`,
> `industry_templates_description_present` (longer than twenty characters — a picker whose entries
> have no sentence is one nobody can choose from) and `industry_templates_definition_is_object`.
