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
`platform → /admin/overview`; overridable per user.

> **Amendment, 2026-10-13 (implementation, Phase 3 step 3).** Resolved by **permission**, in one
> place (`app/page.tsx`): `task:read` → `/today`, everybody else → `/dashboard`. Branching on the
> word "executive" is what rule 4 forbids — roles are rows a tenant edits, and the code would break
> the day somebody renames one. `task:read` is the honest test of "does this person have work owed
> to them". Sign-in, invitation acceptance and the workspace switcher all redirect to `/` rather
> than carrying a copy of the rule; the switcher in particular must, because permissions differ per
> workspace. Onboarding-incomplete orgs are redirected to the
> wizard; suspended/expired orgs land on a dedicated billing screen that keeps read access where the
> plan allows (`FR-BIL-3`).

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

> **Amendment, 2026-10-06 (implementation, Phase 3 step 1).** `/today` is **not** built. What is
> built is `/tasks` — the queue it will be made from — plus the follow-up panel on the lead detail
> screen and `/settings/follow-ups` for the vocabulary. The parts of the paragraph above that did
> ship, and the parts that did not:
>
> - **Shipped.** Completing a follow-up asks for an outcome (required, and the database agrees) and
>   offers "create next follow-up" on the same form, in the same transaction (`FR-TSK-6`).
>   Rescheduling requires a date, a time and a reason, and a reason the tenant marked
>   `requires_note` reveals a note field that the API also enforces (`FR-TSK-5`). Both are driven by
>   tenant configuration, not by a hardcoded list.
> - **Shipped, differently.** The sections are `overdue`, `due_now`, `due_today`, `upcoming`,
>   `completed` and `cancelled`, grouped by the clock rather than by the hour, and each counter is a
>   separate aggregate over the **whole filter** — a board that totals the loaded page tells an
>   executive they have twenty things to do when they have ninety. `noNextAction` sits beside them,
>   because an empty queue means nothing if forty leads have nobody owing them anything
>   (`FR-TSK-4`).
> - **Not shipped.** Optimistic, queued, retried actions. Every action is a server action and a
>   round trip; a tap on a flaky connection shows the refusal rather than surviving it. That
>   belongs with the Today workspace and its offline story, and it is listed as an open item in the
>   roadmap rather than quietly assumed.
> - **Not shipped.** `[Call]` and `[WhatsApp]` on a card — both arrive with their channels.
>
> **Amendment, 2026-10-07 (implementation, Phase 3 step 2).** The SLA screens are built: `/sla` is
> the breach board and `/settings/sla` the policies, and the lead detail screen carries the promise
> as a line in "At a glance". The `SLA 43 min left` the mock-up above shows is therefore real, just
> not yet on `/today`.
>
> Every count on the board is an aggregate over the whole filter, and every reading is derived from
> the clock rather than from the stored state — so a manager refreshing at 10:01 is never told a
> 10:00 promise is still fine because the five-minute sweep has not fired. "Answered late" is its
> own column beside "Missed": a clock somebody eventually got to is a different management problem
> from one still sitting there.
>
> The promise appears on the lead's own screen and not only on the manager's board, because a board
> a manager reads is no use to the person who could still answer in time.

