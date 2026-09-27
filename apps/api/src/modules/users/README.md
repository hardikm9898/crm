# Users module

**Purpose.** The organization's people: who can see whom, and who may invite. It is the first
module where permission, data scope and entitlement all apply to the same request, which is
why it exists at this point rather than later.

## Tables

Reads `memberships`, `users`, `user_roles`, `roles`, `team_members`, `branches`.
Writes `invitations` (acceptance lives in `modules/auth`).

## Endpoints

| Route                           | Permission                   | Notes                                                   |
| ------------------------------- | ---------------------------- | ------------------------------------------------------- |
| `GET /users`                    | `user:read`                  | Breadth decided by the caller's grant, not by the query |
| `GET /users/seats`              | `user:read` @ `organization` | Whole-organization figure, so it needs org scope        |
| `GET /users/invitations`        | `user:manage`                | Pending only                                            |
| `POST /users/invitations`       | `user:manage`                | Seat-limited; sends the invitation email                |
| `DELETE /users/invitations/:id` | `user:manage`                | Tenant-scoped, so a foreign id is a 404                 |

## Business logic

- Listing applies `DataScopeService`: an organization-scoped admin sees everyone, a
  branch-scoped manager sees their branch, a role granted `user:read` at `own` scope sees only
  themselves. `sales_executive` deliberately has no `user:read` at all — browsing colleagues is
  not part of that job.
- Team scope needs the set of colleagues sharing a team, which membership rows do not carry, so
  it resolves through `team_members` before filtering.
- Inviting counts active members **and** outstanding invitations against the `users`
  entitlement.
- Role, team and branch ids are validated by tenant-scoped reads, so an id from another
  organization is simply not found — a 404, never a 403 that would confirm it exists.

## Events and audit

Outbox: `invitation.sent`. Audit: `invitation.sent`, `invitation.revoked`.

## Failure modes

| Failure                                 | Behaviour                                                                   |
| --------------------------------------- | --------------------------------------------------------------------------- |
| Seat limit reached                      | `403 LIMIT_EXCEEDED` with the feature named, so the UI can offer an upgrade |
| Duplicate invitation or existing member | `409 CONFLICT` with a specific message                                      |
| Mailer unavailable                      | The invitation row is already committed; the send is the retryable part     |
| Trial lapsed                            | `SubscriptionGuard` refuses the write before this module runs               |

## Not here yet (Phase 1 step 5)

Role assignment and editing, disabling and re-enabling users, profile editing, branch and team
management, and the organization settings surface.
