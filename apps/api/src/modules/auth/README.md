# Auth module

**Purpose.** Establish _who_ a caller is, and make that identity available to everything
downstream as a `TenantPrincipal`. Authorization — what that caller may do — is layered on
top by the guards in Phase 1 step 3.

## Tables

`users`, `sessions`, `password_resets`, `email_verifications`, `mfa_recovery_codes`
(all platform-level, keyed to the global identity) plus reads of `memberships`,
`user_roles`, `role_permissions`, `team_members` to resolve grants.
`invitations` is read and consumed here; it is written by the organizations module.

## Endpoints

| Route                                              | Auth            | Notes                                                       |
| -------------------------------------------------- | --------------- | ----------------------------------------------------------- |
| `POST /auth/register`                              | public          | Creates the user **and** provisions a complete organization |
| `POST /auth/login`                                 | public          | Returns tokens, or an MFA challenge                         |
| `POST /auth/mfa/verify-login`                      | public          | Second factor; accepts a TOTP or recovery code              |
| `POST /auth/refresh`                               | public          | Rotates the refresh token; detects reuse                    |
| `POST /auth/logout` · `logout-all`                 | public / bearer |                                                             |
| `GET /auth/me`                                     | bearer          | Identity, organizations, resolved permissions and scopes    |
| `GET /auth/sessions` · `DELETE /auth/sessions/:id` | bearer          | Own sessions only                                           |
| `POST /auth/switch-org`                            | bearer          | Re-points the session at another membership                 |
| `POST /auth/verify-email` · `resend-verification`  | public          |                                                             |
| `POST /auth/forgot-password` · `reset-password`    | public          |                                                             |
| `POST /auth/mfa/setup` · `confirm` · `disable`     | bearer          | Disable requires the password again                         |
| `GET /auth/mfa/recovery-codes/count`               | bearer          |                                                             |
| `POST /auth/invitations/accept`                    | public          | Creates the account if needed                               |

## Permissions

None: these endpoints are about becoming authenticated. Everything else in the product is
deny-by-default because `AuthGuard` is registered globally — a new controller is protected
the moment it exists, and opting out needs an explicit `@Public()`.

## Business logic worth knowing

- **Registration provisions a whole organization** in one transaction (branch, team, six
  seeded roles with grants, owner membership, working hours, trial subscription). A
  half-provisioned tenant is unrecoverable without support, so it must be impossible.
- **Refresh tokens rotate on every use**, and presenting a rotated one revokes the entire
  family. Token theft becomes "both parties are signed out" instead of "attacker has
  indefinite access". The successor is created _before_ the old token is revoked, so a crash
  mid-rotation does not lock the user out.
- **The session is verified on every request**, not just at refresh, which is what makes
  "sign out everywhere" and family revocation take effect immediately despite bearer tokens.
- **Permissions are not in the token.** They are resolved from the database and cached in
  Redis under a version-keyed name, so a role change applies on the next request.
- **Unauthenticated endpoints do not disclose whether an account exists.** Login hashes a
  dummy value when the user is unknown so timing does not differ; password reset and resend
  verification always return the same response. Registration is the deliberate exception —
  the person is present and needs to be told to sign in.
- **MFA enrolment is two-step.** Generating a secret does not enable MFA; a valid code must
  be produced first, otherwise a mistyped setup locks the user out. The secret is encrypted
  at rest, bound to the user id by AAD.

## Events

`user.registered`, `organization.created`, `invitation.accepted` → outbox.
(The dispatcher arrives in step 4; until then rows accumulate and `/health/deep` reports the lag.)

## Audit

`auth.login_succeeded`, `auth.login_failed`, `auth.mfa_recovery_code_used`,
`organization.created`, `invitation.accepted`.

## Failure modes

| Failure                    | Behaviour                                                                                                                                                    |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Redis unavailable          | Sign-in throttling **fails closed** (429 with retry guidance) — unlimited password guesses is the worse outcome. Grant lookups fall through to the database. |
| Email provider unavailable | Verification/reset tokens are already persisted; the send is retried by the mailer adapter. A user can request a new link.                                   |
| Crash mid-rotation         | The old refresh token still works, because the successor is written first.                                                                                   |
| Clock skew on TOTP         | One 30-second step either side is accepted; wider windows materially weaken TOTP.                                                                            |

## Security notes

Argon2id (64 MiB, t=3) with transparent rehash on parameter upgrades · HS256 access tokens
(see ADR-0013 for why not RS256 yet) · opaque refresh tokens stored only as SHA-256 hashes ·
httpOnly `SameSite=Lax` refresh cookie scoped to `/api/v1/auth` · password reset revokes all
sessions · MFA disable requires re-authentication · per-account and per-IP throttling.

## Not here yet

Rate limiting for non-auth routes, permission/data-scope guards, entitlement checks, SSO,
and a real email provider (a dev mailer logs instead of sending, and refuses to run in
production).
