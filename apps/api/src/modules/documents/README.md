# modules/documents

The index of everything in object storage. One service, no controller.

- `documents.service.ts` — `store()`, `read()`, `discard()`, `sweepExpired()`.

**No controller, on purpose.** A file is always reached through the thing that owns it — an import's
error file, an export's download — because that is where the permission belongs. A generic
`GET /documents/:id` would have to invent one, and the invented answer would be wrong for at least
one of its callers.

**A row per object, because the row is tenant-scoped and the bucket is not.** Every read above this
service names a document id, which the scoped client refuses to return for another tenant. So a
storage key never has to be trusted, and nothing above the port can enumerate what a bucket holds.

**The order of operations is the same in both directions, and it is not arbitrary.** Writing: bytes
first, then the row — a row pointing at missing bytes is a download that fails in front of a person,
while bytes with no row are an orphan a sweep can find by prefix. Deleting: row first (soft), then
the bytes — a document still listed but whose bytes are gone is the worse of the two.

**Expiry is checked on read, not only by the sweep.** The sweep runs hourly; the promise an export
link makes is "this stops working after N hours". A read of an expired document answers **410**, not
404: the file did exist, and "expired" is the one thing the person needs to know.

**Storage is metered.** `store()` checks the `storage_bytes` entitlement, counted from this table
rather than from the bucket — the table is the tenant-scoped truth, and a bucket-wide sum would be a
cross-tenant read.

**`scan_status` is `pending` and nothing scans.** The column exists so virus scanning (Phase 12) does
not need a migration, and `pending` is honest about the fact that nothing has looked at the file.
