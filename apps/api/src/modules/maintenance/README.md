# Maintenance module

**Purpose.** Scheduled housekeeping. No controllers and no HTTP surface: this module exists to own
the processors that the scheduler triggers.

## Jobs

| Job                             | Cadence      | What it does                                         |
| ------------------------------- | ------------ | ---------------------------------------------------- |
| `maintenance.trial-check`       | daily 08:23  | Gives a lapsed trial a grace period, then expires it |
| `maintenance.invitation-expire` | every 30 min | Marks invitations past their expiry                  |
| `maintenance.session-prune`     | daily 03:17  | Deletes sessions expired or revoked over 30 days ago |
| `maintenance.outbox-reap`       | every 5 min  | Surfaces events the dispatcher is not publishing     |

Times are deliberately off the hour: everything scheduled at `:00` contends for the same minute,
and a unit test asserts no daily job lands there.

## Tables

Writes `subscriptions`, `invitations`, `sessions`, `outbox_events` (the `trial.expired` event) and
`job_failures` (stuck events).

## Business logic

- **Trials lapse gently.** The end of a trial starts a 3-day grace period, not a wall; only an
  expired grace makes the organization read-only, and **nothing is deleted** (`FR-BIL-3`). The
  transition invalidates the cached entitlements and subscription state so it takes effect on the
  next request rather than up to a minute later.
- **Expiring invitations frees seats.** Acceptance already rejects an expired invitation; this makes
  the admin's list truthful and stops abandoned invitations holding seats against the plan limit.
- **The reaper exists because outbox lag is silent.** If events stop flowing, every endpoint still
  returns 200 while follow-ups are not created and messages are not sent, so a stuck event is
  mirrored into `job_failures` where an operator sees it next to failed jobs.

## Failure modes

All four are idempotent and platform-scoped (`withPlatformScope`), so a double firing or a retry is
harmless: running `trial-check` twice produces one `trial.expired` event, and the reaper writes one
row per stuck event. A failure waits for the next tick rather than being retried aggressively.

## Not here yet

Retention purges, analytics rollups, SLA sweeps, usage reconciliation and the rest of
`docs/queue-event-architecture.md` §5 — each arrives with the phase that produces the data it
maintains.
