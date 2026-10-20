# ADR-0040 — The usage meter counts and does not price, a canned reply's count is sends, and a tag is normalised on the way in

- **Status:** accepted
- **Date:** 2026-10-20
- **Context:** Phase 5 step 5 — tags, canned replies, the usage meter (`FR-WA-7`, `FR-BIL-4`), and the measurement that closes the phase
- **Builds on:** [ADR-0039](./ADR-0039-a-conversation-lock-is-advisory-and-an-unclaimed-conversation-is-everybodys.md)

## Context

Three small features and one measurement, and each of the three had a tempting shape that would
have been wrong in a way nobody would notice for a quarter.

- **`messages.billable` and `conversation_category`** have been written from Meta's own receipts
  since step 2 and read by nothing: two columns with no reader, which is the same class of problem
  as a column with no writer. `FR-BIL-4` asks for "WhatsApp usage metering".
- **`conversations.tags`** has existed since step 1 with no writer, and `FR-WA-7` lists tags among
  the inbox's filters.
- **`canned_replies`** is the last sketched table in `database-design.md` §7.
- **Phase 5's last exit criterion** is "inbox p95 < 500 ms with 100 k messages in the tenant
  fixture", and it had been unmeasured for four steps because `work-100k.sql` creates no
  conversations at all.

## Decision

**1. The meter counts rows; it does not keep a running total.** A counter incremented on every
receipt would be a second answer to a question the messages already answer, and the first time the
two disagreed nobody would know which to believe. `GET /whatsapp/usage` counts `messages` where
`billable` in a window, grouped by `conversation_category`.

**2. It reports *conversations*, because that is Meta's unit.** Meta bills per conversation and
marks exactly one message in each as the billable one, with the category it was billed under.
Labelling the figure "messages" would be a wrong answer measured precisely.

**3. It does not estimate cost, and says so on the screen.** Meta's prices are per-country and
Meta changes them. A rate card in this codebase would be wrong within a quarter and wrong
**silently**, on somebody's invoice — and a screen that says "about ₹4,200" and is out by a third
is worse than one that says what it counted and leaves the arithmetic to the bill. The response
carries that sentence rather than leaving the screen to invent it.

**4. A message with no category is counted as `unknown`, not dropped.** Meta omits it on some
older receipts, and a total that silently leaves out what it could not classify is a total nobody
can reconcile.

**5. `messagesSent` counts what reached Meta, not what was written.** `queued` and `failed` are
excluded: a message that has not left is not one that was sent, and a meter that counted it would
flatter the figure an owner reconciles. The e2e asserts the zero that follows from this, because a
suite that never drives the send job should read zero and seeing why is the point.

**6. A canned reply's `usage_count` counts *sends*, never clicks.** The picker is ordered by it, so
a count of clicks would promote whatever is easiest to misclick. The send carries the id it used,
and the message keeps it in a column as well — which makes "which wording actually gets used"
answerable from the messages rather than from a number that could drift.

**7. The body that is sent is what the agent typed, not the stored wording.** An agent edits a
canned reply before sending it more often than not; a send that silently substituted the stored
text would put words in their mouth. The id is only what increments the count.

**8. A private reply is unique per person; a shared one per workspace.** One partial unique on
`(organization_id, owner_user_id, shortcut) WHERE deleted_at IS NULL`. Two agents may each keep
their own `/thanks`; one shared `/price-list` is the point of sharing. The `WHERE` is what lets a
workspace reuse a shortcut it retired — a plain unique would have made that impossible for ever,
which is the `integration_connections_live_provider` lesson in a second place.

**9. A reply is archived, never deleted.** `messages.canned_reply_id` is `Restrict`, so a reply
that has been sent has history pointing at it; deleting it would either fail or take the history.

**10. A shortcut is cleaned, not demanded.** `normaliseShortcut` adds the slash and hyphenates, so
`Price List` becomes `/price-list`. Making somebody type punctuation exactly is how a feature goes
unused, and a shortcut with a capital letter in it is one the composer would never match.

**11. A tag is normalised on the way in, and the whole set is replaced.** `normaliseTags`
lower-cases, hyphenates and de-duplicates: a tag is a **filter chip**, and a vocabulary that keeps
`Site Visit`, `site visit` and `site-visit` apart is three chips for one idea and a filter that
finds a third of what it should. `PUT` and not add-one/remove-one, because two endpoints for one
field is how a screen and an API end up disagreeing about what is on a row.

**12. A tag change is audited and not on the timeline.** A tag is how an agent organises their own
queue; "somebody added a label" is not what a business owner opens a lead to read. Assignment,
transfer, close and reopen **are** on the timeline, because those say who was answering.

## Consequences

- **The measurement found a defect the code review had not.** `GET /conversations` answered
  `nextCursor: null, hasMore: false` on every page — so a workspace with 4 000 conversations was
  told its inbox held 50, with the other 3 950 unreachable and `total` sitting beside the lie
  saying 4 000. Nothing but a fixture at that size would have shown it: with one conversation the
  response is correct. The list now carries a keyset cursor over `(last_message_at, id)` — **both**
  halves, because `last_message_at` ties — and `hasMore` is read from `limit + 1` rows rather than
  inferred from a full page, which is wrong exactly when the total is a multiple of the limit.
- **The fixture itself had to be made possible before it could be useful.** Its first version dated
  messages **in the future** — a conversation created "now" plus 37-minute steps — so "the latest
  message" was one that had not happened and the list's preview showed it. A fixture may be
  artificial; it may not be impossible. It now offsets every conversation twenty hours back and
  computes `last_message_at` from the messages it wrote, rather than guessing an instant no message
  has.
- **No realtime, still.** A canned reply somebody adds appears for a colleague on their next page
  load, like everything else in this inbox.
- **`conversations.priority` remains the last column with no writer** in this module. Said plainly
  in the README rather than left to look like a feature.
- **The meter is a read with no retention story.** It counts `messages`, which §15 keeps for 24
  months, so a usage question about three years ago has no answer. That is a deliberate consequence
  of not keeping a second total, and the alternative — a monthly rollup — is Phase 8's shape of
  problem and should arrive with the rest of them.
