import { describe, expect, it } from 'vitest';
import {
  DEFAULT_REMINDER_OFFSETS,
  MAX_REMINDERS_PER_TASK,
  TASK_BUCKETS,
  compareTasksForQueue,
  describeReminderLead,
  dueParts,
  isOverdue,
  normaliseReminderOffsets,
  reminderInstants,
  taskBucket,
} from './tasks.js';

const KOLKATA = 'Asia/Kolkata';

describe('taskBucket', () => {
  const now = new Date('2026-03-10T09:00:00.000Z'); // 14:30 in Kolkata

  it('puts a task whose time has passed in overdue, from the clock rather than a column', () => {
    // The whole reason `overdue` is not a status: this has to be true one minute after the due
    // time, not at the sweep's next tick.
    expect(
      taskBucket({ status: 'pending', dueAt: new Date('2026-03-10T08:59:00.000Z') }, now, KOLKATA),
    ).toBe('overdue');
  });

  it('calls the next half hour “due now”', () => {
    expect(
      taskBucket({ status: 'pending', dueAt: new Date('2026-03-10T09:20:00.000Z') }, now, KOLKATA),
    ).toBe('due_now');
  });

  it('separates the rest of the workspace’s day from later days', () => {
    // 23:00 Kolkata is still today for the business; 00:30 Kolkata is tomorrow. In UTC the two
    // instants are only ninety minutes apart and both read as "the 10th", which is exactly the
    // mistake storing the instant alone would make.
    expect(
      taskBucket({ status: 'pending', dueAt: new Date('2026-03-10T17:30:00.000Z') }, now, KOLKATA),
    ).toBe('due_today');
    expect(
      taskBucket({ status: 'pending', dueAt: new Date('2026-03-10T19:00:00.000Z') }, now, KOLKATA),
    ).toBe('upcoming');
  });

  it('reports a finished task by what happened to it, not by its due time', () => {
    const longPast = new Date('2026-01-01T00:00:00.000Z');
    expect(taskBucket({ status: 'completed', dueAt: longPast }, now, KOLKATA)).toBe('completed');
    expect(taskBucket({ status: 'cancelled', dueAt: longPast }, now, KOLKATA)).toBe('cancelled');
  });

  it('assigns every task exactly one bucket, so the counts add up to the list', () => {
    const minutes = [-120, -1, 5, 29, 31, 240, 2000, 20_000];
    const buckets = minutes.map((offset) =>
      taskBucket(
        { status: 'pending', dueAt: new Date(now.getTime() + offset * 60_000) },
        now,
        KOLKATA,
      ),
    );
    expect(buckets.every((bucket) => TASK_BUCKETS.includes(bucket))).toBe(true);
    expect(buckets).toHaveLength(minutes.length);
  });

  it('does not call a completed task overdue', () => {
    const past = new Date('2026-01-01T00:00:00.000Z');
    expect(isOverdue({ status: 'completed', dueAt: past }, now)).toBe(false);
    expect(isOverdue({ status: 'pending', dueAt: past }, now)).toBe(true);
  });
});

describe('dueParts', () => {
  it('splits an instant into the workspace’s calendar date and wall clock', () => {
    expect(dueParts(new Date('2026-03-10T09:00:00.000Z'), KOLKATA)).toEqual({
      dueDate: '2026-03-10',
      dueTime: '14:30:00',
    });
  });

  it('rolls the date over where the workspace has already rolled over', () => {
    // 19:00 UTC is 00:30 the next day in Kolkata. A task "due tomorrow at half past midnight"
    // grouped by the UTC date would appear on today's list.
    expect(dueParts(new Date('2026-03-10T19:00:00.000Z'), KOLKATA).dueDate).toBe('2026-03-11');
  });

  it('survives a DST transition in a zone that has one', () => {
    // 2026-03-29 01:30 UTC is 02:30 in Berlin on the morning the clocks go forward.
    expect(dueParts(new Date('2026-03-29T01:30:00.000Z'), 'Europe/Berlin')).toEqual({
      dueDate: '2026-03-29',
      dueTime: '03:30:00',
    });
  });
});

