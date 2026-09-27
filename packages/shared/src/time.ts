/**
 * Time helpers. Everything is stored as UTC `timestamptz`; an organization's
 * timezone only decides what "today" and "working hours" mean for humans
 * (docs/database-design.md §1).
 */

export function startOfDayInZone(date: Date, timeZone: string): Date {
  const parts = zonedParts(date, timeZone);
  return zonedTimeToUtc({ ...parts, hour: 0, minute: 0, second: 0 }, timeZone);
}

export function endOfDayInZone(date: Date, timeZone: string): Date {
  const start = startOfDayInZone(date, timeZone);
  return new Date(start.getTime() + 24 * 60 * 60 * 1000 - 1);
}

/** `YYYY-MM-DD` as seen in the given timezone — the grouping key for daily rollups. */
export function dateKeyInZone(date: Date, timeZone: string): string {
  const { year, month, day } = zonedParts(date, timeZone);
  return `${year}-${pad(month)}-${pad(day)}`;
}

export function minutesBetween(from: Date, to: Date): number {
  return Math.round((to.getTime() - from.getTime()) / 60_000);
}

export function addMinutes(date: Date, minutes: number): Date {
  return new Date(date.getTime() + minutes * 60_000);
}

export function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

export function zonedParts(date: Date, timeZone: string): ZonedParts {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const found: Partial<Record<string, number>> = {};
  for (const { type, value } of formatter.formatToParts(date)) {
    if (type !== 'literal') found[type] = Number(value);
  }
  return {
    year: found.year ?? 1970,
    month: found.month ?? 1,
    day: found.day ?? 1,
    hour: (found.hour ?? 0) % 24,
    minute: found.minute ?? 0,
    second: found.second ?? 0,
  };
}

/** Interprets wall-clock parts in `timeZone` and returns the corresponding UTC instant. */
function zonedTimeToUtc(parts: ZonedParts, timeZone: string): Date {
  const guess = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  // Correct for the zone's offset, then once more for DST transitions at the boundary.
  const firstPass = guess - offsetAt(new Date(guess), timeZone);
  return new Date(guess - offsetAt(new Date(firstPass), timeZone));
}

function offsetAt(date: Date, timeZone: string): number {
  const p = zonedParts(date, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}
