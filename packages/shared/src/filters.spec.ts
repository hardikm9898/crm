import { describe, expect, it } from 'vitest';
import {
  DATE_WINDOWS,
  LEAD_FILTER_FIELDS,
  filterField,
  groupConditions,
  isLeadSortField,
  isRelativeDate,
  kindForCustomFieldType,
  leadFilterCatalogue,
  resolveDateWindow,
  validateFilter,
  type FilterCondition,
} from './filters.js';
import { CUSTOM_FIELD_TYPES } from './custom-fields.js';

const CATALOGUE = leadFilterCatalogue([
  { key: 'budget', label: 'Budget', type: 'currency' },
  { key: 'interested_in', label: 'Interested in', type: 'multiselect' },
  { key: 'site_visit_on', label: 'Site visit on', type: 'date' },
  { key: 'internal_only', label: 'Internal', type: 'text', isFilterable: false },
]);

const ZONE = 'Asia/Kolkata';
/** A Wednesday, mid-month, mid-afternoon in Asia/Kolkata. Fixed, so nothing depends on the clock. */
const WEDNESDAY = new Date('2026-03-18T09:30:00Z');

function problems(conditions: FilterCondition[]) {
  return validateFilter({ conditions }, CATALOGUE);
}

describe('the field catalogue', () => {
  it('describes every standard field it offers', () => {
    for (const field of LEAD_FILTER_FIELDS) {
      expect(field.label.length).toBeGreaterThan(0);
      expect(field.operators.length).toBeGreaterThan(0);
      expect(filterField(field.field, CATALOGUE)).toBeDefined();
    }
  });

  it('covers every field FR-VIEW-2 names', () => {
    const keys = LEAD_FILTER_FIELDS.map((field) => field.field);
    for (const required of [
      'statusId',
      'stageId',
      'leadSourceId',
      'assignedUserId',
      'teamId',
      'branchId',
      'scoreBand',
      'priority',
      'tagIds',
      'createdAt',
      'lastActivityAt',
      'nextActionAt',
      'convertedAt',
      'idleDays',
    ]) {
      expect(keys, `FR-VIEW-2 names ${required}`).toContain(required);
    }
  });

  it('reaches inside a currency value, which is stored as an object', () => {
    // Comparing `budget` rather than `budget.amountMinor` compares an object with a number and
    // matches nothing, silently — which is exactly how this was found, against a real database.
    const budget = filterField('custom.budget', CATALOGUE);
    expect(budget?.valuePath).toEqual(['amountMinor']);
    expect(budget?.valueUnit).toBe('minor');
  });

  it('says that money is in minor units, for the standard field too', () => {
    expect(filterField('valueMinor', CATALOGUE)?.valueUnit).toBe('minor');
  });

  it('leaves valuePath unset for a type stored as a plain value', () => {
    expect(filterField('custom.site_visit_on', CATALOGUE)?.valuePath).toBeUndefined();
    expect(filterField('city', CATALOGUE)?.valuePath).toBeUndefined();
  });

  it('adds this tenant’s custom fields, under a prefix that cannot collide with a column', () => {
    expect(filterField('custom.budget', CATALOGUE)?.kind).toBe('money');
    expect(filterField('custom.interested_in', CATALOGUE)?.kind).toBe('tags');
    expect(filterField('custom.site_visit_on', CATALOGUE)?.kind).toBe('date');
  });

  it('leaves out a custom field marked not filterable', () => {
    expect(filterField('custom.internal_only', CATALOGUE)).toBeUndefined();
  });

  it('gives every custom-field type a filter kind', () => {
    for (const type of CUSTOM_FIELD_TYPES) {
      expect(kindForCustomFieldType(type)).toBeTruthy();
    }
  });

  it('knows which fields are computed rather than stored', () => {
    // The compiler has to treat these differently, so getting the flag wrong is a silent bug.
    const computed = LEAD_FILTER_FIELDS.filter((field) => field.computed).map((f) => f.field);
    expect(computed.sort()).toEqual(['ageInDays', 'idleDays', 'isDuplicate', 'tagIds']);
  });
});

