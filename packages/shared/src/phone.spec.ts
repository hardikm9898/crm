import { describe, expect, it } from 'vitest';
import { PhoneNormalizationError, normalizePhone, tryNormalizePhone } from './phone.js';

describe('normalizePhone', () => {
  it('normalizes the shapes real lead sources send to one E.164 value', () => {
    // The duplicate-detection promise: all of these are the same customer.
    const variants = [
      '9876543210',
      '09876543210',
      '+91 98765 43210',
      '+919876543210',
      '0091 9876543210',
      '(987) 654-3210',
      '98765-43210',
      ' 9876543210 ',
    ];
    for (const variant of variants) {
      expect(normalizePhone(variant, 'IN').e164, variant).toBe('+919876543210');
    }
  });

  it('keeps the raw input for support and debugging', () => {
    expect(normalizePhone('+91 98765 43210').raw).toBe('+91 98765 43210');
  });

  it('exposes last4 for partial search', () => {
    expect(normalizePhone('9876543210').last4).toBe('3210');
  });

  it('detects the country from the dial code', () => {
    expect(normalizePhone('+14155552671').countryCode).toBe('US');
    expect(normalizePhone('+971501234567').countryCode).toBe('AE');
    expect(normalizePhone('+6581234567').countryCode).toBe('SG');
  });

  it('honours a different organization default country', () => {
    expect(normalizePhone('4155552671', 'US').e164).toBe('+14155552671');
    expect(normalizePhone('07911123456', 'GB').e164).toBe('+447911123456');
  });

  it('rejects clearly invalid input', () => {
    expect(() => normalizePhone('')).toThrow(PhoneNormalizationError);
    expect(() => normalizePhone('12345')).toThrow(PhoneNormalizationError);
    expect(() => normalizePhone('98765 43210 98765 43210')).toThrow(PhoneNormalizationError);
    expect(() => normalizePhone('call me maybe')).toThrow(PhoneNormalizationError);
  });

  it('rejects a national number of the wrong length for the country', () => {
    expect(() => normalizePhone('987654321', 'IN')).toThrow(/unsupported_length|too_short/);
  });
});

describe('tryNormalizePhone', () => {
  it('returns null instead of throwing, so one bad import row cannot fail a batch', () => {
    expect(tryNormalizePhone('garbage')).toBeNull();
    expect(tryNormalizePhone(null)).toBeNull();
    expect(tryNormalizePhone(undefined)).toBeNull();
    expect(tryNormalizePhone('9876543210')?.e164).toBe('+919876543210');
  });
});
