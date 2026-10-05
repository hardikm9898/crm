# The lead screens

The list, the record, and the board — the first screens a business actually works in.

## URL state, not client state

Filters, sorting, the active saved view, the page cursor, the detail screen's tab and the kanban's
per-column pages all live in the **URL**. That is four things at once:

- a filtered list is **shareable** — "look at these six leads" is a link;
- it survives a reload and the back button undoes a filter, which is what the back button looks like
  it does;
- the page stays a **server component**: one source of truth, no hydration boundary, no second cache
  to go stale after a mutation;
- and "why am I seeing these rows" is answerable from the address bar.

`?f=city:eq:Pune~priority:in:high,urgent` is the whole filter. `~` separates conditions within an
AND group, `|` separates OR groups, values are percent-encoded. `lib/lead-filters.ts` is the codec
and it is round-trip tested — including a value containing the separators, which is how a missing
tilde escape was found (`encodeURIComponent` leaves `~` alone).

Decoding is deliberately **forgiving**: a malformed condition is dropped, not thrown. A URL is
something people edit, truncate and paste into chat, and a filter bar that shows an error page
because one chip was mangled is worse than one that shows the chips it understood.

## Nothing about the fields is hardcoded

The filter bar is built from `GET /views/fields` — a field list, and per field the operators it
supports and where its choices come from. A custom field added a minute ago is filterable without a
deploy (rule 4, `FR-LEAD-6`). The same is true of statuses, stages, sources, tags and bands: every
picker on these screens is a list of rows.

## A saved view runs as a view

`POST /leads/search` is sent `viewId`, not the view's expanded filter. The API resolves it, checks
its visibility and applies its sort — reimplementing that here is how the browser and the server
drift, and the thing that drifts is the view a business opens every morning. The view's conditions
are still rendered as chips so the rows are explainable.

## Transitions are separate forms

Status, stage, owner and tags each have their own form and their own server action, because each is
its own endpoint on the API with its own permission, preconditions and history table. One "save"
button over all four would have to guess which of them the person meant to change — and a lead that
moved stage because somebody edited their phone number is a bug nobody can explain.

The API validates a stage's required fields and refuses with the list. That refusal is shown
verbatim rather than being duplicated here: two copies of the rule would eventually disagree, and
the browser's copy would be the wrong one.

## A refused form keeps what was typed

A server action re-renders the server tree, the client form remounts, and every uncontrolled input
resets — so a validation error emptied eight fields. The submission comes back in
`ActionState.values` and each input takes its `defaultValue` from it.

## The timeline is a registry, not a switch

`lib/timeline-registry.ts` maps `activity.type → a sentence`, and an unknown type degrades to a
readable line built from its module and action. That is what lets the API start writing
`whatsapp.template_sent` before this app knows the phrase (`FR-TL-1`) — asserted against every type
in the shared registry, including the phases not yet built.

## One page per kanban column

Each column is its own request for ten leads, and "Load more" grows that column alone through the
URL (`NFR-PERF-4`). On a 100 000-lead tenant the first column reports 14 285 and returns ten; all
seven columns load in 53 ms p95. A board that loaded every lead in a stage would be unusable for
exactly the tenant who needs a board.

Moving a lead is offered two ways on purpose: dragging, which is what people expect, and a picker on
each card, which works with a keyboard, with a screen reader, and on a phone where the destination
column is off-screen. Both post to the same action, so both go through the same validation.

## Mobile-first where the work happens

Below `sm` the list is one card per lead with its call and WhatsApp actions, not a six-column table
in a horizontal scroll nobody uses. The detail screen stacks identity → centre → controls, because
at 375 px the first thing wanted is who this is and how to reach them (`NFR-UX-1`).

## The import wizard is a URL, not a component state machine

`/leads/import` shows step one; `/leads/import?job=<id>` shows whichever step that job's **own
status** has reached. So the wizard is reloadable, linkable to a colleague who knows the column
names, and survives a closed tab halfway through a 12 000-row file. Holding the file and a
forty-column mapping in client state would lose all of that to one stray refresh.

The dry run appears as soon as the file is read, before anybody saves a mapping — the proposal is
already stored, so the common case is "upload, read what will happen, press Import". It is fetched
with `GET /imports/:id/check`, never the `POST …/validate` that records the step: a page that re-ran
a state transition on every refresh would be a state machine driven by the reload button.

A running import polls by calling `router.refresh()` every two seconds — the page is a server
component, so "refresh" means re-reading the job from the API, which is exactly what should happen.
The poll stops the moment the run is no longer in flight, so a forgotten tab does not poll all
afternoon.

## Downloads go through a route handler, not a link to the API

Both tokens are httpOnly cookies, so the browser cannot call the API directly.
`/leads/import/[id]/errors.csv` and `/leads/exports/[id]/download` are thin relays: no parsing, no
re-encoding, and the API's own `content-disposition` is passed through, so the file somebody saves is
byte-for-byte the file the API wrote. Rebuilding the CSV here would be a second implementation of the
format — and the formula guard that makes it safe to open in Excel is part of that format.

## Export means the list on screen

The Export button carries the same `?view=` or `?f=` the screen just ran. An unfiltered export asks
once before it generates, because "every lead in the workspace" is rarely what somebody meant by
pressing a button next to a list. Columns are not chosen here: the default set is right nine times
out of ten, and a column picker in a dropdown is the kind of thing that makes somebody give up and
copy rows by hand.
