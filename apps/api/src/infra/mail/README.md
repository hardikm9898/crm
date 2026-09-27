# infra/mail

A port with one development adapter. Providers arrive with the integrations framework in Phase 4.

- `mailer.port.ts` — `MAILER` token and `OutboundEmail` (`to`, `kind`, `subject`, `text`).
- `logging.mailer.ts` — writes the message to the log instead of sending it.

**The development mailer refuses to run in production.** It throws in its own constructor if
`NODE_ENV === 'production'`. A silently-not-sending mailer in production means nobody receives a
password reset while every request returns 200 — the worst kind of failure, because it looks like
success.

**It logs at `debug`,** because the body contains single-use tokens. Practical consequence: boot the
worker with `LOG_LEVEL=debug` or invitation, verification and reset links are simply absent from the
log, and the flow looks broken when it worked.

**Nothing in a request path calls this.** Mail is sent by queue processors reached through the outbox,
and the single-use token is minted **in the processor**, not by the request — so no usable credential
is ever written to the outbox table or a queue payload. A request that returns 201 has committed the
intent to send; the send survives a crash immediately afterwards.
