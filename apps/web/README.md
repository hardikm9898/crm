# @leados/web

The product's own interface: Next.js 16 App Router, React 19, Tailwind CSS 4, no UI component
library. Phase 1 covers sign-in, the authenticated shell, and the workspace-administration screens.

```bash
pnpm --filter @leados/web dev        # needs the API on NEXT_PUBLIC_API_URL (default :4000)
pnpm --filter @leados/web typecheck | lint | test | build
```

## How a page is put together

Almost everything is a **server component** that reads the API with the caller's token and renders
the result. Client components exist only where interactivity genuinely requires them: the
organization switcher, the sign-out button, the active-link highlight, and each form.

```
src/
  proxy.ts                    silent access-token renewal (Next 16's middleware convention)
  app/
    login/                    sign-in
    accept-invitation/        the page invitation emails link to
    api/session/              sign-in, sign-out, org switch, invitation accept — cookie handling
    (app)/                    everything behind authentication
      layout.tsx              shell: nav, org switcher, notification badge, sign-out
      dashboard/              what exists in phase 1, honestly
      notifications/          the caller's own inbox
      settings/               organization, people, roles, own security
  components/ui.tsx           the shared vocabulary
  lib/                        api client, session, nav model, onboarding steps, action plumbing
```

## Four decisions that shape the whole app

**No token ever reaches JavaScript.** Sign-in posts to this app's own `/api/session`, which exchanges
the credentials with the API and stores the access token in an httpOnly cookie. Server components
read it with `cookies()`; the browser cannot. That is what limits the damage of an XSS bug
(docs/security.md §2).

**Mutations are server actions, not browser fetches.** Only the server can attach the token, so
every form posts to a server action that calls the API and returns an `ActionState`. There is
deliberately **no** `/api/proxy/*` catch-all: a route that forwards an arbitrary path with the
caller's token attached is a confused deputy waiting to happen. `lib/action-state.ts` holds the
client-safe types and `lib/server-action.ts` the server half — a client component that imports the
server half pulls `next/headers` into the browser bundle and the build fails.

**Hiding a link is not authorization.** `lib/nav.ts` filters navigation by the permissions
`/auth/me` reported, purely so nobody is shown a link that leads to a 403. Every route is
independently enforced by the API, and the browser checks in `apps/web` prove it: typing
`/settings/roles` as a sales executive renders the API's refusal, not the page. Screens read
`user.scopes` to decide whether a _request_ is worth making — asking for organization-wide seat
usage with a branch-scoped grant just earns a 403 — never to decide what the caller may do.

**Sessions renew silently.** Access tokens last fifteen minutes and refresh tokens thirty days, so
`proxy.ts` renews the access token when the cookie is gone and a refresh cookie is present, and makes
the new token visible to the same render. The API scopes its refresh cookie to `Path=/api/v1/auth`,
which is dead once relayed through this app — `lib/refresh-cookie.ts` rewrites it and explains why.

## What is deliberately not here yet

- **Two-factor sign-in in the browser.** The API supports it; the login form says so plainly instead
  of pretending. Arrives with the account-settings screens.
- **Editing roles and grants.** The matrix is read-only in phase 1; the editor arrives with the CRM
  permissions work.
- **Branch and team management screens.** The API endpoints exist and are tested; the screens come
  with the CRM structure work.
- **A generated API client.** Hand-written until the OpenAPI spec is published in phase 4 — a
  generated client for a spec that does not exist yet would be fiction.

## Testing

`pnpm test` covers the pure logic: navigation filtering, onboarding progress, cookie relaying and
error copy (24 tests). Behaviour that only exists in a browser — cookies, redirects, server actions,
silent renewal, tenant switching — is verified by driving the built app with Playwright against a
real API; those checks live outside the repo as development scripts rather than pretending jsdom
renders what ships.
