import { describe, expect, it } from 'vitest';
import {
  DELIVERABLE_CHANNELS,
  NOTIFICATION_CHANNELS,
  NOTIFICATION_TYPES,
  STALENESS_CHECKS,
  channelsFor,
  crossesMidnight,
  formatMinuteOfDay,
  isMinuteOfDay,
  isQuiet,
  notificationType,
  parseMinuteOfDay,
  quietHoursHold,
} from './notifications.js';

const KOLKATA = 'Asia/Kolkata';
/** A zone that actually observes DST, which Asia/Kolkata does not. */
const BERLIN = 'Europe/Berlin';

/** 21:00 → 07:00, which is what a quiet window almost always looks like. */
const overnight = (timeZone = KOLKATA) => ({
  startMinute: 21 * 60,
  endMinute: 7 * 60,
  timeZone,
});
/** 13:00 → 14:00: a window inside one day, which is the other shape. */
const lunch = (timeZone = KOLKATA) => ({ startMinute: 13 * 60, endMinute: 14 * 60, timeZone });

describe('the type registry', () => {
  it('describes every type well enough for a preference screen', () => {
    for (const spec of NOTIFICATION_TYPES) {
      expect(spec.label, spec.type).toBeTruthy();
      // The sentence matters more than it looks: "Overdue follow-ups" says what but not why, and a
      // preferences screen somebody cannot read is one they switch everything off on.
      expect(spec.hint, spec.type).toBeTruthy();
      expect(spec.defaultChannels.length, spec.type).toBeGreaterThan(0);
      for (const channel of spec.defaultChannels) {
        expect(
          DELIVERABLE_CHANNELS,
          `${spec.type} defaults to a channel nothing can send`,
        ).toContain(channel);
      }
      expect(STALENESS_CHECKS, spec.type).toContain(spec.staleness);
    }
  });

  it('has no duplicate types', () => {
    const types = NOTIFICATION_TYPES.map((spec) => spec.type);
    expect(new Set(types).size).toBe(types.length);
  });

  it('exempts exactly the billing notice from being switched off (FR-NOT-3)', () => {
    const required = NOTIFICATION_TYPES.filter((spec) => !spec.optOut).map((spec) => spec.type);
    expect(required).toEqual(['trial.expired']);
  });

  it('declares every channel the design names, and says which can be sent today', () => {
    expect([...NOTIFICATION_CHANNELS]).toEqual(['in_app', 'email', 'whatsapp', 'push']);
    expect([...DELIVERABLE_CHANNELS]).toEqual(['in_app']);
  });

  it('looks a type up, and does not invent one', () => {
    expect(notificationType('task.overdue')?.label).toBe('Overdue follow-ups');
    expect(notificationType('task.something_new')).toBeUndefined();
  });
});

describe('channelsFor', () => {
  it('uses the default when nobody has chosen', () => {
    expect(channelsFor('task.overdue', undefined)).toEqual(['in_app']);
  });

  it('honours an explicit empty choice — "do not tell me"', () => {
    expect(channelsFor('task.overdue', [])).toEqual([]);
  });

  it('ignores a choice on a notice that is not opt-out', () => {
    expect(channelsFor('trial.expired', [])).toEqual(['in_app']);
  });

  it('drops a channel nothing can deliver on, rather than pretending', () => {
    expect(channelsFor('task.overdue', ['email', 'in_app'])).toEqual(['in_app']);
    expect(channelsFor('task.overdue', ['email'])).toEqual([]);
  });

  it('delivers an unregistered type in-app rather than silently dropping it', () => {
    // A producer added without a registry entry should be visible and annoying, not silent.
    expect(channelsFor('something.new', undefined)).toEqual(['in_app']);
  });
});

describe('isQuiet', () => {
  it('reads a window inside one day', () => {
    expect(isQuiet(new Date('2026-03-10T07:30:00.000Z'), lunch())).toBe(true); // 13:00 IST
    expect(isQuiet(new Date('2026-03-10T08:29:00.000Z'), lunch())).toBe(true); // 13:59
    expect(isQuiet(new Date('2026-03-10T08:30:00.000Z'), lunch())).toBe(false); // 14:00 — closed
    expect(isQuiet(new Date('2026-03-10T07:29:00.000Z'), lunch())).toBe(false); // 12:59
  });

  it('reads a window that crosses midnight, in both halves of it', () => {
    expect(isQuiet(new Date('2026-03-10T16:00:00.000Z'), overnight())).toBe(true); // 21:30 IST
    expect(isQuiet(new Date('2026-03-10T20:00:00.000Z'), overnight())).toBe(true); // 01:30 next day
    expect(isQuiet(new Date('2026-03-11T01:29:00.000Z'), overnight())).toBe(true); // 06:59
    expect(isQuiet(new Date('2026-03-11T01:30:00.000Z'), overnight())).toBe(false); // 07:00
    expect(isQuiet(new Date('2026-03-10T10:00:00.000Z'), overnight())).toBe(false); // 15:30
  });

  it('treats a zero-length window as never quiet, not always quiet', () => {
    const zero = { startMinute: 540, endMinute: 540, timeZone: KOLKATA };
    expect(isQuiet(new Date('2026-03-10T03:30:00.000Z'), zero)).toBe(false);
  });

  it('knows which windows cross midnight', () => {
    expect(crossesMidnight(overnight())).toBe(true);
    expect(crossesMidnight(lunch())).toBe(false);
  });
});

