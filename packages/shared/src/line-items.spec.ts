import { describe, expect, it } from 'vitest';
import { LineItemError, documentTotals, lineTotals, weightedValueMinor } from './line-items.js';

describe('one priced line', () => {
  it('multiplies a whole quantity exactly', () => {
    expect(lineTotals({ quantity: 3, unitPriceMinor: 19_999 })).toEqual({
      grossMinor: 59_997,
      discountMinor: 0,
      netMinor: 59_997,
      taxMinor: 0,
      totalMinor: 59_997,
    });
  });

  it('multiplies a fractional quantity without floating-point drift', () => {
    // 2.5 × ₹199.99 is exactly ₹499.98 (49 998 paise). Done in floating point, `0.1 * 3` style
    // error puts this a paisa out, and a paisa out on a quotation is a conversation.
    expect(lineTotals({ quantity: 2.5, unitPriceMinor: 19_999 }).grossMinor).toBe(49_998);
    expect(lineTotals({ quantity: 0.1, unitPriceMinor: 300 }).grossMinor).toBe(30);
    expect(lineTotals({ quantity: 1.75, unitPriceMinor: 1_000 }).grossMinor).toBe(1_750);
  });

  it('takes the discount off before tax, which is how tax works', () => {
    const line = lineTotals({
      quantity: 1,
      unitPriceMinor: 100_000,
      discountMinor: 10_000,
      taxPercent: 18,
    });
    expect(line.netMinor).toBe(90_000);
    expect(line.taxMinor).toBe(16_200);
    expect(line.totalMinor).toBe(106_200);
  });

  it('handles a fractional tax rate', () => {
    expect(lineTotals({ quantity: 1, unitPriceMinor: 100_000, taxPercent: 2.5 }).taxMinor).toBe(
      2_500,
    );
  });

  it('refuses a discount larger than the line', () => {
    expect(() => lineTotals({ quantity: 1, unitPriceMinor: 1_000, discountMinor: 1_001 })).toThrow(
      LineItemError,
    );
  });

  it('refuses negatives, fractional minor units and an impossible tax rate', () => {
    expect(() => lineTotals({ quantity: -1, unitPriceMinor: 100 })).toThrow(/negative/i);
    expect(() => lineTotals({ quantity: 1, unitPriceMinor: -100 })).toThrow(/negative/i);
    expect(() => lineTotals({ quantity: 1, unitPriceMinor: 10.5 })).toThrow(/whole number/i);
    expect(() => lineTotals({ quantity: 1, unitPriceMinor: 100, taxPercent: 101 })).toThrow(
      /between 0 and 100/i,
    );
    expect(() => lineTotals({ quantity: 1, unitPriceMinor: 100, discountMinor: 1.5 })).toThrow(
      /whole number/i,
    );
  });

  it('allows a free line, which is how a bundled item is quoted', () => {
    expect(lineTotals({ quantity: 1, unitPriceMinor: 0, taxPercent: 18 }).totalMinor).toBe(0);
  });

  it('refuses a quantity beyond what stays exact', () => {
    expect(() => lineTotals({ quantity: 2_000_000, unitPriceMinor: 100 })).toThrow(/exceed/i);
  });
});

describe('the document those lines add up to', () => {
  const ITEMS = [
    { quantity: 2, unitPriceMinor: 50_000, taxPercent: 18 },
    { quantity: 1, unitPriceMinor: 30_000, discountMinor: 5_000, taxPercent: 18 },
    { quantity: 3, unitPriceMinor: 10_000, taxPercent: 5 },
  ];

  it('totals to the sum of the lines, which is the column a customer can add up', () => {
    const totals = documentTotals(ITEMS);
    const lines = ITEMS.map((item) => lineTotals(item));
    expect(totals.grossMinor).toBe(lines.reduce((sum, line) => sum + line.grossMinor, 0));
    expect(totals.taxMinor).toBe(lines.reduce((sum, line) => sum + line.taxMinor, 0));
    expect(totals.totalMinor).toBe(lines.reduce((sum, line) => sum + line.totalMinor, 0));
    expect(totals.netMinor + totals.taxMinor).toBe(totals.totalMinor);
  });

  it('groups tax by rate, because a tax invoice has to show the split', () => {
    // A single Indian quotation routinely mixes 5%, 12% and 18% GST. A document-level rate cannot
    // express that, and a total without the breakdown is not a compliant invoice.
    expect(documentTotals(ITEMS).taxBreakdown).toEqual([
      { percent: 5, taxMinor: 1_500 },
      { percent: 18, taxMinor: 22_500 },
    ]);
  });

  it('leaves a zero-rated line out of the breakdown but inside the total', () => {
    const totals = documentTotals([
      { quantity: 1, unitPriceMinor: 10_000 },
      { quantity: 1, unitPriceMinor: 10_000, taxPercent: 18 },
    ]);
    expect(totals.taxBreakdown).toEqual([{ percent: 18, taxMinor: 1_800 }]);
    expect(totals.totalMinor).toBe(21_800);
  });

  it('is zero for an empty document rather than throwing', () => {
    expect(documentTotals([])).toEqual({
      grossMinor: 0,
      discountMinor: 0,
      netMinor: 0,
      taxMinor: 0,
      totalMinor: 0,
      taxBreakdown: [],
    });
  });

  it('keeps the per-line rounding, rather than recomputing from the raw inputs', () => {
    // Three lines whose individual tax rounds up. Recomputing tax on the summed net would give
    // 3 × 0.5 → 2 paise; summing the rounded lines gives 3. The customer can check the second.
    const items = Array.from({ length: 3 }, () => ({
      quantity: 1,
      unitPriceMinor: 3,
      taxPercent: 18,
    }));
    expect(documentTotals(items).taxMinor).toBe(3);
  });
});

describe('what a stage implies about a deal', () => {
  it('weights the value by the probability', () => {
    expect(weightedValueMinor(1_000_000, 40)).toBe(400_000);
  });

  it('is nothing at 0% and everything at 100%', () => {
    expect(weightedValueMinor(1_000_000, 0)).toBe(0);
    expect(weightedValueMinor(1_000_000, 100)).toBe(1_000_000);
  });

  it('rounds to a whole minor unit', () => {
    expect(weightedValueMinor(333, 33)).toBe(110);
  });
});