describe('normaliseReminderOffsets', () => {
  it('drops duplicates and negatives and orders them as they fire', () => {
    expect(normaliseReminderOffsets([60, 10, 60, -5, 1440])).toEqual([1440, 60, 10]);
  });

  it('caps rather than refuses, because nobody asked to be told nine times', () => {
    const many = [10, 20, 30, 40, 50, 60, 70, 80];
    expect(normaliseReminderOffsets(many)).toHaveLength(MAX_REMINDERS_PER_TASK);
  });

  it('ignores anything that is not a whole number of minutes', () => {
    expect(normaliseReminderOffsets([30.5, 'soon', null, 15])).toEqual([15]);
  });

  it('keeps zero, which means “at the due time”', () => {
    expect(normaliseReminderOffsets([0])).toEqual([0]);
  });
});

describe('reminderInstants', () => {
  const dueAt = new Date('2026-03-10T12:00:00.000Z');

  it('turns offsets into instants', () => {
    const now = new Date('2026-03-09T00:00:00.000Z');
    expect(reminderInstants(dueAt, [60, 10], now)).toEqual([
      { offsetMinutes: 60, remindAt: new Date('2026-03-10T11:00:00.000Z') },
      { offsetMinutes: 10, remindAt: new Date('2026-03-10T11:50:00.000Z') },
    ]);
  });

  it('drops a reminder whose moment has already gone', () => {
    // A task created twenty minutes before it is due must not immediately fire its hour-before
    // reminder: a reminder and the overdue notice arriving together is how a list becomes noise.
    const now = new Date('2026-03-10T11:40:00.000Z');
    expect(reminderInstants(dueAt, [60, 10], now)).toEqual([
      { offsetMinutes: 10, remindAt: new Date('2026-03-10T11:50:00.000Z') },
    ]);
  });

  it('produces nothing for a task due in the past', () => {
    expect(reminderInstants(dueAt, [60], new Date('2026-03-11T00:00:00.000Z'))).toEqual([]);
  });

  it('defaults to one reminder an hour before', () => {
    expect(DEFAULT_REMINDER_OFFSETS).toEqual([60]);
  });
});

describe('describeReminderLead', () => {
  it('reads as a sentence rather than as machine output', () => {
    expect(describeReminderLead(0)).toBe('now');
    expect(describeReminderLead(1)).toBe('in 1 minute');
    expect(describeReminderLead(15)).toBe('in 15 minutes');
    expect(describeReminderLead(60)).toBe('in an hour');
    expect(describeReminderLead(180)).toBe('in 3 hours');
    expect(describeReminderLead(1440)).toBe('tomorrow');
    expect(describeReminderLead(2880)).toBe('in 2 days');
  });
});

describe('compareTasksForQueue', () => {
  it('puts urgent work first even when it is due later', () => {
    const urgentLater = { priority: 'urgent', dueAt: new Date('2026-03-10T16:00:00.000Z') };
    const lowSooner = { priority: 'low', dueAt: new Date('2026-03-10T10:00:00.000Z') };
    expect([lowSooner, urgentLater].sort(compareTasksForQueue)[0]).toBe(urgentLater);
  });

  it('falls back to due time within a priority', () => {
    const early = { priority: 'high', dueAt: new Date('2026-03-10T10:00:00.000Z') };
    const late = { priority: 'high', dueAt: new Date('2026-03-10T11:00:00.000Z') };
    expect([late, early].sort(compareTasksForQueue)).toEqual([early, late]);
  });

  it('does not throw away a task with an unknown priority', () => {
    const odd = { priority: 'whenever', dueAt: new Date('2026-03-10T09:00:00.000Z') };
    const normal = { priority: 'medium', dueAt: new Date('2026-03-10T10:00:00.000Z') };
    expect([odd, normal].sort(compareTasksForQueue)).toEqual([normal, odd]);
  });
});
