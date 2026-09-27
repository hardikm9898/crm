# @leados/shared

Pure, dependency-free primitives used by every other package. No framework imports, no
database, no HTTP — so it can be used from the API, the workers, the seeder and (where
relevant) the web client without dragging anything along.

| Module              | Contents                                                                      | Notes                                                                                                                                                           |
| ------------------- | ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ids.ts`            | `newId()` (UUIDv7), `isUuid`, `idTimestamp`, `newToken`                       | Time-ordered ids give index locality on insert-heavy tables and let the application know a row's id before writing it — which the outbox pattern needs          |
| `phone.ts`          | `normalizePhone`, `tryNormalizePhone`                                         | E.164 normalization. Duplicate detection is meaningless without it: `+91 98765 43210`, `098765 43210` and `9876543210` must collapse to one value (`FR-LEAD-2`) |
| `money.ts`          | `money`, `parseMoney`, `formatMoney`, arithmetic                              | Integer minor units only. No floats for money, anywhere                                                                                                         |
| `time.ts`           | `dateKeyInZone`, `startOfDayInZone`, `minutesBetween`, …                      | "Today" means the organization's timezone, not the server's. DST-safe                                                                                           |
| `tenant-context.ts` | `tenantContext`, `withPlatformScope`, `systemPrincipal`                       | Isolation layer 1. Read the comment block: `run()` must be given an **async** callback                                                                          |
| `rbac.ts`           | `PERMISSIONS`, `PERMISSION_CATALOGUE`, `SYSTEM_ROLE_TEMPLATES`, scope helpers | Code checks permissions, never role names (`FR-IAM-3`). Two consumers share this: the seeder and the API guards                                                 |
| `errors.ts`         | `AppError` + the error-code union                                             | The API's error contract (`docs/api-architecture.md` §2). Cross-tenant access maps to 404, never 403                                                            |
| `result.ts`         | `Result`, `partition`                                                         | For batch and ingestion paths where failure is an expected outcome, not an exception                                                                            |

```bash
pnpm --filter @leados/shared test   # 42 tests, no external dependencies
```
