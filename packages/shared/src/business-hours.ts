import { dateKeyInZone, zonedInstant, zonedParts } from './time.js';

/**
 * Business-hours arithmetic (`FR-TSK-8`).
 *
 * "First response within 60 working minutes" is the promise an SLA makes, and it is **not** a
 * promise about elapsed time: a lead that arrives at 18:50 on a Friday is not late at 19:50, it is
 * late ten minutes into Monday morning. Every one of these functions therefore walks the
 * workspace's own calendar rather than adding milliseconds.
 *
 * Three things make this harder than it looks, and all three are the reason it lives here as a
 * pure function with its own tests rather than inside a service:
 *
 *  * **A working window is a pair of wall-clock minutes on a local day**, not a duration. That is
 *    what makes "09:00–18:00" survive a clock change: on the morning the clocks go forward the
 *    window is still nine wall-clock hours, and on the morning they go back it is still nine — the
 *    real elapsed time differs, and the business's promise does not.
 *  * **Several windows a day is normal.** A shop that closes for lunch has two, and a single
 *    `start`/`end` pair would quietly count the lunch hour as working time.
 *  * **A calendar can be empty.** A workspace with no working hours configured would make a naive
 *    day-walk loop forever, so every walk is bounded and says so by returning `null`.
 */

/** One working window on one weekday. `0` = Sunday, matching `working_hours.day_of_week`. */
export interface BusinessWindow {
  readonly dayOfWeek: number;
  readonly startMinute: number;
  /** Exclusive. `1440` means "until midnight". */
  readonly endMinute: number;
}

export interface BusinessCalendar {
  readonly timeZone: string;
  readonly windows: readonly BusinessWindow[];
  /** `YYYY-MM-DD` keys nobody works, whatever the weekday says. */
  readonly holidays: ReadonlySet<string>;
  /**
   * `YYYY-MM-DD` keys that *are* worked even though the weekday is closed — a working Saturday
   * before a festival, which `holidays.is_working = true` exists to express.
   */
  readonly workingDates: ReadonlySet<string>;
}

/**
 * How far a walk will look for an open window before giving up.
 *
 * A year, because a calendar that has not opened in a year is a misconfiguration and not a long
 * weekend — and because an unbounded walk over an empty calendar is an infinite loop in a cron job.
 */
const MAX_DAYS_TO_WALK = 366;

/** Whether the calendar is open at this instant. */
export function isWithinBusinessHours(at: Date, calendar: BusinessCalendar): boolean {
  const key = dateKeyInZone(at, calendar.timeZone);
  const { hour, minute } = zonedParts(at, calendar.timeZone);
  const minuteOfDay = hour * 60 + minute;
  return windowsOn(key, calendar).some(
    (window) => minuteOfDay >= window.startMinute && minuteOfDay < window.endMinute,
  );
}

/**
 * The instant `minutes` of **working** time after `from`.
 *
 * `null` when the calendar never opens again inside `MAX_DAYS_TO_WALK` — which the caller has to
 * handle rather than guess at, because a due date invented by a fallback is a promise nobody made.
 * Zero minutes returns the first instant the calendar is open at or after `from`, which is the
 * right answer for a target of zero and for the "when does the clock start" question.
 */
export function addBusinessMinutes(
  from: Date,
  minutes: number,
  calendar: BusinessCalendar,
): Date | null {
  if (minutes < 0) return null;
  let remaining = minutes;

  for (const segment of walk(from, calendar)) {
    const length = (segment.end.getTime() - segment.start.getTime()) / 60_000;
    // `<=` rather than `<`: landing exactly on a window's end means the work finishes as the shop
    // closes, and that instant is the honest answer. Rolling it forward to the next morning would
    // make a target of exactly one day's work come due a day late.
    if (remaining <= length) {
      return new Date(segment.start.getTime() + remaining * 60_000);
    }
    remaining -= length;
  }
  return null;
}

/**
 * Working minutes between two instants. Negative ranges answer 0 rather than a negative number:
 * "how long did this take" has no answer before it started.
 */
export function businessMinutesBetween(from: Date, to: Date, calendar: BusinessCalendar): number {
  if (to.getTime() <= from.getTime()) return 0;
  let total = 0;
  for (const segment of walk(from, calendar)) {
    if (segment.start.getTime() >= to.getTime()) break;
    const clipped = Math.min(segment.end.getTime(), to.getTime());
    total += Math.max(0, (clipped - segment.start.getTime()) / 60_000);
    if (segment.end.getTime() >= to.getTime()) break;
  }
  // Rounded once, at the end. Rounding each segment would make a span crossing three days disagree
  // with the same span measured inside one.
  return Math.round(total);
}

/** The first instant at or after `at` that the calendar is open. `null` if it never is. */
export function nextBusinessStart(at: Date, calendar: BusinessCalendar): Date | null {
  for (const segment of walk(at, calendar)) return segment.start;
  return null;
}

