import { Injectable } from '@nestjs/common';
import {
  AppError,
  groupConditions,
  isRelativeDate,
  leadFilterCatalogue,
  resolveDateWindow,
  validateFilter,
  type FilterCondition,
  type FilterField,
  type ResolvedRange,
} from '@leados/shared';
import { DbService } from '../../infra/db/db.service.js';
import { Prisma } from '@leados/db';

/**
 * Turning a saved filter into a query (`FR-VIEW-2`).
 *
 * Every condition compiles to a **Prisma predicate**, never to SQL text. That is not squeamishness
 * about string building: the tenant-scoping extension works by rewriting Prisma's `where`, so a
 * filter assembled as raw SQL would bypass the layer that makes one tenant unable to read another's
 * leads. A filter is user input by definition — it arrives in a request body and is stored as JSON —
 * so it is the last thing that should be allowed near a query string.
 *
 * Three kinds of field, and the interesting work is in the third:
 *
 *  1. **Columns** — `city`, `statusId`, `score`. A direct predicate.
 *  2. **Custom fields** — `custom.budget`. A JSONB path predicate against `custom_values`.
 *  3. **Computed** — `tagIds`, `ageInDays`, `idleDays`, `isDuplicate`. Each is rewritten into
 *     something indexable: "age over 30 days" becomes a bound on `created_at`, not a subtraction
 *     per row, because a filter that cannot use an index is a filter that times out on the tenant
 *     who most needs it.
 */

export interface CompiledFilter {
  readonly where: Prisma.LeadWhereInput;
  /** Conditions that compiled, for the "why am I seeing these" panel. */
  readonly applied: readonly FilterCondition[];
}

@Injectable()
export class FilterCompilerService {
  constructor(private readonly db: DbService) {}

  /** The catalogue for this tenant: standard fields plus their own filterable custom fields. */
  async catalogue(entityType = 'lead'): Promise<readonly FilterField[]> {
    const definitions = await this.db.client.customFieldDefinition.findMany({
      where: { entityType: entityType as never, isActive: true, deletedAt: null },
      select: { key: true, label: true, type: true, isFilterable: true },
      orderBy: { sortOrder: 'asc' },
    });
    return leadFilterCatalogue(
      definitions.map((definition) => ({
        key: definition.key,
        label: definition.label,
        type: definition.type,
        isFilterable: definition.isFilterable,
      })),
    );
  }

  /**
   * Validates and compiles, or throws with the problems.
   *
   * `at` and `timeZone` are parameters rather than read from the clock so that a saved view's
   * meaning is reproducible: the same filter, the same instant, the same rows — which is what makes
   * "why did this view show me that lead" answerable.
   */
  async compile(input: {
    readonly filter: unknown;
    readonly at?: Date;
    readonly entityType?: string;
  }): Promise<CompiledFilter> {
    const catalogue = await this.catalogue(input.entityType ?? 'lead');
    const problems = validateFilter(input.filter, catalogue);
    if (problems.length > 0) {
      throw AppError.validation(
        'This filter cannot be applied',
        problems.map((problem) => ({
          field: problem.index >= 0 ? `conditions.${problem.index}` : 'conditions',
          code: problem.code,
          message: problem.message,
        })),
      );
    }

    const organization = await this.db.client.organization.findFirstOrThrow({
      select: { timezone: true },
    });
    const at = input.at ?? new Date();
    const conditions = ((input.filter as { conditions?: FilterCondition[] }).conditions ??
      []) as readonly FilterCondition[];
    if (conditions.length === 0) return { where: {}, applied: [] };

    const groups = groupConditions(conditions);
    const compiledGroups = groups.map((group) => ({
      AND: group.map((condition) =>
        this.compileCondition(condition, catalogue, at, organization.timezone),
      ),
    }));

    // One group is an AND, several are an OR of ANDs. Emitting `{ AND: [...] }` for the single case
    // rather than `{ OR: [{ AND: [...] }] }` keeps the generated SQL readable in a slow-query log.
    const where: Prisma.LeadWhereInput =
      compiledGroups.length === 1 ? compiledGroups[0]! : { OR: compiledGroups };
    return { where, applied: conditions };
  }

  private compileCondition(
    condition: FilterCondition,
    catalogue: readonly FilterField[],
    at: Date,
    timeZone: string,
  ): Prisma.LeadWhereInput {
    const definition = catalogue.find((entry) => entry.field === condition.field);
    /* c8 ignore next */
    if (!definition) throw AppError.validation('This filter cannot be applied', []);

    if (definition.field.startsWith('custom.')) {
      return this.compileCustomField(condition, definition);
    }
    if (definition.computed === true) {
      return this.compileComputed(condition, at);
    }
    if (definition.kind === 'date') {
      return {
        [definition.field]: this.datepredicate(condition, at, timeZone),
      } as Prisma.LeadWhereInput;
    }
    if (definition.kind === 'money' || definition.kind === 'number') {
      return {
        [definition.field]: this.numberPredicate(condition, definition),
      } as Prisma.LeadWhereInput;
    }
    return { [definition.field]: this.scalarPredicate(condition) } as Prisma.LeadWhereInput;
  }

