# custom-fields

The metadata engine ([ADR-0005](../../../../../docs/decisions/ADR-0005-custom-fields-jsonb.md)). A
business owner adds "Budget" or "Preferred locality" and it is usable on the next request — no
migration, no deploy. That is a Phase 2 exit criterion, and this module is what makes it true.

## What lives here

| Route                                            | Permission            | Notes                                                |
| ------------------------------------------------ | --------------------- | ---------------------------------------------------- |
| `GET /custom-fields`                             | `lead:read`           | Definitions with their options and type capabilities |
| `POST /custom-fields`                            | `custom_field:manage` | Validates the definition before writing it           |
| `PATCH /custom-fields/:id`                       | `custom_field:manage` | Label, help, rules, visibility — never `key`/`type`  |
| `PUT /custom-fields/:id/options`                 | `custom_field:manage` | The intended final list, not a delta                 |
| `DELETE /custom-fields/:id`                      | `custom_field:manage` | Soft; values are kept                                |
| `GET/POST/PATCH/DELETE /custom-fields/sections…` | as above              | Presentational grouping                              |

`FieldRegistryService` is exported: every entity that carries `custom_values` validates against it.

## Why reading needs `lead:read`, not `settings:read`

A sales executive has to render a lead form, and they do not hold `settings:read`. Gating the
vocabulary behind a settings permission would leave them looking at a form with half its fields
missing. _Defining_ a field is a different act and needs `custom_field:manage`.

## Three things that are immutable, and why

- **`key`** appears in stored JSONB, saved views, import mappings and expression index names.
  Renaming it would orphan every value already written — and silently: the field would just look
  empty on every existing record.
- **`type`** decides the stored shape. Changing it would make old values unreadable by the new
  validator.
- **`entityType`** is part of the key's uniqueness.

Deactivate and create a new field instead. A deleted field's key is never reusable, for the same
reason: values are still stored under it, and a new field inheriting them would show one meaning's
data under another's label.

## Deleting keeps the data

`DELETE` is a soft delete and **values are retained**. A field removed today must not rewrite last
quarter's leads; only the retention purge removes data. The same logic applies one level down: an
option dropped from `PUT /options` is deactivated, not deleted, so a lead recorded as "Referral"
keeps saying so after "Referral" is retired — while nobody can newly choose it.

## The registry is in `@leados/shared`

`CUSTOM_FIELD_SPECS` describes each type once: stored shape, whether it takes options, which
validation rules it honours, which filter operators it supports, whether it feeds search. The API
validates against it, the client renders from it (it travels with each definition as
`capabilities`), and `validateCustomValues` — pure, no database — is tested against every type in it.
A type that existed in the registry but was unimplemented would fail that test.

## Caching

Definitions are read on every lead write, so `FieldRegistryService` caches them in Redis for five
minutes, organization-scoped through `RedisService.key()`. **Every write here invalidates that
cache.** Without it, a field created thirty seconds ago is rejected as unknown for five minutes —
precisely the failure the exit criterion forbids.

## Not built yet

`is_indexed` records the intent to give a hot field its own expression index, and
`index_name`/`indexed_at` are the columns the job will fill. The job that creates the index
concurrently is **not implemented**: filterable-but-unindexed fields work today through the
`jsonb_path_ops` GIN index on `custom_values`. It arrives with the filter DSL.
