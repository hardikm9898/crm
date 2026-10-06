# Frontend Architecture — Lead OS

**Stack:** Next.js 16 (App Router) · React 19 · TypeScript strict · Tailwind CSS 4 ·
React Hook Form + Zod · Socket.IO client ·
Traces to: `NFR-UX-*`, `FR-VIEW-*`, `FR-TSK-7`, `FR-WA-7/8`, `FR-LEAD-3..6`

> **§10 records what was actually built in Phase 1** and where it departs from this plan. Where the
> two disagree, §10 is the code's contract and this document is the intent.

---

## 1. Principles

1. **Role-shaped, not feature-shaped.** An executive's app is a task list with a phone attached; an owner's app is an analytics product. Navigation, default route and dashboard are derived from permissions, not from a single menu everyone squints at.
2. **The server is the source of truth.** No business rules duplicated client-side beyond input validation (shared Zod schemas from `packages/contracts`) and optimistic UI.
3. **The API shape is generated, never hand-typed.** Types come from the OpenAPI client; a backend change that breaks the frontend fails typecheck in CI.
4. **Mobile-first where the work happens** (`NFR-UX-1`): Today, lead list, lead detail, tasks, WhatsApp, call, notes are designed at 375 px first, then scaled up. Analytics/config screens are desktop-first but never broken on mobile.
5. **Every screen has four states designed up front**: empty (with a primary action), skeleton, error (retryable), permission-denied. A "blank page while loading" is a defect (`NFR-UX-3`).
6. **Nothing unbounded reaches the browser.** Lists are paginated + virtualized; a kanban column loads a page per column (`NFR-PERF-4`).
7. **Metadata-driven UI.** Custom fields, statuses, stages, task types and sources are _fetched configuration_, rendered by registries. Adding a field type means adding a renderer, not editing 12 screens.

---

## 2. Route structure

```
apps/web/src/app/
├── (public)/                       marketing site, login, register, invite accept,
│   └── s/[siteSlug]/[[...path]]    published tenant websites (ISR + tag revalidation on publish)
├── (onboarding)/onboarding/[step]  guided wizard, resumable (FR-ONB-1)
├── (app)/                          ← authenticated tenant shell (sidebar + topbar + command palette)
│   ├── today/                      DEFAULT for Sales Executive          (FR-TSK-7)
│   ├── dashboard/                  DEFAULT for Owner/Admin/Manager
│   ├── leads/
│   │   ├── page.tsx                list · saved views · filter bar · bulk actions
│   │   ├── [id]/                   lead detail (tabbed, see §5)
│   │   ├── import/                 wizard (step decided by the job's own status, ?job=…)
│   │   └── exports/                generated files, with their expiry
│   ├── pipeline/                   kanban
│   ├── tasks/                      buckets: due now / today / overdue / upcoming / done
│   ├── inbox/                      shared WhatsApp inbox (3-pane → stacked on mobile)
│   │   └── [conversationId]/
│   ├── customers/                  list · detail (journey + details tabs) · new
│   ├── deals/                      board (default) · ?view=list · [id] detail · new
│   ├── quotations/                 list (current versions · ?versions=all) · [id] detail
│   │                               (draft editable, sent frozen) · [id]/pdf relay
│   ├── payments/                   list (received vs filter total) · [id] receipt
│   ├── reports/                    leads · sources · campaigns · users · pipeline · SLA · conversion
│   ├── marketing/                  campaigns · attribution · segments · SEO
│   ├── analytics/                  website · funnel · journeys · realtime
│   ├── automation/                 workflows · runs · registry-driven editor
│   ├── websites/                   builder · pages · domains · SEO
│   ├── settings/                   org · users/roles · fields · pipelines · statuses · sources ·
│   │                               products · quotation numbering · payment methods ·
│   │                               industry (the picker lives on the organization screen)
│   │                               assignment · scoring · duplicates · SLA · tasks config ·
│   │                               whatsapp · integrations · api keys · webhooks · billing ·
│   │                               privacy · notifications · audit log
│   └── search/                     global results
└── (platform)/admin/               Super Admin console (separate shell + separate auth realm)
    ├── overview/ organizations/ plans/ features/ templates/ services/
    ├── system/ (health · queues · failed jobs · webhooks · integrations · api usage · storage)
    ├── analytics/ (MRR · churn · trial conversion · usage) · tenants/[id]/health
    └── support/ · audit/ · flags/ · settings/
```

