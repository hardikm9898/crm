import { describe, expect, it } from 'vitest';
import {
  HEALTH_CLASSES,
  HEALTH_LABELS,
  TODAY_TILES,
  describeDay,
  describeDelta,
  describeMinutes,
  greeting,
} from './today';
import { SLA_HEALTHS } from './sla';

/**
 * The Today screen's own vocabulary, and its reconciliation with the API.
 *
 * `lib/today.ts` hand-writes the payload's shape because the web app may not import
 * `@leados/shared` at runtime (its entry point reaches `node:async_hooks` and a client component
 * that transitively imports it fails `next build`). A spec runs in Node and may import both, which
 * is what keeps the hand-written copy honest — the same arrangement `tasks.spec.ts` uses.
 */

describe('the vocabulary the screen names', () => {
  it('has a label and a colour for every promise reading the SLA module can produce', () => {
    // The trap this is here for: an activity type with no describer renders as its raw key, and
    // the amount and the note a business owner opened the page for never reach the screen. A
    // health with no label would put `at_risk` on a card in front of a customer.
    for (const health of SLA_HEALTHS) {
      expect(HEALTH_LABELS[health], health).toBeTruthy();
      expect(HEALTH_CLASSES[health], health).toBeTruthy();
    }
  });

  it('names a tile for each of the three sections the queue shows, plus the new leads', () => {
    expect(TODAY_TILES.map((tile) => tile.key)).toEqual([
      'overdue',
      'dueNow',
      'laterToday',
      'awaitingFirstContact',
    ]);
    // Every tile links somewhere that can show the whole set behind the number.
    for (const tile of TODAY_TILES) expect(tile.href).toMatch(/^\/(tasks|leads)\?/);
  });
});

describe('describeDelta', () => {
  it('says how late, because the sign is the whole message on this screen', () => {
    expect(describeDelta(-2880)).toBe('2 days late');
    expect(describeDelta(-90)).toBe('2 hours late');
    expect(describeDelta(-5)).toBe('5 minutes late');
  });

  it('says how soon', () => {
    expect(describeDelta(8)).toBe('in 8 minutes');
    expect(describeDelta(1)).toBe('in 1 minute');
    expect(describeDelta(240)).toBe('in 4 hours');
  });

  it('says "now" rather than "in 0 minutes"', () => {
    expect(describeDelta(0)).toBe('now');
    expect(describeDelta(0.4)).toBe('now');
  });
});

describe('describeMinutes', () => {
  it('reads as a person would say it', () => {
    expect(describeMinutes(1)).toBe('1 minute');
    expect(describeMinutes(43)).toBe('43 minutes');
    expect(describeMinutes(60)).toBe('1 hour');
    expect(describeMinutes(1440)).toBe('1 day');
  });

  it('ignores the sign, because the caller supplies the words around it', () => {
    expect(describeMinutes(-43)).toBe('43 minutes');
  });
});

describe('describeDay', () => {
  const zero = {
    overdue: 0,
    dueNow: 0,
    laterToday: 0,
    upcoming: 0,
    awaitingFirstContact: 0,
    noNextAction: 0,
    promisesBreached: 0,
    promisesAtRisk: 0,
    unacknowledgedEscalations: 0,
  };

  it('omits what is zero: a row of noughts reads as a system reporting fields', () => {
    expect(describeDay({ ...zero, dueNow: 2, laterToday: 10 })).toBe('12 follow-ups left today.');
  });

  it('leads with the day and adds only what is true', () => {
    expect(
      describeDay({ ...zero, dueNow: 2, laterToday: 10, overdue: 3, awaitingFirstContact: 5 }),
    ).toBe('12 follow-ups left today · 3 overdue · 5 new leads to call.');
  });

  it('prefers a missed promise over one still running, and never says both', () => {
    const sentence = describeDay({ ...zero, promisesBreached: 2, promisesAtRisk: 4, dueNow: 1 });
    expect(sentence).toContain('2 missed promises');
    expect(sentence).not.toContain('running out');
  });

  it('counts one promise in the singular — what the browser check caught', () => {
    expect(describeDay({ ...zero, dueNow: 1, promisesBreached: 1 })).toBe(
      '1 follow-up left today · 1 missed promise.',
    );
    expect(describeDay({ ...zero, dueNow: 1, promisesAtRisk: 1 })).toBe(
      '1 follow-up left today · 1 promise running out.',
    );
    expect(describeDay({ ...zero, dueNow: 1, promisesAtRisk: 3 })).toBe(
      '1 follow-up left today · 3 promises running out.',
    );
  });

  it('says something useful when there is nothing owed at all', () => {
    expect(describeDay(zero)).toBe('Nothing is owed today, and every new lead has been called.');
  });

  it('never reports a nought beside a contradiction — the walk-through’s finding', () => {
    // "0 follow-ups left today · 1 overdue" was the sentence a tester read on a screen with one
    // late follow-up on it. The count of today's work is not a field to be filled in with a zero.
    expect(describeDay({ ...zero, overdue: 1 })).toBe(
      '1 overdue follow-up, and nothing else today.',
    );
    expect(describeDay({ ...zero, overdue: 3, awaitingFirstContact: 2 })).toBe(
      '3 overdue follow-ups, and nothing else today · 2 new leads to call.',
    );
    expect(describeDay({ ...zero, overdue: 1, laterToday: 1 })).toBe(
      '1 follow-up left today · 1 overdue.',
    );
  });

  it('offers the advice only when there is somebody to take it', () => {
    // The old condition fired when *no other clause* was true, which the uncalled-lead clause
    // itself breaks: the suggestion to call the leads nobody has reached was shown only on days
    // when there were none of them.
    expect(describeDay({ ...zero, awaitingFirstContact: 1 })).toBe(
      'Nothing is owed today. A good moment to call the lead nobody has reached.',
    );
    expect(describeDay({ ...zero, awaitingFirstContact: 4 })).toBe(
      'Nothing is owed today. A good moment to call the 4 leads nobody has reached.',
    );
    expect(describeDay(zero)).not.toMatch(/good moment/);
  });

  it('still says what is running out on a day with nothing due', () => {
    expect(describeDay({ ...zero, promisesBreached: 2 })).toBe(
      'Nothing is owed today · 2 missed promises.',
    );
    expect(describeDay({ ...zero, awaitingFirstContact: 1, promisesAtRisk: 1 })).toBe(
      'Nothing is owed today · 1 new lead to call · 1 promise running out.',
    );
  });

  it('counts one follow-up in the singular, which is where this kind of sentence usually breaks', () => {
    expect(describeDay({ ...zero, dueNow: 1 })).toBe('1 follow-up left today.');
    expect(describeDay({ ...zero, dueNow: 1, awaitingFirstContact: 1 })).toBe(
      '1 follow-up left today · 1 new lead to call.',
    );
  });
});

describe('greeting', () => {
  it('reads the viewer’s own hour', () => {
    expect(greeting(new Date(2026, 9, 13, 8, 0))).toBe('Good morning');
    expect(greeting(new Date(2026, 9, 13, 13, 0))).toBe('Good afternoon');
    expect(greeting(new Date(2026, 9, 13, 20, 0))).toBe('Good evening');
  });
});
