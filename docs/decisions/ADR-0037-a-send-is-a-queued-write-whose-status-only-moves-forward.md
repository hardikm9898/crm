# ADR-0037 — A WhatsApp send is a queued write whose status only moves forward, and whose failure is never silent

- **Status:** accepted
- **Date:** 2026-10-19
- **Context:** Phase 5 step 2 — sending: the window, the template, and a failure nobody can miss
- **Builds on:** [ADR-0036](./ADR-0036-an-inbound-message-becomes-a-lead-through-the-capture-path.md)

## Context

An agent types a reply and presses send. Between that moment and the customer reading it there are
four things that can go wrong and one rule that decides whether it may be sent at all:

- **Meta's 24-hour rule** (`FR-WA-1`). Outside the service window only an approved template may be
  sent. Meta refuses anything else, with an error code.
- **The provider is somebody else's server.** It can be slow, busy, or down; it can refuse this
  message for ever (a template that does not exist in that language) or refuse it for a second (a
  429).
- **Status receipts arrive out of order and more than once.** `read` before `delivered` is routine
  on a busy number, and Meta redelivers.
- **A refusal that nobody sees is a customer who never got an answer** (`FR-WA-9`).

## Decision

**1. The row is written before the send, and the send is a job.** `POST /conversations/{id}/messages`
validates, writes a `queued` message and answers `202`-shaped with that row; the queue hands it to
Meta. A message somebody typed is therefore never lost to a provider timeout, per-number rate
limiting is possible because the sends are serialised, and the thread shows the message immediately
— which is what everybody expects of a chat.

**2. One decider owns the window.** `sendingAllowed({ windowExpiresAt, kind })` in `@leados/shared`
is called by the write path **and** by the composer. The screen greys the text box using the same
function that would refuse the send, so "the button was enabled and the send was refused" cannot
happen. The refusal names the way through ("only an approved template can reach them now") because
a refusal that only says no is a dead end.

**3. `accepted` is not `sent`.** Meta taking the message means it is queued **at Meta**; the `sent`
receipt is what says it left. Writing `sent` on acceptance would make every message look delivered
to an agent whose customer has a flat battery.

**4. The status is a summary that only moves forward; the timestamps are facts.**
`messages.status` moves only when the new status is further along (`statusAdvances`), and the move
is a **conditional update** — `UPDATE … WHERE status IN (statusesBeatenBy(next))` — not a read, a
decision and a write: these jobs run at the queue's concurrency and three receipts for one message
arrive together, so a read-then-write loses the race. Every receipt still writes its **own**
timestamp column and its own `message_status_events` row, because "it says delivered and she never
got it" is answerable only if the instants are kept.

**5. A retryable failure is not a failure.** The adapter answers `retryable` for a 429 or a 5xx and
the message stays `queued` with the attempt counted; five attempts, or any other refusal, marks it
`failed` with **Meta's own sentence**. A failure is then said three times: on the message in the
thread with a "try again" beside it, on the lead's timeline, and as a notification to whoever sent
it — the only work notification in this product that is **not** held for quiet hours, because the
cost of holding it is paid by a customer waiting for an answer.

**6. A retry reuses the row.** A second row would read as the customer having been messaged twice.
The attempt count is what makes the retry visible.

## Consequences

- **The screen can show a message before anybody has sent it**, so `queued` has to read as
  something honest ("On its way") rather than as a tick.
- **A worker that is down holds messages**, like reminders, mail and held notifications before it.
  `maintenance.whatsapp-send-retry` sweeps every two minutes — the shortest sweep in the product
  after the notification release, because the thing waiting is a customer.
- **The conditional update means the service cannot report "I moved it" from its own read.** It
  reports from the row count, which is the only honest source when another job may have moved it a
  millisecond earlier.
- **Rate limiting is a floor we keep, not a limit we discover.** Meta's ceiling depends on the
  number's messaging tier and is not readable from the API, so `WHATSAPP_SENDS_PER_SECOND` defaults
  to ten — far under every tier — and a workspace that needs more raises it deliberately. Over the
  limit the job is re-queued rather than failed, and the attempt is not counted against the message.
- **`delivered` and `read` are deliberately absent from the timeline.** A business owner opening a
  lead wants the conversation, not four rows per message; the status lives on the message, where
  somebody looking at that message is already looking.
