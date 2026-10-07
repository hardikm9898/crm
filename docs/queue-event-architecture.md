# Queue, Event & Automation Architecture — Lead OS

**Broker:** Redis 7 + BullMQ · **Reliability:** transactional outbox + at-least-once delivery +
idempotent consumers · Traces to: `NFR-REL-2/3/4`, `FR-AUT-*`, `FR-ANL-5`, Rules 12/13/17/18

---

## 1. Why events

Lead capture must trigger assignment, scoring, a follow-up task, notifications, a WhatsApp template,
automation enrollment, outbound webhooks, analytics stitching and usage metering. Doing that inside
the HTTP request would make lead creation slow, fragile and coupled to Meta's uptime. So:

> **The HTTP request does the minimum durable write, then publishes facts. Everything else reacts.**

Consequences (all mandatory): handlers never call external APIs; a consumer failure never fails the
producer; new reactions are added as subscribers, not as edits to `createLead`; and every reaction is
independently retryable.

---

## 2. Transactional outbox

The classic failure mode — commit the row, crash before enqueuing, lose the lead's follow-up — is
unacceptable here (`NFR-REL-2`). So events are written **to the database, in the same transaction**
as the state change:

```ts
await prisma.$transaction(async (tx) => {
  const lead = await leadRepo.create(tx, input); // domain write
  await touchpointRepo.append(tx, lead.id, touchpointFromCapture(input));
  await activityRepo.record(tx, { leadId: lead.id, type: 'lead.created', sourceEventId: eventId });
  await outbox.emit(tx, [
    { name: 'lead.created', eventId, aggregate: { type: 'lead', id: lead.id }, payload },
  ]);
});
// commit boundary — nothing external has been called yet
```

A dispatcher worker polls `outbox_events WHERE published_at IS NULL ORDER BY occurred_at`
(`FOR UPDATE SKIP LOCKED`, batches of 100, ~200 ms cadence; `LISTEN/NOTIFY` wakes it immediately on
write) and enqueues each event to its subscribed queues, then marks it published. If it crashes
between enqueue and mark, the event is re-enqueued — **hence every consumer must be idempotent**.

Event envelope (`packages/domain-events`, versioned):

```ts
type DomainEvent<T> = {
  eventId: string; // UUIDv7 — the idempotency key for every consumer
  name: string; // 'lead.created'
  version: number; // payload schema version; consumers handle N and N-1
  occurredAt: string;
  organizationId: string | null; // null only for platform events
  actor: { type: 'user' | 'system' | 'automation' | 'api_key' | 'platform'; id?: string };
  aggregate: { type: string; id: string };
  correlationId: string; // request id or parent event id — full causal chain in logs
  causationId?: string;
  payload: T; // Zod-validated on publish AND on consume
};
```

Payload rules: include ids plus the small denormalized fields consumers need (so a notification does
not have to re-query), never whole entities, never secrets, never raw PII beyond what the consumer
needs. Breaking a payload = new `version`; consumers support the previous version for one release.

---

> **Implemented in Phase 1 step 4.** Two queues exist today — `notifications` and `maintenance` —
> plus the outbox dispatcher, the worker and scheduler roles, and the dead-letter mirror. The rest of
> the catalogue below is the design; each queue arrives with the phase that produces its work.
> Implementation notes that differ from this document:
>
> - **Job ids** are `"{jobName}-{eventId}"`, not `"{jobName}:{eventId}"`: BullMQ reserves `:` in key
>   names and rejects a custom id containing one. The helper `outboxJobId()` is the single source of
>   that format, so producer and tests cannot drift.
> - **Processors are passed to `WorkerService.start()`**, not injected. They live in the domain
>   modules that own them, which depend on the queue infrastructure; injecting them would invert that
>   and — because the queue module is global — a module-local default silently shadowed the root
>   override, yielding a worker that consumed nothing.
> - **A processor identifies its subject from the envelope's `aggregateId`**, not from a field inside
>   `payload`. The envelope is the stable contract; payload bodies evolve, and an event emitted by an
>   earlier release must still be processable.
> - **Single-use tokens are minted in the worker, at send time** (invitation, verification, reset), so
>   no usable credential is ever written to `outbox_events` or a queue payload.

## 3. Queue catalogue

