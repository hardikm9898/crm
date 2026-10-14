import { describe, expect, it } from 'vitest';
import {
  CALL_DIRECTIONS as API_DIRECTIONS,
  CALL_OUTCOME_CATEGORIES as API_CATEGORIES,
  CALL_STATUSES as API_STATUSES,
  describeCallDuration as apiDescribeDuration,
  isContact as apiIsContact,
  statusForCategory as apiStatusForCategory,
} from '@leados/shared';
import {
  CALL_DIRECTIONS,
  CALL_OUTCOME_CATEGORIES,
  CALL_STATUSES,
  CATEGORY_LABELS,
  STATUS_CLASSES,
  STATUS_LABELS,
  describeCallDuration,
  durationSeconds,
  isContactCategory,
  statusForCategory,
} from './calls';

/**
 * The reconciliation `lib/calls.ts` exists for.
 *
 * The web app may not import `@leados/shared` at runtime — its entry point reaches
 * `node:async_hooks` and a client component that pulls that in fails `next build`. So the call
 * vocabulary is written twice, and this spec runs in Node and may import both.
 */
describe('the call vocabulary', () => {
  it('matches the API’s, which the runtime code deliberately does not import', () => {
    expect([...CALL_DIRECTIONS]).toEqual([...API_DIRECTIONS]);
    expect([...CALL_STATUSES]).toEqual([...API_STATUSES]);
    expect([...CALL_OUTCOME_CATEGORIES]).toEqual([...API_CATEGORIES]);
  });

  it('agrees with the API about who was reached', () => {
    // The answer that decides whether a lead is marked contacted and an SLA promise answered. A
    // drift here would put a green chip on a call the API counted as a miss.
    for (const category of CALL_OUTCOME_CATEGORIES) {
      expect(isContactCategory(category), category).toBe(apiIsContact(category));
    }
  });

  it('derives the same status from an outcome as the API would', () => {
    for (const category of CALL_OUTCOME_CATEGORIES) {
      expect(statusForCategory(category), category).toBe(apiStatusForCategory(category));
    }
  });

  it('phrases a duration identically', () => {
    for (const seconds of [null, 0, 1, 40, 180, 252, 3_600, 3_900, 28_800]) {
      expect(describeCallDuration(seconds), String(seconds)).toBe(apiDescribeDuration(seconds));
    }
  });
});

describe('the screen’s own vocabulary', () => {
  it('has a label and a colour for every status', () => {
    for (const status of CALL_STATUSES) {
      expect(STATUS_LABELS[status], status).toBeTruthy();
      expect(STATUS_CLASSES[status], status).toBeTruthy();
    }
  });

  it('makes the one status that owes an answer amber, not grey', () => {
    // `dialing` is the only row on the screen somebody can still do something about. A quiet
    // colour there is how a lead ends up with four attempts and no record of any of them.
    expect(STATUS_CLASSES['dialing']).toMatch(/amber/);
    expect(STATUS_LABELS['dialing']).toBe('No outcome yet');
  });

  it('has a sentence for every category, in words a business owner would use', () => {
    for (const category of CALL_OUTCOME_CATEGORIES) {
      expect(CATEGORY_LABELS[category], category).toBeTruthy();
      // Not the column value: "not_interested" is a developer's word.
      expect(CATEGORY_LABELS[category], category).not.toContain('_');
    }
  });
});

describe('the duration the form submits', () => {
  it('adds the two boxes up', () => {
    expect(durationSeconds('4', '12')).toBe(252);
    expect(durationSeconds('0', '40')).toBe(40);
    expect(durationSeconds('2', null)).toBe(120);
    expect(durationSeconds(null, '45')).toBe(45);
  });

  it('answers null for an empty form rather than a call that lasted no time', () => {
    // `Number(null)` and `Number('')` are both 0, and 0 is a meaningful duration: a blank form
    // coerced to zero would record "connected, no time on the call" on every no-answer.
    expect(durationSeconds(null, null)).toBeNull();
    expect(durationSeconds('', '')).toBeNull();
  });

  it('refuses nonsense instead of coercing it', () => {
    expect(durationSeconds('abc', null)).toBeNull();
    expect(durationSeconds('-3', null)).toBeNull();
  });
});
