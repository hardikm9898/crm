# Deployment & Operations Architecture — Lead OS

Traces to: `NFR-SCALE-2`, `NFR-REL-5`, `NFR-OBS-*`, `FR-SA-4`

---

## 1. Environments

| Env          | Purpose                        | Data                                                         | Providers                                      |
| ------------ | ------------------------------ | ------------------------------------------------------------ | ---------------------------------------------- |
| `local`      | Development                    | Seeded fixtures                                              | Meta sandbox / mocked adapters; MinIO; Mailhog |
| `ci`         | Automated tests                | Created and destroyed per run (testcontainers)               | All adapters faked with recorded fixtures      |
| `staging`    | Production-shaped verification | Anonymized/synthetic tenants only — **never** production PII | Meta test WABA, sandbox payments               |
| `production` | Live                           | Real                                                         | Live                                           |

Config comes only from the environment, validated at boot by a Zod schema — the process refuses to
start with a missing or malformed variable. No environment-specific `if` statements in application
code; behaviour differences are configuration (`NFR-SEC`, Rule 9).

---

## 2. Local development

```yaml
# infra/docker/compose.yml (dev)
services:
  postgres:
    { image: postgres:16-alpine, ports: ['5432:5432'], volumes: [pgdata:/var/lib/postgresql/data] }
  redis: { image: redis:7-alpine, ports: ['6379:6379'] }
  minio:
    {
      image: minio/minio,
      ports: ['9000:9000', '9001:9001'],
      command: server /data --console-address ":9001",
    }
  mailhog: { image: mailhog/mailhog, ports: ['8025:8025'] }
  # api, worker, web run on the host via `pnpm dev` (fast HMR); `--profile full` runs them containerized
```

```bash
pnpm install
cp .env.example .env
pnpm db:up && pnpm db:migrate && pnpm db:seed   # seeds 2 orgs, roles, industry templates, demo leads
pnpm dev                                        # turbo: api :4000, web :3000, worker, scheduler
```

The seed intentionally creates **two** organizations with overlapping phone numbers, so cross-tenant
bugs and duplicate-detection behaviour are visible in ordinary development, not only in CI.

A `SessionStart`-style bootstrap script (`scripts/dev-bootstrap.sh`) brings services up, applies
migrations and seeds, so a fresh clone (or a fresh cloud session) can run tests without manual steps.

---

## 3. Images

One multi-stage `Dockerfile` per app (`api`, `web`, `worker` reuses the api image with a different
command), pnpm fetch → build → prune to production deps → distroless/alpine runtime as a non-root
user, `dumb-init` for signals, healthcheck on `/health/live`. Node `--max-old-space-size` tuned per
process class. Images are tagged with the git SHA (immutable) plus a moving channel tag, and scanned
by Trivy in CI; a high severity blocks promotion.

Process roles from a single api image via env: `ROLE=api` (HTTP + sockets), `ROLE=collector`
(webhooks + beacons only, other routes disabled at the router level), `ROLE=worker QUEUES=…`,
`ROLE=scheduler`.

---

## 4. Production topology

```
Cloudflare/CDN ─▶ Nginx / ALB ─┬─▶ web  (2+ replicas)
                               ├─▶ api  (3+ replicas, autoscaled on p95 + CPU)
                               └─▶ collector (2+ replicas, its own target group — lowest-latency tier)

workers: ingestion(2) · whatsapp(2) · automation(2) · analytics(2) · rollups(1) · misc(1) · scheduler(1)
data:    Postgres 16 primary + standby (managed, PITR) [+ read replica from stage B]
         Redis 7 (managed, AOF + replica)  ·  S3-compatible object storage  ·  CDN for sites/tracker
```

Start on a managed container platform (ECS Fargate / Render / Fly) with managed Postgres and Redis;
the manifests are written so a move to Kubernetes is a packaging change, not an architecture change.
Everything is stateless: no local disk state, no in-process cron (the `scheduler` role owns schedules
via a Redis lock), no sticky sessions (Socket.IO uses the Redis adapter) — `NFR-SCALE-2`.

Nginx/edge responsibilities: TLS termination, HTTP/2, brotli, per-IP connection and rate caps, body
size limits (256 KB default; separate larger limit for upload routes), request id injection, real IP
forwarding, and long-lived upgrade support for websockets.

Separate `collector` scaling matters: a Meta webhook storm or a traffic spike on a tenant's site must
not degrade the dashboard, and vice versa — the ingestion tier is the one that must never drop
(`NFR-REL-1/2`).

---

## 5. CI/CD (GitHub Actions)

```
PR:  install (pnpm cache) → lint → typecheck → unit
     → integration (postgres+redis services, migrations from scratch)
     → tenancy suite + permission suite        ← blocking, non-negotiable
     → build (api, web, worker) → e2e (Playwright, seeded stack) → a11y
     → openapi diff → gitleaks → semgrep/codeql → pnpm audit → image scan
     → bundle/Lighthouse budgets on /today /leads /inbox
main:  all of the above → build & push images (sha tag) → migrate staging → deploy staging
     → smoke tests → (manual approval) → migrate production → rolling deploy → smoke → notify
```

Rules: migrations run as a **separate job before** the app rollout and must be
backward-compatible with the currently deployed version (expand → backfill → contract across
releases), so a rollback never needs a down-migration. Deploys are rolling with health gates and
automatic abort on failing readiness. Feature flags decouple release from launch. Every deploy is
tagged and the SHA is exposed at `/health` for support. A single Actions workflow owns the whole
path — no manual `docker push` from a laptop.

---

## 6. Database operations

