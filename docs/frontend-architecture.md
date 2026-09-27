# Frontend Architecture — Lead OS

**Stack:** Next.js 15 (App Router) · React 19 · TypeScript strict · Tailwind CSS · shadcn/ui (Radix) ·
TanStack Query · React Hook Form + Zod · Socket.IO client ·
Traces to: `NFR-UX-*`, `FR-VIEW-*`, `FR-TSK-7`, `FR-WA-7/8`, `FR-LEAD-3..6`

---

## 1. Principles

1. **Role-shaped, not feature-shaped.** An executive's app is a task list with a phone attached; an owner's app is an analytics product. Navigation, default route and dashboard are derived from permissions, not from a single menu everyone squints at.
2. **The server is the source of truth.** No business rules duplicated client-side beyond input validation (shared Zod schemas from `packages/contracts`) and optimistic UI.
3. **The API shape is generated, never hand-typed.** Types come from the OpenAPI client; a backend change that breaks the frontend fails typecheck in CI.
4. **Mobile-first where the work happens** (`NFR-UX-1`): Today, lead list, lead detail, tasks, WhatsApp, call, notes are designed at 375 px first, then scaled up. Analytics/config screens are desktop-first but never broken on mobile.
5. **Every screen has four states designed up front**: empty (with a primary action), skeleton, error (retryable), permission-denied. A "blank page while loading" is a defect (`NFR-UX-3`).
6. **Nothing unbounded reaches the browser.** Lists are paginated + virtualized; a kanban column loads a page per column (`NFR-PERF-4`).
7. **Metadata-driven UI.** Custom fields, statuses, stages, task types and sources are *fetched configuration*, rendered by registries. Adding a field type means adding a renderer, not editing 12 screens.

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
│   │   └── import/                 wizard
│   ├── pipeline/                   kanban
│   ├── tasks/                      buckets: due now / today / overdue / upcoming / done
│   ├── inbox/                      shared WhatsApp inbox (3-pane → stacked on mobile)
│   │   └── [conversationId]/
│   ├── customers/ · deals/ · quotations/
│   ├── reports/                    leads · sources · campaigns · users · pipeline · SLA · conversion
│   ├── marketing/                  campaigns · attribution · segments · SEO
│   ├── analytics/                  website · funnel · journeys · realtime
│   ├── automation/                 workflows · runs · registry-driven editor
│   ├── websites/                   builder · pages · domains · SEO
│   ├── settings/                   org · users/roles · fields · pipelines · statuses · sources
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

| Surface | Strategy | Why |
|---|---|---|
| App shell, navigation, permissions, org config | **Server Components**, fetched once per navigation, cached per request | Fast first paint; no client waterfall for config |
| Lists, boards, inbox, dashboards | Client Components + TanStack Query with a server-prefetched `HydrationBoundary` | Interactive filtering without losing SSR speed |
| Lead detail | Server shell (header/context) + client tabs (timeline, inbox, tasks) | Header is instant, heavy tabs stream in |
| Published tenant websites | ISR/static + CDN, revalidated by tag on publish | `FR-WEB-5` performance |
| Admin console | Mostly client-side after an SSR shell | Low traffic, high interactivity |

The web app **never** talks to Postgres or Redis. Server Components call the API over HTTP with the
user's token forwarded; there is exactly one authorization implementation, in the API
(`FR-TEN-3`).

---

## 3. Data & state layers

| Concern | Tool | Rules |
|---|---|---|
| Server state | **TanStack Query v5** | Query keys are always `[entity, orgId, params]` — org id in every key, so an org switch cannot show stale cross-org data. `staleTime` 30 s for lists, 5 min for config, `Infinity` for immutable (timeline pages). |
| Mutations | TanStack `useMutation` | Optimistic updates for status/stage/assignment/read-state with rollback on error; `Idempotency-Key` on creates/sends; invalidate by entity tag. |
| UI state | **Zustand** slices | Sidebar, modals, selection, filter drafts, composer drafts (persisted to `localStorage` per conversation so a refresh never loses typing). No server data in Zustand. |
| Forms | RHF + Zod resolver | Schemas imported from `packages/contracts`; server field errors mapped back onto inputs via `error.details[].field`. |
| URL as state | `nuqs`-style search params | Filters, view id, tab, cursor and sort live in the URL so views are shareable and the back button works. |
| Realtime | Socket.IO client | On event: patch the cache or invalidate the key; never render straight from socket payloads. Reconnect triggers a `since` catch-up fetch. |
| Auth tokens | httpOnly, `SameSite=Lax` refresh cookie; access token in memory only | No token in `localStorage` (`NFR-SEC-2`); silent refresh on 401 with a single-flight queue. |

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
*revenue* (not just counts), top/bottom performers, overdue exposure. Manager: SLA board, overdue by
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
  text: TextField, textarea: TextareaField, number: NumberField, currency: CurrencyField,
  date: DateField, datetime: DateTimeField, select: SelectField, multiselect: MultiSelectField,
  radio: RadioField, checkbox: CheckboxField, boolean: SwitchField, url: UrlField,
  email: EmailField, phone: PhoneField, file: FileField, image: ImageField,
  user_ref: UserPicker, lead_ref: LeadPicker,
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

| Layer | Tool | Scope |
|---|---|---|
| Unit | Vitest + Testing Library | Field renderers, validators from definitions, filter-DSL builder, date/timezone helpers, permission gates |
| Component | Vitest + MSW | Lists, forms, composer, timeline renderers against mocked API contracts |
| Contract | Generated client + OpenAPI diff | Typecheck fails if the API shape changed |
| E2E | Playwright | Critical journeys: register → onboarding → create lead → assign → complete follow-up with reschedule reason → send WhatsApp template → convert; plus an executive mobile-viewport run and a permission run (executive cannot open settings) |
| Visual | Playwright screenshots on key screens | Catch layout regressions in Today / lead detail / inbox |
| A11y | `axe-core` in E2E | Zero critical violations on the top 10 screens |
