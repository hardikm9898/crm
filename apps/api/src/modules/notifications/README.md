# notifications

A person's own in-app inbox, and the consumers that fill it.

## What lives here

| Route                             | Authorization                                | Notes                                       |
| --------------------------------- | -------------------------------------------- | ------------------------------------------- |
| `GET /notifications`              | `@NoPermissionRequired('own notifications')` | Cursor-paginated; `unreadOnly=true` filters |
| `GET /notifications/unread-count` | same                                         | What the shell's badge reads                |
| `POST /notifications/:id/read`    | same                                         | `@AllowWhenRestricted()`                    |
| `POST /notifications/read-all`    | same                                         | `@AllowWhenRestricted()`                    |

## Decisions worth knowing

**No permission gates these routes, and that is not a gap.** Every query is scoped to
`principal.actorId` inside the service, so the only reachable rows are the caller's own. A permission
would have to be one every role holds, which is a permission that decides nothing — the boot-time
route audit accepts this only with an explicit stated reason (docs/security.md §4).

**Housekeeping stays available in restricted mode.** Clearing your own badge is not a write anyone
needs to pay for, and a read-only tenant staring at an unclearable "3 unread" would reasonably think
the product was broken.

**Rows are written by outbox consumers, not by the request that caused them.** `invitation.accepted`
and `onboarding.completed` produce notifications from the worker, which is why an invitation accepted
at 2am shows up without anybody being online, and why the notification survives a crash in the
request that triggered it (rule 5).

**Consumers are idempotent on `eventId`** and take their subject from the envelope's `aggregateId`,
never from a field inside `payload` — an event emitted by an older release still has to process.

**`list` returns `{ items, pagination, unreadCount }`,** and the envelope interceptor lifts `items`
into `data` and `pagination` into `meta`. `unreadCount` is therefore _dropped_ from the response;
the shell reads `/notifications/unread-count` instead. Anything else added alongside a paginated
list would vanish the same way.
