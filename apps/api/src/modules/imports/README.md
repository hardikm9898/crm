# modules/imports

The import wizard (`FR-IO-1`, `FR-IO-2`).

- `imports.controller.ts` — upload, preview, mapping, check, validate, start, cancel, rows, errors.csv
- `imports.service.ts` — the wizard's steps, each a persisted job state
- `import-catalogue.service.ts` — names → ids, loaded once per run
- `import-row-mapper.ts` — one spreadsheet row → the fields of a lead (pure)
- `import-runner.service.ts` — the row loop, resumable
- `imports.processor.ts` — `import.process` on the `imports-exports` queue

## The decisions

**Leads are created through `LeadsService`, never written directly.** An imported lead must be
indistinguishable from a typed one: the same duplicate rules, the same assignment engine, the same
timeline entry, the same outbox event, the same custom-field validation. Writing rows here would be
several times faster and would quietly produce leads nobody is assigned to and nothing reacted to.
That is what `FR-IO-2`'s "never blind-create" means in practice.

**The three modes differ only in what they do with a match, never in what a match is.**
`create_only` hands the row to `LeadsService.create` and lets the tenant's own duplicate rules
decide — a workspace whose rules say `reject` gets a refused row, one whose rules say
`attach_to_existing` gets a touchpoint on the lead it already had. `skip_existing` and
`update_existing` ask the question first, through the same `DuplicateDetectionService` and the same
matcher, because they mean something the rules cannot express: "I am re-uploading a list."

**The run acts as the person who asked for it.** `PrincipalService.build()` rebuilds their
permissions and data scope from the database — not a system principal, because their data scope
decides which leads they may update and the audit trail has to name them. If their access was revoked
between pressing Import and the worker picking the job up, the run fails saying so, which is the
correct answer rather than importing on the authority of nobody.

**A row is a record, not a log line.** Every row gets an `import_rows` row — created, updated,
attached, skipped or failed, with the cells as they arrived. That is what makes "where did this lead
come from" answerable six months later, what lets the error file reproduce a row exactly, and what
makes a retry resumable: the rows already recorded are the rows already done. Counters are recomputed
from those rows on resume rather than trusted from the job, because the database refuses a job whose
outcomes do not add up to its processed count.

**A row never fails the run.** Only a fault that makes the whole run impossible does. A run that
stops at row 1 400 of 5 000 and leaves a person guessing is worse than 60 recorded failures.

**`GET :id/check` reads; `POST :id/validate` is a step.** The same dry run, but the wizard's screen
renders the first — a page that re-ran a state transition on every refresh would be a state machine
driven by the browser's reload button.

**Cancel is not a rollback.** The leads already created are real, and deleting somebody's first 900
leads because they pressed Cancel would be far worse than leaving them. The row records say exactly
which ones they are.

## Traps

- **The capture date is written directly, bypassing the lead API.** `createdAt` is deliberately not
  settable through `POST /leads` — a caller able to backdate a lead would make every "new this week"
  report a guess. An import is the one legitimate exception: a year of old enquiries all dated today
  makes the first report after a migration useless.
- **Unknown names are reported, never invented** — except tags. A typo in a status column must not
  create a status, because statuses are workspace configuration. A tag is a label, cheap and
  reversible, and the field catalogue says so, so it is a promise rather than a surprise.
- **Tags are added on update, never replaced.** A re-upload mentioning one tag must not strip the
  five somebody added by hand.
- **The error file is the original columns plus `_row` and `_errors`.** A person fixes the file they
  recognise and re-imports it with the mapping they already chose — which is why `csvCell` and
  `unguardCell` in `@leados/shared` are an exact pair: the formula guard that makes the file safe to
  open in Excel has to survive the round trip.
