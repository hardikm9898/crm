import { describe, expect, it } from 'vitest';
import {
  MATCHABLE_FIELDS,
  confidenceFor,
  matchKey,
  matchRule,
  matchSet,
  matchableField,
  validateMatchOn,
} from './duplicates.js';

describe('matchKey — how two values of a field are compared', () => {
  it('compares an E.164 phone byte-for-byte, because it is already canonical', () => {
    expect(matchKey('phoneE164', '+919876543210')).toBe('+919876543210');
    // Normalization happens on write; a raw number never reaches here.
    expect(matchKey('phoneE164', ' +919876543210 ')).toBe('+919876543210');
  });

  it('compares email case-insensitively — one mailbox, one person', () => {
    expect(matchKey('email', 'Anita@Example.TEST')).toBe('anita@example.test');
  });

  it('collapses whitespace in names and companies', () => {
    expect(matchKey('company', '  Sharma   Motors  ')).toBe('sharma motors');
    expect(matchKey('fullName', 'Anita  Sharma')).toBe('anita sharma');
  });

  it('treats blank and non-string values as nothing to compare', () => {
    expect(matchKey('email', '')).toBeNull();
    expect(matchKey('email', '   ')).toBeNull();
    expect(matchKey('email', null)).toBeNull();
    expect(matchKey('email', 42)).toBeNull();
  });

  it('returns null for a field that is not matchable', () => {
    expect(matchKey('score', '10')).toBeNull();
  });
});

describe('matchSet', () => {
  it('matches only when every field in the set matches', () => {
    const candidate = { email: 'a@b.test', lastName: 'Sharma' };
    expect(
      matchSet(['email', 'lastName'], candidate, { email: 'A@B.test', lastName: 'sharma' }),
    ).toEqual(['email', 'lastName']);
    expect(
      matchSet(['email', 'lastName'], candidate, { email: 'A@B.test', lastName: 'Patel' }),
    ).toBeNull();
  });

  it('does not treat two absent values as a match', () => {
    // Otherwise every anonymous enquiry would be a duplicate of every other.
    expect(matchSet(['email'], {}, {})).toBeNull();
    expect(matchSet(['email'], { email: null }, { email: '' })).toBeNull();
    expect(
      matchSet(['email', 'lastName'], { lastName: 'Sharma' }, { lastName: 'Sharma' }),
    ).toBeNull();
  });
});

describe('matchRule — any set, all fields within a set', () => {
  const matchOn = [['phoneE164'], ['email', 'lastName']];

  it('matches on the first set that fires', () => {
    expect(
      matchRule(matchOn, { phoneE164: '+919876543210' }, { phoneE164: '+919876543210' }),
    ).toEqual(['phoneE164']);
  });

  it('falls through to a later set', () => {
    expect(
      matchRule(
        matchOn,
        { phoneE164: '+919000000001', email: 'a@b.test', lastName: 'Sharma' },
        { phoneE164: '+919000000002', email: 'a@b.test', lastName: 'Sharma' },
      ),
    ).toEqual(['email', 'lastName']);
  });

  it('returns null when no set fires', () => {
    expect(matchRule(matchOn, { email: 'a@b.test' }, { email: 'c@d.test' })).toBeNull();
  });
});

describe('validateMatchOn — refusing a rule that would group strangers', () => {
  it('accepts an identifier on its own', () => {
    expect(validateMatchOn([['phoneE164']])).toEqual([]);
    expect(validateMatchOn([['email']])).toEqual([]);
    expect(validateMatchOn([['whatsappE164']])).toEqual([]);
  });

  it('accepts a composite that includes an identifier', () => {
    expect(validateMatchOn([['email', 'lastName']])).toEqual([]);
  });

  it('refuses a set of weak fields only — the rule that would merge half a database', () => {
    const problems = validateMatchOn([['city']]);
    expect(problems[0]?.code).toBe('TOO_WEAK');
    expect(problems[0]?.message).toContain('phone');
    expect(validateMatchOn([['firstName', 'city']])[0]?.code).toBe('TOO_WEAK');
  });

  it('accepts enough weak fields together to be discriminating', () => {
    // fullName + company + postalCode is 43 — above the floor, and plausible in practice.
    expect(validateMatchOn([['fullName', 'company', 'postalCode']])).toEqual([]);
  });

  it('refuses an empty rule, an empty set and an unknown field', () => {
    expect(validateMatchOn([])[0]?.code).toBe('EMPTY');
    expect(validateMatchOn('phone')[0]?.code).toBe('EMPTY');
    expect(validateMatchOn([[]])[0]?.code).toBe('EMPTY_SET');
    const unknown = validateMatchOn([['phone_number']]);
    expect(unknown[0]?.code).toBe('UNKNOWN_FIELD');
    // The message names what *is* available, because the mistake is usually a near-miss.
    expect(unknown[0]?.message).toContain('phoneE164');
  });

  it('refuses a repeated field in one set', () => {
    expect(validateMatchOn([['email', 'email']])[0]?.code).toBe('DUPLICATE_FIELD');
  });

  it('reports the index of each bad set, so a form can point at it', () => {
    const problems = validateMatchOn([['phoneE164'], ['city']]);
    expect(problems).toHaveLength(1);
    expect(problems[0]?.setIndex).toBe(1);
  });
});

