import { describe, expect, it } from 'vitest';
import {
  addBusinessMinutes,
  alwaysOpen,
  businessMinutesBetween,
  isWithinBusinessHours,
  nextBusinessStart,
  type BusinessCalendar,
} from './business-hours.js';

/** Mon–Fri, 09:00–18:00, in Kolkata. The default a workspace is provisioned with. */
function weekdays(overrides: Partial<BusinessCalendar> = {}): BusinessCalendar {
  return {
    timeZone: 'Asia/Kolkata',
    windows: [1, 2, 3, 4, 5].map((dayOfWeek) => ({
      dayOfWeek,
      startMinute: 9 * 60,
      endMinute: 18 * 60,
    })),
    holidays: new Set<string>(),
    workingDates: new Set<string>(),
    ...overrides,
  };
}

/** 09:00–13:00 and 14:00–18:00 — a business that closes for lunch. */
function withLunch(): BusinessCalendar {
  return {
    ...weekdays(),
    windows: [1, 2, 3, 4, 5].flatMap((dayOfWeek) => [
      { dayOfWeek, startMinute: 9 * 60, endMinute: 13 * 60 },
      { dayOfWeek, startMinute: 14 * 60, endMinute: 18 * 60 },
    ]),
  };
}

/** A Kolkata wall-clock instant, as UTC. Kolkata is UTC+5:30 all year. */
function ist(date: string, time: string): Date {
  return new Date(`${date}T${time}:00+05:30`);
}

describe('isWithinBusinessHours', () => {
  it('is open inside the window and closed outside it', () => {
    // 2026-04-02 is a Thursday.
    expect(isWithinBusinessHours(ist('2026-04-02', '10:00'), weekdays())).toBe(true);
    expect(isWithinBusinessHours(ist('2026-04-02', '08:59'), weekdays())).toBe(false);
    // The end is exclusive: at 18:00 the shop is shut.
    expect(isWithinBusinessHours(ist('2026-04-02', '18:00'), weekdays())).toBe(false);
  });

  it('is closed at the weekend and on a holiday', () => {
    // 2026-04-04 is a Saturday.
    expect(isWithinBusinessHours(ist('2026-04-04', '10:00'), weekdays())).toBe(false);
    const calendar = weekdays({ holidays: new Set(['2026-04-02']) });
    expect(isWithinBusinessHours(ist('2026-04-02', '10:00'), calendar)).toBe(false);
  });

  it('is closed over lunch when the business closes for lunch', () => {
    expect(isWithinBusinessHours(ist('2026-04-02', '13:30'), withLunch())).toBe(false);
    expect(isWithinBusinessHours(ist('2026-04-02', '14:30'), withLunch())).toBe(true);
  });

  it('opens on a working Saturday even though Saturday is closed', () => {
    const calendar = weekdays({ workingDates: new Set(['2026-04-04']) });
    expect(isWithinBusinessHours(ist('2026-04-04', '10:00'), calendar)).toBe(true);
    // And still closes at the hour the busiest configured day closes.
    expect(isWithinBusinessHours(ist('2026-04-04', '18:30'), calendar)).toBe(false);
  });
});

