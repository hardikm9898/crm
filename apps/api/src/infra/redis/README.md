# infra/redis

One connection, and a key builder that makes a cross-tenant key hard to write by accident.

- `key(organizationId, ...parts)` produces `org:<id>:…`, or `platform:…` when the id is explicitly
  `null`. Passing `null` is a visible decision at the call site; forgetting the argument is a type
  error. Nothing builds a Redis key by string concatenation.
- `ping()` is what `/health/ready` reports on, and it waits for the handshake first
  (`waitUntilReady`). That wait exists because `enableOfflineQueue: false` makes any command issued
  before the connection is ready fail immediately — the right behaviour on the request path (fail fast
  beats hanging) and the wrong behaviour for a probe running moments after boot.

**Redis holds nothing that cannot be rebuilt** — cached principals (five minutes), rate-limit counters,
BullMQ's own structures. A flush costs latency and re-authorization, never data. That is what makes it
acceptable to run it without persistence guarantees.

**Two practical notes.** Rate-limit windows are fifteen minutes and outlive a test run, so integration
tests need their own Redis database (`REDIS_URL_TEST`) as well as their own PostgreSQL. And `*.rdb` is
gitignored: the compose stack keeps its snapshot in a named volume, but a Redis started by hand in the
working directory writes `dump.rdb` next to the source, and one of those got committed.