| Concern               | Practice                                                                                                                                                                                             |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Migrations            | Prisma Migrate, forward-only, reviewed SQL; no destructive step without a written rollback note; `CREATE INDEX CONCURRENTLY` for hot tables; long backfills run as jobs, not migrations              |
| Zero-downtime pattern | Add nullable column → deploy writer → backfill job → add constraint → remove old reads → drop old column in a later release                                                                          |
| Connections           | PgBouncer (transaction mode) from stage B; Prisma pool sized per process class; workers get a smaller pool than the API                                                                              |
| Partitions            | `partition.maintain` pre-creates the next 3 periods, detaches and drops expired ones, `ANALYZE`s after attach; alerts if the next partition is missing (a missing future partition = failed inserts) |
| Slow queries          | `pg_stat_statements` + `auto_explain` above 500 ms; a weekly review of the top 20; `EXPLAIN` required in review for any new query on `leads`, `messages`, `activities` or `website_events`           |
| Read replica          | From stage B, used for reports, exports and platform analytics only; replica lag is monitored and read-after-write paths always use the primary                                                      |
| Backups               | Managed automated backups + PITR (7 d minimum, 30 d target), encrypted, cross-region copy; **plus** a monthly logical dump of platform-critical tables                                               |
| Restore               | Documented runbook, rehearsed **quarterly**, with recovery time recorded. An untested backup is not a backup (`NFR-REL-5`)                                                                           |
| RPO/RTO               | RPO ≤ 5 min (PITR), RTO ≤ 2 h for full region restore; ingestion degradation buffer keeps capture alive during a failover window                                                                     |

---

## 7. Observability

| Signal            | Implementation                                                                                                                                                                                                                                         |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Logs              | pino → JSON on stdout → log platform. Every line carries `requestId`, `organizationId`, `userId`, `route`, `durationMs`, `jobId`/`eventId` where relevant. Redaction list enforced (`security.md` §9). Sampled debug logs per-connection behind a flag |
| Traces            | OpenTelemetry auto-instrumentation (HTTP, Prisma, Redis, BullMQ, outbound HTTP) with the request id as the trace correlator; a capture→assignment→WhatsApp-send chain is one trace across processes                                                    |
| Metrics           | Prometheus: RED per route, DB pool saturation, cache hit rate, queue depth/age/failure per queue, outbox lag, provider latency/error rate per provider, WhatsApp send outcomes, ingestion success rate, rollup freshness, active tenants/users         |
| Errors            | Sentry with release + org/user context (ids only, no PII), alert rules on new-issue and spike                                                                                                                                                          |
| Uptime            | External probes on `/health/ready`, the public ingestion endpoint and a published tenant site                                                                                                                                                          |
| Health endpoints  | `/health/live` (process), `/health/ready` (DB + Redis + storage reachable), `/health/deep` (admin-only: partitions present, scheduler heartbeat, outbox lag, DLQ depth, integration health summary)                                                    |
| Product analytics | `daily_org_metrics` + feature-usage events feed the Super Admin tenant-health view (`FR-SA-6`)                                                                                                                                                         |

### Alert catalogue (initial)

| Severity | Condition                                                                                                                                                                                                                                                                                         |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Page** | API 5xx rate > 2% for 5 min · `/health/ready` failing on >1 replica · ingestion success < 99% for 10 min · outbox lag > 60 s · Postgres replica lag > 60 s or connections > 85% · Redis unavailable · next partition missing · scheduler heartbeat stale > 5 min                                  |
| **Warn** | Queue depth > 10 000 or oldest job age > 5 min · DLQ depth > 0 for 15 min · provider error rate > 10% for one provider · integration connections in `error` spiking across tenants (provider outage) · p95 latency > 1 s · disk/storage > 80% · failed payments spike · rollup freshness > 30 min |
| **Info** | Trial expiring cohort · usage threshold crossings per tenant · new org signup · export volume anomaly                                                                                                                                                                                             |

Every alert links to a runbook section. An alert without a runbook is deleted or given one — noisy
unactionable alerts are how real incidents get missed.

---

## 8. Runbooks (in `infra/runbooks/`)

`ingestion-backlog.md` · `whatsapp-integration-down.md` · `webhook-endpoint-flapping.md` ·
`queue-stuck-or-dlq-growing.md` · `automation-runaway.md` (how to hit the kill switch and stop sends) ·
`db-failover-and-restore.md` · `partition-missing.md` · `tenant-data-isolation-incident.md` (S1
procedure) · `credential-rotation.md` · `tenant-suspension-and-restore.md` ·
`impersonation-audit-review.md` · `scale-up-playbook.md` · `rollback-release.md`.

Each runbook: symptom → dashboards to open → first three commands → containment → recovery →
verification → post-incident notes. Written when the subsystem ships, not after the first outage.

---

## 9. Cost & capacity notes

Dominant cost drivers, in order: WhatsApp conversation charges (passed through / metered per tenant),
object storage for media, analytics event volume, and Postgres IOPS. Controls: per-plan retention on
`website_events` and media; S3 lifecycle to infrequent-access after 30 days; rollups keep dashboards
cheap so read load does not scale with event volume; per-tenant usage metering makes WhatsApp and
API cost attributable rather than absorbed (`FR-BIL-4`); alerting on the top 10 tenants by cost so
pricing can be corrected before it hurts.

---

## 10. Definition of production-ready (Phase 12 gate)

Security review complete and the Phase 12 security gate green · cross-tenant isolation suite green ·
load test at 3× expected peak with p95 within budget · queue soak test (1 M jobs) with zero loss ·
webhook retry/DLQ verified end to end · backup restore drill completed and timed · rollback rehearsed ·
all alerts wired to an on-call rotation with runbooks · mobile and cross-browser matrix passed ·
accessibility audit passed · legal pages and sub-processor list published · support and impersonation
flows audited · `.env.example` complete · every module's README present and accurate.
