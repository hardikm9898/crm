# Health module

**Purpose.** Answer "is this process alive, can it serve traffic, and is the system
actually healthy" at three depths, for three different audiences.

| Endpoint            | Audience                                | Touches dependencies | Enveloped      |
| ------------------- | --------------------------------------- | -------------------- | -------------- |
| `GET /health/live`  | Orchestrator restart decisions          | No                   | No — bare body |
| `GET /health/ready` | Load balancer traffic decisions         | Yes (database)       | No — bare body |
| `GET /health/deep`  | Super Admin system-health page, on-call | Yes + diagnostics    | Yes            |

**Tables.** None of its own. Reads `_prisma_migrations` and `outbox_events` for diagnostics.

**Permissions.** None today. `/health/deep` moves behind platform authentication when the
auth module lands; it exposes operational internals (never tenant data).

**Business logic.** `ready` degrades when a dependency answers slowly (>1 s) and reports
`down` when a probe throws — the status code is what a load balancer acts on. `deep` adds
migration state (pending migrations mean a half-deployed release) and **outbox lag**.

**Why outbox lag is here.** It is the single most important internal signal in the system:
if unpublished events accumulate, domain events are not reaching consumers, which means
follow-ups are not being created, notifications are not being sent and WhatsApp messages
are not going out — while every endpoint still returns 200. Paging alert at >60 s
(`docs/deployment-architecture.md` §7).

**Note.** `deep` reads across tenants and says so explicitly via
`withPlatformScope('health: platform diagnostics', …)`. Without that opt-in the scoped
client would refuse the query — which is the intended default.

**Failure modes.** Database unreachable → `ready` 503 with the component detail, `live`
still 200 (the process is fine; restarting it would not help).
