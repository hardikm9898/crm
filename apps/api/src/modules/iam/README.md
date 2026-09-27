# iam

Roles, grants, and which roles a person holds. The mechanism that `authz` enforces.

## What lives here

| Route                        | Permission    | Notes                                                                         |
| ---------------------------- | ------------- | ----------------------------------------------------------------------------- |
| `GET /permissions`           | `role:read`   | The catalogue, grouped by module, with `supportsScope`                        |
| `GET /roles`                 | `role:read`   | Includes each role's grants and how many people hold it                       |
| `POST /roles`                | `role:manage` |                                                                               |
| `PATCH /roles/:id`           | `role:manage` | Name and description only                                                     |
| `PUT /roles/:id/permissions` | `role:manage` | The intended final set, not a delta                                           |
| `DELETE /roles/:id`          | `role:manage` | Refused for seeded roles, and while anyone holds it or an invitation names it |
| `PUT /users/:id/roles`       | `user:manage` | The intended final set                                                        |
| `PATCH /users/:id`           | `user:manage` | Default branch, and active/suspended                                          |

## Decisions worth knowing

**Grants are replaced, not patched.** Both `PUT` routes take the whole intended set. A permissions
screen shows a complete picture and submits a complete picture; a delta API would let two
administrators editing at once merge into a state neither of them chose.

**Roles are rows, and code never reads a role's code.** A tenant may rename "Sales Executive",
invent "Telecaller", or give a branch manager organization-wide reporting, with no deployment
(rule 4). Anything that branched on `role.code` would quietly break the moment a tenant renamed it.
`isEditable` marks the roles a tenant may not restructure; `isSystem` marks the ones seeded from
`SYSTEM_ROLE_TEMPLATES`.

**Lockout guards.** Three writes are refused with `BUSINESS_RULE_VIOLATION`, all for the same
reason — an organization that has locked itself out needs support to recover:

- taking `role:manage` away from the only role that still has it, while anybody holds that role;
- taking the last person with `role:manage` off every role that grants it;
- suspending your own access, or the owner's.

They are enforced here rather than in the UI because the UI is not the only client. The web app
offers all three and reports the refusal instead of trying to predict it.

**Every change invalidates the principal cache.** Grants are cached for five minutes
(`PrincipalService`), so any write here calls `invalidateOrganization()`. Forgetting it means a
revoked role keeps working for up to five minutes — which looks like the authorization layer being
broken rather than a cache being stale.
