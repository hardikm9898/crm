# ADR-0039 — A conversation lock is advisory, an unclaimed conversation is everybody's, and a `STOP` is applied in the request that carried it

- **Status:** accepted
- **Date:** 2026-10-20
- **Context:** Phase 5 step 4 — the shared inbox (`FR-WA-7`) and the opt-out keyword (`FR-WA-10`)
- **Builds on:** [ADR-0036](./ADR-0036-an-inbound-message-becomes-a-lead-through-the-capture-path.md), [ADR-0037](./ADR-0037-a-send-is-a-queued-write-whose-status-only-moves-forward.md)

## Context

`FR-WA-7` opens with "many agents on one business number". Everything hard about this step follows
from that sentence: two people can be looking at the same customer, one of them may be away from
their desk, and the customer is waiting either way. `FR-WA-10` adds the one rule that must never
lose a race — a customer who types `STOP` must stop receiving marketing, immediately.

Four facts shape the decisions below:

- **A conversation has no branch and no team.** `conversations` carries `assigned_user_id` and
  nothing else about who may see it, so every data scope narrower than the whole workspace
  resolves to "assigned to me".
- **A seeded sales executive holds `conversation:read` and `conversation:reply` at `own` scope.**
  That is the role template, and it has been since Phase 1.
- **A workspace with no assignment rule leaves every incoming conversation unassigned.** This is
  the common case, not an edge: assignment rules are opt-in.
- **Consent is a boolean on the lead**, read by the send path at send time.

## Decision

**1. An unclaimed conversation is readable and answerable by anybody who holds the permission.**
`conversationScopeWhere` adds `OR assigned_user_id IS NULL` to whatever the scope resolved to, for
all four services that touch a conversation — the reader, the sender, the attachment store and the
ownership changes. Without it a shared inbox is unreadable by the people it is for: an own-scoped
executive sees only conversations somebody has already given them, so a new customer's first
message is visible to nobody but an owner or an admin. The conversations at the greatest risk of
never being answered were the ones the inbox hid. This is the `/my/today` lesson one module later,
and the narrow reading is the one that cannot be defended: a conversation nobody owns is precisely
the one somebody has to be able to pick up. Assignment, transfer and the audit trail are what make
picking it up accountable.

**2. The lock is advisory, five minutes long, and separate from ownership.** `assigned_user_id` is
ownership: it survives a closed tab, it drives "my conversations", and changing it is an audited
act. `lock_user_id` with `lock_expires_at` is "I am typing", taken by opening a conversation and
refreshed by replying. Using one column for both would either lose ownership when somebody closed
a tab or leave a conversation permanently claimed by whoever opened it first.

A reply by somebody who is not the holder **goes through**. The requirement asks that two agents on
one conversation _see_ each other, which is a sentence on a screen; refusing the second one means a
customer waits until a colleague's five minutes run out, possibly while that colleague is at lunch.
Taking over somebody's lock is allowed and written to the audit log, which is the accountability a
refusal would have bought at the customer's expense.

**3. The sentence is one function, called from both sides.** `conversationLock` in `@leados/shared`
answers `{ held, mine, expiresAt, message }` from the viewer's own side, and the API returns that
state rather than two raw columns. "You have this conversation open" and "Nikhil opened this four
minutes ago — check with them before replying" are a reassurance and a warning; a single sentence
for both would be neither, and a screen computing its own answer from `lock_expires_at` is how two
readings of one row diverge.

**4. A lapsed lock is swept, even though every read already ignores it.** The read is honest
without the sweep; the **column** is not. A row saying "Nikhil holds this" three days after Nikhil
went on holiday is something a person will read and believe, and a `lock_expires_at` that nothing
clears means every screen and every query has to remember to compare it to the clock. One of them
eventually will not.

**5. A snooze is delivered, not merely expired.** `snoozed_until <= now()` as a list predicate
would make a conversation visible before anything had told the person who asked to come back to it
— the decision the notification release sweep already made, for the same reason, and why both run
every minute. The sweep wakes the row with a conditional `UPDATE … WHERE status = 'snoozed'`, so a
conversation somebody closed a second earlier is not dragged back by a job that is behind.

**6. `STOP` is applied in the request that received the message.** Not in a job: `FR-WA-10` says a
revocation suppresses marketing sends _immediately_, and a queue hop is a window in which a
campaign reads the old value and sends the person the thing they asked to stop. The write, the
timeline entry and the audit row are one transaction.

**7. The keyword list is short, and the ambiguous words are deliberately off it.** `stop`,
`unsubscribe`, `optout`, `remove me` and their spellings are matched against the **whole** message,
trimmed and case-folded. `no`, `cancel`, `end` and `quit` each appear on somebody's published
opt-out list and each is a word a customer uses mid-conversation — "no" answers "would Saturday
suit?", and "cancel" is about an appointment far more often than about marketing. A false positive
here silences a customer **invisibly**: nothing on any screen says why they stopped getting
messages, and the one person who could explain it is the customer. The error that costs a marketing
message is cheaper than the error that costs a relationship.

**8. A mention is an id the client sends, not a name the service parses.** Matching `@Asha` against
member names is ambiguous the moment a workspace has two Ashas, and wrong in the quiet direction:
the wrong person is told and the right one is not. The composer offers a picker, submits ids, and
the body keeps the text somebody typed — written in one request so the two cannot disagree. Every
id is checked against `Membership`, because an array column cannot carry a foreign key.

## Consequences

- **"Own scope" means something slightly wider for conversations than for leads**, and that is a
  real asymmetry in this product's authorization rather than an accident. It is stated in
  `conversation-scope.ts`, which is the one place it is implemented.
- **Two agents can reply to one customer.** The lock makes it visible and the audit log makes it
  reconstructable; nothing makes it impossible, because the thing that would is worse.
- **A worker that is down holds snoozed conversations and stale locks**, like reminders, mail, held
  notifications, queued sends and media downloads before it. The read stays honest throughout,
  which is why this failure is milder than the others.
- **Notes are their own table.** A note is never sent, so putting one in `messages` would make
  every "did we reply?" query and every export carry a predicate it could forget — and one
  forgotten predicate shows a colleague's private words to a customer.
- **A snooze writes no timeline entry.** "The inbox hid this for two hours" is a fact about
  somebody's working day, not about the customer; the audit log has it, which is where a question
  about the inbox belongs. Assignment, transfer, close and reopen **are** on the timeline, because
  a business owner reading a lead wants to know who was answering and why it stopped.
- **`consent.granted` and `consent.revoked` came off the deferred activity list four phases early.**
  They were down for Phase 13's consent centre; `FR-WA-10` writes them now, and the entry carries
  the word the customer actually sent so "why did we stop messaging her?" has an answer.
- **A second `STOP` writes nothing.** They were already stopped, and a product that logged it twice
  would read as not having listened the first time.
- **An automatic acknowledgement is _returned_, not sent.** `consentAcknowledgement` gives the
  workspace the words; whether to send them is the send path's decision, because a reply to `STOP`
  is itself a message and the 24-hour window rules apply to it. One rule about sending, in the one
  service that owns it.
