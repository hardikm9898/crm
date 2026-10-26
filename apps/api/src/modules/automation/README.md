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

## What is not here

No **dry run** and no **retry from the failed step**. `automation_run_steps.attempt` exists for the
second, and both are named in the roadmap rather than implied. `tasks.automation_run_id` is still
absent: a workflow-created follow-up is attributed through its step's `output.taskId`.
