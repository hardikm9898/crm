import { describe, expect, it } from 'vitest';
import {
  decodeFilter,
  describeCondition,
  encodeFilter,
  leadListHref,
  toApiFilter,
  withoutCondition,
  type CatalogueField,
  type UiCondition,
} from './lead-filters';

const CITY: CatalogueField = {
  field: 'city',
  label: 'City',
  kind: 'text',
  operators: ['eq', 'contains'],
};
const STATUS: CatalogueField = {
  field: 'statusId',
  label: 'Status',
  kind: 'reference',
  operators: ['in'],
};

describe('filters survive a round trip through the URL', () => {
  const cases: { name: string; conditions: UiCondition[] }[] = [
    {
      name: 'a single condition',
      conditions: [{ field: 'city', operator: 'eq', value: 'Pune', groupIndex: 0 }],
    },
    {
      name: 'two conditions in one group',
      conditions: [
        { field: 'city', operator: 'eq', value: 'Pune', groupIndex: 0 },
        { field: 'priority', operator: 'in', value: ['high', 'urgent'], groupIndex: 0 },
      ],
    },
    {
      name: 'two groups',
      conditions: [
        { field: 'city', operator: 'eq', value: 'Pune', groupIndex: 0 },
        { field: 'score', operator: 'gte', value: '75', groupIndex: 1 },
      ],
    },
    {
      name: 'a valueless operator',
      conditions: [{ field: 'assignedUserId', operator: 'is_null', groupIndex: 0 }],
    },
    {
      name: 'a named date window',
      conditions: [
        { field: 'nextActionAt', operator: 'lte', value: { window: 'overdue' }, groupIndex: 0 },
      ],
    },
    {
      name: 'a between pair',
      conditions: [{ field: 'score', operator: 'between', value: ['10', '90'], groupIndex: 0 }],
    },
    {
      name: 'a value containing the separators',
      conditions: [
        { field: 'company', operator: 'eq', value: 'Sharma: Motors ~ Pune | Ltd', groupIndex: 0 },
      ],
    },
    {
      name: 'a value containing a comma, on a non-list operator',
      conditions: [
        { field: 'company', operator: 'contains', value: 'Patel, Shah & Co', groupIndex: 0 },
      ],
    },
  ];

  for (const { name, conditions } of cases) {
    it(name, () => {
      expect(decodeFilter(encodeFilter(conditions))).toEqual(conditions);
    });
  }

  it('produces a URL a person can read', () => {
    const encoded = encodeFilter([
      { field: 'city', operator: 'eq', value: 'Pune', groupIndex: 0 },
      { field: 'priority', operator: 'in', value: ['high', 'urgent'], groupIndex: 0 },
      { field: 'score', operator: 'gte', value: '75', groupIndex: 1 },
    ]);
    expect(encoded).toBe('city:eq:Pune~priority:in:high,urgent|score:gte:75');
  });

  it('encodes nothing for an empty filter', () => {
    expect(encodeFilter([])).toBe('');
    expect(decodeFilter('')).toEqual([]);
    expect(decodeFilter(null)).toEqual([]);
  });
});

describe('decoding is forgiving, because URLs get edited and truncated', () => {
  it('drops a condition with no operator rather than failing the page', () => {
    expect(decodeFilter('city')).toEqual([]);
  });

  it('drops a condition whose value is missing', () => {
    expect(decodeFilter('city:eq')).toEqual([]);
  });

  it('keeps the conditions it understood alongside one it did not', () => {
    const decoded = decodeFilter('city:eq:Pune~garbage');
    expect(decoded).toHaveLength(1);
    expect(decoded[0]?.field).toBe('city');
  });

  it('survives a stray percent sign from a hand-edited URL', () => {
    const decoded = decodeFilter('company:eq:100%');
    expect(decoded[0]?.value).toBe('100%');
  });

  it('ignores empty groups', () => {
    expect(decodeFilter('city:eq:Pune||')).toHaveLength(1);
  });
});

