/**
 * Phone normalization to E.164.
 *
 * Duplicate detection is the reason this exists: `+91 98765 43210`, `098765 43210`
 * and `9876543210` are the same customer, and a CRM that treats them as three leads
 * fails at its primary job (docs/product-requirements.md FR-LEAD-2, FR-DUP-1).
 *
 * This is intentionally a small, dependency-free normalizer covering the shapes real
 * lead sources send. It is NOT a full carrier-grade validator; when per-country
 * length/prefix rules matter beyond this, swap in libphonenumber behind the same
 * function signature.
 */

export type CountryCode = 'IN' | 'US' | 'GB' | 'AE' | 'AU' | 'CA' | 'SG';

interface CountryRule {
  readonly dialCode: string;
  /** Valid national-number lengths, excluding the dial code. */
  readonly nationalLengths: readonly number[];
  /** Trunk prefix stripped before prepending the dial code (e.g. India's leading 0). */
  readonly trunkPrefix?: string;
}

const COUNTRIES: Readonly<Record<CountryCode, CountryRule>> = {
  IN: { dialCode: '91', nationalLengths: [10], trunkPrefix: '0' },
  US: { dialCode: '1', nationalLengths: [10], trunkPrefix: '1' },
  CA: { dialCode: '1', nationalLengths: [10], trunkPrefix: '1' },
  GB: { dialCode: '44', nationalLengths: [10, 9], trunkPrefix: '0' },
  AE: { dialCode: '971', nationalLengths: [9], trunkPrefix: '0' },
  AU: { dialCode: '61', nationalLengths: [9], trunkPrefix: '0' },
  SG: { dialCode: '65', nationalLengths: [8] },
};

export interface NormalizedPhone {
  /** E.164, e.g. `+919876543210`. */
  readonly e164: string;
  /** Exactly what the caller sent, preserved for support and debugging. */
  readonly raw: string;
  readonly countryCode: CountryCode | null;
  /** Last 4 digits — used for partial search without exposing the full number. */
  readonly last4: string;
}

export class PhoneNormalizationError extends Error {
  constructor(
    readonly raw: string,
    readonly reason:
      'empty' | 'too_short' | 'too_long' | 'unsupported_length' | 'invalid_characters',
  ) {
    super(`Cannot normalize phone number (${reason}): ${JSON.stringify(raw)}`);
    this.name = 'PhoneNormalizationError';
  }
}

/**
 * @param input  Phone number in any common shape.
 * @param defaultCountry Organization's default country, used when the input carries no
 *                       international prefix (docs/database-design.md §4 `organizations`).
 */
export function normalizePhone(input: string, defaultCountry: CountryCode = 'IN'): NormalizedPhone {
  const raw = input.trim();
  if (raw.length === 0) throw new PhoneNormalizationError(input, 'empty');
  if (/[^\d\s+()\-.]/.test(raw)) throw new PhoneNormalizationError(input, 'invalid_characters');

  const hadPlus = raw.startsWith('+') || raw.startsWith('00');
  let digits = raw.replace(/\D/g, '');
  if (raw.startsWith('00')) digits = digits.slice(2);

  const rule = COUNTRIES[defaultCountry];

  if (!hadPlus) {
    // National format: drop a trunk prefix, then prepend the default dial code.
    if (rule.trunkPrefix && digits.startsWith(rule.trunkPrefix)) {
      const withoutTrunk = digits.slice(rule.trunkPrefix.length);
      if (rule.nationalLengths.includes(withoutTrunk.length)) digits = withoutTrunk;
    }
    // Some sources already include the dial code without a '+'.
    const alreadyInternational =
      digits.startsWith(rule.dialCode) &&
      rule.nationalLengths.includes(digits.length - rule.dialCode.length);
    if (!alreadyInternational) digits = `${rule.dialCode}${digits}`;
  }

  if (digits.length < 8) throw new PhoneNormalizationError(input, 'too_short');
  if (digits.length > 15) throw new PhoneNormalizationError(input, 'too_long'); // E.164 maximum

  const country = detectCountry(digits);
  if (country) {
    const national = digits.slice(COUNTRIES[country].dialCode.length);
    if (!COUNTRIES[country].nationalLengths.includes(national.length)) {
      throw new PhoneNormalizationError(input, 'unsupported_length');
    }
  }

  return { e164: `+${digits}`, raw, countryCode: country, last4: digits.slice(-4) };
}

/** Never throws — for bulk import and ingestion, where one bad row must not fail the batch. */
export function tryNormalizePhone(
  input: string | null | undefined,
  defaultCountry: CountryCode = 'IN',
): NormalizedPhone | null {
  if (input === null || input === undefined) return null;
  try {
    return normalizePhone(input, defaultCountry);
  } catch {
    return null;
  }
}

function detectCountry(digits: string): CountryCode | null {
  const matches = (Object.keys(COUNTRIES) as CountryCode[])
    .filter((code) => digits.startsWith(COUNTRIES[code].dialCode))
    .sort((a, b) => COUNTRIES[b].dialCode.length - COUNTRIES[a].dialCode.length);
  return matches[0] ?? null;
}