**Landing route resolution** (server-side, on the authenticated layout): `executive → /today`,
`manager → /dashboard?scope=team`, `owner/admin → /dashboard`, `marketing → /marketing`,
`platform → /admin/overview`; overridable per user. Onboarding-incomplete orgs are redirected to the
wizard; suspended/expired orgs land on a dedicated billing screen that keeps read access where the
plan allows (`FR-BIL-3`).

### Rendering strategy

| Surface                                        | Strategy                                                                        | Why                                              |
| ---------------------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------ |
| App shell, navigation, permissions, org config | **Server Components**, fetched once per navigation, cached per request          | Fast first paint; no client waterfall for config |
| Lists, boards, inbox, dashboards               | Client Components + TanStack Query with a server-prefetched `HydrationBoundary` | Interactive filtering without losing SSR speed   |
| Lead detail                                    | Server shell (header/context) + client tabs (timeline, inbox, tasks)            | Header is instant, heavy tabs stream in          |
| Published tenant websites                      | ISR/static + CDN, revalidated by tag on publish                                 | `FR-WEB-5` performance                           |
| Admin console                                  | Mostly client-side after an SSR shell                                           | Low traffic, high interactivity                  |

The web app **never** talks to Postgres or Redis. Server Components call the API over HTTP with the
user's token forwarded; there is exactly one authorization implementation, in the API
(`FR-TEN-3`).

---

## 3. Data & state layers

| Concern      | Tool                                                                       | Rules                                                                                                                                                                                                              |
| ------------ | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Server state | **TanStack Query v5**                                                      | Query keys are always `[entity, orgId, params]` — org id in every key, so an org switch cannot show stale cross-org data. `staleTime` 30 s for lists, 5 min for config, `Infinity` for immutable (timeline pages). |
| Mutations    | TanStack `useMutation`                                                     | Optimistic updates for status/stage/assignment/read-state with rollback on error; `Idempotency-Key` on creates/sends; invalidate by entity tag.                                                                    |
| UI state     | **Zustand** slices                                                         | Sidebar, modals, selection, filter drafts, composer drafts (persisted to `localStorage` per conversation so a refresh never loses typing). No server data in Zustand.                                              |
| Forms        | RHF + Zod resolver                                                         | Schemas imported from `packages/contracts`; server field errors mapped back onto inputs via `error.details[].field`.                                                                                               |
| URL as state | `nuqs`-style search params                                                 | Filters, view id, tab, cursor and sort live in the URL so views are shareable and the back button works.                                                                                                           |
| Realtime     | Socket.IO client                                                           | On event: patch the cache or invalidate the key; never render straight from socket payloads. Reconnect triggers a `since` catch-up fetch.                                                                          |
| Auth tokens  | httpOnly, `SameSite=Lax` cookies for **both** the access and refresh token | No token in `localStorage` **or in JavaScript at all** (`NFR-SEC-2`) — see §10.3. Silent renewal happens in the Next proxy, not in a client fetch interceptor.                                                     |

**Org switching** clears the query cache, re-reads `/auth/me`, and re-resolves navigation — no
cross-tenant residue in memory (`FR-IAM-6`).

---

## 4. Design system

Tokens (CSS variables, light + dark) in `packages/ui`: neutral greys for surfaces, one restrained
primary for actions, semantic colours for state only (success/warning/danger/info). **No decorative
gradients** (`NFR-UX-6`). Stage/status/tag colours are tenant data, rendered through a helper that
guarantees a contrast-safe text colour against any chosen background.

Typography: Inter (system fallbacks), 4 sizes + 2 weights per surface; tabular numerals for all
metrics. Spacing: 4 px base scale. Radius: 2 sizes. One elevation level for cards, one for overlays.

Component inventory (`packages/ui`): `AppShell`, `Sidebar` (permission-filtered), `Topbar`,
`CommandPalette` (⌘K: go to lead by name/phone, jump to screen, run action), `DataTable`
(column config, sticky header, row selection, bulk bar, virtualized, server pagination, saved-view
aware), `FilterBar` (chips from the same DSL the API parses), `SavedViewSwitcher`, `KanbanBoard`
(`@dnd-kit`, per-column paging, optimistic move), `Timeline` (type→renderer registry, grouped by
day), `DynamicFieldRenderer` + `DynamicForm` (see §6), `LeadCard` (mobile), `TaskCard` (swipe: done /
reschedule), `StatCard`, `Chart*` wrappers, `ConversationList`, `MessageBubble`, `MessageComposer`
(template picker, media, canned replies, 24 h-window warning), `LeadContextPanel`, `EmptyState`,
`Skeleton*`, `ConfirmDialog` (typed confirmation for destructive actions), `Toast`, `PermissionGate`,
`EntitlementGate` (renders an upgrade prompt instead of a broken feature), `SLABadge`, `ScorePill`,
`SourceBadge`, `PhoneActions` (call/WhatsApp/copy).

