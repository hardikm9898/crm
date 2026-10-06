# ADR-0021 — An industry template replaces a workspace's vocabulary, and only while it is empty

**Status:** Accepted · **Date:** 2026-10-06 · Refines `product-requirements.md` `FR-ONB-2`, `FR-ONB-3` · Phase 2 step 10

## Context

`FR-ONB-2` asks for templates across ten industries "seeding custom fields, pipeline + stages,
statuses, lost reasons, task types, sources, saved views, starter automations and WhatsApp template
drafts — all then editable". Every new workspace is already provisioned with an industry-neutral
vocabulary, because the product has to work on first login: there has to be a default status to put
a lead in and a pipeline to put it on. So a template is not _adding_ a vocabulary to an empty
workspace. It is deciding what to do about the one that is already there.

Three answers, and the difference between them is what a business owner sees on their second day.

**Merge: add what the template has and keep what is there.** The cheapest, and the worst. A
workspace that picked "Real estate" ends with twelve statuses — "Qualified" from the generic set and
"Site visit scheduled" from the template, "Proposal sent" alongside "Booked" — two of which mean the
same thing and none of which anybody chose. Merging _by name_ is not better: it produces a
vocabulary that is neither the template's nor the tenant's, and nobody can say which rows came from
where.

**A mode: remember the template and have the product read it.** `if (industry === 'real_estate')`
somewhere, and the lead screen asks different questions. This violates rule 4 outright — a tenant's
statuses become partly data and partly code — and it makes the ten industries ten code paths to
test instead of ten rows of content.

**Replace, and refuse when replacing would lose something.** What we built.

## Decision

**Applying a template deletes the workspace's statuses, lead pipeline stages, sources, lost reasons,
tags and custom field definitions, and writes the template's. The API refuses the whole operation
once the workspace contains a lead, a customer, a deal or a quotation, naming what it found.**

- **The refusal is the safety property, not a limitation.** `leads.status_id` is `Restrict`, so
  deleting a status a lead sits in would fail at the database anyway — but failing halfway through a
  replacement is not an outcome worth having. Refusing up front, with a sentence that says to change
  things in Settings instead, is the honest version.
- **That window is exactly onboarding**, which is when somebody picks an industry. A workspace that
  has started working does not want its vocabulary swapped; it wants to rename one status.
- **Two sources survive the replacement**: `Manual entry` and `API`. They are not a tenant's
  marketing channels — the capture paths look them up by name — and a template that deleted them
  would break lead creation immediately after onboarding.
- **The pipeline is kept and its stages replaced.** `pipelines_one_default_per_org_entity` is
  partial-unique, the **deal** pipeline must not be touched, and a workspace with no lead pipeline
  cannot create a lead.
- **The default status is cleared before the delete.** `lead_statuses_one_default_per_org` is a
  partial unique index, so inserting the template's default while the old one still exists is
  refused; clearing on the way out also means a failed replacement leaves no default rather than two.
- **The provisioned saved views are kept** and only a view whose name the template reuses is
  replaced. "Unassigned" and "My open leads" are about the mechanism, not the industry.
- **Everything written is an ordinary row.** No column marks a row as a template's. `industry` and
  `industry_template_key` are recorded so a screen can say what was installed and a support
  conversation can start from "you chose Real estate" — and **nothing in the product branches on
  either**. That is what makes a template allowed to be wrong about an industry without being a
  problem: the business renames two statuses and carries on.

**The catalogue is a code constant and a reference table, not one or the other.**
`INDUSTRY_TEMPLATES` in `@leados/shared` is the definition — read by the seeder, by the API's picker
and by the tests that keep the ten internally consistent. `industry_templates` exists because an
organization has to be able to **reference** the template it applied, and because the Super Admin
console (`FR-SA`) is specified to manage templates without a deploy. The row's `definition` JSON is
a copy of the constant, upserted on every platform seed; the API reads the constant rather than the
JSON, so there is one place the ten are actually defined.

**Finishing the wizard shows three things to do (`FR-ONB-3`).** "Your CRM is ready" with nothing to
click is where a trial goes to die, so the completion state is a list of three links to screens that
exist: add a lead, import the list you already have, invite the people who will use it. The
checklist stays visible rather than disappearing, because the adoption nudge is "you have not
imported anything yet", not a tick.

## Consequences

- A workspace can switch industry freely during onboarding and not at all afterwards. That is a
  product rule somebody will eventually want relaxed; the relaxation is a _merge_ UI that shows the
  diff and asks per row, which is a feature, not a loosened constraint.
- The field registry is rewritten wholesale, so its cache is dropped in the same breath. Without
  that the lead form keeps offering the previous industry's questions for five minutes — which looks
  exactly like the template not having been applied.
- **Task types, starter automations and WhatsApp template drafts are not seeded**, because none of
  those tables exists yet (Phases 3, 6 and 5). `TemplateField`, `TemplateStatus` and the rest are a
  per-concern shape precisely so adding `taskTypes` to the ten definitions is a content change when
  the table arrives.
- The ten definitions are content, and content is wrong sometimes. The unit suite asserts what must
  hold for any workspace to function — one default status, one won stage at 100 %, one lost stage at
  0 %, no duplicate names, options on every select, a filter that names a status the template
  installs — and an e2e test applies all ten and creates a lead in each.

## Alternatives rejected

| Alternative                             | Why not                                                                                           |
| --------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Merge the template with what is there   | Twelve statuses, two of which mean the same thing, and no way to say which came from where        |
| An industry "mode" the product reads    | Breaks rule 4 and turns ten rows of content into ten code paths                                   |
| Replace unconditionally, whenever asked | Deleting a status a lead sits in fails at the FK — halfway through a replacement                  |
| Apply a template at provisioning only   | The industry is chosen in the wizard, after signup; and it must be changeable while empty         |
| Keep the definitions only in the table  | The API, the seeder and the tests would read JSON nobody type-checks                              |
| Keep the definitions only in code       | An organization could not reference its template, and the Super Admin surface would have no table |
