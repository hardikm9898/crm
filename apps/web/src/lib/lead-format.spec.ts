import { describe, expect, it } from 'vitest';
import {
  bandFor,
  bandTone,
  daysSince,
  formatDateTime,
  formatMoney,
  formatPhone,
  initials,
  priorityTone,
  relativeTime,
  statusTone,
  telHref,
  whatsappHref,
  type BandLike,
} from './lead-format';

const BANDS: BandLike[] = [
  { name: 'Cold', minScore: 0, maxScore: 29 },
  { name: 'Warm', minScore: 30, maxScore: 64 },
  { name: 'Hot', minScore: 65, maxScore: 1000 },
];

describe('score bands', () => {
  it('finds the band a score falls in, at the boundaries too', () => {
    expect(bandFor(0, BANDS)?.name).toBe('Cold');
    expect(bandFor(29, BANDS)?.name).toBe('Cold');
    expect(bandFor(30, BANDS)?.name).toBe('Warm');
    expect(bandFor(1000, BANDS)?.name).toBe('Hot');
  });

  it('takes its tone from position in the range, not from the name', () => {
    // A tenant may rename "Hot" to "Priority" or to Gujarati; a switch on the name would show every
    // band as neutral, silently, and only for the tenants who used the feature as intended.
    const renamed: BandLike[] = [
      { name: 'Thanda', minScore: 0, maxScore: 29 },
      { name: 'Garam', minScore: 30, maxScore: 64 },
      { name: 'Ekdum garam', minScore: 65, maxScore: 1000 },
    ];
    expect(bandTone(renamed[2], renamed)).toBe('danger');
    expect(bandTone(renamed[1], renamed)).toBe('warning');
    expect(bandTone(renamed[0], renamed)).toBe('neutral');
  });

  it('is neutral when there is no band or no set', () => {
    expect(bandTone(undefined, BANDS)).toBe('neutral');
    expect(bandTone(BANDS[0], [])).toBe('neutral');
  });

  it('treats a single band as the top of its own range', () => {
    const one: BandLike[] = [{ name: 'All', minScore: 0, maxScore: 1000 }];
    expect(bandTone(one[0], one)).toBe('danger');
  });
});

describe('money comes from minor units, in the row’s own currency', () => {
  it('formats rupees in the Indian grouping', () => {
    // 450,000,000 paise is ₹45,00,000 — forty-five lakh, not four and a half crore.
    expect(formatMoney(450_000_000, 'INR')).toBe('₹45,00,000');
  });

  it('uses the currency the row carries, not a default', () => {
    // A tenant billing in dirhams seeing ₹ is a bug they cannot explain.
    expect(formatMoney(100_000, 'AED')).toMatch(/AED|د\.إ/);
  });

  it('shows a dash for an absent value rather than zero', () => {
    // Zero is a real amount; "no amount recorded" is not zero.
    expect(formatMoney(null, 'INR')).toBe('—');
    expect(formatMoney(0, 'INR')).not.toBe('—');
  });

  it('shows the number rather than breaking on an unknown currency code', () => {
    expect(formatMoney(120_000, 'ZZZ')).toContain('1,200');
  });
});

describe('relative time', () => {
  const now = new Date('2026-03-18T12:00:00Z');

  it('says "just now" inside a minute', () => {
    expect(relativeTime(new Date('2026-03-18T11:59:40Z'), now)).toBe('just now');
  });

  it('counts backwards and forwards', () => {
    expect(relativeTime(new Date('2026-03-15T12:00:00Z'), now)).toBe('3 days ago');
    expect(relativeTime(new Date('2026-03-18T14:00:00Z'), now)).toBe('in 2 hours');
  });

  it('shows a dash for nothing, and for something unparseable', () => {
    expect(relativeTime(null, now)).toBe('—');
    expect(relativeTime('not a date', now)).toBe('—');
  });

  it('formats an absolute time for the places a relative one is too vague', () => {
    expect(formatDateTime('2026-03-18T06:30:00Z')).toContain('2026');
    expect(formatDateTime(null)).toBe('—');
  });

  it('counts whole idle days', () => {
    expect(daysSince(new Date('2026-03-08T12:00:00Z'), now)).toBe(10);
    expect(daysSince(null, now)).toBeNull();
  });
});

describe('small presentational judgements', () => {
  it('takes initials from the first and last name, never more than two letters', () => {
    expect(initials('Anita Sharma')).toBe('AS');
    expect(initials('Rakesh Kumar Patel')).toBe('RP');
    expect(initials('Meena')).toBe('ME');
    expect(initials(null)).toBe('?');
  });

  it('tones a status by the category the tenant assigned, not by its name', () => {
    expect(statusTone('won')).toBe('success');
    expect(statusTone('lost')).toBe('danger');
    expect(statusTone('open')).toBe('neutral');
    // A tenant status called "Won back" in the open category must not read as a win.
    expect(statusTone('open')).not.toBe('success');
  });

  it('tones priority', () => {
    expect(priorityTone('urgent')).toBe('danger');
    expect(priorityTone('high')).toBe('warning');
    expect(priorityTone('low')).toBe('neutral');
  });

  it('groups an Indian number so it can be read aloud, and leaves others alone', () => {
    expect(formatPhone('+919812390001')).toBe('+91 98123 90001');
    expect(formatPhone('+14155550123')).toBe('+14155550123');
    expect(formatPhone(null)).toBe('—');
  });

  it('builds call and WhatsApp links only from a real E.164 number', () => {
    expect(telHref('+919812390001')).toBe('tel:+919812390001');
    expect(whatsappHref('+919812390001')).toBe('https://wa.me/919812390001');
    // A number that was never normalized gets no link rather than a broken one.
    expect(telHref('98123 90001')).toBeNull();
    expect(whatsappHref(null)).toBeNull();
  });
});