describe('confidenceFor', () => {
  it('scores an identifier match high', () => {
    expect(confidenceFor(['phoneE164'])).toBeGreaterThanOrEqual(80);
  });

  it('caps a match with no identifier below certainty, however many fields agree', () => {
    // Four weak fields agreeing is suggestive, not conclusive — and a queue a person triages needs
    // that distinction to be visible.
    expect(confidenceFor(['fullName', 'company', 'city', 'postalCode'])).toBeLessThanOrEqual(85);
  });

  it('never returns zero for a match that happened', () => {
    expect(confidenceFor(['city'])).toBeGreaterThan(0);
  });

  it('is at least as confident about more agreeing fields', () => {
    expect(confidenceFor(['email', 'lastName'])).toBeGreaterThanOrEqual(confidenceFor(['email']));
  });
});

describe('the matchable field registry', () => {
  it('describes every field it lists', () => {
    for (const field of MATCHABLE_FIELDS) {
      expect(matchableField(field.field)).toBe(field);
      expect(field.label.length).toBeGreaterThan(0);
      expect(field.weight).toBeGreaterThan(0);
    }
  });

  it('marks exactly the identifiers as sufficient alone', () => {
    const alone = MATCHABLE_FIELDS.filter((field) => field.sufficientAlone).map((f) => f.field);
    expect(alone.sort()).toEqual(['email', 'phoneE164', 'whatsappE164']);
  });

  it('compares phone numbers exactly and names loosely, never the other way round', () => {
    expect(matchableField('phoneE164')?.comparison).toBe('exact');
    expect(matchableField('fullName')?.comparison).toBe('normalized');
  });

  it('only aliases fields that are compared the same way', () => {
    // An alias compared differently from the field naming it would compare a normalized value
    // against an exact one and never match, silently.
    for (const field of MATCHABLE_FIELDS) {
      for (const alias of field.aliasFields ?? []) {
        expect(matchableField(alias), `${field.field} aliases unknown ${alias}`).toBeDefined();
        expect(matchableField(alias)?.comparison).toBe(field.comparison);
      }
    }
  });

  it('aliases the phone columns to each other, in both directions', () => {
    // One-directional aliasing would make the result depend on which column the rule happened to
    // name, which is not something a business could reason about.
    expect(matchableField('phoneE164')?.aliasFields).toContain('whatsappE164');
    expect(matchableField('whatsappE164')?.aliasFields).toContain('phoneE164');
  });
});

describe('a number that arrived in the other phone column', () => {
  const rule = [['phoneE164']];

  it('matches a capture whose WhatsApp number is the existing lead phone', () => {
    expect(
      matchRule(rule, { whatsappE164: '+919812390001' }, { phoneE164: '+919812390001' }),
    ).toEqual(['phoneE164']);
  });

  it('matches the other way round too', () => {
    expect(
      matchRule(rule, { phoneE164: '+919812390001' }, { whatsappE164: '+919812390001' }),
    ).toEqual(['phoneE164']);
  });

  it('matches when either of two numbers on the record agrees', () => {
    expect(
      matchRule(
        rule,
        { phoneE164: '+919000000001', whatsappE164: '+919812390001' },
        { phoneE164: '+919812390001', whatsappE164: '+919777777777' },
      ),
    ).toEqual(['phoneE164']);
  });

  it('still does not match two records that share no number at all', () => {
    expect(
      matchRule(rule, { whatsappE164: '+919812390001' }, { phoneE164: '+919000000002' }),
    ).toBeNull();
  });

  it('still refuses to match two records with no number at all', () => {
    expect(matchRule(rule, { email: 'a@x.test' }, { email: 'a@x.test' })).toBeNull();
  });

  it('does not alias fields that are not phone numbers', () => {
    expect(matchRule([['email']], { email: 'a@x.test' }, { fullName: 'a@x.test' })).toBeNull();
  });
});
