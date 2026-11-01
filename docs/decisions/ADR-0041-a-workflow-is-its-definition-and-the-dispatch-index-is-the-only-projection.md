# ADR-0041 — A workflow is its definition, the dispatch index is the only projection, and the registry is served rather than compiled

- **Status:** accepted
- **Date:** 2026-10-25
- **Context:** Phase 6 step 1 — the automation registry, workflows, versions and publish (`FR-AUT-1`, `FR-AUT-2`, `FR-AUT-3`, `FR-AUT-4`, `FR-AUT-5`, `FR-AUT-8`)
- **Builds on:** [ADR-0040](./ADR-0040-the-usage-meter-counts-and-does-not-price.md)

## Context

Phase 6's first exit criterion is unusually specific, and it decides the shape of everything in
this step: **"adding a new action type requires no engine change and no frontend release (proven
by adding one)."** Two obvious designs fail it before a line is written.

- A `switch` in the executor is an engine change by definition.
- A **Zod schema per action** is an engine change too, and a less obvious one: a browser cannot
  read a Zod object, so the editor would need a hand-written form per action — and every new
  action would be a release of `apps/web`.

Separately, `database-design.md` §9 described the workflow graph **twice**: as
`workflow_versions.definition JSONB` ("normalized graph snapshot") _and_ as `workflow_steps` rows,
with `workflow_triggers` beside them. That is the defect this codebase has already paid for once —
"a column a feature reads has to be read by _one_ thing", which cost `notification_preferences` a
per-type copy of somebody's quiet hours — arriving as a plan rather than as code.

## Decision

**1. The registry is a declaration the API serves, and both halves read.** Each trigger, condition
field and action in `packages/shared/src/automation.ts` carries a list of parameter fields with a
type, a label, a hint and — where the value is a row in this workspace — which _kind_ of row. The
editor renders inputs from that list; the write path validates against the same list
(`validateWorkflowDefinition`, pure, in `@leados/shared` so a preview and a refusal cannot
disagree); the executor will dispatch on the key. Adding an action is one entry plus one handler.

The web app's `lib/automation.ts` therefore copies **nothing**. Its siblings (`webhooks.ts`,
`tasks.ts`, `forms.ts`) each hand-write a copy of a shared list — they must, because
`@leados/shared`'s entry point reaches `node:async_hooks` and a client component importing it
fails `next build` — and each pays for the copy with a reconciling spec. Here the vocabulary
arrives as data, so there is no copy to drift. What `lib/automation.spec.ts` reconciles is the one
thing a declaration cannot carry: how a row of each reference kind reads in a picker.

**2. Four actions are declared as the engine's own.** `wait`, `branch`, `stop` and `enroll` change
the _shape_ of a run — a branch carries nested steps, a wait suspends it — so each carries
`control: true`. Saying so in the registry is what keeps the first criterion honest: "adding an
action needs no engine change" is a claim about the other kind, and four control shapes pretending
to be plug-ins would make it a claim nobody could check.

**3. The definition is the one source. `workflow_steps` is not built.** The JSONB on the version is
what a run pins to, it is versioned atomically, and a graph edited as a whole is saved as a whole.
Rows would be a second copy that can disagree with the JSON, and nothing needs to query a step
independently of its version. §9 was corrected in the same change rather than followed — when a
doc and the code disagree one of them is a bug, and here it was the doc.

**4. `workflow_triggers` earns its place by being an index, not a copy.** Dispatch asks "which
workflows in this workspace listen to `lead.created`" on _every_ domain event, and digging that
out of JSONB is a scan. So one row per workflow that has something published, written by one
method from the published definition, inside the publish transaction. It carries the event and the
trigger's parameters and **no status of its own**: `status` and `kill_switch` live on `workflows`
and dispatch joins them, so "is this workflow live" has exactly one answer. Archiving or deleting
empties it, because the row's presence is what an event looks at.

**5. A draft may be incomplete; publishing is where the problem list becomes a refusal.** Saving is
not publishing. An editor that refuses to save a half-built workflow is an editor somebody loses an
afternoon in, so `PUT /definition` records whatever parses as an object and answers the problems
beside it, and `POST /publish` refuses with the same list as field errors.

**6. Editing a published workflow writes a new version.** There is at most one unpublished version
per workflow — the draft — and a save updates it in place rather than minting a version per
keystroke. A published version is never written again, which is the whole of "editing a live
workflow does not alter in-flight runs": a run pins `version_id`, and the row it pins to is
immutable.

**7. References are checked against the workspace, not against a schema.** The registry knows a
parameter points at a status; only the workspace knows whether _that_ status still exists. So
`validateWorkflowDefinition` checks shape and the service checks ids — including that a WhatsApp
template is **approved**, not merely present, because a workflow published with a pending template
is one that fails at three in the morning. The import's dry run already paid for the version of
this mistake where a schema was asked a question only the tenant's data could answer.

**8. A customer's reply became a real event.** `whatsapp.received` was in the trigger list and
`whatsapp.message_received` was emitted by nothing — a trigger a screen offers with nothing behind
it is a workflow that can never run and looks built. The inbound path now emits it inside the same
transaction as the message insert, which is also the first transaction that write has had.

## Consequences

- Adding an action is two edits: `WORKFLOW_ACTIONS` and, from step 2, a handler. Nothing in
  `apps/web` changes, and `lib/automation.spec.ts` proves it by rendering and collecting an action
  (`send_pigeon`) that does not exist.
- Adding a new _reference kind_ is three: the registry, `REFERENCE_SOURCES` (the endpoint behind
  it) and `REFERENCE_LABELS` (how its rows read). The exit criterion is about actions, and this is
  the honest boundary of the claim.
- `workflows.current_version_id` and `workflow_versions.workflow_id` form a **circular** pair of
  composite FKs. Both are `RESTRICT`, because `SetNull` on a composite FK would null the NOT NULL
  `organization_id`; a workflow is soft-deleted, and the publish transaction inserts the version
  before pointing at it.
- Nothing runs. There is no executor, no enrollment, no run log and no guardrail counter — the
  `reentry_policy`, `cooldown_hours` and `max_runs_per_entity` columns are written by this step and
  read by the next. A workflow that can be published and does nothing is honest; the screen says so
  at the top, and the roadmap entry says so too.
- Nothing reaches a lead's timeline yet, by the same reasoning: a workflow is configuration, and
  rule 6's entries are what _runs_ write, where there is a lead to write them about. Configuration
  lands in the audit log (`workflow.created`, `workflow.published`, `workflow.stopped`).
- The editor edits a **linear** list of steps. Branches are representable, validated and stored
  three deep; the visual builder that edits them arrives with the executor.