Charts: a thin wrapper over Recharts with a shared categorical palette, axis/tooltip/legend defaults
and accessible colour pairings, so every chart in the product looks like one system.

Accessibility (`NFR-UX-5`): Radix primitives for focus management, visible focus rings, labelled
inputs, `aria-live` for toasts and inbox arrivals, keyboard paths for every primary action (`j/k`
navigate list, `e` complete task, `r` reschedule, `/` search, `⌘K` palette),
`prefers-reduced-motion` respected, AA contrast enforced by a token test.

---

## 5. Key screens

### 5.1 Today (Sales Executive) — the most important screen in the product

One request (`GET /my/today`) returns everything; the page must be useful in under one second on a
mid-range Android over 4G.

```
Good morning, Rahul                                    [⌘K]  [🔔 3]
You have 12 follow-ups today · 3 overdue · 5 new leads
┌──────────┬──────────┬──────────┬──────────┐
│ Due now  │  Today   │ Overdue  │ New leads│   tappable → filters the list below
│    2     │    12    │    3     │    5     │
└──────────┴──────────┴──────────┴──────────┘
⚠ OVERDUE (3)                                          ← always first, red, never collapsed
  Amit Shah · +91 98… · Site visit follow-up · 2 days late
  [Call] [WhatsApp] [Done] [Reschedule]
NEXT UP (12)   grouped by hour
  10:30  Priya Mehta · Budget ₹50L · Score 82 (hot) · Facebook
         [Call] [WhatsApp] [Done] [Reschedule]
NEW LEADS NEEDING FIRST CONTACT (5)  · SLA 43 min left
UNREAD WHATSAPP (4)
```

Every card action is one tap. `Done` opens a sheet with outcome + "create next follow-up" preselected
(`FR-TSK-6`). `Reschedule` **requires** date, time and a reason (`FR-TSK-5`) — the reason list is
tenant config, "Other" reveals a note field. Actions are optimistic and queued: a tap on a flaky
connection is never lost, and the card shows a retry state if the request ultimately fails.

### 5.2 Lead detail — three columns on desktop, stacked on mobile (`FR-LEAD`, §55 of the brief)

```
LEFT (320px)                CENTER (flex)                     RIGHT (300px)
Customer identity           Tabs: Overview · Timeline ·        Status  [▾]
name, phone, WhatsApp,      WhatsApp · Tasks · Calls ·         Stage   [▾]  (validates required fields)
email, city, company        Notes · Deals · Website ·          Owner   [▾]
Source + campaign chips     Marketing · Documents              Score 82 ▲ (why? → breakdown)
Tags                                                          Next follow-up · 10:30 tomorrow
Custom fields by section    Timeline = unified activity        Open tasks (3)
Consent flags               stream, day-grouped, filter by     SLA: first response met (12m)
Duplicate warning banner    type, infinite scroll              Quick actions:
Created / last activity                                        [Call][WhatsApp][Task][Note][Quote]
```

The timeline renderer is a registry: `activity.type → component`. An unknown type degrades to a
generic row rather than crashing — so a backend that ships a new activity type before the frontend
does is safe (`FR-TL-1`).

### 5.3 Shared WhatsApp inbox (`FR-WA-7/8`)

Three panes on desktop (conversations | messages | lead context), stacked with back navigation on
mobile. Conversation list: filters (unread, mine, unassigned, priority, tag, SLA breaching), search,
unread badges, assignee avatar, 24 h-window countdown. Messages: grouped by day, status ticks
(sent/delivered/read/failed with error reason), media previews, reply-to, internal notes inline but
visually distinct, @mentions with autocomplete. Composer: free text disabled with a clear
explanation when the 24 h window has closed, template picker with variable preview filled from the
lead, canned replies via `/`, media upload with type/size validation. Ownership: a soft lock shows
"Priya is replying…" to prevent two agents answering at once; transfer and close/reopen are one
action with an audit trail. Realtime throughout; unread counts update across panes.

### 5.4 Dashboards