> **Amendment, 2026-10-13 (implementation, Phase 3 step 3).** `/today` **is** built, and the
> mock-up above is now a fair description of it with four differences. What shipped:
>
> - **One request.** `GET /my/today` returns all five sections and nine counts. There is no
>   swallowing loader behind it: a Today screen that renders empty because the request failed is
>   the worst thing this product can do, so a failure takes the whole screen with it and says so.
> - **Four tiles, two columns at 375 px**, each a link to the full list behind its number. The
>   sections are `Overdue` (first, red, never collapsed), `Next up`, `Later today`, then
>   `Promises running out` and `New leads, nobody has called`. The promises come **above** the new
>   leads: a clock running out is a commitment the business has already made, and it outranks a
>   lead nobody has promised anything to yet.
> - **`[Call]` and `[WhatsApp]` are on the card after all**, as `tel:` and `wa.me` hand-offs to
>   the device — which is what somebody on a phone wants today, and is not the click-to-call
>   abstraction that _logs_ the call (that still arrives with the channels). WhatsApp appears only
>   for a lead who consented, and neither appears for a number that is not E.164.
> - **The actions are optimistic, queued and retried**, which is the part of the paragraph above
>   that step 1 listed as not shipped. A tap is recorded before the request leaves, retried at
>   0 s / 1 s / 2 s / 4 s, kept in `localStorage` across a reload, and shown as failed with a
>   "Try again" button once it has run out of attempts. A _refusal_ is never retried — see
>   [ADR-0024](./decisions/ADR-0024-today-is-one-request-and-its-taps-are-queued.md).
> - **`Done` is a sheet, not a dialog**, with the outcome required and "plan the next follow-up"
>   pre-ticked. A modal on a 375 px screen covers the thing somebody is deciding about.
>
> What did not ship: the **unread WhatsApp** section, which arrives with the inbox as an addition
> to the same payload; and `⌘K` and the keyboard paths of §4, which are still phase-later.
>
> Measured: `p95 = 60 ms` on the 100 k fixture against the 400 ms budget; no sideways scroll at
> 375 px; every card action at least 44 px tall. All three are asserted in the browser check.

> The due time is **two inputs, a date and a time**, not one `datetime-local`: that control renders
> differently in every browser, is close to unusable on an Indian Android keyboard, and cannot be
> given a sensible default time. The browser's own UTC offset rides along as a hidden field, because
> the server renders in UTC and "at 10:00" means ten o'clock where the person typing it is.

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

> **Amendment, 2026-10-14 (implementation, Phase 3 step 6 — calls).** The mock-up above puts
> **Calls** in the centre tabs and `[Call]` among the quick actions. As built, the calls panel is a
> card in the Overview column, between the follow-ups and the custom fields, because the sequence
> somebody working a lead reads in is _what is owed · what was said · who this is_ — and a tab hides
> the panel behind a click on the one screen where the phone is the point.
>
> - **The attempt nobody has recorded comes first, in amber, with its form already open.** A dialled
>   call leaves a `dialing` row, and with no telephony provider the product cannot know how it went;
>   an amber row asking the question is the only thing that reliably turns an attempt into a record.
>   `dialing` is the one status on the screen somebody can still do something about, which is why
>   it is the one that is not grey.
> - **The dial button says what it will do.** `GET /calls/config` carries `telephony.placesCalls`, so
>   the sentence under it reads "this opens your phone, and logs the attempt here" today and changes
>   itself the day a provider is connected. The server cannot open a `tel:` link, so the action hands
>   the href back and the button follows it — which is why `ActionState`'s success variant gained a
>   small `data` map.
> - **The outcome form asks once.** Not "did it connect?" and "what happened?" — the status is
>   derived from the chosen outcome's category (`statusForCategory`), and the duration boxes appear
>   only for a call that connected, because the API refuses a duration on one that did not.
> - **The follow-up is closed from the same form**, when the lead has exactly one open follow-up.
>   With more than one, guessing is worse than not offering it: closing the wrong follow-up is a lie
>   about what was done, and the queue screen is one click away.
> - **`/calls`** is the log: the calls awaiting an outcome first, as work, then the history. Four
>   figures over the whole filter — not the page — and `/settings/calls` holds the outcome
>   vocabulary, beside the follow-up vocabulary and for the same reason: renaming an outcome changes
>   what every past call reads as, which is not a thing to do from the screen where somebody is
>   logging one.

