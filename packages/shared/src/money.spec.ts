import { describe, expect, it } from 'vitest';
import { addMoney, formatMoney, money, parseMoney, subtractMoney } from './money.js';

describe('money', () => {
  it('parses major units into minor units without float error', () => {
    expect(parseMoney('50,000.50', 'INR').amountMinor).toBe(5_000_050n);
    expect(parseMoney(0.1, 'INR').amountMinor).toBe(10n);
    expect(parseMoney('0.07', 'USD').amountMinor).toBe(7n);
  });

  it('handles zero-decimal and three-decimal currencies', () => {
    expect(parseMoney('1000', 'JPY').amountMinor).toBe(1000n);
    expect(parseMoney('1.234', 'KWD').amountMinor).toBe(1234n);
  });

  it('survives the classic float trap', () => {
    const total = addMoney(parseMoney('0.1', 'USD'), parseMoney('0.2', 'USD'));
    expect(total.amountMinor).toBe(30n);
    expect(formatMoney(total, 'en-US')).toBe('$0.30');
  });

  it('adds and subtracts only within one currency', () => {
    const a = money(1000n, 'INR');
    expect(subtractMoney(a, money(250n, 'INR')).amountMinor).toBe(750n);
    expect(() => addMoney(a, money(1n, 'USD'))).toThrow(/Currency mismatch/);
  });

  it('rejects invalid currency codes and amounts', () => {
    expect(() => money(1n, 'RUPEES')).toThrow();
    expect(() => parseMoney('abc', 'INR')).toThrow();
  });
});