describe('addBusinessMinutes', () => {
  it('adds inside one day', () => {
    expect(addBusinessMinutes(ist('2026-04-02', '10:00'), 60, weekdays())).toEqual(
      ist('2026-04-02', '11:00'),
    );
  });

  it('carries into the next working day rather than into the night', () => {
    // The promise an SLA makes is about working minutes. A lead at 17:30 with a 60-minute target
    // is not late at 18:30 — it is late half an hour into the next morning.
    expect(addBusinessMinutes(ist('2026-04-02', '17:30'), 60, weekdays())).toEqual(
      ist('2026-04-03', '09:30'),
    );
  });

  it('skips the weekend', () => {
    // Friday 17:30 + 60 working minutes lands on Monday morning, not Saturday's.
    expect(addBusinessMinutes(ist('2026-04-03', '17:30'), 60, weekdays())).toEqual(
      ist('2026-04-06', '09:30'),
    );
  });

  it('skips a holiday, and does not skip a working Saturday', () => {
    const withHoliday = weekdays({ holidays: new Set(['2026-04-03']) });
    expect(addBusinessMinutes(ist('2026-04-02', '17:30'), 60, withHoliday)).toEqual(
      ist('2026-04-06', '09:30'),
    );
    const withSaturday = weekdays({ workingDates: new Set(['2026-04-04']) });
    expect(addBusinessMinutes(ist('2026-04-03', '17:30'), 60, withSaturday)).toEqual(
      ist('2026-04-04', '09:30'),
    );
  });

  it('does not count the lunch hour as working time', () => {
    // 12:30 + 60 working minutes is 14:30, not 13:30: half an hour before lunch and half an hour
    // after it. Two rows for one day is the whole reason a window is not a start/end pair.
    expect(addBusinessMinutes(ist('2026-04-02', '12:30'), 60, withLunch())).toEqual(
      ist('2026-04-02', '14:30'),
    );
  });

  it('starts the clock at the next opening when the lead arrives out of hours', () => {
    // 21:00 on a Thursday with a 30-minute target: the clock starts at 09:00 on Friday.
    expect(addBusinessMinutes(ist('2026-04-02', '21:00'), 30, weekdays())).toEqual(
      ist('2026-04-03', '09:30'),
    );
    // And a target of zero is the opening instant itself, which is what "when does the clock
    // start" asks.
    expect(addBusinessMinutes(ist('2026-04-02', '21:00'), 0, weekdays())).toEqual(
      ist('2026-04-03', '09:00'),
    );
  });

  it('lands on closing time when the target is exactly a day’s work', () => {
    // 09:00 + 540 working minutes is 18:00 the same day. Rolling it to the next morning would make
    // a one-day target come due a day late.
    expect(addBusinessMinutes(ist('2026-04-02', '09:00'), 540, weekdays())).toEqual(
      ist('2026-04-02', '18:00'),
    );
    expect(addBusinessMinutes(ist('2026-04-02', '09:00'), 541, weekdays())).toEqual(
      ist('2026-04-03', '09:01'),
    );
  });

  it('spans several days for a long target', () => {
    // Three working days of 540 minutes each, from Thursday 09:00: Thu, Fri, Mon.
    expect(addBusinessMinutes(ist('2026-04-02', '09:00'), 540 * 3, weekdays())).toEqual(
      ist('2026-04-06', '18:00'),
    );
  });

  it('answers null rather than guessing when the calendar never opens', () => {
    const closed: BusinessCalendar = {
      timeZone: 'Asia/Kolkata',
      windows: [],
      holidays: new Set(),
      workingDates: new Set(),
    };
    // An unbounded day-walk here would be an infinite loop inside a cron job, and a due date
    // invented by a fallback is a promise nobody made.
    expect(addBusinessMinutes(ist('2026-04-02', '10:00'), 60, closed)).toBeNull();
    expect(nextBusinessStart(ist('2026-04-02', '10:00'), closed)).toBeNull();
  });

  it('refuses a negative target', () => {
    expect(addBusinessMinutes(ist('2026-04-02', '10:00'), -1, weekdays())).toBeNull();
  });

  it('is always open when the policy says business hours do not apply', () => {
    const open = alwaysOpen('Asia/Kolkata');
    expect(addBusinessMinutes(ist('2026-04-04', '23:30'), 60, open)).toEqual(
      ist('2026-04-05', '00:30'),
    );
    expect(isWithinBusinessHours(ist('2026-04-04', '03:00'), open)).toBe(true);
  });
});

describe('a clock change', () => {
  /** Mon–Fri 09:00–18:00 in Berlin, which moves its clocks twice a year. */
  const berlin: BusinessCalendar = {
    timeZone: 'Europe/Berlin',
    windows: [1, 2, 3, 4, 5].map((dayOfWeek) => ({
      dayOfWeek,
      startMinute: 9 * 60,
      endMinute: 18 * 60,
    })),
    holidays: new Set(),
    workingDates: new Set(),
  };

  it('keeps a window nine wall-clock hours long on the day the clocks go forward', () => {
    // 2026-03-29 is the spring-forward Sunday; Monday the 30th is the first working day on CEST.
    // 09:00 + 540 working minutes is 18:00 local, whatever the offset was the day before.
    const due = addBusinessMinutes(
      new Date('2026-03-30T07:00:00.000Z'), // 09:00 CEST
      540,
      berlin,
    );
    expect(due?.toISOString()).toBe('2026-03-30T16:00:00.000Z'); // 18:00 CEST
  });

  it('carries across the change itself without losing or inventing an hour', () => {
    // Friday the 27th at 17:30 CET + 60 working minutes = Monday the 30th at 09:30 CEST. The
    // offset moved between the two, which is exactly the case a milliseconds-based calculation
    // gets wrong by an hour.
    const due = addBusinessMinutes(new Date('2026-03-27T16:30:00.000Z'), 60, berlin);
    expect(due?.toISOString()).toBe('2026-03-30T07:30:00.000Z'); // 09:30 CEST
  });

  it('does the same in the autumn, when the clocks go back', () => {
    // 2026-10-25 is the autumn Sunday. Friday the 23rd 17:30 CEST + 60 → Monday 09:30 CET.
    const due = addBusinessMinutes(new Date('2026-10-23T15:30:00.000Z'), 60, berlin);
    expect(due?.toISOString()).toBe('2026-10-26T08:30:00.000Z'); // 09:30 CET
  });

  it('measures the real minutes a customer waited, not the wall-clock ones', () => {
    // A window that contains a clock change is 23 or 25 hours of wall clock in 24 of real time;
    // "how long did they wait" is a question about the world's clock, so an always-open calendar
    // across the spring change counts 60 real minutes for a 01:30 → 03:30 local span.
    const open = alwaysOpen('Europe/Berlin');
    const waited = businessMinutesBetween(
      new Date('2026-03-29T00:30:00.000Z'), // 01:30 CET
      new Date('2026-03-29T01:30:00.000Z'), // 03:30 CEST
      open,
    );
    expect(waited).toBe(60);
  });
});

