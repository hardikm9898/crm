import { describe, expect, it } from 'vitest';
import { NOTIFICATION_TYPES } from '@leados/shared';
import {
  GROUP_HINTS,
  GROUP_LABELS,
  NOTIFICATION_GROUPS,
  byGroup,
  describeQuietHours,
  formatMinuteOfDay,
  heldUntil,
  isOn,
  type NotificationTypePreference,
} from './notifications';

/**
 * The notification centre's own vocabulary, reconciled with the API's.
 *
 * `lib/notifications.ts` hand-writes the shapes because the web app may not import
 * `@leados/shared` at runtime; this spec runs in Node and may import both, which is what keeps the
 * copy honest. The reconciliation that matters here is the **groups**: a group the API can put a
 * type in and this screen has no heading for is a switch that renders nowhere.
 */

function entry(overrides: Partial<NotificationTypePreference> = {}): NotificationTypePreference {
  return {
    type: 'task.overdue',
    label: 'Overdue follow-ups',
    hint: 'When a follow-up passes its time.',
    group: 'work',
    optOut: true,
    defaultChannels: ['in_app'],
    channels: null,
    effectiveChannels: ['in_app'],
    ...overrides,
  };
}

describe('the group vocabulary', () => {
  it('covers every group the API can put a type in', () => {
    const groups = new Set(NOTIFICATION_TYPES.map((spec) => spec.group));
    for (const group of groups) {
      expect(NOTIFICATION_GROUPS, `the API sends a ${group} type`).toContain(group);
    }
  });

  it('has a heading and a sentence for every group it names', () => {
    for (const group of NOTIFICATION_GROUPS) {
      expect(GROUP_LABELS[group], group).toBeTruthy();
      expect(GROUP_HINTS[group], group).toBeTruthy();
    }
  });
});

describe('byGroup', () => {
  it('keeps the reading order rather than the API’s', () => {
    const sections = byGroup([
      entry({ type: 'member.joined', group: 'workspace' }),
      entry({ type: 'lead.unassigned_pool', group: 'leads' }),
      entry({ type: 'task.overdue', group: 'work' }),
    ]);
    expect(sections.map((section) => section.group)).toEqual(['work', 'leads', 'workspace']);
  });

  it('drops an empty group rather than rendering a bare heading', () => {
    const sections = byGroup([entry({ group: 'work' })]);
    expect(sections).toHaveLength(1);
    expect(sections[0]!.group).toBe('work');
  });
});

describe('isOn', () => {
  it('reads the effective state, not the stored one', () => {
    // `channels: null` means "never touched", which is on-by-default — and a screen that read the
    // stored value would show every switch off until somebody saved it once.
    expect(isOn(entry({ channels: null, effectiveChannels: ['in_app'] }))).toBe(true);
    expect(isOn(entry({ channels: [], effectiveChannels: [] }))).toBe(false);
  });
});

describe('describeQuietHours', () => {
  it('says the window crosses midnight, because otherwise it reads as a typo', () => {
    expect(describeQuietHours({ startMinute: 1290, endMinute: 420 }, 'Asia/Kolkata')).toBe(
      'Held from 21:30 until 07:00 the next morning, Asia/Kolkata time.',
    );
  });

  it('says a same-day window plainly', () => {
    expect(describeQuietHours({ startMinute: 780, endMinute: 840 }, 'Asia/Kolkata')).toBe(
      'Held from 13:00 until 14:00, Asia/Kolkata time.',
    );
  });

  it('says what "off" actually means, rather than just "off"', () => {
    expect(describeQuietHours(null, 'Asia/Kolkata')).toMatch(/at any hour/);
  });
});

describe('formatMinuteOfDay', () => {
  it('pads both halves, which is what a time input needs', () => {
    expect(formatMinuteOfDay(0)).toBe('00:00');
    expect(formatMinuteOfDay(9 * 60 + 5)).toBe('09:05');
    expect(formatMinuteOfDay(1439)).toBe('23:59');
  });
});

describe('heldUntil', () => {
  const row = {
    id: 'n1',
    type: 'task.overdue',
    title: 'Overdue',
    body: null,
    link: null,
    readAt: null,
    createdAt: '2026-10-13T16:10:00.000Z',
  };

  it('reads the hold the API recorded in the payload', () => {
    expect(heldUntil({ ...row, data: { heldUntil: '2026-10-14T01:30:00.000Z' } })).toBe(
      '2026-10-14T01:30:00.000Z',
    );
  });

  it('answers null for a notification that was never held, and for junk', () => {
    expect(heldUntil({ ...row, data: {} })).toBeNull();
    expect(heldUntil({ ...row, data: { heldUntil: 1760000000000 } })).toBeNull();
    expect(heldUntil({ ...row, data: undefined as never })).toBeNull();
  });
});
