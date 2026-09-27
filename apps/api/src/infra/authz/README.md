# Authorization (`infra/authz`)

**Purpose.** Decide what an authenticated caller may do, and how much of the tenant's data
they may see. Authentication (`modules/auth`) establishes _who_; this decides _whether_ and
_how widely_.

## The three questions, separated on purpose

| Question                                   | Component                                | Refusal                      |
| ------------------------------------------ | ---------------------------------------- | ---------------------------- |
| May this person do this?                   | `PermissionGuard` + `@RequirePermission` | `403 PERMISSION_DENIED`      |
| Is their grant wide enough for this route? | `PermissionGuard` `minimumScope`         | `403 OUT_OF_DATA_SCOPE`      |
| Which rows may they see?                   | `DataScopeService`                       | filtered query, not an error |

They stay separate because the client needs to react differently: "ask an admin" vs. "this
list is narrower than you expect" vs. nothing at all.

## Deny by default, twice over

1. The guard is **global**, so a new controller is covered the moment it exists.
2. `RouteAuditService` **fails startup** if any route declares nothing. A forgotten decorator
   is a boot failure, not an endpoint every authenticated user of every tenant can call.

Each route carries exactly one of:

```ts
@Public()                                   // reachable unauthenticated
@RequirePermission('user:read')             // needs the permission
@RequirePermission('user:read', { minimumScope: 'organization' })
@NoPermissionRequired('own session')        // authenticated, self-scoped, with a reason
```

Code checks **permissions, never role names** (FR-IAM-3). Roles are tenant data: an
organization can invent "Telecaller" with its own grants and nothing in the codebase changes.

## Data scopes

A grant carries a scope: `own | team | branch | organization`. `DataScopeService.filterFor()`
turns that into a query predicate; `canAct()` answers the same question for a single row,
because knowing an id must never be authority on its own.

Two deliberate behaviours:

- **Unsatisfiable scopes narrow, they never widen.** A branch-scoped user with no branch gets
  their own rows, not everyone's.
- **`own` with no ownership column returns `{ kind: 'none' }`** — an empty result. Returning
  everything would be a silent widening, which is the failure mode that matters.

The filter is structural (`userColumn`/`teamColumn`/`branchColumn`) rather than
Prisma-specific, so leads, tasks, conversations and deals reuse it in Phase 2+ unchanged.

## Grant resolution and staleness

Permissions are **not** in the access token. They are resolved from the database and cached in
Redis under a version-keyed name; `PrincipalService.invalidateOrganization()` bumps the
version, so a role edit applies on the next request instead of when tokens expire. Any code
that changes roles, grants, team membership or branch assignment must call it — there is a test
that a stripped role stops working immediately.

## Tests

`data-scope.service.spec.ts` (all four scopes, unsatisfiable scopes, single-row authority),
`permission.guard.spec.ts` (each declaration kind, scope too narrow, no principal),
`route-audit.service.spec.ts` (an undeclared route throws at boot),
`test/route-authorization.e2e-spec.ts` — generated from the live routing table: every route is
declared, every write outside `/auth` is permission-gated, every declared permission exists in
the catalogue, and no route answers another organization's caller.
