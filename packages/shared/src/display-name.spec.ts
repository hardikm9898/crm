import { describe, expect, it } from 'vitest';
import { buildDisplayName } from './display-name.js';

describe('the name a record is shown by', () => {
  it('prefers a person’s name', () => {
    expect(
      buildDisplayName({ firstName: 'Kavita', lastName: 'Rao', company: 'Rao Interiors' }),
    ).toBe('Kavita Rao');
  });

  it('accepts half a name', () => {
    expect(buildDisplayName({ firstName: 'Kavita' })).toBe('Kavita');
    expect(buildDisplayName({ lastName: 'Rao' })).toBe('Rao');
  });

  it('falls back to the company, because a B2B enquiry often names no person', () => {
    expect(buildDisplayName({ company: 'Rao Interiors', email: 'hello@rao.test' })).toBe(
      'Rao Interiors',
    );
  });

  it('falls back to the email before the phone, because it is readable', () => {
    expect(buildDisplayName({ email: 'kavita@rao.test', phoneE164: '+919845012345' })).toBe(
      'kavita@rao.test',
    );
  });

  it('uses the phone as a last resort, and WhatsApp after that', () => {
    expect(buildDisplayName({ phoneE164: '+919845012345' })).toBe('+919845012345');
    expect(buildDisplayName({ whatsappE164: '+919845012345' })).toBe('+919845012345');
  });

  it('ignores whitespace-only parts rather than naming a record " "', () => {
    expect(buildDisplayName({ firstName: '  ', company: '\t', email: ' ' })).toBe('');
  });

  it('returns an empty string when there is no identity at all', () => {
    expect(buildDisplayName({})).toBe('');
  });
});
