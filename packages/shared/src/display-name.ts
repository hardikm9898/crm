/**
 * The name a record is shown and searched by.
 *
 * One definition for every entity that has one, because the alternative is two: leads and customers
 * both derive a display name from whatever identity the caller actually gave, and a workspace where
 * a lead reads "Kavita Rao" and the customer it became reads "+919845012345" has lost somebody.
 *
 * The order is deliberate. A person's name first; then the company, because a B2B enquiry often
 * arrives as "Rao Interiors" with no contact named; then the email, which is at least human; then
 * the phone number, which is a last resort but is still something a person can recognise and search
 * for. An empty string means the caller supplied no identity at all, which every caller treats as a
 * validation failure rather than as a name.
 */
export interface DisplayNameParts {
  readonly firstName?: string | null;
  readonly lastName?: string | null;
  readonly company?: string | null;
  readonly email?: string | null;
  readonly phoneE164?: string | null;
  readonly whatsappE164?: string | null;
}

export function buildDisplayName(parts: DisplayNameParts): string {
  const name = [parts.firstName, parts.lastName]
    .map((part) => part?.trim())
    .filter((part): part is string => Boolean(part))
    .join(' ');
  if (name) return name;
  if (parts.company?.trim()) return parts.company.trim();
  if (parts.email?.trim()) return parts.email.trim();
  if (parts.phoneE164?.trim()) return parts.phoneE164.trim();
  if (parts.whatsappE164?.trim()) return parts.whatsappE164.trim();
  return '';
}
