# infra/storage

A port with one driver. The S3 driver arrives with the media-heavy phases; nothing above the port
changes when it does.

- `storage.port.ts` — the `STORAGE` token, `StoragePort`, `documentKey()` and `assertSafeKey()`.
- `local-disk.storage.ts` — objects as files under `STORAGE_LOCAL_ROOT`.

**Two things are deliberately absent from the contract.** There is no `list`: the `documents` table
is the index, and it is tenant-scoped — a driver-level listing would be the one read path in the
system that crosses tenants. And there is no public URL: a download is always served by the API,
after a permission check, so no caller can assume bytes are reachable without one. A pre-signed S3
URL is an optimisation that driver may add later, not something the port promises.

**Every key is validated in one place.** `assertSafeKey()` refuses an empty, absolute or
`..`-containing key, and the local driver _also_ re-resolves the path and checks it is still inside
the root. Two checks for the same thing, on purpose: the cost of being wrong once here is reading
`/etc/passwd`.

**Keys are tenant-first** — `org/<organizationId>/<subject>/<yyyy-mm>/<id>-<name>` — because that
is the prefix an operator deletes when a workspace is purged, and what a bucket policy or lifecycle
rule can be written against. The month folder keeps a local directory survivable; the id keeps two
uploads of `leads.csv` from colliding; the sanitised original name is kept so an operator can tell
what a file is.

**The local driver writes to a temporary file and renames it.** `rename` within a filesystem is
atomic, so a reader fetching a document while an export is being written never sees half a CSV.

**Unlike the development mailer, it is not refused in production.** A single node with a mounted
volume is a legitimate deployment (`docs/deployment-architecture.md` §3). What it cannot do is serve
a _replicated_ API — two nodes would each have half the files — so the production checklist calls for
the S3 driver as soon as the API scales out.