Separate queues (not one firehose) so a WhatsApp backlog cannot delay analytics and a slow tenant
cannot starve others. Each is deployed as its own worker group and scaled independently.

| Queue             | Jobs                                                                                                                                                                               | Concurrency        | Attempts / backoff               | Notes                                                                                                                                                        |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ingestion`       | `capture.lead`, `capture.replay`, `import.row`                                                                                                                                     | 20                 | 5 / exp 2 s→5 m                  | Highest priority; per-org rate cap prevents one tenant's import blocking others                                                                              |
| `assignment`      | `lead.assign`, `lead.reassign-bulk`                                                                                                                                                | 10                 | 5 / exp                          | Round-robin cursor under a Redis lock (`lock:rr:{ruleId}`, 5 s TTL)                                                                                          |
| `scoring`         | `lead.score`, `score.decay-sweep`                                                                                                                                                  | 10                 | 3 / exp                          | Idempotent per `(leadId, eventId)`                                                                                                                           |
| `whatsapp-in`     | `wa.process-event`, `wa.download-media`                                                                                                                                            | 30                 | 5 / exp                          | Ordered per conversation via a FIFO group key                                                                                                                |
| `whatsapp-out`    | `wa.send-message`, `wa.send-template`, `wa.campaign-batch`                                                                                                                         | per-number limiter | 5 / exp + `Retry-After` honoured | Rate-limited per phone number to the provider tier; 429/5xx backoff; permanent 4xx (invalid number, policy) fails fast to the DLQ with a user-visible reason |
| `automation`      | `wf.trigger`, `wf.execute-step`, `wf.resume`, `wf.reconcile-waiting`                                                                                                               | 20                 | 5 / exp                          | Per-org concurrency cap; guardrail counters checked before each action                                                                                       |
| `notifications`   | `notify.in-app`, `notify.email`, `notify.whatsapp`, `notify.digest`                                                                                                                | 30                 | 5 / exp                          | Preference + quiet-hours + suppression checked **at send time**                                                                                              |
| `webhooks-out`    | `webhook.deliver`                                                                                                                                                                  | 50                 | 7 / 10 s→24 h jittered           | Per-endpoint circuit breaker; auto-disable after 15 consecutive failures                                                                                     |
| `analytics`       | `analytics.ingest-batch`, `analytics.session-close`, `analytics.identity-stitch`                                                                                                   | 30                 | 3 / exp                          | Dedupe on `(orgId, siteId, eventId)`                                                                                                                         |
| `rollups`         | `rollup.website-daily`, `rollup.funnel-daily`, `rollup.source-daily`, `rollup.campaign-daily`, `rollup.user-daily`, `rollup.org-daily`, `rollup.platform-daily`, `rollup.backfill` | 5                  | 3 / exp                          | Idempotent upserts; recompute a whole day rather than incrementing                                                                                           |
| `integrations`    | `ads.sync-campaigns`, `ads.sync-metrics`, `wa.sync-templates`, `gsc.sync`, `integration.health-check`                                                                              | 10                 | 5 / exp                          | Cursor-based; partial failure resumes, never restarts                                                                                                        |
| `imports-exports` | `import.process`, `export.generate`                                                                                                                                                | 5                  | 3                                | Per-row progress; result file in storage with an expiring **API-served** download (see the amendment below)                                                  |
| `documents`       | `doc.scan`, `doc.thumbnail`, `pdf.quotation`                                                                                                                                       | 10                 | 3                                | Upload quarantine until `scan_status = clean`                                                                                                                |
| `billing`         | `billing.charge`, `billing.dunning`, `usage.aggregate`, `trial.check`                                                                                                              | 5                  | 5 / long backoff                 | Money jobs: strict idempotency keys, never auto-retried past the provider's window                                                                           |
| `maintenance`     | `partition.maintain`, `retention.purge`, `sla.sweep`, `task.overdue-sweep`, `health.probe`, `outbox.reap`                                                                          | 5                  | 3                                | Platform-scoped; explicitly allowed to run without a tenant context                                                                                          |
| `ai`              | `ai.summarize-lead`, `ai.summarize-conversation`, `ai.suggest-reply`, `ai.next-best-action`                                                                                        | 5                  | 2                                | Budget-capped per org; failure degrades silently (feature disappears, core unaffected)                                                                       |
| `dlq:*`           | one per queue                                                                                                                                                                      | —                  | manual                           | Mirrored into `job_failures` for the Super Admin UI (`FR-SA-4`)                                                                                              |

**Job payloads carry `organizationId`, `correlationId` and `eventId`.** A processor's first act is to
restore the tenant context; a job without one throws before touching data (`FR-TEN-3`).

> **Amendment, 2026-10-05 (implementation).** `imports-exports` landed with two changes to the row
> above.
>
> **There is no signed URL.** The storage port deliberately exposes none: a download is served by
> the API after a permission check, so `export:pii` can be re-checked at download time and the
> access audited. A pre-signed URL would be a bearer of the whole list to anyone it reached, and
> could not be withdrawn when somebody's access was.
>
> **The tenant context is not restored from the payload alone.** Both processors rebuild the
> **requester's** principal through `PrincipalService` — permissions, data scope and all — because
> an import may only update leads its requester can see, an export must contain only what they may
> read, and the audit trail has to name a person. A system principal would quietly widen both. If
> that person's access was revoked between pressing the button and the worker picking the job up,
> the job fails saying so, which is the correct answer rather than acting on the authority of
> nobody. This is the one place a job's tenant context comes from the _database_ rather than from
> the envelope.

> **Amendment, 2026-10-06 (implementation).** Two changes from the quotations step.
>
> **`pdf.quotation` is not a queue job.** It is rendered synchronously in the request that needs it
> and cached per version as a `documents` row. One page of a dozen lines takes milliseconds, so
> queueing it would buy a polling UI, a job state machine and a download button that says "come
> back in a moment", in exchange for nothing — and because a sent quotation is immutable
> ([ADR-0019](./decisions/ADR-0019-quotation-versions-are-immutable.md)), its bytes are too, so the
> first request stores them and every later one serves that row. The `documents` queue row above
> keeps `doc.scan` and `doc.thumbnail`, which are genuinely slow and genuinely asynchronous; it is
> not declared in `QUEUES` until one of them exists.
>
> **`maintenance.quotation-expiry` is new**, daily at 00:49. `valid_until` is a date, so a quotation
> valid "until the 20th" is valid for all of the 20th and expiring it just after midnight on the
> 21st is exactly on time. The sweep reads across tenants under `withPlatformScope` and then writes
> **inside each row's own tenant context** as a system principal, because `TimelineService` takes
> the organization from the context by design — writing activity rows by hand under platform scope
> is how one lands in the wrong workspace. Its `UPDATE` re-checks `status = 'sent'`, so a quotation
> accepted between the read and the write is not quietly expired underneath the acceptance.

### Fairness

Per-org token buckets guard `ingestion`, `whatsapp-out`, `automation` and `rollups`. A job that
exceeds its org's slice is re-queued with a small delay rather than executed, so a 50 000-row import
in one tenant cannot delay another tenant's live leads (noisy-neighbour control, §11 of
`system-architecture.md`).

---

## 4. Idempotency patterns (Rule 12/13)

| Concern                          | Mechanism                                                                                                                                                      |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Provider webhook replay          | `provider_events UNIQUE (org, provider, external_event_id)` — insert first, process only if inserted                                                           |
| Duplicate WhatsApp message       | `messages UNIQUE (provider, provider_message_id)`                                                                                                              |
| Duplicate timeline entry         | `activities UNIQUE (org, source_event_id)`                                                                                                                     |
| Duplicate lead from client retry | `inbound_payloads UNIQUE (org, channel, idempotency_key)` + `idempotency_keys` response replay                                                                 |
| Re-run of a workflow step        | `automation_run_steps` unique on `(run_id, step_key, attempt)` + effect-level keys (e.g. the WhatsApp send uses `wf:{runId}:{stepKey}` as its idempotency key) |
| Rollup re-run                    | Upsert on `(org, …, date)`, whole-day recompute                                                                                                                |
| Outbound webhook retry           | Consumer dedupes on `X-LeadOS-Event-Id`; we retry safely because we say so in the docs                                                                         |
| Bulk actions                     | Per-item natural key; already-applied items are skipped, not failed                                                                                            |

Rule of thumb: **derive an idempotency key from the event, not from the attempt.** Two retries of the
same event produce one effect.

---

## 5. Scheduled work

Registered as BullMQ repeatable jobs by the `scheduler` process (a single logical owner via a Redis
lock, crash-safe and replaceable). Cron expressions are stored, not hardcoded, so the platform admin
can retune cadence.

| Schedule           | Job                                                                   | Purpose                                                                                                                                   |
| ------------------ | --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| every minute       | `task.reminder-dispatch`                                              | Due reminders → notifications                                                                                                             |
| every minute       | `wf.reconcile-waiting`                                                | Resume workflow runs whose `resume_at` passed (safety net for lost delayed jobs)                                                          |
| every 5 min        | `sla.sweep`                                                           | At-risk → warn, breached → escalate (`FR-TSK-8`). Built; breaches handled before warnings in a tick                                       |
| every 5 min        | `rollup.*-daily` (today's partial)                                    | Near-real-time dashboards                                                                                                                 |
| every 10 min       | `integration.health-check`                                            | Per-connection probes → `integration_health_checks`                                                                                       |
| every 15 min       | `analytics.session-close`                                             | Close sessions idle > 30 min                                                                                                              |
| hourly             | `ads.sync-metrics`                                                    | Spend/impressions/clicks                                                                                                                  |
| hourly             | `webhook.reap-exhausted`                                              | Disable dead endpoints, alert admins                                                                                                      |
| every 30 min       | `task.overdue-sweep`                                                  | Report a missed follow-up **once** and notify owner + manager. _Not_ org-hour aware and does not "mark overdue" — see the amendment below |
| daily 00:15 org-tz | `rollup.backfill` (yesterday, full recompute)                         | Late events corrected                                                                                                                     |
| daily 01:07        | `score.decay-sweep`                                                   | Inactivity decay (`FR-SCR-1`). Implemented at :07 — every schedule here runs on an odd minute so a restart does not fire them all at once |
| daily 02:00        | `retention.purge`                                                     | Retention + DSR purges (`FR-PRV-3`)                                                                                                       |
| daily 02:30        | `partition.maintain`                                                  | Pre-create/detach/drop partitions                                                                                                         |
| daily 03:00        | `lead.recycle-sweep`                                                  | Stale/unworked leads back to the pool (`FR-ASG-7`)                                                                                        |
| daily 07:00 org-tz | `notify.digest`                                                       | "Your day" digest for opted-in users                                                                                                      |
| daily 08:00        | `trial.check`                                                         | Expiring/expired trials → notify + transition (`FR-BIL-3`)                                                                                |
| daily 09:00        | `billing.dunning`                                                     | Failed-payment retries                                                                                                                    |
| daily 04:00        | `tenant.health-score`                                                 | Churn signals (`FR-SA-6`)                                                                                                                 |
| weekly             | `usage.reconcile`, `search.vector-rebuild`, `db.vacuum-analyze-hints` | Hygiene                                                                                                                                   |

All schedules are working-hours/timezone aware where they touch humans — a follow-up reminder at
3 a.m. is a defect, not a feature.

> **Amendment, 2026-10-06 (implementation, Phase 3 step 1).** `task.reminder-dispatch` and
> `task.overdue-sweep` are built, both on the `maintenance` queue. Three things this section said
> that are not what shipped; the reasoning is
> [ADR-0022](./decisions/ADR-0022-overdue-is-derived-and-a-reschedule-moves-the-row.md).
>
> - **The overdue sweep does not "mark overdue".** Overdue is derived from the clock, because a
>   stored flag is wrong between ticks. The sweep writes `tasks.overdue_notified_at`, a
>   `task.overdue` timeline entry and a `task.overdue` event — once per missed follow-up, which is
>   what `overdue_notified_at` is for, and again after a reschedule, which clears it.
> - **Neither sweep is working-hours aware yet**, and the sentence above is therefore not true of
>   them. A reminder fires at the offset somebody chose, including at 3 a.m. if they chose it; a
>   missed follow-up is reported at the next half-hourly tick whatever the hour. Making these
>   quiet-hours aware needs `notification_preferences` to carry quiet hours and the dispatcher to
>   respect them — which is the notification-centre step later in Phase 3, and is listed as an open
>   item in the roadmap rather than quietly assumed.
> - **The reminder is dispatched by the sweep itself**, not handed to a second queue hop. The
>   in-app notification _is_ the delivery; a per-channel job arrives with the channel (email,
>   WhatsApp). The sweep creates the notification **before** marking the row sent, so a crash
>   retries into an idempotent `create` rather than losing the reminder.
>
> **`sla.sweep` is built** and lives on `maintenance` with the other platform-wide sweeps. Breaches
> are escalated before warnings inside one tick, because warning about something that has already
> happened is noise; and escalating once is `UNIQUE (organization_id, clock_id, level)` on
> `escalations` rather than a careful `if` — the sweep inserts and reads the collision, which is the
> only form that survives two sweeps running at once. Its notifications go out through
> `sla.at_risk` / `sla.breached` and one `notify.sla-escalation` processor dispatching on the
> envelope's event name, with the recipients **stored on the escalation row** by the sweep so the
> row and the notifications cannot disagree when somebody's role changes in between.
>
> `task.overdue` is the only one of the five task events with a consumer today
> (`notify.task-overdue` → the assignee and whoever holds `task:manage_others`). `task.created`,
> `task.completed`, `task.rescheduled` and `task.cancelled` are recorded and listed with no
> subscribers, so a typo in an event name shows up as "unsubscribed" rather than as silence.

---

## 6. Retry, failure and DLQ

Policy: exponential backoff with full jitter, per-queue attempt caps (§3). Errors are classified:

| Class         | Examples                                                                               | Behaviour                                                                   |
| ------------- | -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| **Transient** | timeouts, 429, 5xx, deadlock, connection reset                                         | Retry with backoff                                                          |
| **Permanent** | 400 invalid payload, unknown template, revoked token, invalid number, policy violation | Fail immediately to the DLQ with a human-readable reason surfaced in the UI |
| **Poison**    | payload that crashes the processor                                                     | Quarantine after 2 attempts; alert; never block the queue                   |

On exhaustion: the job moves to `dlq:<queue>` **and** a row is written to `job_failures` (queue, name,
redacted payload, error, attempts). The Super Admin console lists, inspects and retries these
(`FR-SA-4`); tenant-visible failures also produce a tenant notification with a specific message
("WhatsApp message to +91… failed: template not approved") — `FR-NOT-2`, `NFR-REL-3`, never silent.

Alerting thresholds: DLQ depth > 0 for 15 min (warn) / > 50 (page); queue depth > 10 000 or oldest
job age > 5 min (warn); outbox lag > 30 s (page — this means events are not flowing).

---

## 7. Automation engine runtime

The engine is a **durable, step-wise interpreter over a stored workflow graph**. It is not a
scripting host: steps are registry types with JSON-Schema-validated config, which is what makes
`FR-AUT-8` (add a trigger/action without touching the engine) true.

### Registry

```ts
interface ActionHandler<C, O> {
  type: string; // 'action.send_whatsapp_template'
  configSchema: ZodType<C>; // drives backend validation AND the UI form
  requiredEntitlement?: string; // e.g. 'whatsapp'
  requiredPermission?: string;
  execute(ctx: StepContext, config: C): Promise<StepResult<O>>; // MUST be idempotent on ctx.idempotencyKey
  describe(config: C): string; // human summary for logs and the UI
}
```

Symmetric interfaces exist for `TriggerDefinition` (event name + filter schema + sample payload) and
`ConditionEvaluator` (reuses the §4 filter DSL of `api-architecture.md`, so a saved view, a segment
and an automation condition are the same expression language).

### Execution

```
domain event → outbox → queue:automation → wf.trigger
  1 look up active workflow_triggers for (organizationId, eventName)      ← single indexed query
  2 evaluate trigger filters against the payload (cheap, in-process)
  3 check guardrails: workflow active? kill switch? entitlement? re-entry policy?
    per-entity run cap? per-org daily action cap? loop depth (automation-caused events carry depth)?
  4 create automation_enrollments + automation_runs (status=running)      [TX]
  5 enqueue wf.execute-step (runId, stepKey = first step)

