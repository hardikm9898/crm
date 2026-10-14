# Calls — logging them, and dialling from the product

`FR-CALL-1..3`. The call log is the only record a business has of the work that is actually done on
a lead: everything else in the CRM is a consequence of a conversation somebody had, so a call that
is not logged is a day's work that did not happen as far as every report is concerned.

The whole module is built so that it **works before any telephony provider exists**, because that is
the state every workspace is in on day one and the state most of them stay in.

## Tables

| Table           | What it holds                                                              |
| --------------- | -------------------------------------------------------------------------- |
| `calls`         | One call: who with, which way, what the line did, what it meant, how long  |
| `call_outcomes` | What a call can end as, in the tenant's own words, with a category in code |

`calls.lead_id` is **nullable**, because an inbound call from a number nobody recognises is exactly
the call most worth keeping; `calls.task_id` points at the follow-up the call was made for.

## Endpoints

| Method   | Path                          | Permission        |
| -------- | ----------------------------- | ----------------- |
| `GET`    | `/calls`                      | `call:read`       |
| `GET`    | `/calls/config`               | `call:read`       |
| `GET`    | `/calls/:id`                  | `call:read`       |
| `POST`   | `/calls`                      | `call:log`        |
| `POST`   | `/calls/dial`                 | `call:log`        |
| `POST`   | `/calls/:id/outcome`          | `call:log`        |
| `PATCH`  | `/calls/:id`                  | `call:log`        |
| `DELETE` | `/calls/:id`                  | `call:log`        |
| `GET`    | `/settings/call-outcomes`     | `call:read`       |
| `POST`   | `/settings/call-outcomes`     | `settings:manage` |
| `PATCH`  | `/settings/call-outcomes/:id` | `settings:manage` |
| `DELETE` | `/settings/call-outcomes/:id` | `settings:manage` |

`call:log` is separate from `call:read` for the reason `payment:record` is separate from
`payment:read`: seeing what the team did on the phone and adding to that record are different acts.
It is also the permission **click-to-call** needs, so a workspace can let somebody read the history
without letting them ring a customer — which is why the auditor template holds `call:read` and not
`call:log`.

`GET /calls/config` is readable with `call:read` rather than `settings:manage`, like the task form's
config: the outcome dropdown is part of logging a call.

## Business logic worth knowing

The reasoning is
[ADR-0027](../../../../../docs/decisions/ADR-0027-calls-sit-behind-a-port-and-an-attempt-is-not-a-contact.md).
In short:

- **A status and an outcome are different facts, and both are recorded.** `status` is what the
  telephony saw (it rang, the line was busy, we spoke for four minutes); `outcome_id` is what the
  conversation meant, and it is the tenant's own list. Collapsing them loses one or the other: a
  connected call with no useful outcome and a no-answer with "asked to call back" are both ordinary.
- **The outcome's _category_ is code; its name is a row.** The product has to know that "Hot — spoke
  to them" means somebody was reached, and no amount of reading the name tells it that. The same
  arrangement lead statuses use.
- **An attempt and a result are two timeline entries.** `call.attempted` when the product dials,
  `call.logged` when the call is over and what happened is known. With the manual driver the product
  hands a number to a phone and never learns the result, so a lead showing three attempts and no
  outcomes is telling a manager something true.
- **A dialled call is left `dialing` for ever, not swept into a guess.** What the sweep does instead
  is _ask_: one notification, fifteen minutes on, recorded in `outcome_prompted_at` so it never asks
  twice — the same shape as `tasks.overdue_notified_at`.
- **A call that reached somebody is a contact.** `LeadContactService` writes
  `leads.first_contacted_at` / `last_contacted_at` and satisfies the first-response promise, in the
  call's own transaction and through the same service a completed follow-up uses. Which categories
  count is `isContact` in `@leados/shared` — `not_interested` does (the business answered the
  enquiry), `wrong_number` does not (somebody answered, but not this person).
- **"Spoke to them" cannot be recorded against a call that did not connect.** That pair decides
  whether the lead is marked contacted and whether a promise is answered, so the one contradiction
  that would matter is refused with a field attached.
- **The event's subject is the lead, not the call.** The scoring processor reads its subject from
  `payload.aggregateId`, and a rule reads `event.outcomeCategory`. An unlinked inbound call has no
  lead to score, so `call.logged` is emitted when the call is **attributed** rather than when it is
  logged — which is also the moment it becomes true of a lead.
- **`finishFollowUp` is not in the call's transaction.** The call row is the thing that must not be
  lost; a task left open is visible on every queue screen and recoverable in one click; and making
  them atomic would mean reimplementing task completion inside this module.
- **Deleting a call does not undo the contact.** `first_contacted_at` records that somebody was
  reached, and a mistyped log is not evidence they were not — making the SLA report disagree with a
  clock that was satisfied at the time is a worse lie than a deleted row.

## Telephony

`apps/api/src/infra/telephony` holds the port (`FR-CALL-2`). `dial()` answers **how** the call will
be placed, not that it was: `mode: 'device'` hands a `tel:` link to the client, `mode: 'provider'`
means the provider rang both parties and gives the id its webhooks will carry. Those are genuinely
different outcomes and the port says which happened, because the UI has to do something different in
each case.

Deliberately not on the port: recordings, transcripts and summaries (they arrive as webhooks on a
call that already exists, so they are an update to a row), and a hangup (nothing here can end a call
it did not place, and a port method one driver must throw from is a lie in the contract).

## Sweeps

| Job                  | Cron               | What it does                                    |
| -------------------- | ------------------ | ----------------------------------------------- |
| `call.outcome-sweep` | `*/10 \* \* \* \*` | Asks what happened on the calls nobody recorded |

Platform-wide, through `calls_awaiting_outcome` — the one index on this table not prefixed by
`organization_id`, because a sweep across every tenant cannot use one that is.