Owner: today's funnel counts, pipeline value by stage, conversion rate trend, leads by source with
_revenue_ (not just counts), top/bottom performers, overdue exposure. Manager: SLA board, overdue by
executive, unassigned queue, no-next-action list, leaderboard, response times. Marketing: spend →
leads → CPL → customers → CAC → revenue → ROAS by channel/campaign, funnel, journey explorer,
attribution model selector (visibly labelled on every number). WhatsApp: volume in/out, median
first-response time, unread, resolved, template performance. All cards read rollups and are
cached; every number has a drill-through to the filtered list behind it (a metric you cannot click
is a dead end).

### 5.5 Settings & automation

Settings is a two-level nav with search, each page a small focused form with inline help and a
"preview/test" affordance where behaviour is non-obvious (assignment rule test, duplicate rule test,
scoring preview, template preview, webhook test, ingestion test). The automation editor is a
**registry-driven vertical step list** in v1: `GET /automation/registry` returns triggers, conditions
and actions with JSON Schemas, and the UI renders forms from those schemas — so a new backend action
type appears in the UI with no frontend release (`FR-AUT-8`). The same definition JSON will feed the
visual canvas later; no migration of workflow data will be required.

---

## 6. Dynamic field rendering

```ts
// packages/ui/src/dynamic-fields/registry.ts
export const fieldRenderers: Record<CustomFieldType, FieldRenderer> = {
  text: TextField,
  textarea: TextareaField,
  number: NumberField,
  currency: CurrencyField,
  date: DateField,
  datetime: DateTimeField,
  select: SelectField,
  multiselect: MultiSelectField,
  radio: RadioField,
  checkbox: CheckboxField,
  boolean: SwitchField,
  url: UrlField,
  email: EmailField,
  phone: PhoneField,
  file: FileField,
  image: ImageField,
  user_ref: UserPicker,
  lead_ref: LeadPicker,
};
```

`DynamicForm` takes the definitions (fetched + cached as org config), groups by section, sorts by
`sortOrder`, applies role visibility, builds a Zod schema at runtime from each definition's
`validation`, and renders through the registry. The same definitions drive: lead create/edit, the
form builder preview, public form rendering, list columns (`showInList`), the filter bar
(`isFilterable`), import mapping, template variable pickers and automation condition builders — one
metadata source, six consumers, zero duplication (Rule 3, `FR-LEAD-6`).

Adding a field type = one renderer + one validator entry + one backend type. No screen edits.

---

## 7. Performance

Route-level code splitting; heavy modules (charts, kanban DnD, website builder, rich text) lazy-loaded.
`next/image` for all media with S3 loader. `DataTable` and `ConversationList` virtualized
(`@tanstack/react-virtual`). Infinite queries with cursor pagination — the client holds one page plus
what it has scrolled through, never a full dataset. Debounced (300 ms) search with request
cancellation. Prefetch on hover/intent for lead rows and conversations. Budgets enforced in CI via
Lighthouse on `/today`, `/leads`, `/inbox`: LCP < 2.5 s and TTI < 3.5 s on Moto G-class 4G, initial
JS ≤ 200 KB gzip per route, CLS < 0.1. A PR that regresses a budget fails.

---

## 8. Error, offline & permission handling

A global error boundary per route segment with a retry action and the `requestId` for support.
Mutations surface API `error.code` through a code→copy map (one place to write user-facing error
text, localizable). `403 PERMISSION_DENIED` renders an explanatory panel, not a redirect loop.
`403 LIMIT_EXCEEDED` / `FEATURE_NOT_IN_PLAN` render an upgrade card with the actual limit and usage
from `error.details`. Flaky-network resilience for executive actions: task complete/reschedule and
message send are queued in memory with retry and a visible pending state (a salesperson in a
basement must not lose a completion). Full offline support is explicitly out of scope for v1 but the
mutation queue is the seam where it would be added.

---

## 9. Testing

| Layer     | Tool                                  | Scope                                                                                                                                                                                                                                       |
| --------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit      | Vitest + Testing Library              | Field renderers, validators from definitions, filter-DSL builder, date/timezone helpers, permission gates                                                                                                                                   |
| Component | Vitest + MSW                          | Lists, forms, composer, timeline renderers against mocked API contracts                                                                                                                                                                     |
| Contract  | Generated client + OpenAPI diff       | Typecheck fails if the API shape changed                                                                                                                                                                                                    |
| E2E       | Playwright                            | Critical journeys: register → onboarding → create lead → assign → complete follow-up with reschedule reason → send WhatsApp template → convert; plus an executive mobile-viewport run and a permission run (executive cannot open settings) |
| Visual    | Playwright screenshots on key screens | Catch layout regressions in Today / lead detail / inbox                                                                                                                                                                                     |
| A11y      | `axe-core` in E2E                     | Zero critical violations on the top 10 screens                                                                                                                                                                                              |