describe('validation refuses what would otherwise break somebody’s dashboard', () => {
  it('accepts an empty filter as "everything"', () => {
    expect(problems([])).toEqual([]);
  });

  it('accepts a well-formed filter', () => {
    expect(
      problems([
        { field: 'statusId', operator: 'in', value: ['a', 'b'] },
        { field: 'score', operator: 'gte', value: 75 },
        { field: 'nextActionAt', operator: 'lte', value: { window: 'overdue' } },
      ]),
    ).toEqual([]);
  });

  it('names a field that no longer exists, and says why it might not', () => {
    const [problem] = problems([{ field: 'custom.deleted_field', operator: 'eq', value: 'x' }]);
    expect(problem?.code).toBe('UNKNOWN_FIELD');
    expect(problem?.message).toContain('deleted');
  });

  it('refuses an operator the field’s type cannot support, and suggests the ones it can', () => {
    const [problem] = problems([{ field: 'createdAt', operator: 'contains', value: 'March' }]);
    expect(problem?.code).toBe('OPERATOR_NOT_SUPPORTED');
    expect(problem?.message).toContain('between');
  });

  it('refuses "between" with one bound', () => {
    expect(problems([{ field: 'score', operator: 'between', value: [10] }])[0]?.code).toBe(
      'EXPECTED_PAIR',
    );
  });

  it('refuses a list operator given a bare value', () => {
    expect(problems([{ field: 'statusId', operator: 'in', value: 'a' }])[0]?.code).toBe(
      'EXPECTED_LIST',
    );
  });

  it('refuses an empty list, which would silently match nothing', () => {
    expect(problems([{ field: 'statusId', operator: 'in', value: [] }])[0]?.code).toBe(
      'EXPECTED_LIST',
    );
  });

  it('refuses a value on an operator that takes none', () => {
    expect(problems([{ field: 'assignedUserId', operator: 'is_null', value: 'x' }])[0]?.code).toBe(
      'UNEXPECTED_VALUE',
    );
    expect(problems([{ field: 'assignedUserId', operator: 'is_null' }])).toEqual([]);
  });

  it('requires a value for an operator that needs one', () => {
    expect(problems([{ field: 'city', operator: 'eq' }])[0]?.code).toBe('MISSING_VALUE');
  });

  it('refuses a date that is neither a timestamp nor a known window', () => {
    expect(problems([{ field: 'createdAt', operator: 'gte', value: 'soonish' }])[0]?.code).toBe(
      'BAD_DATE',
    );
    expect(
      problems([{ field: 'createdAt', operator: 'gte', value: { window: 'last_week' } }]),
    ).toEqual([]);
    expect(
      problems([{ field: 'createdAt', operator: 'gte', value: '2026-03-01T00:00:00Z' }]),
    ).toEqual([]);
  });

  it('refuses a non-number on a number field', () => {
    expect(problems([{ field: 'score', operator: 'gte', value: 'high' }])[0]?.code).toBe(
      'BAD_NUMBER',
    );
    // A numeric string is accepted: it is what a query string gives you.
    expect(problems([{ field: 'score', operator: 'gte', value: '75' }])).toEqual([]);
  });

  it('refuses an unknown operator by name', () => {
    expect(problems([{ field: 'city', operator: 'sounds_like', value: 'Pune' }])[0]?.code).toBe(
      'UNKNOWN_OPERATOR',
    );
  });

  it('refuses a filter that is not an object with conditions', () => {
    expect(validateFilter(null, CATALOGUE)[0]?.code).toBe('SHAPE');
    expect(validateFilter({ conditions: 'all' }, CATALOGUE)[0]?.code).toBe('SHAPE');
  });

  it('refuses more OR groups than anyone could read', () => {
    const many = Array.from({ length: 12 }, (_, index) => ({
      field: 'city',
      operator: 'eq',
      value: `City ${index}`,
      groupIndex: index,
    }));
    expect(problems(many).map((problem) => problem.code)).toContain('TOO_MANY_GROUPS');
  });

  it('reports the index of the condition at fault, so a UI can point at it', () => {
    const found = problems([
      { field: 'city', operator: 'eq', value: 'Pune' },
      { field: 'score', operator: 'gte', value: 'high' },
    ]);
    expect(found[0]?.index).toBe(1);
  });
});

