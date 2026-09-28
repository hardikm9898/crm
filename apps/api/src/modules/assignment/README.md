# assignment

Who gets the lead, and why. `FR-ASG-1`–`FR-ASG-4`.

The most common complaint about an assignment engine is "why did this lead go to the wrong person",
and an engine that cannot answer is one a business switches off. So everything here returns a
**decision** — the rule that matched, every member considered, the named reason each excluded one was
skipped, and whether it fell back — rather than a user id.

## What lives here

| Route                                  | Permission        | Notes                                         |
| -------------------------------------- | ----------------- | --------------------------------------------- |
| `GET /assignment/strategies`           | `lead:read`       | The registry, so a rule builder has no enum   |
| `GET /assignment/rules`                | `lead:read`       | With conditions, pool and rotation state      |
| `POST /assignment/rules`               | `settings:manage` | Refuses a rule that could never assign anyone |
| `PATCH`/`DELETE /assignment/rules/:id` | `settings:manage` | Soft delete                                   |
| `PUT /assignment/rules/:id/conditions` | `settings:manage` | The intended final set                        |
| `PUT /assignment/rules/:id/pool`       | `settings:manage` | With weights; resets the rotation cursor      |
| `POST /assignment/test`                | `lead:read`       | Writes nothing; `at` overrides the clock      |
| `POST /assignment/evaluate`            | `lead:assign`     | Re-evaluates existing leads                   |
| `POST /assignment/reassign`            | `lead:assign`     | Bulk; `null` returns them to the pool         |

## Six strategies, one decision path

`specific_user`, `team`, `round_robin`, `weighted_round_robin`, `least_open_leads`,
`top_performer`. `decide()` evaluates the rules and picks somebody without writing anything;
`assignOnCreate()` applies that decision inside the caller's transaction; the tester renders it and
applies nothing. One code path, two consumers — which is the only way the tester can be trusted to
predict the write path.

## Conditions are AND within a group, OR across groups

`groupIndex` is the grouping key, so "Mumbai **and** budget over 50 lakh, **or** a referral" is two
groups. A missing field makes a condition false rather than raising — a lead with no city is not a
match for "city is Mumbai", and it is not an error either. A rule with no conditions matches
everything, which is what makes a catch-all rule expressible.

## Eligibility has four independent reasons, and it names them

Not an active member; outside working hours or a branch holiday; on leave or marked away; at the
rule's capacity cap. Working hours are evaluated in the **organization's** timezone, because that is
the clock the business runs on. Somebody with no hours recorded for today is **unavailable** rather
than always available: silence is not a shift pattern.

## Round-robin fairness is durable, and skipping does not cost a turn

The cursor lives in `round_robin_state` and is written inside the assigning transaction, so the row
lock serialises two simultaneous captures — they cannot both take the same turn. A Redis counter
would be faster and would drift the first time the cache was flushed; fairness that resets on a
deploy is not fairness.

The rotation runs over the pool **as configured**, not over the eligible subset. An absent member is
skipped and keeps their place, so coming back from leave does not cost them the leads they were
owed. Weighted rotation consumes a member's weight before moving on, and a skip clears the
partially-consumed weight so the rotation cannot stall.

## The fallback exists for the 9pm lead

A lead that arrives out of hours, matches a rule whose pool is all off shift and goes nowhere is the
most expensive silent failure this product can have: the business paid for the click and nobody ever
calls. So a fallback is part of every rule — a named person, a team, or the unassigned pool — and:

- a fallback to a named person **ignores working hours**, because a fallback that could fall back to
  nobody defeats the point;
- ending up unassigned **always** notifies, whatever the rule says, via the `lead.unassigned_pool`
  event and the outbox;
- the notification's recipients are resolved by the `lead:assign` **permission**, never a role name
  (rule 4).

`maintenance.lead-recycle` completes the loop: a lead nobody touched within `settings.leadRecycleDays`
is returned to the pool rather than reassigned, because the engine, not the job, decides who gets it.
An absent setting means no recycling — a silent default here would move other people's leads.
