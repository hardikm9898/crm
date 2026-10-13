import { describe, expect, it } from 'vitest';
import { OVERSIGHT_WINDOWS as API_WINDOWS } from '@leados/shared';
import {
  OVERSIGHT_WINDOWS,
  PERSON_COLUMNS,
  QUEUE_TILES,
  cellValue,
  describeBacklog,
  describeMinutes,
  describeScope,
  isOversightWindow,
  type OversightPerson,
} from './oversight';

/**
 * The oversight screen's vocabulary, and the property the whole screen rests on: **every number has
 * somewhere to go**. A metric you cannot click through to the rows behind it is a dead end
 * (`docs/frontend-architecture.md` §5.4), so this asserts that each column produces a link and that
 * the links point at filters the lead screen and the task screen actually understand.
 */

function person(overrides: Partial<OversightPerson> = {}): OversightPerson {
  return {
    userId: '01a13691-7027-7733-b8c7-ef499930faa6',
    name: 'Priya Nair',
    email: 'priya@acme.test',
    openFollowUps: 12,
    overdue: 3,
    rescheduled: 2,
    awaitingFirstContact: 5,
    noNextAction: 7,
    promisesBreached: 1,
    promisesAtRisk: 2,
    promisesMet: 20,
    promisesAnsweredLate: 4,
    onTimeRate: 80,
    medianResponseMinutes: 14,
    leadsAssigned: 31,
    converted: 4,
    ...overrides,
  };
}

describe('the period windows', () => {
  it('match the API’s exactly', () => {
    // The web app may not import @leados/shared at runtime; a spec runs in Node and may.
    expect([...OVERSIGHT_WINDOWS]).toEqual([...API_WINDOWS]);
  });

  it('accepts only a window the API offers, so a hand-typed URL cannot ask for two years', () => {
    expect(isOversightWindow(30)).toBe(true);
    expect(isOversightWindow(365)).toBe(false);
    expect(isOversightWindow(0)).toBe(false);
  });
});

describe('every number has somewhere to go', () => {
  it('gives each tile a destination the lead or task screen understands', () => {
    for (const tile of QUEUE_TILES) {
      expect(tile.href, tile.key).toMatch(/^\/(leads\?f=|tasks\?bucket=)/);
      expect(tile.hint, tile.key).toBeTruthy();
    }
  });

  it('gives each column a link for a real person', () => {
    const row = person();
    for (const column of PERSON_COLUMNS) {
      const href = column.href(row);
      expect(href, String(column.key)).toBeTruthy();
      expect(href, String(column.key)).toMatch(/^\/(leads|tasks|sla)/);
      // A link carrying a person's id must carry *this* person's id — the mistake that makes a
      // manager click "Priya: 7 overdue" and land on somebody else's queue.
      expect(href, String(column.key)).toContain(row.userId);
    }
  });

  it('uses the filter DSL the lead screen reads, not query parameters it ignores', () => {
    // `/leads` has no query-parameter filters at all: its state is the encoded `?f=` DSL or a saved
    // view id. A link like `?uncontacted=true` renders the unfiltered list, which is worse than no
    // link — the trap `/today` paid for.
    const leadLinks = [
      ...QUEUE_TILES.map((tile) => tile.href),
      ...PERSON_COLUMNS.map((column) => column.href(person())),
    ].filter((href): href is string => href !== null && href.startsWith('/leads'));
    expect(leadLinks.length).toBeGreaterThan(0);
    for (const href of leadLinks) expect(href).toMatch(/^\/leads\?f=/);
  });

  it('labels and explains every column', () => {
    for (const column of PERSON_COLUMNS) {
      expect(column.label, String(column.key)).toBeTruthy();
      expect(column.hint, String(column.key)).toBeTruthy();
      expect(['outcome', 'cost', 'volume']).toContain(column.kind);
    }
  });

  it('has no rank, score or total column — that is the design, not an omission', () => {
    const keys = PERSON_COLUMNS.map((column) => String(column.key));
    expect(keys).not.toContain('score');
    expect(keys).not.toContain('rank');
    expect(keys).not.toContain('total');
    // And nothing counting activity: a leaderboard ranked by calls logged teaches people to log.
    expect(keys.some((key) => /activit|logged|calls/i.test(key))).toBe(false);
  });
});

describe('cellValue', () => {
  it('shows an em dash for a rate nobody has earned yet, not a zero and not a hundred', () => {
    const rate = PERSON_COLUMNS.find((column) => column.key === 'onTimeRate')!;
    expect(cellValue(rate, person({ onTimeRate: null }))).toBe('—');
    expect(cellValue(rate, person({ onTimeRate: 80 }))).toBe('80%');
    expect(cellValue(rate, person({ onTimeRate: 0 }))).toBe('0%');
  });

  it('reads a median as a duration', () => {
    const median = PERSON_COLUMNS.find((column) => column.key === 'medianResponseMinutes')!;
    expect(cellValue(median, person({ medianResponseMinutes: 14 }))).toBe('14 min');
    expect(cellValue(median, person({ medianResponseMinutes: 190 }))).toBe('3 hours');
    expect(cellValue(median, person({ medianResponseMinutes: null }))).toBe('—');
  });

  it('prints a plain count as a count', () => {
    const overdue = PERSON_COLUMNS.find((column) => column.key === 'overdue')!;
    expect(cellValue(overdue, person({ overdue: 0 }))).toBe('0');
    expect(cellValue(overdue, person({ overdue: 25 }))).toBe('25');
  });
});

describe('describeScope', () => {
  it('says whose numbers these are, in words rather than as a scope name', () => {
    expect(describeScope('organization', 9)).toBe('Everyone in the workspace — 9 people.');
    expect(describeScope('branch', 4)).toBe('Your branch — 4 people.');
    expect(describeScope('own', 1)).toBe('Only your own work — 1 person.');
  });
});

describe('describeBacklog', () => {
  const empty = {
    unassigned: 0,
    awaitingFirstContact: 0,
    noNextAction: 0,
    overdue: 0,
    dueToday: 0,
  };

  it('leads with what nobody owns, because no person’s row contains it', () => {
    expect(describeBacklog({ ...empty, unassigned: 14, overdue: 3 })).toBe(
      '14 unassigned · 3 overdue.',
    );
  });

  it('omits what is zero', () => {
    expect(describeBacklog({ ...empty, overdue: 2 })).toBe('2 overdue.');
  });

  it('says something true when there is no backlog at all', () => {
    expect(describeBacklog(empty)).toMatch(/Nothing is unassigned/);
  });
});

describe('describeMinutes', () => {
  it('is short enough for a table cell', () => {
    expect(describeMinutes(1)).toBe('1 min');
    expect(describeMinutes(59)).toBe('59 min');
    expect(describeMinutes(60)).toBe('1 hour');
    expect(describeMinutes(1440)).toBe('1 day');
  });
});