  /**
   * A custom field lives in `custom_values` JSONB, so its predicate is a path filter.
   *
   * Comparisons are string-shaped here on purpose. JSONB holds what the writer put there, and the
   * custom-field engine stores numbers as numbers and dates as ISO strings — so `gt` on a number
   * field compares numerically, while everything else compares as text, which is what the operators
   * a text field advertises actually mean.
   */
  private compileCustomField(
    condition: FilterCondition,
    definition: FilterField,
  ): Prisma.LeadWhereInput {
    const key = definition.field.slice('custom.'.length);
    // A currency value is stored as `{ currency, amountMinor }`, so the comparison has to reach
    // inside it. Which sub-path comes from the type registry, not from a guess here.
    const path = [key, ...(definition.valuePath ?? [])];
    const operator = condition.operator;
    const value = condition.value;

    switch (operator) {
      case 'is_null':
        // Absent and JSON-null are the same thing to a person looking at an empty field.
        return {
          OR: [
            { customValues: { path, equals: Prisma.DbNull } },
            { NOT: { customValues: { path, not: Prisma.DbNull } } },
          ],
        } as unknown as Prisma.LeadWhereInput;
      case 'is_not_null':
        return { customValues: { path, not: Prisma.DbNull } } as unknown as Prisma.LeadWhereInput;
      case 'eq':
        return {
          customValues: { path, equals: value as never },
        } as unknown as Prisma.LeadWhereInput;
      case 'ne':
        return { customValues: { path, not: value as never } } as unknown as Prisma.LeadWhereInput;
      case 'contains':
        return {
          customValues: { path, string_contains: String(value) },
        } as unknown as Prisma.LeadWhereInput;
      case 'starts_with':
        return {
          customValues: { path, string_starts_with: String(value) },
        } as unknown as Prisma.LeadWhereInput;
      case 'in':
        return {
          OR: (value as unknown[]).map((entry) => ({
            customValues: { path, equals: entry as never },
          })),
        } as unknown as Prisma.LeadWhereInput;
      case 'nin':
        return {
          AND: (value as unknown[]).map((entry) => ({
            customValues: { path, not: entry as never },
          })),
        } as unknown as Prisma.LeadWhereInput;
      case 'gt':
      case 'gte':
      case 'lt':
      case 'lte':
        return {
          customValues: { path, [operator]: value as never },
        } as unknown as Prisma.LeadWhereInput;
      case 'between': {
        const [from, to] = value as [unknown, unknown];
        return {
          AND: [
            { customValues: { path, gte: from as never } },
            { customValues: { path, lte: to as never } },
          ],
        } as unknown as Prisma.LeadWhereInput;
      }
      case 'has_any':
        return {
          OR: (value as unknown[]).map((entry) => ({
            customValues: { path, array_contains: [entry] as never },
          })),
        } as unknown as Prisma.LeadWhereInput;
      case 'has_all':
        return {
          customValues: { path, array_contains: value as never },
        } as unknown as Prisma.LeadWhereInput;
      /* c8 ignore next 2 */
      default:
        throw AppError.validation('This filter cannot be applied', []);
    }
  }

  /**
   * The computed fields, each rewritten into something an index can serve.
   *
   * `ageInDays > 30` becomes `createdAt < (now - 30 days)`. Note the flip: **older than** 30 days
   * means an **earlier** timestamp, and getting that backwards is the kind of bug that silently
   * shows a manager the wrong half of their pipeline.
   *
   * No timezone here, unlike the date windows: "age in days" is elapsed time, not a count of calendar
   * days, so a day is 24 hours wherever the business is.
   */
  private compileComputed(condition: FilterCondition, at: Date): Prisma.LeadWhereInput {
    switch (condition.field) {
      case 'tagIds': {
        const ids = condition.value as string[];
        if (condition.operator === 'is_null') return { tags: { none: {} } };
        if (condition.operator === 'is_not_null') return { tags: { some: {} } };
        if (condition.operator === 'has_all') {
          // Every tag present: an AND of `some`, because one `some` with an `in` would match a lead
          // carrying any one of them.
          return { AND: ids.map((tagId) => ({ tags: { some: { tagId } } })) };
        }
        return { tags: { some: { tagId: { in: ids } } } };
      }
      case 'ageInDays':
        return { createdAt: this.daysAgoPredicate(condition, at) };
      case 'idleDays':
        return { lastActivityAt: this.daysAgoPredicate(condition, at) };
      case 'isDuplicate':
        return condition.value === true || condition.value === 'true'
          ? { isDuplicateOfId: { not: null } }
          : { isDuplicateOfId: null };
      /* c8 ignore next 2 */
      default:
        throw AppError.validation('This filter cannot be applied', []);
    }
  }