describe('the API body', () => {
  it('omits the value for an operator that takes none', () => {
    const body = toApiFilter([{ field: 'assignedUserId', operator: 'is_null', groupIndex: 0 }]);
    expect(body.conditions[0]).toEqual({
      field: 'assignedUserId',
      operator: 'is_null',
      groupIndex: 0,
    });
    expect('value' in body.conditions[0]!).toBe(false);
  });

  it('carries the group index through, because AND/OR depends on it', () => {
    const body = toApiFilter([
      { field: 'city', operator: 'eq', value: 'Pune', groupIndex: 0 },
      { field: 'city', operator: 'eq', value: 'Mumbai', groupIndex: 1 },
    ]);
    expect(body.conditions.map((condition) => condition.groupIndex)).toEqual([0, 1]);
  });
});

describe('chips read as sentences', () => {
  it('uses the field label and a human operator', () => {
    expect(
      describeCondition({ field: 'city', operator: 'eq', value: 'Pune', groupIndex: 0 }, CITY),
    ).toBe('City is Pune');
  });

  it('says "is empty" rather than showing an operator nobody types', () => {
    expect(
      describeCondition({ field: 'assignedUserId', operator: 'is_null', groupIndex: 0 }, undefined),
    ).toBe('assignedUserId is empty');
  });

  it('resolves an id to a name when one is known', () => {
    const chip = describeCondition(
      {
        field: 'statusId',
        operator: 'in',
        value: ['01a0e98a-65fa-75a8-a2d1-7a41a3dd7bd4'],
        groupIndex: 0,
      },
      STATUS,
      { '01a0e98a-65fa-75a8-a2d1-7a41a3dd7bd4': 'Qualified' },
    );
    expect(chip).toBe('Status is any of Qualified');
  });

  it('shortens an unresolved id instead of showing a uuid nobody can check', () => {
    const chip = describeCondition(
      {
        field: 'statusId',
        operator: 'in',
        value: ['01a0e98a-65fa-75a8-a2d1-7a41a3dd7bd4'],
        groupIndex: 0,
      },
      STATUS,
    );
    expect(chip).toBe('Status is any of 01a0e98a…');
  });

  it('describes a date window in words', () => {
    expect(
      describeCondition(
        { field: 'nextActionAt', operator: 'lte', value: { window: 'overdue' }, groupIndex: 0 },
        { field: 'nextActionAt', label: 'Next action due', kind: 'date', operators: ['lte'] },
      ),
    ).toBe('Next action due is at most overdue');
  });

  it('joins a between pair with "and"', () => {
    expect(
      describeCondition(
        { field: 'score', operator: 'between', value: ['10', '90'], groupIndex: 0 },
        { field: 'score', label: 'Score', kind: 'number', operators: ['between'] },
      ),
    ).toBe('Score is between 10 and 90');
  });
});

describe('list links', () => {
  it('drops the cursor when the filter changes, so page three of another filter cannot leak in', () => {
    const href = leadListHref({
      conditions: [{ field: 'city', operator: 'eq', value: 'Pune', groupIndex: 0 }],
      sort: 'score',
      direction: 'desc',
    });
    expect(href).toBe('/leads?f=city%3Aeq%3APune&sort=score&dir=desc');
    expect(href).not.toContain('cursor');
  });

  it('returns a bare path when there is nothing to say', () => {
    expect(leadListHref({})).toBe('/leads');
  });

  it('can address another base path, for the recycle bin and the board', () => {
    expect(leadListHref({ deleted: true, basePath: '/leads' })).toBe('/leads?deleted=1');
  });

  it('removes one chip without disturbing the others', () => {
    const conditions: UiCondition[] = [
      { field: 'city', operator: 'eq', value: 'Pune', groupIndex: 0 },
      { field: 'score', operator: 'gte', value: '75', groupIndex: 1 },
    ];
    expect(withoutCondition(conditions, 0)).toEqual([conditions[1]]);
  });
});