describe('businessMinutesBetween', () => {
  it('counts only the working part of a span', () => {
    // Thursday 17:00 to Friday 10:00 is 17 elapsed hours and 120 working minutes.
    expect(
      businessMinutesBetween(ist('2026-04-02', '17:00'), ist('2026-04-03', '10:00'), weekdays()),
    ).toBe(120);
  });

  it('counts nothing across a closed weekend', () => {
    expect(
      businessMinutesBetween(ist('2026-04-04', '09:00'), ist('2026-04-05', '18:00'), weekdays()),
    ).toBe(0);
  });

  it('answers 0 for a span that ends before it starts', () => {
    expect(
      businessMinutesBetween(ist('2026-04-03', '10:00'), ist('2026-04-02', '10:00'), weekdays()),
    ).toBe(0);
  });

  it('carries the seconds, so a sixty-minute promise is not due in fifty-nine', () => {
    // The walk used to truncate the start to the whole minute, which made every due instant up to
    // 59 seconds early — a business under-delivering against its own SLA, reaching a manager as a
    // breach that arrived too soon. Found by an end-to-end assertion, not by reading the code.
    const from = new Date('2026-04-02T05:30:45.000Z'); // 11:00:45 IST, mid-window
    const due = addBusinessMinutes(from, 60, weekdays());
    expect(due?.toISOString()).toBe('2026-04-02T06:30:45.000Z');
    expect((due!.getTime() - from.getTime()) / 60_000).toBe(60);
  });

  it('is the inverse of addBusinessMinutes, which is what makes a breach report trustworthy', () => {
    // From a mid-minute instant too, now that the walk no longer truncates one.
    const from = new Date(ist('2026-04-02', '16:00').getTime() + 37_000);
    for (const target of [15, 60, 120, 540, 700, 1600]) {
      const due = addBusinessMinutes(from, target, weekdays());
      expect(due, `target ${target}`).not.toBeNull();
      expect(businessMinutesBetween(from, due!, weekdays()), `target ${target}`).toBe(target);
    }
  });
});

describe('overlapping configuration', () => {
  it('merges two rows that overlap instead of counting the overlap twice', () => {
    // 09:00–13:00 and 12:00–18:00 is nine hours, not ten. Counting it twice would make the SLA an
    // hour easier to meet than the business thinks it is.
    const calendar = weekdays({
      windows: [
        { dayOfWeek: 4, startMinute: 9 * 60, endMinute: 13 * 60 },
        { dayOfWeek: 4, startMinute: 12 * 60, endMinute: 18 * 60 },
      ],
    });
    expect(
      businessMinutesBetween(ist('2026-04-02', '09:00'), ist('2026-04-02', '18:00'), calendar),
    ).toBe(540);
  });

  it('ignores a row whose end is not after its start', () => {
    const calendar = weekdays({
      windows: [
        { dayOfWeek: 4, startMinute: 9 * 60, endMinute: 9 * 60 },
        { dayOfWeek: 4, startMinute: 14 * 60, endMinute: 18 * 60 },
      ],
    });
    expect(addBusinessMinutes(ist('2026-04-02', '09:00'), 30, calendar)).toEqual(
      ist('2026-04-02', '14:30'),
    );
  });
});
