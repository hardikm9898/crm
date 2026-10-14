import { describe, expect, it } from 'vitest';
import {
  CALL_OUTCOME_CATEGORIES,
  CALL_STATUSES,
  DEFAULT_CALL_OUTCOMES,
  MAX_CALL_SECONDS,
  SETTLED_CALL_STATUSES,
  describeCallDuration,
  isCallDuration,
  isContact,
  isSettledCallStatus,
  statusForCategory,
} from './calls.js';

describe('the call status vocabulary', () => {
  it('is every status except the one that means nobody knows yet', () => {
    // The API builds its "a logged call is a call that is over" schema straight from this list, so
    // a sixth status added to `CALL_STATUSES` and forgotten here would be quietly un-loggable.
    expect([...SETTLED_CALL_STATUSES]).toEqual(CALL_STATUSES.filter((s) => s !== 'dialing'));
  });

  it('recognises a settled status and refuses anything else', () => {
    expect(isSettledCallStatus('no_answer')).toBe(true);
    expect(isSettledCallStatus('dialing')).toBe(false);
    expect(isSettledCallStatus('whatever')).toBe(false);
  });
});

describe('which outcomes mean somebody was reached', () => {
  it('counts a conversation that went nowhere', () => {
    // A business that rang, got through and was turned down has answered the enquiry. Counting
    // that as "never responded" would hold its own SLA against it for doing the job.
    expect(isContact('not_interested')).toBe(true);
    expect(isContact('connected')).toBe(true);
    expect(isContact('callback')).toBe(true);
  });

  it('does not count a ringing phone, or the wrong person answering', () => {
    expect(isContact('no_answer')).toBe(false);
    expect(isContact('busy')).toBe(false);
    // Somebody was spoken to, but not *this* person — the lead has still never been reached.
    expect(isContact('wrong_number')).toBe(false);
  });

  it('has an answer for every category, and refuses an unknown one', () => {
    for (const category of CALL_OUTCOME_CATEGORIES) {
      expect(typeof isContact(category), category).toBe('boolean');
    }
    expect(isContact('')).toBe(false);
  });
});

describe('what a workspace starts with', () => {
  it('offers one name per category, so nothing is unreachable from the form', () => {
    expect(DEFAULT_CALL_OUTCOMES).toHaveLength(CALL_OUTCOME_CATEGORIES.length);
    expect(new Set(DEFAULT_CALL_OUTCOMES.map((o) => o.category))).toEqual(
      new Set(CALL_OUTCOME_CATEGORIES),
    );
  });

  it('names them distinctly, because `call_outcomes` is unique on (organization, name)', () => {
    expect(new Set(DEFAULT_CALL_OUTCOMES.map((o) => o.name)).size).toBe(
      DEFAULT_CALL_OUTCOMES.length,
    );
  });

  it('orders them the way somebody picks from them', () => {
    const orders = DEFAULT_CALL_OUTCOMES.map((o) => o.sortOrder);
    expect([...orders].sort((a, b) => a - b)).toEqual(orders);
    // The three that mean a conversation happened come first: that is the common case, and a form
    // whose first option is "No answer" invites the wrong answer.
    expect(DEFAULT_CALL_OUTCOMES.slice(0, 3).every((o) => isContact(o.category))).toBe(true);
  });
});

describe('a duration a person reads', () => {
  it('keeps the seconds under a minute, because a 40-second call is a fact', () => {
    expect(describeCallDuration(40)).toBe('40 sec');
  });

  it('reads minutes and seconds, and drops a bare zero', () => {
    expect(describeCallDuration(252)).toBe('4 min 12 sec');
    expect(describeCallDuration(180)).toBe('3 min');
  });

  it('reads hours once a call is long', () => {
    expect(describeCallDuration(3_900)).toBe('1 hr 5 min');
  });

  it('says so when there was no time on the call, rather than "0 sec"', () => {
    // A no-answer has no duration at all, and "0 sec" reads as a measurement rather than as the
    // absence of one.
    expect(describeCallDuration(null)).toBe('no time on the call');
    expect(describeCallDuration(0)).toBe('no time on the call');
  });
});

describe('the duration guard', () => {
  it('accepts a call up to eight hours and refuses a typo', () => {
    expect(isCallDuration(0)).toBe(true);
    expect(isCallDuration(MAX_CALL_SECONDS)).toBe(true);
    expect(isCallDuration(MAX_CALL_SECONDS + 1)).toBe(false);
    expect(isCallDuration(-1)).toBe(false);
    // A provider reporting milliseconds is the realistic version of this.
    expect(isCallDuration(252_000)).toBe(false);
  });

  it('refuses a fraction, because the column is an integer', () => {
    expect(isCallDuration(12.5)).toBe(false);
  });
});

describe('the status a chosen outcome implies', () => {
  it('never contradicts the API’s own refusal', () => {
    // `CallsService.assertStatusMatchesOutcome` refuses an outcome that means somebody was spoken
    // to on a call that did not connect. The screen derives the status from the outcome, so this
    // proves the derivation can never produce the request the API rejects.
    for (const category of CALL_OUTCOME_CATEGORIES) {
      if (isContact(category)) expect(statusForCategory(category), category).toBe('completed');
    }
  });

  it('answers with a settled status for every category', () => {
    for (const category of CALL_OUTCOME_CATEGORIES) {
      expect(isSettledCallStatus(statusForCategory(category)), category).toBe(true);
    }
  });

  it('says a wrong number connected, while `isContact` says nobody was reached', () => {
    // The one category where the two questions diverge: somebody answered, but not this person.
    expect(statusForCategory('wrong_number')).toBe('completed');
    expect(isContact('wrong_number')).toBe(false);
  });

  it('never derives `failed`, which only a provider can know', () => {
    expect(CALL_OUTCOME_CATEGORIES.map(statusForCategory)).not.toContain('failed');
  });
});
