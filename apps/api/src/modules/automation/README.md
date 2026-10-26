# modules/automation

The automation registry, the workflows, and the engine that runs them (`FR-AUT-1`…`FR-AUT-8`).
Step 1 built everything up to publish; step 2 built the executor, the enrollments, the run log and
the guardrails. What is **not** here is named at the bottom.

All of it behind `automation:manage`, which has been in the catalogue since Phase 1 and was already
granted in every workspace the owner and admin templates created (328 grants before this step), so
there is **no backfill migration** here — a grant migration that inserts nothing and claims
otherwise is worse than none.

| Method   | Path                                                 |
| -------- | ---------------------------------------------------- |
| `GET`    | `/automation/catalogue` — the whole registry          |
| `GET`    | `/automation/workflows` · `/automation/workflows/:id` |
| `POST`   | `/automation/workflows` · `:id/publish`               |
| `PUT`    | `/automation/workflows/:id/definition`                |
| `PATCH`  | `/automation/workflows/:id`                           |
| `DELETE` | `/automation/workflows/:id`                           |
| `GET`    | `:id/versions` · `:id/versions/:versionId`            |
| `POST`   | `/automation/workflows/:id/start` — the `manual` trigger's door (202) |
| `GET`    | `/automation/runs?leadId=&workflowId=&status=` · `/automation/runs/:id` |

## The tables

| Table               | What it holds                                                                     |
| ------------------- | --------------------------------------------------------------------------------- |
| `workflows`         | Name, status, the live version, the kill switch and the re-entry guardrails        |
| `workflow_versions` | `definition JSONB` — the whole graph — plus who published it and when              |
| `workflow_triggers` | The dispatch index: one row per published workflow, keyed `(organization_id, event)` |
| `automation_enrollments` | One row per (workflow, lead, cycle). The unique on it **is** the re-entry policy |
| `automation_runs` | Where a run got to, which version it is pinned to, and when it should wake |
| `automation_run_steps` | One attempt at one step: input, output, decision, reason, error. Partitioned monthly |
| `automation_guardrail_counters` | The atomic daily action cap, per workspace day |

`workflow_steps` is **not** built, and `database-design.md` §9 was corrected rather than followed:
it described the graph twice, which is the defect `notification_preferences` already paid for.
ADR-0041 has both halves of that reasoning.

## The decisions

- **The registry is served, not compiled.** `packages/shared/src/automation.ts` declares each
  trigger, condition field and action with a list of parameter fields; `GET /automation/catalogue`
  hands that to the editor, and `validateWorkflowDefinition` checks a saved graph against the same
  declarations. That is what makes "adding an action requires no engine change and no frontend
  release" checkable — the alternative, a Zod schema per action, is unreadable by a browser and so
  forces a hand-written form, and therefore a release, per action.
- **Four actions carry `control: true`.** `wait`, `branch`, `stop` and `enroll` change the shape of
  a run, so they are the engine's own vocabulary rather than plug-in handlers. Saying so in the
  registry is what keeps the claim above about the *other* kind.
- **A draft may be incomplete.** `PUT :id/definition` records whatever parses as an object and
  answers the problem list beside it; `POST :id/publish` is where that list becomes a 400 with the
  problems as field errors. An editor that refuses to save a half-built workflow is one somebody
  loses an afternoon in.
- **A published version is never written again.** A save updates the single unpublished version in
  place; a save *after* a publish mints the next one. A run pins `version_id`, which is the whole of
  "editing a live workflow does not alter in-flight runs".
- **Publishing rewrites the dispatch index in the same transaction.** A trigger row left over from
  the previous version would send the next event to a version nobody published. Archiving and
  deleting empty it, because the row's presence is what an event looks at.
- **The index carries no status.** `status` and `kill_switch` live on `workflows` and dispatch joins
  them, so "is this workflow live" has exactly one answer.
- **References are checked against the workspace.** The registry knows a parameter points at a
  status; only the workspace knows whether *that* status still exists — and whether a WhatsApp
  template is **approved**, which existence does not answer and a three-in-the-morning send does.
- **A workflow cannot start itself.** Loop detection proper is step 2's, but `enroll` pointing at
  its own workflow is representable and obviously wrong, so it is a problem the editor shows.
- **Configuration is audited; runs are on the timeline.** `workflow.created`,
  `workflow.published`, `workflow.stopped` and `workflow.deleted` go to the audit log (a draft save
  deliberately does not — an audit log full of keystrokes is one nobody can read). Everything a
  *run* decides goes to the lead's timeline: `automation.enrolled`, `action_executed`, `skipped`,
  `failed`, `exited`, each with the engine's own sentence.

