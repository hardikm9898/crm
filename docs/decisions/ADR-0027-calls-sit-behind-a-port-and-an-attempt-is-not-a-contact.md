# ADR-0027 — Calls sit behind a port, and an attempt is not a contact

**Status:** Accepted · **Date:** 2026-10-14 · **Phase 3, step 6** · Traces to `FR-CALL-1..3`,
`FR-TSK-6`, `FR-SCR-2`

## Context

`FR-CALL-1` asks for "click-to-call, call tasks, manual call logging with outcome, duration, notes
and optional recording URL". `FR-CALL-2` adds the constraint that makes this step a design problem
rather than a CRUD table: "Telephony MUST sit behind a provider abstraction so cloud telephony, IVR,
dialer, recording, transcription and AI summary can be added without touching CRM core."
`FR-CALL-3` says the outcomes "are a configurable list and feed scoring, SLA and reports".

Two facts about the world the product is going into:

- **No workspace has a telephony provider on day one, and most never will.** Indian small businesses
  ring customers from the phone in their hand. A feature that needs a plan before it does anything
  is a feature nobody in the first six months uses.
- **The phone is where the work happens.** Everything else in the CRM is a consequence of a
  conversation somebody had. So the call log is the only record of the work itself, and "what
  happened on those forty calls" is the question the whole module exists to answer.

Before this step, `/today` handed a number to the device with `tel:` and recorded nothing. That is
useful and completely blind.

## Decision

### 1. `status` and `outcome_id` are both on a call, and they are different questions

`status` is what the **telephony** saw — it rang and nobody picked up, the line was busy, we spoke
for four minutes. `outcome_id` is what the **conversation meant** — interested, wants a callback,
wrong number — and it is a row in `call_outcomes`, because "not interested" is a different list in a
school from a car dealership (rule 4).

Collapsing them loses one or the other. A connected call with no useful outcome and a no-answer with
"asked to call back" (a voicemail they returned) are both ordinary, and a single enum cannot say
either.

The **category** is code, not configuration: the product has to know that "Hot — spoke to them"
means somebody was reached, and no amount of reading the name tells it that. The same arrangement
lead statuses use, for the same reason.

With the manual driver there is no telephony at all, so the person is the only source of both
answers — and asking them twice ("did it connect?" and "what happened?") is asking one question in
two vocabularies, one of them a developer's. So the screen asks once, for the outcome, and derives
the status (`statusForCategory`). A provider driver reports the status itself.

### 2. An attempt and a result are two different facts, and two timeline entries

`call.attempted` is written when the product dials. `call.logged` is written when the call is over
and what happened is known. The pair exists because the manual driver **cannot** know the result: it
hands a number to a phone and the product never hears from it again.

So a dialled call is left `dialing` — for ever, if nobody says otherwise. That is not an unfinished
state machine; it is the truth. A lead whose history shows three attempts and no outcomes is telling
a manager something real, and a sweep that guessed "probably no answer" would replace a fact with a
fiction that reads identically.

The same shape as `lead.converted` beside `customer.created`: one event, two subjects, two
sentences, because the same sentence twice reads as a duplicated row rather than as a handover.

### 3. What the sweep does instead is **ask**

`call.outcome-sweep` runs every ten minutes and sends one notification —
`call.outcome_missing` — for a call dialled more than fifteen minutes ago whose outcome nobody has
recorded.

This is load-bearing, not a nicety. Without it the feature is a honeypot: click-to-call is one tap
and recording the outcome is a form, so the log fills with attempts and the question the module
exists to answer stays unanswerable. The nudge is what turns an attempt into a record.

Three properties, each of which is a way it could have been worse than nothing:

- **Once per call.** `calls.outcome_prompted_at` records the question, exactly as
  `tasks.overdue_notified_at` does. A second nudge is nagging and a third is why people switch
  notifications off.
- **It stops looking after a day.** Past that nobody remembers the call, so there is nothing useful
  to ask. It also bounds what the sweep reads.
- **A held nudge re-checks itself.** The type declares staleness `call_still_open`
  ([ADR-0025](./ADR-0025-quiet-hours-hold-a-notification-and-the-release-re-checks-it.md)), so one
  written at 21:40 and held until 07:00 is dropped if the outcome was recorded at 21:45 — which is
  the common case.

### 4. A call that reached somebody is a contact, and `isContact` decides which ones did

`leads.first_contacted_at` / `last_contacted_at` and the `first_response` SLA clock are written by
**one** service, `LeadContactService`, which a completed follow-up and a logged call both call.

A second copy inside the calls module is the `telHref` trap (two implementations, different
null-handling, one of them wrong) with a worse consequence: a lead could end up marked contacted by
one channel with the promise left running by another.

Two of the six categories are easy to get wrong, in opposite directions:

- **`not_interested` is a contact.** A business that rang, got through and was turned down has
  answered the enquiry. Counting that as "never responded" would hold its own SLA against it for
  doing the job, and would leave the lead in the uncontacted queue for somebody to ring again.
- **`wrong_number` is not.** Somebody answered, but not this person — so the lead has still never
  been reached, and the number on the record is what needs fixing.

Each column moves in one direction only. `last_contacted_at` never goes backwards: logging an older
call afterwards must not make a lead look staler than the most recent contact really was.
`first_contacted_at` never goes **forwards**, for the mirror-image reason — somebody logging
Monday's call on Wednesday is recording that the business responded on Monday, and a column that
kept Wednesday would tell every "time to first response" report the business took two days longer
than it did.

And "spoke to them" on a call that did not connect is refused. That pair decides both of the above,
so the one contradiction that would matter answers an SLA with a conversation that never happened.

### 5. The port says **how** the call is being placed, not that it was

```ts
dial(request) → { mode: 'device'; href: 'tel:+91…' }
              | { mode: 'provider'; provider: string; providerCallId: string }
```

A cloud provider rings both parties server-side; the manual driver hands the number to the device.
Those are genuinely different outcomes, the UI has to do something different in each case, and a
port that pretended they were the same would force every caller to guess. `placesCalls` is read by
`GET /calls/config` so the sentence under the button changes the day a provider is connected,
instead of a screen hard-coding one of the two.

**Nothing above the port writes a `calls` row.** `CallsService` writes it _before_ asking, so a
provider failure leaves a logged attempt rather than nothing.

Deliberately **not** on the port:

- **Recordings, transcripts and AI summaries.** They arrive as provider webhooks on a call that
  already exists, so they are an update to a row, not a method on this port. `recording_url`,
  `recording_document_id`, `provider` and `provider_call_id` are on `calls` today with no writer,
  which is honest: the columns the webhook will fill, and the partial unique index
  (`calls_provider_call_unique`) that makes an at-least-once webhook idempotent.
- **A hangup.** Nothing in this product can end a call it did not place, and the manual driver could
  never implement it. A port method one driver has to throw from is a lie in the contract.

### 6. The scoring event's subject is the **lead**, not the call

The scoring processor reads its subject from `payload.aggregateId`, so `call.logged` is emitted with
`aggregateType: 'lead'` and the call's id in the payload, alongside `outcomeCategory` — which is
what lets a tenant score "spoke to them" and "wrong number" differently from one rule.

It follows that an **unlinked** inbound call emits nothing: there is no lead to score, and enqueuing
a job whose subject is a call id would be a silent no-op of exactly the shape this codebase keeps
paying for. `call.logged` is emitted when the call is **attributed** instead — which is also the
first moment it is true _of a lead_.

### 7. `call_outcomes.score_delta` from the Phase 0 sketch is deliberately not implemented

`docs/database-design.md` §7 sketched a per-outcome score delta. Scoring is `scoring_rules`
(`FR-SCR-2`), and `ScoringSubject.event` already carries `outcomeCategory`, so a workspace that
wants "+15 when we speak to them" writes that as a rule like every other rule.

A second per-outcome delta would be a second scoring engine, with no answer to the questions that
immediately follow: does it decay? does it respect `max_applications`? does it appear in the score
breakdown? which of the two wins? The column is not added and the contract is amended to say why.

### 8. `finishFollowUp` is not in the call's transaction

`POST /calls` takes an optional `finishFollowUp`, because completing a follow-up and logging the call
that finished it are one action to the person doing them (`FR-TSK-6`). It is applied **after** the
call commits, by calling `TasksService.complete`.

Ordered that way on purpose: the call row is the record of what happened and is the thing that must
not be lost; a task left open is visible on every queue screen and recoverable in one click; and
making them atomic would mean reimplementing task completion — its own outcome vocabulary, the next
follow-up, the reminders — inside the calls module. The response says which happened
(`followUpCompleted`), so the screen never claims more than it did.

## Consequences

- Click-to-call works with no provider, no integration and no plan, and the row it leaves is what
  the outcome form then asks about.
- `leads.first_contacted_at` has a second writer and still exactly one implementation.
- A workspace's call log is only as good as the nudge: a worker that stays down means nobody is
  asked, and the attempts accumulate unrecorded. The same failure reminders and held notifications
  already have, and the reason the sweep is on the ten-minute tick rather than the daily one.
- A provider driver is a class and a line in `TelephonyModule`. Its webhook controller is new work
  (Phase 4) and needs no change to anything in this step: the idempotency index, the provider
  columns and the `dialing` state are already there for it.
- `call.missed` exists in the activity registry with no describer and no writer, because only a
  provider can report an inbound call nobody answered. It is on the timeline registry's deferred
  list, which is the only honest record of what the timeline cannot yet say.
