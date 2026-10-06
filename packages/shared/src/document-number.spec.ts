import { describe, expect, it } from 'vitest';
import { formatDocumentNumber, previewDocumentNumber } from './document-number.js';

describe('formatDocumentNumber', () => {
  it('pads to the series width', () => {
    expect(formatDocumentNumber({ prefix: 'QTN-', padding: 4 }, 7)).toBe('QTN-0007');
  });

  it('leaves a number alone when the series does not pad', () => {
    expect(formatDocumentNumber({ prefix: 'Q', padding: 0 }, 7)).toBe('Q7');
  });

  it('keeps the whole number when it outgrows the padding, rather than wrapping', () => {
    // Truncating here would hand two customers the same reference, which is worse than an ugly
    // number — and would collide on (organization_id, number, version).
    expect(formatDocumentNumber({ prefix: 'QTN-', padding: 4 }, 10_000)).toBe('QTN-10000');
  });

  it('allows an empty prefix, because some businesses just number things', () => {
    expect(formatDocumentNumber({ prefix: '', padding: 3 }, 12)).toBe('012');
  });

  it('accepts a prefix with a year in it, since it is the tenant’s string and not a template', () => {
    expect(formatDocumentNumber({ prefix: 'Q/2026/', padding: 4 }, 1)).toBe('Q/2026/0001');
  });

  it('clamps an absurd padding rather than building a kilobyte of zeroes', () => {
    expect(formatDocumentNumber({ prefix: '', padding: 9_999 }, 1)).toHaveLength(12);
  });

  it('refuses a counter value that is not a positive whole number', () => {
    expect(() => formatDocumentNumber({ prefix: '', padding: 4 }, 0)).toThrow(/positive integer/);
    expect(() => formatDocumentNumber({ prefix: '', padding: 4 }, -1)).toThrow(/positive integer/);
    expect(() => formatDocumentNumber({ prefix: '', padding: 4 }, 1.5)).toThrow(/positive integer/);
  });

  it('previews the next number for a settings screen', () => {
    expect(previewDocumentNumber({ prefix: 'INV-', padding: 5 }, 42)).toBe('INV-00042');
  });
});
