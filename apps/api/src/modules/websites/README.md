# websites

Phase 7 step 1 — the website model, its pages, and the version a publish pins
(`FR-WEB-1`, `FR-WEB-2`, `FR-WEB-5`).

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
| Step 2     | The renderer at `s/[siteSlug]/[[...path]]`, ISR, tag revalidation               |
| Step 3     | The block registry and its validator — `blocks` is stored uninterpreted         |
| Step 4     | `website_forms`, and `FR-WEB-6`'s automatic wiring                              |
| Step 5     | Per-page SEO, `robots.txt`, `sitemap.xml`, structured data, redirects           |
| Step 6     | `website_domains`, verification, TLS                                            |
| Phase 8    | `websites.tracking_site_id` — a column with no reader is a column with a defect |

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
