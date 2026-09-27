import { describe, expect, it } from 'vitest';
import {
  addMinutes,
  dateKeyInZone,
  isValidTimeZone,
  minutesBetween,
  startOfDayInZone,
} from './time.js';

describe('timezone handling', () => {
  it('computes "today" in the organization timezone, not the server timezone', () => {
    // 2026-09-27T19:30Z is already 2026-09-28 in Kolkata (+05:30).
    const instant = new Date('2026-09-27T19:30:00Z');
    expect(dateKeyInZone(instant, 'Asia/Kolkata')).toBe('2026-09-28');
    expect(dateKeyInZone(instant, 'UTC')).toBe('2026-09-27');
    expect(dateKeyInZone(instant, 'America/Los_Angeles')).toBe('2026-09-27');
  });

  it('resolves start of day to the correct UTC instant', () => {
    const start = startOfDayInZone(new Date('2026-09-27T19:30:00Z'), 'Asia/Kolkata');
    expect(start.toISOString()).toBe('2026-09-27T18:30:00.000Z'); // midnight IST on the 28th
  });

  it('handles a DST boundary without drifting a day', () => {
    // US DST ends 2026-11-01; a late-October instant must still map to the right local date.
    const instant = new Date('2026-10-31T23:30:00Z');
    expect(dateKeyInZone(instant, 'America/New_York')).toBe('2026-10-31');
    const afterChange = new Date('2026-11-02T04:30:00Z');
    expect(dateKeyInZone(afterChange, 'America/New_York')).toBe('2026-11-01');
  });

  it('measures elapsed minutes for SLA clocks', () => {
    const from = new Date('2026-09-27T10:00:00Z');
    expect(minutesBetween(from, addMinutes(from, 43))).toBe(43);
  });

  it('validates timezone identifiers', () => {
    expect(isValidTimeZone('Asia/Kolkata')).toBe(true);
    expect(isValidTimeZone('Mars/Olympus')).toBe(false);
  });
});
