# ADR-0014 — Duplicate matching: field sets, first rule wins, phone columns as aliases

**Status:** Accepted · **Date:** 2026-09-28 · Refines `functional-requirements.md` `FR-DUP-1` · Phase 2 step 2

## Context

A B2C business buys the same lead repeatedly — a website form, a WhatsApp message, a call, a Meta
lead ad — and both failure modes are expensive. Two records mean two people chasing one customer and
two sets of history nobody can reconcile. A wrong merge destroys history that cannot be recovered.

Three questions had to be settled before any of it could be built, and each had a plausible wrong
answer:

1. **How is a rule expressed?** A general predicate language is more powerful and cannot be
   satisfied by an indexed lookup, which puts an unbounded scan on the lead write path.
2. **Which rule decides when several match?** The obvious answer is "the strongest match".
3. **What counts as "the same field"?** Lead numbers arrive in two columns: `phone_e164` from forms
   and calls, `whatsapp_e164` from conversations. Compared column-to-column, the same human being
   captured through two channels is two people.

## Decision

**A rule is a list of field sets** — `[["phoneE164"], ["email", "lastName"]]`, read as "any set,
all fields within a set". It is how a business states the rule out loud, and each set maps to one
indexed lookup. A set that carries no identifier and too little combined weight (`["city"]`,
`["firstName", "city"]`) is **refused at configuration time**: it passes any schema check and would
then group strangers, which is the one duplicate-detection failure a business cannot undo.

**Rules are evaluated in priority order and the first that matches decides**, not the
highest-confidence match. Priority is the operator's statement of intent; a business that puts
`reject` above `attach_to_existing` means it, and choosing the stronger match instead would be the
engine overruling them silently. Confidence is still recorded, and it orders the triage queue.

**The phone columns are aliases of each other.** `MATCHABLE_FIELDS` declares `phoneE164` and
`whatsappE164` as aliases, so a rule naming either compares against both, on both sides of the
comparison. Aliases must share a field's comparison method, which a unit test enforces. Matched
fields are reported under the name **the rule used**, so an explanation names a manager's own rule
back to them rather than an internal column they never configured.

**Detection is two stages and they must agree**: a narrow candidate query over the indexed
identifier columns plus the lookback window (capped, because a capture matching hundreds of leads
means the rule is wrong), then exact comparison in memory through the same pure matcher the rule
tester calls. The tester and the write path cannot diverge because they are the same function.

## Consequences

**Positive:** detection costs one indexed query on the write path; a rule is explainable in one
sentence; the tester's answer is the write path's answer; the same number through any channel is one
person, which is what makes WhatsApp conversations (Phase 5) attach to leads that already exist
rather than duplicating them.

**Negative:** a list of sets cannot express "A and not B", and nothing here does fuzzy name
matching — deliberately, since trigram-matched names would merge strangers who share a common name
in a large city. Alias comparison also makes `[["phoneE164"]]` and `[["whatsappE164"]]` the same
rule, so the provisioned default seeds one set rather than two.

## Alternatives rejected

- **A predicate language or query DSL for rules.** Expressive, unindexable, and no business owner
  would author it.
- **Strongest match wins.** Ignores the priority the operator set, and makes the outcome of a
  capture depend on a score nobody can see at configuration time.
- **A separate `identities` table** (one row per phone/email/handle, leads linked to identities).
  This is the better model for a product whose leads have many identifiers each, and the cost is a
  join on every read and a second write path for identity reconciliation. It stays available: the
  matcher is pure and the rules are data, so nothing in the application would have to change shape.
- **Fuzzy name matching in a rule.** The confidence score already reports weak agreement; letting a
  rule _fire_ on it would attach records on the strength of a common surname.
