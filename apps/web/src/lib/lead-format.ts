/**
 * Presentation helpers for leads — pure, so they are testable without a browser.
 *
 * These exist as functions rather than inline JSX because each one encodes a judgement that would
 * otherwise be made differently on three screens: what a score band looks like, how money reads,
 * how long ago something happened.
 */

/** Tone for a score band. Resolved by *position in the range*, never by name (rule 4). */
export type Tone = 'neutral' | 'success' | 'warning' | 'danger';

export interface BandLike {
  readonly name: string;
  readonly minScore: number;
  readonly maxScore: number;
  readonly colour?: string | null;
}

/**
 * A band's tone from where it sits in the range, not from its name.
 *
 * A tenant may rename "Hot" to "Priority" or to Gujarati, and a switch on the name would then show
 * every band as neutral — silently, and only for the tenants who used the feature as intended.
 */
export function bandTone(band: BandLike | undefined, bands: readonly BandLike[]): Tone {
  if (!band || bands.length === 0) return 'neutral';
  const sorted = [...bands].sort((left, right) => left.minScore - right.minScore);
  const position = sorted.findIndex((entry) => entry.name === band.name);
  if (position < 0) return 'neutral';
  const share = sorted.length === 1 ? 1 : position / (sorted.length - 1);
  if (share >= 0.99) return 'danger'; // hottest: the one to call now
  if (share >= 0.5) return 'warning';
  return 'neutral';
}

export function bandFor(score: number, bands: readonly BandLike[]): BandLike | undefined {
  return bands.find((band) => score >= band.minScore && score <= band.maxScore);
}

/**
 * Money, from minor units.
 *
 * Money crosses the wire in minor units everywhere in this product, so the conversion happens once,
 * here. `Intl` is given the currency the row carries rather than a default: a tenant billing in AED
 * seeing ₹ would be a bug they could not explain.
 */
export function formatMoney(
  minor: number | null | undefined,
  currency: string | null | undefined,
  locale = 'en-IN',
): string {
  if (minor === null || minor === undefined) return '—';
  const code = currency ?? 'INR';
  try {
    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency: code,
      maximumFractionDigits: 0,
    }).format(minor / 100);
  } catch {
    // An unknown currency code should show the number, not break the row.
    return `${code} ${Math.round(minor / 100).toLocaleString(locale)}`;
  }
}

/**
 * "3 days ago", "in 2 hours", "just now".
 *
 * `now` is a parameter so a test does not depend on the wall clock, and so a server render and the
 * client agree on the same instant.
 */
export function relativeTime(
  value: string | Date | null | undefined,
  now: Date = new Date(),
): string {
  if (!value) return '—';
  const at = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(at.getTime())) return '—';

  const seconds = Math.round((at.getTime() - now.getTime()) / 1000);
  const absolute = Math.abs(seconds);
  if (absolute < 45) return 'just now';

  const units: readonly [Intl.RelativeTimeFormatUnit, number][] = [
    ['year', 31_536_000],
    ['month', 2_592_000],
    ['week', 604_800],
    ['day', 86_400],
    ['hour', 3_600],
    ['minute', 60],
  ];
  for (const [unit, size] of units) {
    if (absolute >= size) {
      const formatter = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
      return formatter.format(Math.round(seconds / size), unit);
    }
  }
  return 'just now';
}

/** Just the date, for a column where the time of day adds nothing. */
export function formatDate(value: string | Date | null | undefined): string {
  if (!value) return '—';
  const at = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(at.getTime())) return '—';
  return at.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
}

/** A date and time in the viewer's locale, for the places a relative time is too vague. */
export function formatDateTime(value: string | Date | null | undefined): string {
  if (!value) return '—';
  const at = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(at.getTime())) return '—';
  return at.toLocaleString('en-IN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/** Initials for an avatar, from a full name. Never more than two letters. */
export function initials(name: string | null | undefined): string {
  const parts = (name ?? '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return `${parts[0]![0]}${parts[parts.length - 1]![0]}`.toUpperCase();
}

/** Tone for a status, from the category the tenant assigned it — never from its name. */
export function statusTone(category: string | null | undefined): Tone {
  switch (category) {
    case 'won':
      return 'success';
    case 'lost':
      return 'danger';
    case 'invalid':
      return 'neutral';
    default:
      return 'neutral';
  }
}

export function priorityTone(priority: string | null | undefined): Tone {
  switch (priority) {
    case 'urgent':
      return 'danger';
    case 'high':
      return 'warning';
    default:
      return 'neutral';
  }
}

/**
 * A phone number for display, grouped so it can be read aloud.
 *
 * Only the +91 shape is grouped specially, because that is the market this product is built for and
 * a wrong guess elsewhere is worse than no grouping at all.
 */
export function formatPhone(e164: string | null | undefined): string {
  if (!e164) return '—';
  const indian = /^\+91(\d{5})(\d{5})$/.exec(e164);
  if (indian) return `+91 ${indian[1]} ${indian[2]}`;
  return e164;
}

/** `tel:` and `wa.me` targets. A number that is not E.164 gets no link rather than a broken one. */
export function telHref(e164: string | null | undefined): string | null {
  return e164 && e164.startsWith('+') ? `tel:${e164}` : null;
}

export function whatsappHref(e164: string | null | undefined): string | null {
  if (!e164 || !e164.startsWith('+')) return null;
  return `https://wa.me/${e164.slice(1)}`;
}

/** How stale a lead is, in whole days, for the ageing column. */
export function daysSince(
  value: string | Date | null | undefined,
  now: Date = new Date(),
): number | null {
  if (!value) return null;
  const at = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(at.getTime())) return null;
  return Math.floor((now.getTime() - at.getTime()) / 86_400_000);
}