wf.execute-step
  load run + version (immutable snapshot → editing the workflow cannot corrupt this run, FR-AUT-5)
  resolve step handler from the registry
  write automation_run_steps (status=pending, idempotency_key = wf:{runId}:{stepKey}:{attempt})
  execute:
    condition → evaluate → choose branch
    action    → handler.execute(ctx) — external effects use the step idempotency key
    delay     → status=waiting, resume_at = computed (working-hours aware); enqueue delayed job
    exit      → status=completed
  record input/output/decision/error, then enqueue the next step
```

Context available to every step: the entity snapshot (lead/customer/deal, custom fields included),
the trigger payload, previous step outputs, org settings/timezone, and a template resolver for
variable interpolation (`{{lead.full_name}}`, `{{cf.budget}}`, `{{user.first_name}}`) with strict
escaping and a hard failure on unknown paths (a WhatsApp template rendered with `undefined` is worse
than no message).

### Guardrails (`FR-AUT-6`) — non-negotiable

Max runs per entity per workflow per window; global per-org action cap per day (e.g. WhatsApp sends);
loop detection via a `causationDepth` on automation-emitted events (default max 5, then hard stop +
alert); per-org automation concurrency; per-workflow kill switch and a platform-wide emergency stop;
a dry-run mode (`POST /workflows/{id}/test-run`) that logs every decision and executes nothing. A
single bad workflow must never be able to message a tenant's entire customer base or get their WABA
banned — this is the highest-consequence subsystem in the product.

### Observability

Every run is inspectable per lead (`GET /leads/{id}/automation-runs`) and per workflow, with each
step's input, output, decision and error; `automation.action_executed` / `skipped` / `failed` are also
written to the lead timeline with the _reason_ (`FR-TL-1`, `FR-AUT-7`), so "why did this customer get
this message?" and "why didn't they?" are both answerable without a developer. Failed runs are
retryable from the failed step, not from the beginning (side effects already applied are not
repeated, thanks to step idempotency keys).

---

## 8. Event subscription map (extract)

| Event                                      | Subscribers                                                                                                                                                                               |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lead.created`                             | assignment · scoring · first-follow-up creation · SLA clock start · notifications · automation trigger · outbound webhook · analytics identity stitch · usage meter · timeline            |
| `lead.assigned`                            | notify assignee (+ previous owner) · SLA reassessment · automation · webhook · timeline · daily user rollup                                                                               |
| `lead.stage_changed`                       | stage-entry automation hooks · deal sync · rollups · webhook · timeline                                                                                                                   |
| `lead.converted`                           | customer creation/link · revenue attribution recompute · campaign metrics · webhook · timeline                                                                                            |
| `message.received`                         | conversation upkeep (unread, window, reopen) · first-response SLA satisfy · scoring (+engagement) · automation (`WhatsApp reply` trigger) · agent notification · realtime push · timeline |
| `message.sent` / `failed`                  | status tracking · WhatsApp usage meter · failure notification + integration health · timeline                                                                                             |
| `task.completed`                           | next-follow-up prompt data · user metrics · automation · timeline                                                                                                                         |
| `task.overdue`                             | assignee + manager notification · escalation · user metrics · timeline                                                                                                                    |
| `sla.breached`                             | escalation chain · manager dashboard · timeline                                                                                                                                           |
| `analytics.checkout_started`               | scoring (+30) · abandoned-checkout automation · funnel rollup · timeline                                                                                                                  |
| `payment.completed`                        | deal/revenue update · attribution recompute · stop marketing automations for that entity · receipt notification · webhook · timeline                                                      |
| `consent.revoked`                          | suppression list insert · cancel pending marketing sends · exit marketing workflows · timeline                                                                                            |
| `trial.expiring` / `subscription.past_due` | tenant + platform notifications · entitlement recompute · admin alert                                                                                                                     |
| `integration.failed`                       | tenant admin notification · integration health · platform alert                                                                                                                           |

Note how many rows end in "timeline": that is the product principle made operational. A new feature
that does not appear on the lead timeline has not been finished.

---

## 9. Testing the async layer (`NFR-MNT-3`)

Real Redis + real Postgres in CI (testcontainers), no mocked broker. Required tests: outbox publishes
exactly once under a simulated crash between commit and dispatch; a duplicate WhatsApp webhook
delivery produces one message, one activity and one automation run; a job retried 3× produces one
effect; a workflow edited mid-run continues on its original version; delay steps resume after the
reconciliation sweep when the delayed job is deliberately dropped; guardrail caps and loop detection
actually stop execution; per-org fairness (a 50 k import in Org A does not delay Org B's capture by
more than the agreed budget); DLQ routing and manual retry work end to end.
