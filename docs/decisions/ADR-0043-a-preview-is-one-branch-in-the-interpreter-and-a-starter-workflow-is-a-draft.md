# ADR-0043 — A preview is one branch in the interpreter, a retry reopens the run it failed in, and a starter workflow arrives as a draft

- **Status:** accepted
- **Date:** 2026-10-26
- **Context:** Phase 6 step 3 — the dry run, retry from the failed step, and the industry starter workflows (`FR-AUT-3`, `FR-AUT-6`, `FR-AUT-7`)
- **Builds on:** [ADR-0041](./ADR-0041-a-workflow-is-its-definition-and-the-dispatch-index-is-the-only-projection.md), [ADR-0042](./ADR-0042-the-engine-is-a-chain-of-short-jobs-and-its-authority-is-the-workspaces.md)

## Context

The engine runs. What it does not yet have is the three things that decide whether a non-technical
owner ever turns a workflow on: a way to see what it _would_ do before it does it, a way to pick a
run back up after a provider was down, and something in the box on the first day so the screen is
not an empty list beside a graph editor.

Each had an answer that looks obviously right and is wrong.

## Decision

**1. A dry run is the same interpreter with one branch in it, not a second implementation.**

The tempting version is a `previewWorkflow()` that walks the definition and describes each step.
It would be simpler, and it would drift: ADR-0042 already argued that two paths through this
subsystem is how one of them stops telling the truth, and the import's dry run and the ingestion
test tool have each paid for the version of this mistake where a preview validated something the
write path does not (`createLeadSchema` without the workspace's country) or echoed a value the
write path would transform.

So a preview **is** a run. It gets a row in `automation_runs` with `dry_run = true`, it is driven
by `AutomationExecutorService.advance`, and every decision above the handler call — the entry
conditions, the branch arms, the wait arithmetic, the step ordering, the step log — is the same
code. There is exactly one `if (run.dryRun)` on the path to a handler, plus three small ones where
a _control shape_ would otherwise have an external effect: the wait continues instead of
suspending, `enroll` records what it would hand over instead of handing it over, and no timeline
row is written.

What follows from "it is a run" is the part worth writing down:

- **It is enrolled in nothing.** `enrollment_id` is nullable and
  `automation_runs_real_run_is_enrolled` pairs the two columns in both directions. A preview that
  took an enrolment would spend the lead's one allowed cycle under the `once` policy, so the real
  run afterwards would be refused _by the very thing the preview was checking_. And a real run with
  no enrolment is a run outside the re-entry policy. Both mirrors are contradictions, which is the
  test this codebase applies to a biconditional CHECK after the two payments constraints that
  together made a refund impossible.
- **It is not the live run.** `automation_runs_live`, the partial index the re-entry guard reads,
  excludes `dry_run`. The endpoint cannot leave a preview running — it is driven inline to
  completion — but an interrupted request can, and without the predicate that row would answer
  "this lead is already in this workflow" for ever.
- **It writes nothing to the timeline.** The timeline is the record of what happened to this
  customer. A row saying a workflow acted when it did not is the one lie that would make the rest
  of it unusable; the run log is where a preview is read.
- **It spends no cap.** The daily action counter is incremented where the handler is called, which
  is below the branch.

**It previews the draft.** The version a preview pins to is the unsaved draft when there is one and
the published version otherwise — the version the _next_ run would use. A preview that could only
run against a published workflow would be a tool for checking something already live, which is the
opposite of what it is for.

**It answers 200, inline.** `POST :id/start` is 202 and queued because its first step may call a
provider and a button must not wait for one. A preview calls no provider, so there is nothing to
wait for and the answer is the whole point of the button.

**2. A retry reopens the run it failed in, and the step log is append-only.**

`current_step_id` points at the last step that **succeeded** — `finish` deliberately leaves it
alone — so `nextStep` returns the failed one and nothing before it runs again. That is the
requirement (`queue-event-architecture.md`: "retryable from the failed step, not from the
beginning… side effects already applied are not repeated"), and it falls out of a column rather
than needing a plan.

The new attempt writes a **new** `automation_run_steps` row rather than overwriting the failure:
the first attempt stays readable, and `attempt` is what makes the handler's idempotency key
(`wf:{runId}:{stepId}:{attempt}`) different this time — which is the point, because a retry is
meant to re-do the effect that did not happen.

One guard is re-asked and the others are not. The **kill switch** and the workflow's status are
checked again, because a run that failed before somebody stopped the workflow must not be the way
its actions happen anyway. The re-entry policy is **not** re-asked: this lead is already enrolled,
and a retry is not an entry. A preview cannot be retried at all — it is tested again, and a retry
that executed what a preview declined to execute would be a preview with a button that makes it
real.

**3. A starter workflow is a draft, and its references are resolved at apply time.**

`FR-AUT-3` asks for starter workflows per industry. Two things had to be decided.

**They are created as drafts, deliberately unpublished.** Publishing a guessed workflow into
somebody's workspace during onboarding would start it creating follow-ups on their customers before
they had read what it does. A template is a guess about a business; the point is that somebody opens
it, changes two things, and then turns it on. `workflow_versions_publisher_published_it` is one-way
precisely so a version published by the system _could_ exist — and this step chooses not to use
that latitude.

**A template cannot carry ids, so a parameter may name a row.** The statuses and task types a
starter workflow points at are created in the same transaction that applies the template, so there
is nothing to point at when the template is written. A parameter value may therefore be
`{ $taskType: 'Site visit' }` or `{ $status: 'Site visit scheduled' }`, and `applyIndustryTemplate`
resolves it against the workspace's own rows. Two placeholder kinds, because those are the two a
starter workflow needs; a third is a line in `resolveTemplateReference`.

An unresolvable reference **throws**, aborting the apply rather than installing a draft that can
never be published. What keeps that from happening is a spec, not a hope:
`packages/db/src/seeding/industry-templates.spec.ts` asserts that every placeholder in every
template names a row that template or the common provisioning seed creates, and that every starter
workflow passes the same validator `publish` runs. It lives in `@leados/db` because that is the
only package that can see both halves of the question.

## Consequences

- A preview is a row somebody can find again. It appears in the run list with a Preview badge and
  a sentence that says so before it says anything else, and `?dryRun=false` is how a screen that
  wants only real runs asks for them (three-way, because absent means both).
- `AutomationRun.cycle` is now nullable in every presenter and on the web type. "This lead's first
  time through" and "this never counted" are different facts, and a 1 here would state the first of
  them falsely.
- Applying an industry template now writes workflows as well as a vocabulary, so it got the
  explicit transaction timeout CLAUDE.md predicted it would need: `TEMPLATE_TRANSACTION` (30 s),
  for the same reason provisioning has one.
- `change_priority` was added to the registry to prove Phase 6's first exit criterion — "adding a
  new action type requires no engine change and no frontend release". It cost one declaration, one
  handler method, and nothing else: no change to the executor, the validator, the editor or any
  web component. That is the honest reading of the criterion — an action needs an implementation,
  and what it must not need is a change to the machinery or a release of the screens.

## Alternatives considered

- **A `previewWorkflow()` beside the executor.** Simpler to write, and the thing ADR-0042 warned
  about: the two would agree on the day they were written and not afterwards.
- **A preview that enrols and then deletes the enrolment.** It would make `cycle` non-null and the
  CHECK unnecessary, and it would be wrong the moment anything read the enrolment between the two
  writes — including the re-entry guard, which is the only reader that matters.
- **A retry that starts the run again from the beginning.** Honest, and it re-sends. The whole
  reason `attempt` is on the step row rather than the run row is to avoid this.
- **Publishing the starter workflows.** Rejected: see above. A workspace whose first WhatsApp
  message was sent by a template they had not read would be right to distrust the product.
- **Starter workflows as rows in `industry_templates.definition` JSON only.** They already are —
  the catalogue row carries the whole template — but the _application_ of them has to resolve ids,
  which is code either way. What matters is that there is one definition of a template, and there
  still is.
