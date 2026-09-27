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
