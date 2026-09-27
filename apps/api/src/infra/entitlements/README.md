# Entitlements (`infra/entitlements`)

**Purpose.** Answer "does this organization's plan include this, and are they within their
limits" — and, when a subscription lapses, keep the product readable without destroying
anything.

## Components

| Component                                    | Answers                                                                      |
| -------------------------------------------- | ---------------------------------------------------------------------------- |
| `EntitlementService`                         | Is a feature enabled? What is the limit? (plan features + per-org overrides) |
| `UsageService`                               | How much of a per-period allowance is consumed?                              |
| `EntitlementGuard` + `@RequireFeature`       | Refuses a route the plan does not include                                    |
| `SubscriptionGuard` + `@AllowWhenRestricted` | Read-only mode after a lapse                                                 |

## Rules this module exists to keep

- **Rule 7 — no hardcoded plans.** Nothing in the codebase knows that "starter allows 3 users".
  It asks. Limits are rows a Super Admin edits.
- **Rule 4 — no hardcoded tenant behaviour.** Exceptions sales promises are
  `entitlement_overrides` rows with a reason and an expiry, not an `if` on an organization id.
- **`FR-BIL-3` — expiry restricts, it never deletes.** Past the grace period an organization
  keeps reads, exports and billing; only writes are refused, with `TRIAL_EXPIRED` /
  `SUBSCRIPTION_INACTIVE` so the UI can explain why and offer the upgrade.

## Distinctions that matter

- **`403 LIMIT_EXCEEDED` (plan) vs. `429 RATE_LIMITED` (burst).** One means "buy more", the
  other "slow down". Conflating them produces useless client behaviour.
- **Stock vs. flow limits.** Seats and stored leads are counted from the domain tables, which
  cannot drift. Messages and API calls are metered in `usage_counters`, incremented atomically —
  two concurrent sends must not both read "999 of 1000".
- **Seat accounting includes pending invitations**, or a 3-seat plan could be turned into 30 by
  sending 30 invitations.
- **No subscription at all is unrestricted, not locked.** A fresh deployment with no plans
  configured must still work; the state is visible as `source: 'unrestricted'` rather than
  being an accident.

## Caching

Entitlements and subscription state are cached per organization for 5 minutes / 1 minute.
`invalidate()` must be called on plan change, override change or subscription transition —
covered by a test that a raised override takes effect immediately.

## Consumers today

Seat limits on invitations (`modules/users`). `UsageService` has **no route consumer yet**: its
first ones are API call metering (Phase 4) and WhatsApp message allowances (Phase 5). It is
built and tested now because the atomicity property is easier to get right in isolation than
under a live send path.
