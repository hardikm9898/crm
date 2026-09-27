# crm-config

The vocabulary a tenant runs its business in: statuses, sources, lost reasons, pipelines, stages and
tags. Every one is a row, because rule 4 says nothing about a tenant may be hardcoded — a business
renaming "Site visit done" to "Viewing complete" must not need a deployment.

## What lives here

| Route                                                                          | Permission        | Notes                                                                       |
| ------------------------------------------------------------------------------ | ----------------- | --------------------------------------------------------------------------- |
| `GET /crm/config`                                                              | `lead:read`       | Everything a form or board needs, in one request                            |
| `GET /crm/statuses\|sources\|lost-reasons\|tags\|pipelines`                    | `lead:read`       | Individually, with usage counts                                             |
| `POST/PATCH/DELETE /crm/statuses`, `…/pipelines`, `PUT …/pipelines/:id/stages` | `pipeline:manage` | The permission's own description is "Define pipelines, stages and statuses" |
| `POST/PATCH/DELETE /crm/sources`, `…/lost-reasons`                             | `settings:manage` |                                                                             |
| `POST /crm/tags`                                                               | `lead:update`     | Tagging is part of working a lead                                           |
| `PATCH/DELETE /crm/tags/:id`                                                   | `settings:manage` | Renaming one affects every lead carrying it                                 |

## Why reads are gated on `lead:read`

Same reason as the field builder: anyone who can see a lead needs the words it is described in. A
sales executive holds `lead:read` and not `settings:read`, and a form that cannot list its own
statuses is not a form.

Tags are the one split. Creating one is something an executive does mid-conversation ("Investor"),
so it takes `lead:update` and is **idempotent** — a colleague having typed it first is not an error.
Renaming or deleting one changes what every lead carrying it says, so that takes `settings:manage`.

## Configuration in use is not destroyed

Deleting a status, source, lost reason, pipeline or stage that records still reference is **refused**,
with the count in the message. Two reasons:

- Deleting would either orphan those rows or silently move them, and neither is what anyone asked for.
- Attribution and loss reports read _historical_ configuration. A source deleted today would blank
  last quarter's "where did our leads come from".

Deactivating is always available and is what the error message points at: it hides the row from new
writes while leaving history readable.

## Defaults are enforced by the database

Partial unique indexes guarantee one default status and one default pipeline per organization
(`lead_statuses_one_default_per_org`, `pipelines_one_default_per_org_entity`). The service clears the
old default inside the same transaction and lets the index be the arbiter rather than trusting a
read-then-write. Clearing the default outright is refused: a workspace with no default status is one
where lead creation fails for everyone.

## Stage editing is `PUT`, and populated stages cannot be dropped

The stage editor shows a complete board and submits a complete board. Submitting a stage's `id` keeps
it; omitting an empty stage removes it; omitting a **populated** one is refused with the count,
because a lead has to be somewhere and silently moving it would corrupt stage-duration history.

Board coherence the database cannot express is checked here: at most one won stage, at most one lost
stage, no duplicate names. Two "Won" columns is revenue counted twice.
