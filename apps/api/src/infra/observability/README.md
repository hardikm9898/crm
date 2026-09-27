# infra/observability

Structured logging with Pino, and the redaction that makes it safe to keep.

- `LOGGER` is the injectable token; `PinoLoggerService` adapts it to Nest's own logger interface.
- Every line carries `service`, and inside a request also `requestId`, so one request's path through
  the system can be reconstructed from the logs alone.

**Redaction is a list, and the list is the interesting part.** Authorization headers and cookies,
passwords and hashes, access/refresh/challenge tokens and token hashes, secrets and credentials, TOTP
codes and recovery codes, and the PII that has no business in a log (email, phone) are replaced with
`[redacted]`, at the top level and one level down.

Pino matches the **whole property name**, not a substring — which is why `challengeToken`,
`tokenHash`, `recoveryCodes` and `mfaSecret` are listed individually rather than being assumed
covered by `token` and `secret`. Anything genuinely secret that acquires a new property name has to
be added here; nothing infers it.

Email _bodies_ are not on the list, because nothing in production logs one: the development mailer is
the only thing that does, and it logs at `debug` for exactly that reason (`infra/mail`).

Log level comes from `LOG_LEVEL`. Tracing and metrics are Phase 12 (`docs/deployment-architecture.md`);
what exists now is the correlation id, which is the part later work builds on rather than replaces.
