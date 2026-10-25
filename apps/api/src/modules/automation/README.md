# modules/automation

The automation registry, workflows, versions and publish (`FR-AUT-1`, `FR-AUT-2`, `FR-AUT-3`,
`FR-AUT-4`, `FR-AUT-5`, `FR-AUT-8`). **Nothing runs yet** — the executor, the enrollment, the run
log and the guardrail counters are step 2's, and this module ships without them on purpose: a
workflow that can be written, checked and published is honest, and a half-built engine is not.

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

## The tables

| Table               | What it holds                                                                     |
| ------------------- | --------------------------------------------------------------------------------- |
| `workflows`         | Name, status, the live version, the kill switch and the re-entry guardrails        |
| `workflow_versions` | `definition JSONB` — the whole graph — plus who published it and when              |
| `workflow_triggers` | The dispatch index: one row per published workflow, keyed `(organization_id, event)` |

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
- **Nothing here touches a lead's timeline.** A workflow is configuration; rule 6's entries are what
  *runs* write, where there is a lead to write them about. Configuration is audited
  (`workflow.created`, `workflow.published`, `workflow.stopped`, `workflow.deleted`), and a draft
  save deliberately is not — an audit log full of keystrokes is one nobody can read.