> **Amendment, 2026-10-14 (implementation, Phase 3 step 7 — email).** Two screens changed, and both
> changes are the same idea: a setting that was greyed out became real, and a silence became a
> sentence.
>
> - **`/notifications` now has a tick box per channel per type**, not one on/off switch. `email`
>   appeared there the moment there was a sender behind it; the channels the product still cannot
>   deliver on are **not rendered at all**, because a greyed-out box invites somebody to try it and a
>   live one would be a promise the product breaks. The list comes from the API
>   (`deliverableChannels`), so the sentence under the card cannot drift from what is true. The row
>   submits the **whole** channel set — PUT semantics, the same as the lead tag picker — because the
>   set is the intended final answer and a delta would make "turn email off" and "I never had it on"
>   indistinguishable.
> - **`/settings/members` marks a member the platform cannot email**, with the reason as a sentence
>   ("Email is bouncing — this address does not exist") and the date. The alternative is silence: a
>   colleague whose address hard-bounced stops receiving every notification they chose email for, and
>   nothing anywhere would say so. The reason is translated out of the column's vocabulary on
>   purpose — "bounce" tells somebody nothing, and "the address does not exist" tells them to go and
>   ask their colleague for a different one.
>
> There is deliberately **no screen for the suppression list itself**. It is platform data, the
> operator console that would edit it is Phase 10, and a tenant-facing screen listing other
> workspaces' bounced addresses is not a screen this product can have.

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

