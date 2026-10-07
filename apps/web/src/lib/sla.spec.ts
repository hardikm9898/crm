import { describe, expect, it } from 'vitest';
import { SLA_TARGETS as API_TARGETS } from '@leados/shared';
import {
  BOARD_COUNTS,
  HEALTH_CLASSES,
  HEALTH_LABELS,
  SLA_HEALTHS,
  SLA_TARGETS,
  TARGET_LABELS,
  describeTargetMinutes,
  minutesFromNow,
} from './sla';

describe('the SLA vocabulary', () => {
  it('matches the API’s, which this file deliberately does not import at runtime', () => {
    // `@leados/shared`'s entry point reaches `node:async_hooks` through the tenant context, and a
    // client component that pulls that in fails the Next build outright. So the list is declared
    // twice and reconciled here, in a test that runs in Node and may import both.
    expect([...SLA_TARGETS]).toEqual([...API_TARGETS]);
  });

  it('has a heading and a colour for every health reading', () => {
    for (const health of SLA_HEALTHS) {
      expect(HEALTH_LABELS[health], health).toBeTruthy();
      expect(HEALTH_CLASSES[health], health).toBeTruthy();
    }
    for (const target of SLA_TARGETS) {
      expect(TARGET_LABELS[target], target).toBeTruthy();
    }
  });

  it('names no column name on the screen', () => {
    // `first_response` is a column name; nobody outside the repository reads it.
    for (const label of [...Object.values(TARGET_LABELS), ...Object.values(HEALTH_LABELS)]) {
      expect(label).not.toMatch(/_/);
    }
  });

  it('reads the board in the order a manager works it', () => {
    expect(BOARD_COUNTS.map((entry) => entry.key).slice(0, 2)).toEqual(['breached', 'at_risk']);
    for (const entry of BOARD_COUNTS) {
      // "Missed (3)" says what but not why; the whole point of a board is that the next thing to
      // do is obvious.
      expect(entry.hint.length, entry.key).toBeGreaterThan(10);
    }
  });
});

describe('describeTargetMinutes', () => {
  it('says “working” where that is what it means', () => {
    // The distinction is the whole feature: a lead arriving at 18:50 on a Friday is not late at
    // 19:50, and a screen that said "60 minutes" would be promising something else.
    // "an working hour" is what a careless article produces, and it would reach the screen.
    expect(describeTargetMinutes(60)).toBe('a working hour');
    expect(describeTargetMinutes(60, false)).toBe('an hour');
    expect(describeTargetMinutes(120, false)).toBe('2 hours');
    expect(describeTargetMinutes(45)).toBe('45 working minutes');
  });

  it('reads a day’s work as a day', () => {
    expect(describeTargetMinutes(540)).toBe('a working day');
    expect(describeTargetMinutes(1080)).toBe('2 working days');
  });
});

describe('minutesFromNow', () => {
  it('is positive ahead and negative behind, so one function serves both sides', () => {
    const now = new Date('2026-10-07T10:00:00.000Z');
    expect(minutesFromNow('2026-10-07T10:30:00.000Z', now)).toBe(30);
    expect(minutesFromNow('2026-10-07T09:15:00.000Z', now)).toBe(-45);
  });
});
