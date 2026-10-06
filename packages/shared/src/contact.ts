import { AppError, type FieldError } from './errors.js';
import { PhoneNormalizationError, normalizePhone, type CountryCode } from './phone.js';

/**
 * A record's phone numbers, normalized the one way the whole product normalizes them.
 *
 * Shared between leads and customers because duplicate detection, search and WhatsApp delivery all
 * assume `phone_e164` is canonical — and a second normalizer, however similar, is a second set of
 * edge cases. The raw form is kept alongside it for support conversations ("the number I was given
 * was 98765 43210"), which is exactly the case where the canonical form is not what somebody needs
 * to read back over the phone.
 *
 * Both numbers are attempted before anything is thrown, so a form with two bad numbers reports two
 * errors rather than one at a time.
 */
export interface NormalizedContact {
  readonly phoneE164: string | null;
  readonly phoneRaw: string | null;
  readonly whatsappE164: string | null;
}

export function normalizeContactNumbers(
  input: { phone?: string | null; whatsapp?: string | null },
  defaultCountry: CountryCode,
): NormalizedContact {
  const errors: FieldError[] = [];

  const toE164 = (value: string | null | undefined, field: string): string | null => {
    if (value === null || value === undefined || value.trim() === '') return null;
    try {
      return normalizePhone(value, defaultCountry).e164;
    } catch (error) {
      const reason = error instanceof PhoneNormalizationError ? error.reason : 'invalid';
      errors.push({
        field,
        code: 'INVALID_PHONE',
        message: `That does not look like a phone number (${reason}).`,
      });
      return null;
    }
  };

  const phoneE164 = toE164(input.phone, 'phone');
  const whatsappE164 = toE164(input.whatsapp, 'whatsapp');
  if (errors.length > 0) throw AppError.validation('Some details need correcting', errors);

  return { phoneE164, phoneRaw: input.phone?.trim() ?? null, whatsappE164 };
}
