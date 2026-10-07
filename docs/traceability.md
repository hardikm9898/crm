# Traceability — brief section → requirement → design document

Purpose: prove that nothing in the original 74-section brief was dropped, and give every future PR a
place to check "where is this specified?". `PRD` = `product-requirements.md`.

| Brief § | Topic                                   | Requirements                            | Design location                                                                            |
| ------- | --------------------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------ |
| 1       | Product vision, lead channels           | PRD §1, `FR-CAP-1`                      | PRD §1; `system-architecture.md` §8.1                                                      |
| 2       | Everything around the lead              | `FR-TL-1..3`                            | `database-design.md` §6.4–6.5; ADR-0009                                                    |
| 3       | Multi-tenant hierarchy & isolation      | `FR-TEN-1..7`                           | `system-architecture.md` §6; `security.md` §3; ADR-0001                                    |
| 4       | Roles (Super Admin → Executive)         | `FR-IAM-3..5`, `FR-SA-1..7`, `FR-TSK-7` | `security.md` §4; `database-design.md` §4; `frontend-architecture.md` §2, §5.1             |
| 5       | Lead fields, standard + custom          | `FR-LEAD-1..9`                          | `database-design.md` §5, §6.1; ADR-0005                                                    |
| 6       | Dynamic lead capture / forms            | `FR-CAP-2..5`                           | `system-architecture.md` §8.1; `database-design.md` §8                                     |
| 7       | Website lead API                        | `FR-CAP-6/7`, `FR-API-1..5`             | `api-architecture.md` §6                                                                   |
| 8       | Lead source management                  | `FR-LEAD-7`, `FR-MKT-1`                 | `database-design.md` §6.2 (`lead_sources`), §10 rollups                                    |
| 9       | Duplicate management                    | `FR-DUP-1..5`                           | `database-design.md` §6.2; `system-architecture.md` §8.1 step 4                            |
| 10      | Assignment engine                       | `FR-ASG-1..7`                           | `database-design.md` §6.3; `queue-event-architecture.md` §3                                |
| 11      | Lead scoring                            | `FR-SCR-1..3`                           | `database-design.md` §6.3; `api-architecture.md` (score-breakdown)                         |
| 12      | Pipeline management                     | `FR-PIP-1..3`                           | `database-design.md` §6.3; `frontend-architecture.md` §4 (KanbanBoard)                     |
| 13      | Task management                         | `FR-TSK-1..3`                           | `database-design.md` §6.4; ADR-0022; `apps/api/src/modules/tasks/README.md`                |
| 14      | Follow-up engine                        | `FR-TSK-4..7`                           | `frontend-architecture.md` §5.1; `api-architecture.md` (`/tasks`, `/my/today`); ADR-0022   |
| 14a     | SLA, breach and escalation              | `FR-TSK-8`                              | `database-design.md` §6.4; ADR-0023; `apps/api/src/modules/sla/README.md`                  |
| 15      | Follow-up automation                    | `FR-AUT-1..8`                           | `queue-event-architecture.md` §7                                                           |
| 16      | WhatsApp Cloud API                      | `FR-WA-1..6`                            | `integration-architecture.md` §4; ADR-0008                                                 |
| 17      | Shared WhatsApp inbox                   | `FR-WA-7/8`                             | `database-design.md` §7; `frontend-architecture.md` §5.3                                   |
| 18      | WhatsApp webhook + idempotency          | `FR-WA-6`                               | `system-architecture.md` §8.2; `api-architecture.md` §7; `queue-event-architecture.md` §4  |
| 19      | WhatsApp templates                      | `FR-WA-5`                               | `integration-architecture.md` §4; `database-design.md` §7                                  |
| 20      | WhatsApp automation                     | `FR-AUT-4`, `FR-WA-9/10`                | `queue-event-architecture.md` §7; roadmap Phase 6 exit criteria                            |
| 21      | Conversation timeline                   | `FR-TL-1`                               | ADR-0009; `database-design.md` §6.5                                                        |
| 22      | Call management + telephony abstraction | `FR-CALL-1..3`                          | `integration-architecture.md` §2; `database-design.md` §7                                  |
| 23      | Website builder                         | `FR-WEB-1..5`                           | `database-design.md` §10; roadmap Phase 7                                                  |
| 24      | Website → CRM lead integration          | `FR-WEB-6`                              | `system-architecture.md` §8.1; roadmap Phase 7 exit criteria                               |
| 25      | Website analytics                       | `FR-ANL-1..6`                           | `system-architecture.md` §8.3; `database-design.md` §10; ADR-0010                          |
| 26      | Customer journey                        | `FR-ATT-1/2`                            | `database-design.md` §6.2 (touchpoints); `frontend-architecture.md` §5.4                   |
| 27      | Marketing module                        | `FR-MKT-1..5`                           | `database-design.md` §11; `integration-architecture.md` §6                                 |
| 28      | Campaign tracking & attribution         | `FR-ATT-3/4`, `FR-MKT-1`                | `database-design.md` §11; roadmap Phase 9 exit criteria                                    |
| 29      | SEO / service packages                  | `FR-MKT-5`, `FR-BIL-6`                  | `database-design.md` §3, §11                                                               |
| 30      | Free trial                              | `FR-BIL-3`                              | `database-design.md` §12; `queue-event-architecture.md` §5 (`trial.check`)                 |
| 31      | Billing & subscriptions                 | `FR-BIL-1..5`                           | `database-design.md` §12                                                                   |
| 32      | Super Admin dashboard                   | `FR-SA-2`                               | `api-architecture.md` §5 (admin); `database-design.md` §10 (`daily_platform_metrics`)      |
| 33      | Super Admin automation/alerts           | `FR-SA-5`                               | `queue-event-architecture.md` §5/§6; `deployment-architecture.md` §7                       |
| 34      | Audit log                               | `FR-AUD-1/2`                            | `security.md` §10; `database-design.md` §4, §16.8                                          |
| 35      | Notification center                     | `FR-NOT-1..3`                           | `database-design.md` §13; `queue-event-architecture.md` §3                                 |
| 36      | Mobile responsiveness                   | `NFR-UX-1`                              | `frontend-architecture.md` §1, §5.1                                                        |
| 37      | Business dashboards                     | `FR-SA-2`, `FR-MKT-3`                   | `frontend-architecture.md` §5.4                                                            |
| 38      | Sales executive dashboard               | `FR-TSK-7`                              | `frontend-architecture.md` §5.1                                                            |
| 39      | Global search                           | `FR-VIEW-1`                             | `database-design.md` §15; ADR-0007                                                         |
| 40      | Filters & saved views                   | `FR-VIEW-2/3`                           | `api-architecture.md` §4; `database-design.md` §6.2                                        |
| 41      | Import / export                         | `FR-IO-1..3`                            | `database-design.md` §13; roadmap Phase 2                                                  |
| 42      | API platform                            | `FR-API-1..3`                           | `api-architecture.md` §1–5, §11                                                            |
| 43      | Webhook system                          | `FR-API-4`                              | `api-architecture.md` §8; `database-design.md` §8                                          |
| 44      | Background jobs                         | `NFR-PERF-5`, Rule 13                   | `queue-event-architecture.md` §3–6                                                         |
| 45      | Database architecture & indexes         | `FR-TEN-4`                              | `database-design.md` (whole)                                                               |
| 46      | Security                                | `NFR-SEC-1..4`                          | `security.md` §1–11                                                                        |
| 47      | Privacy                                 | `FR-PRV-1..5`                           | `security.md` §12                                                                          |
| 48      | Analytics architecture                  | `FR-ANL-5/6`                            | ADR-0010; `database-design.md` §10                                                         |
| 49      | AI features                             | `FR-AI-1..4`                            | roadmap Phase 11; `integration-architecture.md` §2                                         |
| 50      | Automation builder                      | `FR-AUT-1/8`                            | `queue-event-architecture.md` §7; `frontend-architecture.md` §5.5                          |
| 51      | Business onboarding                     | `FR-ONB-1/3`                            | `frontend-architecture.md` §2; `database-design.md` §17                                    |
| 52      | Industry templates                      | `FR-ONB-2`                              | `database-design.md` §3, §17                                                               |
| 53      | Billing model (3 revenue streams)       | `FR-BIL-1/4/6`                          | `database-design.md` §12                                                                   |
| 54      | UI/UX requirements                      | `NFR-UX-2..6`                           | `frontend-architecture.md` §4                                                              |
| 55      | Lead detail UI                          | `FR-LEAD-1`, `FR-TL-2`                  | `frontend-architecture.md` §5.2                                                            |
| 56      | Performance & scale                     | `NFR-PERF-*`, `NFR-SCALE-*`             | `system-architecture.md` §10; `frontend-architecture.md` §7                                |
| 57      | Observability                           | `NFR-OBS-1/2`                           | `deployment-architecture.md` §7                                                            |
| 58      | Graceful integration failure            | `NFR-REL-3`                             | `integration-architecture.md` §7; `queue-event-architecture.md` §6                         |
| 59      | Data export / backup                    | `FR-IO-3`, `NFR-REL-5`                  | `deployment-architecture.md` §6                                                            |
| 60      | Product analytics per tenant            | `FR-SA-6`                               | `database-design.md` §10 (`daily_org_metrics`)                                             |
| 61      | Churn / customer health                 | `FR-SA-6`                               | `database-design.md` §12 (`tenant_health_scores`)                                          |
| 62      | Incremental build order                 | —                                       | `implementation-roadmap.md`                                                                |
| 63      | Development rules 1–20                  | —                                       | `docs/README.md` §Non-negotiables; enforced per `security.md` §13                          |
| 64      | Technology architecture                 | —                                       | `system-architecture.md` §3; ADR-0002/0003/0004                                            |
| 65      | Domain modules                          | —                                       | `system-architecture.md` §5                                                                |
| 66      | API design conventions                  | `FR-API-1`                              | `api-architecture.md` §2–3                                                                 |
| 67      | Testing requirements                    | `NFR-MNT-3`                             | `api-architecture.md` §12; `queue-event-architecture.md` §9; `frontend-architecture.md` §9 |
| 68      | Per-module documentation                | `NFR-MNT-*`                             | `system-architecture.md` §5 (module README contract); roadmap cross-cutting                |
| 69      | Claude Code workflow                    | —                                       | `implementation-roadmap.md` (phase gates)                                                  |
| 70      | Reporting format                        | —                                       | `implementation-roadmap.md` §Reporting format                                              |
| 71      | Product quality standard                | `NFR-UX-2`                              | PRD §2 (persona acceptance test); `frontend-architecture.md` §1                            |
| 72      | Suggested extra features                | PRD §6 gap analysis                     | PRD §6 (accepted items + phase); `open-questions.md` §E (declined/deferred)                |
| 73      | The five persona questions              | PRD §2                                  | `frontend-architecture.md` §2, §5.1, §5.4                                                  |
| 74      | Lead Operating System principle         | —                                       | `docs/README.md`; ADR-0009; `queue-event-architecture.md` §8                               |
