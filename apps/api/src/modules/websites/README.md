# websites

Phase 7, steps 1–5 — the website model, its pages, the version a publish pins, the block registry,
the forms a page places, and what a page tells a crawler
(`FR-WEB-1`, `FR-WEB-2`, `FR-WEB-3`, `FR-WEB-5`, `FR-WEB-6`).

## What this module is, in one sentence

Three things that must not be confused with each other: the **draft** (`websites` plus
`website_pages`, which the editor changes), the **version** (an immutable snapshot, written on
publish), and what is **served** (always a version, never the draft).

Keeping those apart is the whole of `FR-WEB-5`. A renderer that read the draft would make "rollback
restores the previous version exactly" unachievable, because there would be nothing to restore
_to_: the only record of what the public saw would be rows somebody has since edited.

## What is not here yet

| Arrives in | What                                                                            |
| ---------- | ------------------------------------------------------------------------------- |
| Step 6     | `website_domains`, verification, TLS                                            |
| Step 7     | Template content, the consent banner, and the phase's usability gate            |
| Phase 8    | `websites.tracking_site_id` — a column with no reader is a column with a defect |

Steps 2 to 5 have landed. Their notes are in `docs/implementation-roadmap.md`; what belongs here is
the one thing a reader of _this module_ needs and would not guess.

## Versioned is what somebody wrote; live is what the business is

The public read (`GET /public/sites/:subdomain`) answers a snapshot **and four things beside it**,
and which side of that line a fact falls on is a decision, not an accident:

| Beside the snapshot | Why it is not in it                                                                                                        |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `site.baseUrl`      | One answer to "where does this site live", so a canonical and a sitemap entry cannot disagree. Step 6 changes it here only |
| `forms`             | A rotated public key must stop working, and an edited form must stay current                                               |
| `business`          | Trading hours live in `working_hours`; a second copy is one that can disagree with the one customers read                  |
| `products`          | A price frozen into a published version goes stale in structured data, where that is a penalty rather than a typo          |
| `redirects`         | A rollback of the _content_ must not delete redirects added since, and 404 links other people published                    |

Everything in the snapshot is content: blocks, titles, `seo`, `seo_defaults`, the theme. It changes
when somebody publishes and not before.

## A redirect chain is collapsed, so a loop is unrepresentable

`website_redirects` keeps one invariant: **no `to_path` is ever another row's `from_path` on the same
site.** It is kept by rewriting, not by refusing — adding `/b` → `/c` when `/a` → `/b` exists rewrites
the first to `/a` → `/c`, and pointing a new redirect at an address that has itself moved stores the
final one. Renaming a page twice is an ordinary thing to do; refusing it would be unusable and
allowing the chain would serve two hops to a crawler that counts them.

The payoff is a renderer with one lookup and no loop guard. **A page always wins over a redirect**,
declared in the renderer alone: creating a redirect whose source is a page is refused, and a page
created at an existing redirect's source leaves it listed as `shadowed` with a sentence saying why it
does nothing.

`GET :id/served` exists so that step 1 can be verified at all: it answers what a visitor _would_
be served once step 2 can serve it. It is behind `website:read` and is not a public route.

## Permissions

`website:read` and `website:manage`. Two rather than one, unlike `automation:manage`: a website has
plenty worth reading without changing — what is live, what the draft says, which version is serving
— and `auditor` is a role whose entire purpose is that.

Publishing is deliberately **not** split from `website:manage`. A role that may rewrite every word
of a live page's draft but not press the button protects nothing, because the next publish by anyone
ships their text.

Both keys are new, so `20261106095500_phase7_website_permission_grants` grants them to the
`is_system` roles of workspaces that already existed: adding a key to `PERMISSION_CATALOGUE` reaches
new workspaces and nothing else. `PrincipalService` then caches grants for five minutes, so a 403
can outlive the migration by that much.

## Things that will bite

- **`websites.subdomain` is globally unique, with no `organization_id` beside it.** An inbound
  request for `acme.leados.app` carries nothing else, so the column has to resolve one workspace
  across all of them. The collision check therefore runs under `withPlatformScope` — the
  tenant-scoped client cannot see the row it would collide with — and answers 422 with a sentence.
  Without that it is a raw unique violation: a 500 on a mistake somebody could have fixed.
- **A rollback writes a new version.** It does not move `published_version_id` backwards. Moving it
  would be fewer writes and would make the history a lie: "what was live on Tuesday" would have two
  answers, and a site rolled back twice would look like a site nobody had touched.
- **A version row cannot be updated at all**, by trigger. Not a convention a service happens to
  follow: a method that does not edit a snapshot today is not the same promise as an edit that
  cannot happen.
