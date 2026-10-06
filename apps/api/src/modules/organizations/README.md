# organizations

The tenant's own shape: its profile, its onboarding state, its branches and its teams.

## What lives here

| Route                                                          | Permission            | Notes                                                 |
| -------------------------------------------------------------- | --------------------- | ----------------------------------------------------- |
| `GET /organization`                                            | `organization:read`   | Profile, counts, subscription summary, ingestion key  |
| `PATCH /organization`                                          | `organization:manage` | Partial update; rejects an empty patch                |
| `PATCH /organization/onboarding`                               | `organization:manage` | Available in restricted mode — see below              |
| `GET /branches`                                                | `organization:read`   |                                                       |
| `POST/PATCH/DELETE /branches/:id`                              | `branch:manage`       | Soft delete; the default branch cannot be removed     |
| `GET /teams`                                                   | `organization:read`   |                                                       |
| `POST/PATCH/DELETE /teams/:id`                                 | `team:manage`         |                                                       |
| `POST /teams/:id/members`, `DELETE /teams/:id/members/:userId` | `team:manage`         | Membership by `userId`, resolved through `Membership` |

## Decisions worth knowing

**Onboarding stays writable in restricted mode.** `@AllowWhenRestricted()` on the onboarding route
is deliberate: a tenant whose trial lapses mid-setup must still be able to finish choosing a plan.
Blocking the wizard would trap exactly the person we want to convert.

**The onboarding payload is free-form on purpose.** The API stores `{ step, completed, data }` and
has no opinion about what the steps are — the wizard owns that list (`apps/web/src/lib/onboarding.ts`).
Adding a step is then a frontend change, and an organization that recorded a step an older release
never had simply resumes where it was.

**`publicKey` is returned to anyone with `organization:read`,** which every role holds, because a
sales executive needs the workspace's timezone and currency. It is an ingestion identifier rather
than a secret (docs/security.md §7), but the web app still only shows it to someone with
`organization:manage` — see `apps/web/src/app/(app)/settings/page.tsx`.

**Provisioning lives in its own module.** `OrganizationProvisioningModule` exists because
registration (in `auth`) and organization management both need provisioning, and importing
`OrganizationsModule` from `AuthModule` produced a circular import that surfaced as
`Cannot access 'AuthModule' before initialization` — a boot failure with no useful stack. Provisioning
is the shared leaf; neither side imports the other.

**Every collection returns `data: [...]` with `meta.pagination`.** `fullPage()` exists so a list that
is genuinely un-paginated still produces a pagination block, because the envelope interceptor only
lifts `items` when `pagination` is present — without it, one endpoint would answer `{ items: [...] }`
and the rest an array (docs/api-architecture.md §2).

## Industry templates (`FR-ONB-2`)

`industry-templates.service.ts`, behind two routes on the organization: `GET
organization/industry-templates` (the picker, `organization:read`) and `POST
organization/industry-template` (`organization:manage`).

**A template replaces, it does not merge.** It deletes the workspace's statuses, lead pipeline
stages, sources, lost reasons, tags and custom field definitions and writes the template's. Merging
would leave twelve statuses, two of which mean the same thing and none of which anybody chose. The
reasoning and the five alternatives rejected are
[ADR-0021](../../../../../docs/decisions/ADR-0021-industry-templates-replace.md).

**The refusal is the safety property.** `assertWorkspaceIsUntouched` refuses once there is a lead, a
customer, a deal or a quotation, naming what it found — because `leads.status_id` is `Restrict`, so
the delete would fail at the database anyway, and failing halfway through a replacement is not an
outcome worth having. That window is exactly onboarding, which is when somebody picks an industry.

**Nothing branches on the chosen template.** `industry` and `industry_template_key` are recorded so
a screen can say what was installed; every row a template writes is an ordinary editable row. That
is rule 4, and it is why a template is allowed to be wrong about an industry.

### Traps

- **Reading the catalogue needs `withPlatformScope`.** `industry_templates` is platform reference
  data like `permissions`, so a tenant route reading it says why in the scope's reason string.
- **The definitions come from the code constant, not from the row's JSON.** The table exists so an
  organization can reference a template and so the Super Admin console has something to manage; the
  constant in `@leados/shared` is where the ten are defined, and reading the JSON instead would make
  the picker depend on something nothing type-checks.
- **The field registry's cache has to be dropped in the same breath.** A template rewrites every
  definition, and the registry is cached for five minutes — without `invalidateForOrganization` the
  lead form keeps asking the previous industry's questions, which looks exactly like the template
  not having been applied.
- **`Manual entry` and `API` are not replaced.** The capture paths look them up by name; a template
  that deleted them would break lead creation immediately after onboarding.
- **The default status is cleared before the delete.** `lead_statuses_one_default_per_org` is a
  partial unique index: inserting the template's default while the old one still exists is refused,
  and clearing on the way out also means a failure leaves no default rather than two.
- **The pipeline is kept and only its stages replaced.** The deal pipeline must not be touched, and
  `pipelines_one_default_per_org_entity` would refuse a second default lead pipeline.
- **The wizard's steps are the frontend's, so the API does not advance them.** Applying a template
  is one server action that calls two endpoints: the template, then `PATCH organization/onboarding`.
  It advances the step **only if the template landed** — a step ticked over a failure is how
  somebody reaches "start working" with the generic vocabulary.