/** A calendar that is always open — what `business_hours_only = false` means. */
export function alwaysOpen(timeZone: string): BusinessCalendar {
  return {
    timeZone,
    windows: Array.from({ length: 7 }, (_, dayOfWeek) => ({
      dayOfWeek,
      startMinute: 0,
      endMinute: 1440,
    })),
    holidays: new Set<string>(),
    workingDates: new Set<string>(),
  };
}

/** A working stretch, as two instants. */
interface Segment {
  readonly start: Date;
  readonly end: Date;
}

/** A window on a local day, as wall-clock minutes. */
interface LocalWindow {
  readonly startMinute: number;
  readonly endMinute: number;
}

/**
 * The working segments from `from` onwards, as **instants**, with the first one clipped to `from`
 * itself.
 *
 * Instants rather than (date, minute) pairs, and clipped to the exact instant rather than to the
 * minute it falls in: truncating to the whole minute made `addBusinessMinutes` land up to 59
 * seconds early, so a sixty-minute promise came due in fifty-nine — a business under-delivering
 * against its own SLA by a minute, which reaches a manager as a breach that arrived too soon.
 *
 * A generator because both consumers stop early and neither knows how far it will need to look.
 * Walking local *dates* — rather than adding 24 hours — is what makes a DST day correct: the day a
 * clock change falls on is 23 or 25 real hours long, and its windows are still the wall-clock
 * minutes the business chose. Each boundary is converted on its own day, so the offset in force
 * that day is the one applied.
 */
function* walk(from: Date, calendar: BusinessCalendar): Generator<Segment> {
  let key = dateKeyInZone(from, calendar.timeZone);
  for (let day = 0; day < MAX_DAYS_TO_WALK; day += 1) {
    for (const window of windowsOn(key, calendar)) {
      const end = zonedInstant(key, window.endMinute, calendar.timeZone);
      if (end.getTime() <= from.getTime()) continue;
      const opened = zonedInstant(key, window.startMinute, calendar.timeZone);
      const start = opened.getTime() < from.getTime() ? from : opened;
      if (start.getTime() >= end.getTime()) continue;
      yield { start, end };
    }
    key = nextDateKey(key);
  }
}

/**
 * The windows that apply on one local date, in order and with overlaps merged.
 *
 * Merging matters: two rows saying 09:00–13:00 and 12:00–18:00 are one window of nine hours, and
 * counting them separately would credit the overlap twice — an SLA that is an hour easier to meet
 * than the business thinks.
 */
function windowsOn(dateKey: string, calendar: BusinessCalendar): LocalWindow[] {
  const isException = calendar.workingDates.has(dateKey);
  if (calendar.holidays.has(dateKey) && !isException) return [];

  const dayOfWeek = weekdayOf(dateKey);
  let windows = calendar.windows.filter((window) => window.dayOfWeek === dayOfWeek);
  if (windows.length === 0 && isException) {
    // A working date on a closed weekday has no hours of its own. Borrowing the busiest configured
    // day is the only answer that is not "closed", and "closed" would make the exception pointless.
    windows = longestConfiguredDay(calendar);
  }
  if (windows.length === 0) return [];

  const sorted = [...windows]
    .map((window) => ({
      startMinute: Math.max(0, Math.min(1440, window.startMinute)),
      endMinute: Math.max(0, Math.min(1440, window.endMinute)),
    }))
    .filter((window) => window.endMinute > window.startMinute)
    .sort((a, b) => a.startMinute - b.startMinute);

  const merged: LocalWindow[] = [];
  for (const window of sorted) {
    const last = merged[merged.length - 1];
    if (last && window.startMinute <= last.endMinute) {
      merged[merged.length - 1] = {
        startMinute: last.startMinute,
        endMinute: Math.max(last.endMinute, window.endMinute),
      };
    } else {
      merged.push({ startMinute: window.startMinute, endMinute: window.endMinute });
    }
  }
  return merged;
}

function longestConfiguredDay(calendar: BusinessCalendar): BusinessWindow[] {
  const byDay = new Map<number, BusinessWindow[]>();
  for (const window of calendar.windows) {
    byDay.set(window.dayOfWeek, [...(byDay.get(window.dayOfWeek) ?? []), window]);
  }
  let best: BusinessWindow[] = [];
  let bestLength = 0;
  for (const windows of byDay.values()) {
    const length = windows.reduce(
      (sum, window) => sum + Math.max(0, window.endMinute - window.startMinute),
      0,
    );
    if (length > bestLength) {
      bestLength = length;
      best = windows;
    }
  }
  return best;
}

/** The weekday of a `YYYY-MM-DD` key, read as a calendar date rather than as an instant. */
function weekdayOf(dateKey: string): number {
  const [year, month, day] = dateKey.split('-').map(Number);
  /* c8 ignore next */
  if (!year || !month || !day) return 0;
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

function nextDateKey(dateKey: string): string {
  const [year, month, day] = dateKey.split('-').map(Number);
  /* c8 ignore next */
  if (!year || !month || !day) return dateKey;
  const next = new Date(Date.UTC(year, month - 1, day + 1));
  return `${next.getUTCFullYear()}-${pad(next.getUTCMonth() + 1)}-${pad(next.getUTCDate())}`;
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}