## The engine (step 2)

- **A run is a chain of short jobs, one step each.** A wait is a delayed job plus
  `automation_runs.resume_at`, not a worker standing still for two days; a worker restart loses a
  job and not a run; a failure is recorded against the step that failed. The delayed job is the
  fast path and `resume_at` is the promise — `maintenance.automation-resume` sweeps it every
  minute, which is the exit criterion ("a deliberately dropped delayed job is recovered by the
  reconciliation sweep") stated as a mechanism.
- **The engine's authority is the workspace's, enumerated** in `automation-authority.ts`. A
  workflow has no `actorId`, and the data scope defaults to `own` — so the first draft's every
  action answered "Lead not found". Permissions are held at **organization** scope because a
  workflow is the workspace's standing instruction, and listed one by one rather than granted
  wholesale: adding an action that needs something new is a line there, which is a moment where a
  person decides.
- **Loop detection rides on the principal.** Every event a step causes carries
  `causation_depth + 1`, defaulted by `OutboxService.emit` from `principal.automation` — so
  `LeadsService` emits a correctly attributed event without knowing automation exists, and the
  dispatcher refuses at `MAX_CAUSATION_DEPTH`. Nothing to forget at a call site.
- **Every action goes through the service that owns the write.** A handler writing
  `leads.status_id` itself would skip the history row, the SLA reassessment, the outbox event and
  the timeline entry.
- **A skip is an outcome, not a failure.** A handler that throws is retried by the queue; one that
  answers `skipped` carries a reason, the run continues, and the sentence reaches the timeline —
  which is the whole of "including *skipped because*".
- **The cap is a counter and the record is the steps.** `INSERT … ON CONFLICT DO UPDATE …
  RETURNING count` is the only shape that enforces a cap atomically before the action. It may
  over-count an action that then failed, which is the safe direction for a safety limit; an absent
  setting is a default and never "unlimited".

## The preview and the retry (step 3)

- **A preview is a run, not a second implementation.** `POST /automation/workflows/:id/test-run`
  creates an `automation_runs` row with `dry_run = true` and drives it **inline** through
  `AutomationExecutorService.advance` until it stops. Everything above the handler call is the same
  code — the entry conditions, the branch arms, the wait arithmetic, the step log, the ordering —
  and there is exactly **one** `if (run.dryRun)` on the path to a handler. Three more sit where a
  *control shape* would otherwise reach outside: the wait continues instead of suspending (a
  preview that slept for two days answers nothing anybody asked), `enroll` records what it would
  hand over, and no timeline row is written.
- **It is enrolled in nothing, and that is a CHECK.** `automation_runs_real_run_is_enrolled` pairs
  `dry_run` with `enrollment_id` in both directions. A preview that took an enrolment would spend
  the lead's one allowed cycle under the `once` policy, so the real run afterwards would be refused
  by the thing the preview was checking.
- **It is not the live run.** The `automation_runs_live` predicate excludes it. The endpoint cannot
  leave a preview running, but an interrupted request can, and that row would otherwise block the
  real event for ever.
- **It previews the draft** — the unsaved version when there is one, the published one otherwise.
  A preview that only worked on a published workflow would check something already live.
- **200 and inline**, where `POST :id/start` is 202 and queued: a preview calls no provider.
- **The retry reopens the run it failed in.** `current_step_id` points at the last step that
  *succeeded* — `finish` leaves it alone — so `nextStep` returns the failed one and nothing before
  it runs again. The new attempt writes a **new** step row rather than overwriting the failure, and
  `attempt` is what makes the handler's idempotency key different this time. The kill switch and
  the status are re-asked; the re-entry policy is not, because the lead is already enrolled. A
  preview cannot be retried — it is tested again.
- **A starter workflow is a draft.** `applyIndustryTemplate` writes the industry's workflows with
  their `{ $taskType }` / `{ $status }` placeholders resolved against the rows the same transaction
  created, and publishes none of them: a template is a guess about a business, and a workflow
  messaging somebody's customers before they had read it is not a feature.

## What is not here

`tasks.automation_run_id` is still absent: a workflow-created follow-up is attributed through its
step's `output.taskId`. Per-org **concurrency** is the queue's (`concurrency: 5`) rather than a
per-workspace limiter, and a platform-wide emergency stop is Phase 10's. A preview runs against
**one** lead: there is no "what would this do to my whole database" report, which would be a
different feature with a different cost.
