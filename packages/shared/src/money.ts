/**
 * Money is always an integer of minor units plus a currency.
 * Floats are never used for money anywhere in this codebase
 * (docs/database-design.md §1).
 */
export interface Money {
  readonly amountMinor: bigint;
  readonly currency: string;
}

const MINOR_UNIT_EXPONENT: Readonly<Record<string, number>> = {
  INR: 2,
  USD: 2,
  EUR: 2,
  GBP: 2,
  AED: 2,
  AUD: 2,
  CAD: 2,
  SGD: 2,
  JPY: 0,
  KWD: 3,
  BHD: 3,
  OMR: 3,
};

export function minorUnitExponent(currency: string): number {
  return MINOR_UNIT_EXPONENT[currency.toUpperCase()] ?? 2;
}

export function money(amountMinor: bigint | number, currency: string): Money {
  const code = currency.toUpperCase();
  if (!/^[A-Z]{3}$/.test(code)) throw new Error(`Invalid currency code: ${currency}`);
  return { amountMinor: BigInt(amountMinor), currency: code };
}

/** Parses a human-entered major-unit amount ("50,000.50") into minor units. */
export function parseMoney(input: string | number, currency: string): Money {
  const text = String(input).replace(/[,\s]/g, '');
  if (!/^-?\d+(\.\d+)?$/.test(text)) throw new Error(`Invalid amount: ${String(input)}`);
  const exponent = minorUnitExponent(currency);
  const [whole = '0', fraction = ''] = text.split('.');
  const padded = fraction.padEnd(exponent, '0').slice(0, exponent);
  const negative = whole.startsWith('-');
  const magnitude = BigInt(`${whole.replace('-', '')}${padded}`);
  return money(negative ? -magnitude : magnitude, currency);
}

export function formatMoney(value: Money, locale = 'en-IN'): string {
  const exponent = minorUnitExponent(value.currency);
  const divisor = 10 ** exponent;
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: value.currency,
    minimumFractionDigits: exponent,
  }).format(Number(value.amountMinor) / divisor);
}

export function addMoney(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return { amountMinor: a.amountMinor + b.amountMinor, currency: a.currency };
}

export function subtractMoney(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return { amountMinor: a.amountMinor - b.amountMinor, currency: a.currency };
}

function assertSameCurrency(a: Money, b: Money): void {
  if (a.currency !== b.currency) {
    throw new Error(`Currency mismatch: ${a.currency} and ${b.currency}`);
  }
}