> **Amendment, 2026-10-13 (implementation, Phase 3 step 5).** The manager's half is built, as
> **`/oversight`** — one screen, `report:read`, narrowed by the reader's own scope.
>
> - **"Leaderboard" is a table with no rank, no score and no total**, and nothing on it counts
>   activity. A single number hides which dimension somebody is behind on and gets optimised the
>   moment it exists; an activity count would measure data-entry diligence and call it performance.
>   Every column is an outcome (answered on time, median reply, converted) or a cost (overdue,
>   moved, never called, nothing planned), and the screen says so where a reader would look for the
>   ranking. See
>   [ADR-0026](./decisions/ADR-0026-oversight-has-no-single-score.md).
> - **Every number is a link, and the link is defined beside the number.** `lib/oversight.ts` holds
>   each column's label, hint, kind and a function producing its destination; a spec asserts every
>   column produces one carrying that person's own id. The lead links are filter-DSL URLs, because
>   `/leads` has no query-parameter filters — a `?uncontacted=true` link renders the _unfiltered_
>   list, which is worse than no link, and `/today` paid for that once.
> - **"—", not 0 % and not 100 %**, for somebody who has answered nothing yet. A cost above zero is
>   the only thing on the table that is coloured, so the eye lands on the two numbers that need a
>   conversation rather than the forty that do not.
> - **The unassigned backlog is a tile of its own**, above the table: a lead with no owner is in
>   nobody's row, which makes it the number a manager would otherwise never see.
> - **The table scrolls sideways on a phone** rather than reflowing. These columns only mean
>   anything next to each other, and a stack of ten labelled numbers per person is not a table.
>
> `/dashboard` is still the Phase-1 screen it was: it has never pretended to have data it does not
> have, and the owner's funnel and revenue cards arrive with the rollups. The cards here read live
> aggregates for now, which §5.4 above says will become rollup reads — stated rather than quietly
> deviated from, because inventing the rollups now would mean two definitions of every number.

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
/                          resolves by session → /today, /dashboard or /login
/login                     sign-in (two-factor completion not built — the form says so)
/accept-invitation         the page invitation emails link to
(app)/dashboard            what exists in phase 1, honestly — no invented charts
(app)/notifications        the caller's own inbox, and the settings behind it
(app)/settings             organization profile, plan, ingestion key, onboarding wizard
(app)/settings/members     people, seat usage, invite, revoke, role and status changes
(app)/settings/roles       roles and a read-only permission × role matrix with scopes
(app)/settings/security    own sessions, end one or all, account security summary
api/session/*              sign-in, sign-out, org switch, invitation accept (cookie handling)
```

> **Amendment, 2026-10-13 (implementation, Phase 3 step 4).** `/notifications` is now the
> notification **centre**: the inbox, then the quiet-hours form, then a switch per notification
> type grouped under "Your work", "Leads" and "The workspace".
>
> - **The settings are on the same screen as the list, under it.** Somebody comes here because of a
>   notification they did or did not want, and making them find a second screen to act on that is
>   how a preferences page goes unused.
> - **One form per switch, no Save button over all of them.** A screen where somebody flips seven
>   switches, walks away, and is woken at midnight by the one they thought they had turned off is
>   worse than one that costs a tap per change. Each row prints its state as **text** beside the
>   button (`On`, `Off`, `Always on`) — a settings row whose value lives only inside a control is
>   one nothing can read back, which is the lesson the payment-methods list paid for.
> - **A held notification says so in the list** ("held for your quiet hours until 07:00"), because
>   the alternative is somebody reading a 21:40 timestamp at nine in the morning and concluding the
>   product is a night behind.
> - **The quiet-hours form is two `time` inputs and a zone**, with the zone a plain text box: the
>   API validates it against the runtime's own list and refuses anything else, and the common case
>   is leaving it blank to follow the workspace. The sentence above the form says what the window
>   does, and says when it crosses midnight — "between 21:30 and 07:00" otherwise reads as a
>   mistake somebody made typing it.
> - **There is no loader that swallows a failure here.** On this screen "nothing is configured" and
>   "the request failed" look identical, and the second would invite somebody to re-save settings
>   they already have — which on this screen means being woken up.
>
> Only in-app is offered, and the screen says why: a tick box for a channel that silently drops
> every message is worse than saying the channel is not here yet.

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

### 10.7 As built — Phase 4, step 1 (capture forms, and the page a stranger fills in)

`/forms`, `/forms/new`, `/forms/[id]` and — outside the authenticated shell — `/f/[key]`.

The route structure in §2 puts public pages under `(public)/`. The visitor-facing form is at
`app/f/[key]` instead: a bare segment with no group, because it shares nothing with the marketing
site or the sign-in screens and because its URL is pasted into other people's websites, where every
extra segment is something that can be mistyped. It renders with no navigation, no session and no
workspace switcher — nothing that would make sense to somebody who has never seen this product, and
nothing that would look wrong inside an `<iframe>` on a business's own site.

- **The form posts straight to the API from the browser**, which is the opposite of every other
  form in this app and deliberate: there is no session to attach, the endpoint is public, and
  routing a stranger's submission through our own server would add a hop that can fail without
  adding anything. It is also what lets the page work inside an iframe on another domain. The
  origin comes from `apiBaseUrl()` — `NEXT_PUBLIC_API_URL`, which is public precisely because the
  browser needs it.
- **The answers are React state, so a refusal loses nothing.** A 400 puts each message under its
  own field, and sends the visitor back to the first step that has something wrong with it — a
  field error for a question on another step is otherwise invisible, which is how a form becomes a
  dead end. This is the trap every server-action form in this product had to be taught, arrived at
  from the other direction.
- **"Next" validates this step only.** Refusing to advance because of a question not yet shown
  reads as a broken form.
- **The honeypot is off-screen rather than `display: none`.** A field a bot can see in the markup
  and a person cannot see on the screen is the whole trick; `hidden` is a flag some bots read.
  `tabIndex={-1}` and `aria-hidden` keep it away from a keyboard and a screen reader.
- **A switched-off form and a made-up key render the same page** ("no longer taking enquiries"),
  because any difference turns the key into an oracle (ADR-0029).

On the workspace side, `/forms/[id]` is ordered the way somebody uses it: the **link and the embed
snippet first**, because the next thing anybody wants after building a form is to put it on their
website; then the questions; then where captures land; then what has come in.

- **The builder holds the question list as state and saves it in one call.** A form's questions are
  an ordered list edited as a whole, and per-field saves would let "move this to step 2" half-apply.
- **It refuses to save a form that cannot reach anybody**, with the sentence under the list and the
  button disabled — the same check the API makes, made where somebody can act on it rather than
  after pressing Save. The questions already on the form are not offered again, so the "same
  question twice" refusal cannot be reached at all.
- **The submissions list prints the answers, with the labels the questions had** — and an answer to
  a question that has since been deleted is shown, in italics, as "not a question on this form"
  rather than dropped: the payload is kept whole precisely so "what did they actually type" has an
  answer. A dropdown's answer is shown as the **choice**, not the value stored under it, which the
  browser check caught reading "Which service: interiors" back to the person who wrote that
  dropdown.
- **The refusals are on the list screen too.** A form whose required question nobody can answer
  looks exactly like a quiet week, and the refused submissions are the only rows on that screen
  anybody has to act on.

**One suite, 30 checks**, all green: building a form by clicking from the menu, the key's link and
the iframe snippet, the builder's own refusal, a visitor filling in a two-step form at 375 px with
no session at all, a missing answer named under its own box, the thank-you in the workspace's own
words, the submission and the lead it became, the timeline entry carrying what they typed, a bot
thanked exactly as a person is with the refusal visible to the workspace, and a switched-off form
answering a sentence a visitor can act on.

### 10.8 As built — Phase 4, step 2 (the lead API's two screens)

`/settings/api-keys` and `/ingestion`, both behind `api_key:manage`. The first is where a
credential is made; the second is where somebody finds out what an integration actually sent. They
are two screens rather than one because they are read by the same person at different moments: the
key is created once, and the log is opened every time a lead does not appear.

- **The secret travels in `ActionState.data`, and nowhere else.** `create` and `rotate` are the only
  actions in this app that hand a credential to the browser. The API answers the secret exactly once
  and no endpoint will answer it again, so it cannot come from the re-rendered server tree the way
  every other value on the screen does — which is what `data` was added for (click-to-call needed
  the same thing for a `tel:` href). A refresh loses it; a browser check asserts that the page's
  HTML no longer contains it afterwards. Both halves are `readOnly` inputs rather than text: a
  credential somebody has to select by hand arrives in a config file with a space on the end.
- **The request to make is printed with this workspace's own public key in it**, and reads both
  halves of the credential from shell variables (`$LEADOS_KEY_ID`, `$LEADOS_SECRET`). A snippet with
  a secret pasted into it is a secret in a browser's history, in a screenshot and in a support
  ticket. The key id is not a secret and is still not printed in the list — the list shows the
  16-character prefix, because a screen printing full credentials invites a photograph of itself.
- **Three standings, not two.** Live, Expired and Revoked: a revoked key was switched off
  deliberately, and an expired one ran out while nobody was watching, which is the one of the two
  that is probably a broken integration right now. "Never used — nothing has signed a request with
  it yet" is said in words, because a key that was created and pasted somewhere wrong is the
  commonest question this screen answers.
- **`/ingestion` leads with the test tool and the failures, and puts the log last.** A screen that
  led with the log would bury the handful of rows somebody has to act on under the hundreds that
  worked — the same argument the forms screen makes for showing refused submissions above the forms.
  The headline sentence carries a plural per clause and omits what is zero.
- **The dry run's verdict is a sentence, not an inference.** "This would create a lead" or "This
  would be refused — see why below", above the normalised payload: a tool that printed JSON and left
  the answer to be worked out from it would be a tool for the person who wrote the endpoint. The
  result comes back as pre-formatted strings in `ActionState.data`, because a POST that persists
  nothing has no server tree to render from.
- **A replay reports itself from the server tree.** The button has no success message: a successful
  replay revalidates the screen, the payload leaves the "did not become leads" list, and the form is
  unmounted with its action state. The payload's own row says "Tried again just now — it became a
  lead", which survives a refresh and is the honest record. A refusal keeps the row, so its notice
  stays beside it.
- **The one click is three editable boxes and a button.** The key, the label and the kind are
  prefilled — `propertyType` → `property_type`, "Property type", and a kind guessed from the samples
  — and editable before the press, because a custom field's key appears in stored values, saved
  views, import mappings and index names and cannot be changed afterwards. A name that cannot be a
  key at all (a collision with a lead's own column) says so instead of offering a button that is
  certain to be refused, and the button is hidden entirely from somebody without
  `custom_field:manage`.

**One suite, 63 checks**, all green: a key created by clicking from the menu, its secret read out of
the card and then absent from the page's HTML after a refresh, that same credential signing a real
capture over HTTP, the log's sentence and figures agreeing with what was sent, a payload stored by a
crash finished from the screen (and the lead it became carrying what they said on its timeline), the
test tool's two verdicts with the reason the endpoint would give, the one click creating `agent_code`
and **the next payload filling it in**, rotation invalidating the old secret within a second, and a
revoked key reading as revoked with nothing able to post through it.

### 10.9 As built — Phase 4, step 3 (where this workspace's events go)

`/settings/webhooks`, one screen behind `webhook:manage` — a permission that has been in the
catalogue since Phase 1 with nothing reading it. There is no read-only variant: a delivery's body
carries the event's own data, so somebody who may read the log may already read the lead it is
about, and a second, poorer view of the same rows would be a second thing to keep correct.

- **The order is the order somebody uses it**: the endpoints, then what has been sent, then the code
  their server needs to verify a delivery. The verification snippet is **on the screen** rather than
  in a document, because the one thing that makes a receiving endpoint unsafe is trusting a body
  without checking its signature, and a developer who has to go and find that page will ship without
  it. Beside it, in words, is what the retries actually do — any 2xx stops them, `410 Gone` switches
  the endpoint off, everything else is retried at 10 s, 1 m, 5 m, 30 m, 2 h, 6 h and 24 h.
- **The secret is shown once, in `ActionState.data`**, exactly as the API key's is (§10.8): the API
  answers it on create and on rotate and will not answer it again, so it cannot come from the
  re-rendered server tree. Rotating keeps the endpoint and changes what signs it, which is the
  sentence on the card, because the alternative reading — that rotating makes a new endpoint — is
  how somebody ends up with two.
- **A refused URL says which rule refused it.** The classification (`https` only in production, no
  credentials in the URL, no loopback, link-local, private or metadata address, no non-443 port) is
  shared with the API and every branch has its own sentence: "that address is inside our own
  network" is actionable, "invalid URL" is not. The static check runs again against the **resolved**
  addresses at send time, so a hostname that becomes private later is refused then too.
- **The log is one row per delivery with its attempts folded inside it.** The status chip, the event,
  the endpoint, what the server answered, and — behind "The body we signed" — the exact payload and
  each attempt's code and duration. Folded, because the body is what you want on the one row in a
  hundred you are investigating; printed in full, it would be a screen of JSON per event.
- **[Send again] appears on the rows where it means something** — failed and exhausted, never on a
  succeeded or still-pending one — and a pending row shows no button rather than a disabled one,
  because a button that cannot be pressed is a question about why.
- **Three figures, each totalling the set rather than the page**: the endpoints, the recent
  deliveries (the API's `meta.pagination.total`, not the 25 rows rendered), and how many of them are
  not delivered. The summary sentence above them carries a plural per clause and omits what is zero.
- **"Switched off" is not one state.** An endpoint somebody switched off reads as off; one the
  product disabled after fifteen consecutive failures is listed as failing, with the reason, because
  those are opposite situations and the second one is an integration that is broken right now. The
  same event also raises a `webhook.disabled` notification that cannot be opted out of.

**One suite, 40 checks**, all green: an endpoint created from the form with its secret read out of
the card and then absent from the page after a refresh, four refused URLs each naming their own rule,
a test delivery arriving at a real in-process receiver with a signature the check verifies by hand,
a real lead capture fanning out to the endpoint that subscribed to it and not to the one that did
not, a 500 from the receiver producing a failed row with the next attempt stated, [Send again]
delivering it once the receiver answers 200, `410 Gone` switching the endpoint off with its reason
on the screen, the attempt list reading HTTP code and duration per attempt, and the verification
snippet containing this workspace's own header names.
