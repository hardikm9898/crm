# modules/exports

Background exports of the lead list (`FR-IO-3`).

- `exports.controller.ts` — catalogue, list, create, get, download
- `exports.service.ts` — the job, the permission decisions, the audit entries
- `export-generator.service.ts` — the paged scan and the CSV
- `exports.processor.ts` — `export.generate` on the `imports-exports` queue

## The decisions

**A job, not a response.** A hundred thousand leads cannot be assembled inside an HTTP request, and
a file that exists afterwards is one a person can fetch twice and come back to after lunch.

**Personal data is a permission, not a warning.** `export:data` lets somebody export; the moment a
chosen column is personal data, `export:pii` is required too. A sales executive taking a pipeline
report home is not the same act as taking ten thousand phone numbers, and the audit entry names who
did it. The check is repeated at **download**, not only at creation: permissions change, and a file
of personal data must stop being reachable by somebody whose access was taken away.

**Which columns are personal data is declared, not derived.** `EXPORTABLE_LEAD_COLUMNS` in
`@leados/shared` carries a `pii` flag per column, and custom fields carry their own. A list derived
from the schema would silently classify the next column somebody adds as non-personal.

**The link expires.** An export URL bears the whole list to anyone who has it, so the document
carries an expiry (`EXPORT_RETENTION_HOURS`) and the hourly sweep drops the bytes. The row stays:
who exported what is history, and deleting the evidence with the file would defeat the audit entry.
A listing therefore computes `downloadable` from the expiry too — `completed` alone would keep
offering a download that answers 410.

**A saved view is resolved at generation time.** The point of exporting a view is that it is the
view's _current_ definition; a copy of its filter taken at request time could be stale by the time
the job runs.

**The filter compiles to Prisma predicates and the data scope still applies.** An export is a read
like any other: `export:data` at `own` exports that person's leads, not the workspace's. Nothing
here builds SQL, for the same reason nothing else does.

## Traps

- **The scan is paged by id, not offset.** A 100 000-row export under an `OFFSET` that grows is
  quadratic, and rows created during the run would shift the window.
- **The finished file is held in memory**, because the storage port takes a `Buffer`. That is why
  `MAX_EXPORT_ROWS` is 100 000 and why the CSV is appended a page at a time rather than built from a
  2D array of every cell. Streaming an object into storage is a port change that belongs with the S3
  driver.
- **A currency custom field is `{ currency, amountMinor }`.** `String()` renders it
  `[object Object]`; a multi-value field renders as `a,b`, which is indistinguishable from two
  columns once it is in a CSV. `renderCustom()` handles both, and money uses `minorUnitExponent` so
  an export and a lead screen never disagree about where the point goes.
- **Every cell goes through `csvCell`.** A lead whose name is `=cmd|…` is a spreadsheet formula
  waiting for somebody to open the file.