---

## 10. As built — Phase 1, step 5

What shipped, and where it departs from the plan above. Recorded here rather than quietly diverging:
a plan that is contradicted by the code is worse than no plan.

### 10.1 Departures, with reasons

| Planned                             | Built                                                                | Why                                                                                                                                                                                                                                                                                                      |
| ----------------------------------- | -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Next.js 15                          | **Next.js 16**                                                       | 16 was current when the app was created. Its `middleware.ts` is deprecated in favour of `proxy.ts`, which is what `src/proxy.ts` uses.                                                                                                                                                                   |
| shadcn/ui (Radix)                   | **no component library**                                             | Phase 1 needs eight components (card, stat, table, badge, button, field, empty state, error notice). A library earns its weight when there are dialogs, comboboxes and date pickers to get right — that is the CRM screens, and it can be adopted then without rewriting these pages.                    |
| TanStack Query for all server state | **server components; TanStack Query kept as a dependency for later** | Every Phase 1 screen is a read that must be correct at first paint and is re-read after a mutation. A client cache adds a loading state, a second source of truth and a hydration boundary, and buys nothing until there is polling, infinite scroll and optimistic status changes — i.e. the lead list. |

> **Amendment, 2026-10-05 (Phase 2 step 4).** The lead list is built and the prediction above did
> not hold: it needed no client cache. Filters, sorting, the active saved view, the page cursor and
> the kanban's per-column pages all live in the **URL**, which makes a filtered list shareable,
> survives a reload, gives the back button the behaviour it looks like it has, and keeps the page a
> server component with one source of truth. Mutations are server actions that revalidate the paths
> they changed. Measured on a 100 000-lead tenant, `/leads` renders in 126 ms p95 and `/pipeline` in
> 103 ms — so there is nothing a cache would be bought with. TanStack Query remains an unused
> dependency; the first screen likely to need it is the WhatsApp inbox in Phase 5, which has polling
> and optimistic sends.
> | Zustand for UI state | **not yet introduced** | Nothing in Phase 1 has UI state that outlives a component. |
> | Mutations via `useMutation` | **server actions** | The access token is in an httpOnly cookie, so only the server can attach it. See §10.3. |
> | Types from a generated OpenAPI client | **hand-written client (`lib/api.ts`) speaking the documented envelope** | The spec is published in Phase 4. A generated client for a spec that does not exist would be fiction; the hand-written one is deliberately thin so it can be deleted. |
> | Shared Zod schemas from `packages/contracts` | **route-handler schemas local to the web app** | `packages/contracts` does not exist yet. The API validates authoritatively; the web app validates only what its own route handlers accept. |
> | Tokens in `packages/ui` | **`apps/web/src/app/globals.css`** | They move to `packages/ui` when a second app needs them (the tenant website renderer, Phase 7). |
> | `(public)` and `(onboarding)` route groups | **`login/`, `accept-invitation/` at the root; onboarding is a card inside `/settings`** | There is no marketing site in this repo yet, and a four-step checklist did not justify a route group with its own layout. The wizard is resumable and server-stored as planned. |

### 10.2 Routes that exist

```
/                          resolves by session → /dashboard or /login
/login                     sign-in (two-factor completion not built — the form says so)
/accept-invitation         the page invitation emails link to
(app)/dashboard            what exists in phase 1, honestly — no invented charts
(app)/notifications        the caller's own inbox
(app)/settings             organization profile, plan, ingestion key, onboarding wizard
(app)/settings/members     people, seat usage, invite, revoke, role and status changes
(app)/settings/roles       roles and a read-only permission × role matrix with scopes
(app)/settings/security    own sessions, end one or all, account security summary
api/session/*              sign-in, sign-out, org switch, invitation accept (cookie handling)
```

Navigation lists Phase 2–9 destinations as inert rows labelled with their phase, rather than omitting
them. An honest "arrives in phase 5" beats a link that 404s and beats a menu that hides the product's
shape from someone evaluating it.

### 10.3 The authentication model, as built

