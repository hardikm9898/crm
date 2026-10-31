# ADR-0042 — The engine is a chain of short jobs, its authority is the workspace's, and loop detection rides on the principal

- **Status:** accepted
- **Date:** 2026-10-26
- **Context:** Phase 6 step 2 — the durable step executor, the guardrails and the run log (`FR-AUT-6`, `FR-AUT-7`)
- **Builds on:** [ADR-0041](./ADR-0041-a-workflow-is-its-definition-and-the-dispatch-index-is-the-only-projection.md)

## Context

Step 1 built the registry, the workflow, the version a run pins to and the dispatch index. Nothing
ran. This step is the engine, and `queue-event-architecture.md` §7 is blunt about the stakes: "a
single bad workflow must never be able to message a tenant's entire customer base or get their WABA
banned — this is the highest-consequence subsystem in the product."

Four questions had to be answered before any of it could be written, and each had a tempting wrong
answer.

## Decision

**1. A run is a chain of short jobs, one step each.** Not one job that walks the graph. Three things
follow, and all three are the reason:

- A **wait** is a delayed job plus `automation_runs.resume_at`, not a worker sitting still for two
  days.
- A **worker restart** loses a job and not a run: the row says where it got to.
- A **failure** is recorded against the step that failed, which is what makes "retry from the failed
  step" expressible later rather than a rewrite.

The delayed job is only the fast path. `resume_at` is the promise, and the
`maintenance.automation-resume` sweep reads it every minute — which is Phase 6's third exit
criterion stated as a mechanism: "a deliberately dropped delayed job is recovered by the
reconciliation sweep". The e2e drops one on purpose and asserts the sweep finishes the run.

**2. The engine's authority is the workspace's, enumerated.** A workflow has no `actorId` — it is
not a person — and `DataScopeService` defaults an absent scope to `own`, which compares a row
against `principal.actorId`. So the first draft's every action answered **"Lead not found"**: the
data scope working exactly as designed against a principal who is nobody. The fix is not to widen
the scope quietly but to say what a workflow is: `automationPrincipal` holds its permissions at
**organization** scope, because a workflow is the workspace's standing instruction, and the
permissions themselves are **enumerated** in `ENGINE_PERMISSIONS` rather than granted wholesale.
Deliberately absent: `automation:manage` (a workflow cannot edit workflows), every `*:delete`,
billing and settings. Adding an action that needs something new is a line in that file, which is a
moment where a person decides what a workflow may do.

**3. Loop detection rides on the principal, not on the call sites.** Every event an automation step
causes must carry `causation_depth + 1`, and a step's effects go through the ordinary services — a
`change_status` action calls `LeadsService`, which emits `lead.status_changed` through its own
`OutboxService.emit`. Threading a depth through every service would be a parameter on every method
and one call site away from a workflow that triggers itself for ever. Instead the depth lives on
`TenantPrincipal.automation`, and `emit` defaults from it: a service that has never heard of
automation produces a correctly attributed event, and the dispatcher refuses at
`MAX_CAUSATION_DEPTH`. It is the same argument `actorType` already made for living there, and the
e2e asserts the emitted event's depth and actor rather than the engine's own bookkeeping.

**4. Every action goes through the service that owns the write.** A `change_status` handler writing
`leads.status_id` itself would skip the history row, the SLA reassessment, the outbox event and the
timeline entry — four things, silently. The cost is that an action inherits its service's refusals,
which is the point: a workflow cannot send a template WhatsApp has not approved, because the send
path will not let it.

**5. `lead_id` with a composite FK, not `entity_type` + `entity_id`.** §9 modelled the engine's
tables the second way. Every trigger's subject is a lead today (`WORKFLOW_TRIGGERS[].subject`, which
the boot check enforces), an `entity_id` with no foreign key is a dangling reference nothing
catches, and `tasks` already shows the shape a second subject takes: a nullable column per kind with
a CHECK that exactly one is set. §9 was corrected rather than followed, for the second step running.

**6. A skip is an outcome, not a failure.** A handler that throws is retried by the queue; one that
answers `skipped` with a reason is a decision — "nobody owns this lead, so there was nobody to
tell", "they asked not to be messaged", "the lead is already at that status". The run continues, and
the reason reaches the lead's timeline as `automation.skipped`. That sentence **is** `FR-AUT-7`'s
"including _skipped because_", and it is why `automation_run_steps_skipped_says_why` makes a
reasonless skip unrepresentable.

**7. The cap is a counter; the record is the steps.** The usage meter's rule — count rows, never
keep a running total — still holds for _reporting_, and `automation_run_steps` is the record. The
guardrail counter exists because a cap has to be enforced **atomically before** the action, in one
statement, which `INSERT … ON CONFLICT DO UPDATE … RETURNING count` is and a read-then-write is
not. It may over-count an action that then failed, which is the safe direction for a safety limit.
The window is the workspace's own day, because a cap a business reads as "per day" has to start when
their day does. An absent setting is **not** unlimited: `DEFAULT_DAILY_ACTION_CAP` applies, because
the workspace that never opened the automation settings is exactly the one a runaway workflow would
happen to.

**8. Unknown placeholders fail the run.** `{{lead.nickname}}` against a lead with no such fact
throws, the step is recorded `failed` with the placeholder named, and the timeline says so. A
WhatsApp template rendered with `undefined` is worse than no message, and a note reading "Call Mr
undefined back" is the kind of thing a business sends once and then stops trusting the product.

## Consequences

- `automation_run_steps` is the fifth monthly-partitioned table, and the partition-maintenance job
  now keeps five tables ahead of the calendar rather than four.
- A run's branch decisions are read back from its own step log, because resuming after a two-day
  wait has to know which arm the branch above took. That is why `nextStep` takes the decisions
  rather than only the current step.
- The engine runs with more authority than most members hold. What bounds it is the enumerated
  permission list plus the five guardrails, and the audit log says `automation` did it.
- Nothing retries a failed run yet: `attempt` is on the step row and `retry-from-failed-step` is the
  next step's. A failed run stays failed, visibly, with the step and the sentence.
- `GET /automation/runs` and `/automation/runs/:id` are behind `automation:manage`, not `lead:read`:
  a run's steps carry the parameters a workflow was configured with. The **timeline** is where
  somebody with `lead:read` reads what happened, which is the screen they were already on.
- There is no dry run. `POST /workflows/{id}/test-run` would have to execute nothing while logging
  every decision, which is a second execution path through the interpreter — and two paths through
  the highest-consequence subsystem in the product is how one of them drifts. It arrives with the
  per-run retry, where the same `attempt` plumbing serves both.