describe('quietHoursHold', () => {
  it('lets a notification through outside the window', () => {
    expect(quietHoursHold(new Date('2026-03-10T10:00:00.000Z'), overnight())).toBeNull();
  });

  it('holds an evening arrival until the morning', () => {
    // 22:00 IST on the 10th → released at 07:00 IST on the 11th, which is 01:30 UTC.
    const hold = quietHoursHold(new Date('2026-03-10T16:30:00.000Z'), overnight());
    expect(hold?.toISOString()).toBe('2026-03-11T01:30:00.000Z');
  });

  it('holds an arrival after midnight until the same morning, not the next one', () => {
    // 02:00 IST on the 11th is in the *second* half of the window that opened at 21:00 on the
    // 10th, and 07:00 that same morning is five hours away — not twenty-nine. The two halves of a
    // midnight-crossing window resolve to the same release instant, which is the property worth
    // asserting: `at` moved forward four and a half hours and the release did not move at all.
    const evening = quietHoursHold(new Date('2026-03-10T16:30:00.000Z'), overnight());
    const afterMidnight = quietHoursHold(new Date('2026-03-10T21:00:00.000Z'), overnight());
    expect(afterMidnight?.toISOString()).toBe('2026-03-11T01:30:00.000Z');
    expect(afterMidnight?.getTime()).toBe(evening?.getTime());
  });

  it('holds until the end of a same-day window', () => {
    const hold = quietHoursHold(new Date('2026-03-10T07:45:00.000Z'), lunch());
    expect(hold?.toISOString()).toBe('2026-03-10T08:30:00.000Z'); // 14:00 IST
  });

  it('releases at the wall-clock hour across a spring-forward night', () => {
    // Berlin loses an hour at 02:00 on 2026-03-29. A notification arriving at 23:30 local on the
    // 28th must be released at 07:00 *local* on the 29th — which is five and a half hours later,
    // not six and a half. Adding a duration would deliver it at 06:00.
    const at = new Date('2026-03-28T22:30:00.000Z'); // 23:30 CET
    const hold = quietHoursHold(at, overnight(BERLIN));
    expect(hold?.toISOString()).toBe('2026-03-29T05:00:00.000Z'); // 07:00 CEST
    expect((hold!.getTime() - at.getTime()) / 3_600_000).toBe(6.5);
  });

  it('releases at the wall-clock hour across a fall-back night', () => {
    // Berlin gains an hour at 03:00 on 2026-10-25: 07:00 local is eight and a half hours after
    // 23:30 local, not seven and a half.
    const at = new Date('2026-10-24T21:30:00.000Z'); // 23:30 CEST
    const hold = quietHoursHold(at, overnight(BERLIN));
    expect(hold?.toISOString()).toBe('2026-10-25T06:00:00.000Z'); // 07:00 CET
    expect((hold!.getTime() - at.getTime()) / 3_600_000).toBe(8.5);
  });

  it('never returns an instant in the past', () => {
    const at = new Date('2026-03-10T16:30:00.000Z');
    const hold = quietHoursHold(at, overnight());
    expect(hold!.getTime()).toBeGreaterThan(at.getTime());
  });
});

describe('minute-of-day values', () => {
  it('accepts a minute inside the day and refuses anything else', () => {
    expect(isMinuteOfDay(0)).toBe(true);
    expect(isMinuteOfDay(1439)).toBe(true);
    expect(isMinuteOfDay(1440)).toBe(false);
    expect(isMinuteOfDay(-1)).toBe(false);
    expect(isMinuteOfDay(90.5)).toBe(false);
  });

  it('round-trips through the form’s own format', () => {
    expect(formatMinuteOfDay(21 * 60 + 30)).toBe('21:30');
    expect(formatMinuteOfDay(0)).toBe('00:00');
    expect(parseMinuteOfDay('21:30')).toBe(21 * 60 + 30);
    expect(parseMinuteOfDay('07:00')).toBe(420);
    for (const minute of [0, 1, 599, 1439]) {
      expect(parseMinuteOfDay(formatMinuteOfDay(minute))).toBe(minute);
    }
  });

  it('refuses what `Number()` would have accepted', () => {
    // The same lesson the reminder offsets paid for: a coercion on untrusted input must refuse
    // what `Number` takes, not reuse it.
    expect(parseMinuteOfDay('')).toBeNull();
    expect(parseMinuteOfDay('9:00')).toBeNull();
    expect(parseMinuteOfDay('24:00')).toBeNull();
    expect(parseMinuteOfDay('21:60')).toBeNull();
    expect(parseMinuteOfDay('21-30')).toBeNull();
  });
});
