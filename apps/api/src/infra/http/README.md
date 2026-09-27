# infra/http

The request pipeline: one response shape, one error shape, one place a request's identity lives.

| File                            | Role                                                                     |
| ------------------------------- | ------------------------------------------------------------------------ |
| `request-context.middleware.ts` | Opens the tenant context and the request store; assigns the request id   |
| `request-store.ts`              | Ambient request id, IP and user agent, for logs and the audit trail      |
| `envelope.interceptor.ts`       | `{ success, data, message?, meta }` for every response, applied globally |
| `app-exception.filter.ts`       | Maps every throw onto the error catalogue; nothing internal leaks        |
| `zod-validation.pipe.ts`        | Per-route body/query validation onto the field-error contract            |

**Why the middleware opens an _empty_ context.** `AsyncLocalStorage.enterWith` does not propagate out
of an awaited callee, and a Nest guard is awaited by the framework — so a principal set with
`enterWith` inside a guard is invisible to the route handler, silently. The middleware therefore calls
`tenantContext.runEmpty()` and the guard fills it with `setPrincipal()`. The store object is shared by
reference, which is the entire mechanism. (The middleware also `.catch(next)`s: a bare `void` swallowed
the rejection and the request hung instead of failing.)

**The envelope lifts pagination, and that has a consequence.** A handler returning
`{ items, pagination }` becomes `data: [...]` with `meta.pagination` — so **any other field returned
alongside a paginated list is dropped**. `notifications.list` learned this with its `unreadCount`;
the shell reads `/notifications/unread-count` instead. Conversely a collection with no pagination
block is _not_ lifted, which is why `fullPage()` exists.

**Errors never describe internals.** Stack traces, SQL and provider payloads stay in the log with the
request id; the client gets a catalogue code, a sentence written for a person, and that id.