This is the part that differs most from the plan, and it is a deliberate tightening of `NFR-SEC-2`:

- **Neither token is ever readable by JavaScript.** Sign-in posts to the web app's own
  `/api/session`, which exchanges the credentials with the API and sets the access token as an
  httpOnly cookie. Server components read it with `cookies()`. The plan had the access token in
  memory, which survives XSS only until the attacker reads the variable.
- **No `/api/proxy/*` catch-all.** A route that forwards an arbitrary path with the caller's token
  attached is a confused deputy. Mutations go through named server actions instead.
- **The API's refresh cookie is re-scoped when relayed.** The API sets `Path=/api/v1/auth`, which no
  route of the web app serves; relayed unchanged, the browser would hold a cookie it could never
  send and every session would end after fifteen minutes. `lib/refresh-cookie.ts` rewrites the path
  and nothing else.
- **Renewal happens in `proxy.ts`,** only when the access cookie is absent and a refresh cookie is
  present, and the new token is injected into the same render — so the renewal is invisible rather
  than a redirect through sign-in. A failed renewal drops the refresh cookie so the next navigation
  does not repeat the round-trip.
- **Signing out revokes at the API as well as clearing the cookie.** Dropping the cookie alone would
  leave a session that a stolen refresh token could still renew.

### 10.4 Permission handling, as built

`lib/nav.ts` filters navigation by the permissions `/auth/me` reports. That is presentation only.
Two rules make it more than decoration:

1. **Every route is enforced by the API,** and the browser checks assert it: typing `/settings/roles`
   as a sales executive renders the API's refusal, not the page.
2. **Scopes decide whether a request is worth making, never what the caller may do.** Seat usage
   requires an organization-scoped `user:read`, so the members page reads `user.scopes['user:read']`
   before asking — a branch-scoped grant would earn a 403, and a card that always 403s is a defect,
   not a security control.

One tightening beyond the API: the ingestion `publicKey` is returned to anyone with
`organization:read` (which every role holds, because everyone needs the timezone and currency), but
the settings page shows it only to someone with `organization:manage`.

### 10.5 Verification

`pnpm --filter @leados/web test` covers the pure logic — navigation filtering, onboarding progress,
cookie relaying, error copy. Everything that only exists in a browser was verified by driving the
**built** app with Playwright against a real API and a real worker: sign-in and cookie flags, the
permission-filtered shell, organization save and reload, the onboarding wizard, invite and revoke,
the roles matrix, session listing, the notification badge clearing, accepting an invitation, a spent
token being refused, switching between two tenants, silent renewal after the access cookie is
dropped, and a signed-out visitor being redirected. Four narrower-scoped and cross-tenant personas
were driven through the same screens.

Four suites, **62 checks**, all green against the built app — plus an invitation-acceptance suite that
runs once per minted token. Two of the defects fixed in this step were found only here: the dev seed
had been failing since an earlier refactor, and `WEB_ORIGIN/accept-invitation` was a page that did not
exist.

Those checks are development scripts, not committed tests: they need a booted API, a worker and seed
data. Turning them into a CI job is Phase 12 work (`docs/implementation-roadmap.md`).

### 10.6 Verification — Phase 2, step 4 (the lead screens)

`pnpm --filter @leados/web test` covers the pure logic added here: the filter ⇄ URL codec (including
the round trip of a value containing the separators, which is how a tilde-escaping bug was found),
money and relative-time formatting, score-band tone resolved by _position in the range_ rather than
by name, and the timeline renderer registry — asserted against every type in the shared registry, so
the fallback is proven for the phases not yet built.

Everything that only exists in a browser was driven against the **built** app with a real API and
worker: the list, its saved-view chips and its filter bar; a filter that matches nothing; a mangled
filter URL; sorting; creating a lead and landing on it; a refusal that lands on the field and keeps
what was typed; the detail screen's tabs, transitions and score breakdown; the kanban board, a move
through the accessible picker, and per-column pagination; bulk assign and a bulk tag that must not
delete the tags already on a lead; a 375 px viewport; and a permission run as an executive.

**Five suites, 81 checks**, all green — including a **100 000-lead tenant** built by
`packages/db/perf/leads-100k.sql`, where the board's first column holds 14 285 leads and returns
ten. Three of the four defects fixed in this step were found only here, and the fourth only by the
fixture: Zod's developer-facing messages reaching users, a refused form emptying itself, and an
unindexed foreign key making lead deletion quadratic.