- **Snapshots are compared by deep equality, never by bytes.** JSONB does not preserve key order.
- **`websites_published_has_version` is one-way.** Its mirror ("a draft has no published version")
  reads just as sensibly and is false — unpublishing keeps the pointer so republishing is one
  write. A later migration that "tidies" it into an equality would pass an existence check and make
  taking a site offline impossible.
- **The home page is a partial unique**, so making a second page the home page clears the first in
  the same transaction. A plain unique would have allowed one home page _and_ one non-home page per
  site, which is the opposite of the rule.

## Step 2 — the public read path and revalidation

`GET /public/sites/:subdomain` is the one endpoint a visitor's browser reaches, through the renderer
at `apps/web/src/app/s/[siteSlug]/[[...path]]`. It returns the **whole snapshot** of the published
version, because a snapshot is what publishing produces: a page at a time would mean a site
assembled from reads that can disagree about which publish they came from.

**A draft is indistinguishable from a site that never existed** — same status, same code, same
message, and the draft's name nowhere in the body. A distinct "not published yet" would make an
unreleased site's existence, name and plans readable by anybody who guessed the address.

The read is `withPlatformScope`, because a `@Public()` route has no principal and the tenant-scoped
client throws without one. A route reaching for `db.client` here would answer 500 to **every**
visitor, including those asking for a site that does not exist — the integration framework's inbound
door paid for exactly that once.

`publish`, `unpublish` and `rollback` each emit an outbox event, and
`maintenance.site-revalidate` calls the web app's `POST /api/revalidate-site` to drop the site's
cache tag. All three, because all three change what the public sees: revalidating only on publish
would leave a withdrawn site served from cache, which is the failure nobody tests for because the
screen says "offline".

- The tag is keyed on the **subdomain**, which is why the event payload carries it: the site's id is
  deliberately absent from the public response, so there is no id for a tag to use.
- `WEB_REVALIDATE_SECRET` is optional in the config schema and **fatal in the job**. Required at boot
  would refuse to start every deployment upgrading into this release without it; a throwing job
  dead-letters and names the variable the first time somebody publishes.
- The web route uses `revalidateTag(tag, { expire: 0 })`. `'max'` — which Next's own deprecation
  message suggests — marks the tag stale instead, so the first request after a publish serves the
  **previous** version. That is the most confusing moment this feature has.

## Step 3 — the block registry

`GET /websites/block-catalogue` serves `WEBSITE_BLOCKS`, and the editor renders one control per
declared field. Served rather than bundled for the reason the automation catalogue is: adding a
block type reaches a running editor without a frontend release.

A block type costs **one declaration and one renderer**, and no editor code. That is Phase 6's
registry argument with its conclusion corrected — a block is a layout, and a schema cannot describe
one, so the renderer is unavoidable. The renderer map in `apps/web` is typed
`Record<BlockType, …>`, which makes a declared type with no renderer and a renderer nothing declares
both type errors; there is no boot check here because the compiler already does it.

Both page write paths call `validateBlocks`. The important property is the asymmetry:

- **Write refuses** an unknown block type. Nothing should be able to save a block this release
  cannot draw.
- **Read tolerates** one. A rollback to a snapshot from a newer release must not blank a live site,
  so the renderer skips what it does not know and draws the rest.

Problems are addressed as `blocks[2].params.heading`, so a screen prints each against the field it
names. `fieldErrors` in the web app is keyed by that `field`, which is why the addressing matters:
a summary-only refusal is the `ERROR_COPY` defect, and the mapping editor paid for it.

`url` and `string_list` were added to `PARAM_TYPES` for this registry. No automation action uses
either; an editor renders the types **its own** registry declares, not every type in the list.

## Step 4 — a form on a page (`FR-WEB-6`)

A page places a form with a `form` block whose `formId` is a `reference`. The editor renders a
picker from the endpoint the catalogue declares for that kind (`/forms`), and the published page
mounts `PublicForm` — the same component `/f/:key` uses. One honeypot, one validation path, one
submission contract: a second capture engine for websites would have drifted from the first within a
phase, and "zero manual integration" means there is nothing to wire.

**The form's key is resolved per read, not snapshotted.** A page is versioned because its content
is what somebody publishes; a form is live. Snapshotting the key would keep a rotated key working —
the one thing rotation exists to stop — and snapshotting the questions would leave published pages
asking the old ones. It is returned beside the snapshot, never inside it, because the snapshot has
to stay byte-stable across reads.

A form deactivated or deleted between the publish and the visit is **absent** from the map, and the
renderer draws nothing for that block.

Shape is all `validateBlocks` can check, so the service queries for the row — through the
**tenant-scoped** client, which makes "another workspace's form" and "no such form" the same
refusal. A distinguishable answer would turn a form id into an oracle.

`website_forms` was **not** created; see `database-design.md` §10's as-built note. The block is
already the declaration, and both questions a join table would answer have answers.