describe('date windows resolve against the organization’s clock', () => {
  it('treats "today" as the tenant’s day, not the server’s', () => {
    // 09:30 UTC is 15:00 in Kolkata, so the tenant's day started 09:30 earlier in UTC terms.
    const { from, to } = resolveDateWindow('today', WEDNESDAY, ZONE);
    expect(from?.toISOString()).toBe('2026-03-17T18:30:00.000Z');
    expect(to?.toISOString()).toBe('2026-03-18T18:29:59.999Z');
  });

  it('runs a week Monday to Sunday', () => {
    const { from, to } = resolveDateWindow('this_week', WEDNESDAY, ZONE);
    // The Monday of that week is the 16th, its Sunday the 22nd — in Kolkata.
    expect(from?.toISOString()).toBe('2026-03-15T18:30:00.000Z');
    expect(to?.toISOString()).toBe('2026-03-22T18:29:59.999Z');
  });

  it('puts last week entirely before this one, with no overlap and no gap', () => {
    const thisWeek = resolveDateWindow('this_week', WEDNESDAY, ZONE);
    const lastWeek = resolveDateWindow('last_week', WEDNESDAY, ZONE);
    expect(lastWeek.to!.getTime()).toBeLessThan(thisWeek.from!.getTime());
    expect(thisWeek.from!.getTime() - lastWeek.to!.getTime()).toBe(1);
  });

  it('bounds "overdue" at the current instant, not at midnight', () => {
    // A follow-up due at 10am is overdue at 11am. Bounding at end-of-day would hide it all day,
    // which is exactly the lead that gets lost.
    const { from, to } = resolveDateWindow('overdue', WEDNESDAY, ZONE);
    expect(from).toBeNull();
    expect(to?.toISOString()).toBe(WEDNESDAY.toISOString());
  });

  it('counts "last 7 days" inclusively of today', () => {
    const { from, to } = resolveDateWindow('last_7_days', WEDNESDAY, ZONE);
    expect(from?.toISOString()).toBe('2026-03-11T18:30:00.000Z');
    expect(to?.toISOString()).toBe('2026-03-18T18:29:59.999Z');
  });

  it('spans a whole month, including the last day', () => {
    const { from, to } = resolveDateWindow('this_month', WEDNESDAY, ZONE);
    expect(from?.toISOString()).toBe('2026-02-28T18:30:00.000Z');
    expect(to?.toISOString()).toBe('2026-03-31T18:29:59.999Z');
  });

  it('spans the previous month, across a year boundary', () => {
    const january = new Date('2026-01-10T09:30:00Z');
    const { from, to } = resolveDateWindow('last_month', january, ZONE);
    expect(from?.toISOString()).toBe('2025-11-30T18:30:00.000Z');
    expect(to?.toISOString()).toBe('2025-12-31T18:29:59.999Z');
  });

  it('resolves every window it publishes, in both hemispheres’ zones', () => {
    for (const window of DATE_WINDOWS) {
      for (const zone of ['Asia/Kolkata', 'America/Los_Angeles', 'UTC']) {
        const range = resolveDateWindow(window, WEDNESDAY, zone);
        expect(range.from === null || range.to === null || range.from <= range.to).toBe(true);
      }
    }
  });

  it('recognises a relative date and rejects a lookalike', () => {
    expect(isRelativeDate({ window: 'today' })).toBe(true);
    expect(isRelativeDate({ window: 'sometime' })).toBe(false);
    expect(isRelativeDate('today')).toBe(false);
  });
});

describe('grouping and sorting', () => {
  it('groups conditions in ascending group order, defaulting to one group', () => {
    const groups = groupConditions([
      { field: 'a', operator: 'eq', value: 1, groupIndex: 2 },
      { field: 'b', operator: 'eq', value: 2 },
      { field: 'c', operator: 'eq', value: 3, groupIndex: 2 },
    ]);
    expect(groups.map((group) => group.map((condition) => condition.field))).toEqual([
      ['b'],
      ['a', 'c'],
    ]);
  });

  it('only allows sorting by fields that are actually indexed for it', () => {
    expect(isLeadSortField('score')).toBe(true);
    expect(isLeadSortField('nextActionAt')).toBe(true);
    expect(isLeadSortField('customValues')).toBe(false);
  });
});
