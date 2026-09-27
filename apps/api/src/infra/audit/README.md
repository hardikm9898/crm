# infra/audit

Writes the audit trail (`FR-AUD-1`). Append-only **at the database level**, enforced by a trigger, so
this service has no `update` and no `delete` — there is nothing to add later.

- `recordInTransaction(tx, entry)` is the preferred form: the trail commits with the change it
  describes, so there is no window where one exists without the other.
- `record(entry)` exists for events that have no surrounding transaction (a failed login).

**Attribution is ambient, never supplied.** Actor, IP, user agent and request id come from
`tenantContext` and `requestStore`, not from the caller's arguments. A caller therefore cannot
attribute an entry to someone else, and cannot forget to attribute it at all. `organizationId`,
`actorType` and `actorLabel` are accepted explicitly only for events that happen _before_ a tenant
context exists — sign-in being the one that matters.

**Retention is a trigger, not a cron job.** `packages/db/src/audit-purge.ts` exposes
`withAuditPurge()`, which sets the flag the trigger checks; deletes outside that helper are refused.
The forward migration that introduced it also moved the trigger's error to the default `P0001` code,
because Prisma mistranslated `restrict_violation` as "Foreign key constraint violated" and the real
reason never reached the client. The audit table's own FKs are `RESTRICT` for the same reason a
composite FK cannot be `SetNull`: nulling `organization_id` is not an option.