  /**
   * "N days ago" as a timestamp bound, with the comparison inverted.
   *
   * `idleDays >= 7` is "last activity at or before seven days ago" — `lte`. The inversion is done
   * once, here, rather than being re-derived at every call site.
   */
  private daysAgoPredicate(condition: FilterCondition, at: Date): Prisma.DateTimeFilter {
    const cutoff = (days: number) => new Date(at.getTime() - days * 86_400_000);
    const days = (value: unknown) => Number(value);

    switch (condition.operator) {
      case 'gt':
        return { lt: cutoff(days(condition.value)) };
      case 'gte':
        return { lte: cutoff(days(condition.value)) };
      case 'lt':
        return { gt: cutoff(days(condition.value)) };
      case 'lte':
        return { gte: cutoff(days(condition.value)) };
      case 'eq': {
        // "Exactly N days" is the day-wide window, not an instant.
        const upper = cutoff(days(condition.value));
        const lower = cutoff(days(condition.value) + 1);
        return { gt: lower, lte: upper };
      }
      case 'between': {
        const [low, high] = (condition.value as [unknown, unknown]).map(days) as [number, number];
        return { gte: cutoff(Math.max(low, high)), lte: cutoff(Math.min(low, high)) };
      }
      case 'is_null':
        return { equals: null } as unknown as Prisma.DateTimeFilter;
      case 'is_not_null':
        return { not: null } as unknown as Prisma.DateTimeFilter;
      /* c8 ignore next 2 */
      default:
        throw AppError.validation('This filter cannot be applied', []);
    }
  }

  private datepredicate(
    condition: FilterCondition,
    at: Date,
    timeZone: string,
  ): Prisma.DateTimeNullableFilter {
    const resolve = (value: unknown): ResolvedRange =>
      isRelativeDate(value)
        ? resolveDateWindow(value.window, at, timeZone)
        : { from: new Date(value as string), to: new Date(value as string) };

    switch (condition.operator) {
      case 'is_null':
        return { equals: null };
      case 'is_not_null':
        return { not: null };
      case 'eq': {
        // A named window compared with `eq` means "inside that window", which is what somebody
        // choosing "is today" means, and never "at this exact microsecond".
        const { from, to } = resolve(condition.value);
        return { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) };
      }
      case 'gt':
      case 'gte': {
        const { from } = resolve(condition.value);
        const bound = from ?? new Date(0);
        return condition.operator === 'gt' ? { gt: bound } : { gte: bound };
      }
      case 'lt':
      case 'lte': {
        // The *end* of the window: "due by today" includes everything up to tonight.
        const { to } = resolve(condition.value);
        const bound = to ?? at;
        return condition.operator === 'lt' ? { lt: bound } : { lte: bound };
      }
      case 'between': {
        const [low, high] = condition.value as [unknown, unknown];
        const from = resolve(low).from ?? new Date(0);
        const to = resolve(high).to ?? at;
        return { gte: from, lte: to };
      }
      /* c8 ignore next 2 */
      default:
        throw AppError.validation('This filter cannot be applied', []);
    }
  }

  private numberPredicate(
    condition: FilterCondition,
    definition: FilterField,
  ): Prisma.IntFilter | Prisma.BigIntNullableFilter {
    // `value_minor` is a BigInt column; everything else is an Int. Passing a plain number to a
    // BigInt filter throws inside Prisma rather than at the boundary, so it is converted here.
    const cast = (value: unknown) =>
      definition.kind === 'money' ? BigInt(Math.trunc(Number(value))) : Number(value);

    switch (condition.operator) {
      case 'eq':
        return { equals: cast(condition.value) } as Prisma.IntFilter;
      case 'ne':
        return { not: cast(condition.value) } as Prisma.IntFilter;
      case 'gt':
        return { gt: cast(condition.value) } as Prisma.IntFilter;
      case 'gte':
        return { gte: cast(condition.value) } as Prisma.IntFilter;
      case 'lt':
        return { lt: cast(condition.value) } as Prisma.IntFilter;
      case 'lte':
        return { lte: cast(condition.value) } as Prisma.IntFilter;
      case 'between': {
        const [low, high] = condition.value as [unknown, unknown];
        return { gte: cast(low), lte: cast(high) } as Prisma.IntFilter;
      }
      case 'is_null':
        return { equals: null } as unknown as Prisma.IntFilter;
      case 'is_not_null':
        return { not: null } as unknown as Prisma.IntFilter;
      /* c8 ignore next 2 */
      default:
        throw AppError.validation('This filter cannot be applied', []);
    }
  }

  private scalarPredicate(condition: FilterCondition): unknown {
    switch (condition.operator) {
      case 'eq':
        return { equals: condition.value };
      case 'ne':
        return { not: condition.value };
      case 'in':
        return { in: condition.value };
      case 'nin':
        return { notIn: condition.value };
      case 'contains':
        // Case-insensitive, because nobody searching for "sharma motors" means the lowercase one.
        return { contains: String(condition.value), mode: 'insensitive' };
      case 'starts_with':
        return { startsWith: String(condition.value), mode: 'insensitive' };
      case 'is_null':
        return { equals: null };
      case 'is_not_null':
        return { not: null };
      /* c8 ignore next 2 */
      default:
        throw AppError.validation('This filter cannot be applied', []);
    }
  }
}
