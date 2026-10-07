import { describe, expect, it } from 'vitest';
import { TASK_BUCKETS as API_BUCKETS } from '@leados/shared';
import {
  BUCKET_CLASSES,
  BUCKET_HINTS,
  BUCKET_LABELS,
  QUEUE_BUCKETS,
  TASK_BUCKETS,
  defaultDue,
  dueFields,
  isQueueBucket,
} from './tasks';

describe('the bucket vocabulary', () => {
  it('matches the API’s, which this file deliberately does not import at runtime', () => {
    // `@leados/shared`'s entry point reaches `node:async_hooks` through the tenant context, and a
    // client component that pulls that in fails the Next build outright. So the list is declared
    // twice and reconciled here, in a test that runs in Node and may import both.
    expect([...TASK_BUCKETS]).toEqual([...API_BUCKETS]);
  });

  it('has a heading, a sentence and a colour for every one of them', () => {
    for (const bucket of TASK_BUCKETS) {
      expect(BUCKET_LABELS[bucket], bucket).toBeTruthy();
      // The sentence matters more than it looks: "Overdue (3)" says what but not why, and the
      // whole point of a queue is that the next thing to do is obvious.
      expect(BUCKET_HINTS[bucket]?.length ?? 0, bucket).toBeGreaterThan(10);
      expect(BUCKET_CLASSES[bucket], bucket).toBeTruthy();
    }
  });

  it('reads the queue in the order somebody works it, and leaves finished work out of it', () => {
    expect([...QUEUE_BUCKETS]).toEqual(['overdue', 'due_now', 'due_today', 'upcoming']);
    expect(QUEUE_BUCKETS).not.toContain('completed');
  });

  it('recognises a bucket name from the URL, and refuses anything else', () => {
    expect(isQueueBucket('overdue')).toBe(true);
    expect(isQueueBucket('whenever')).toBe(false);
  });
});

describe('the two fields a person fills in', () => {
  it('splits an instant into a date and a time input', () => {
    // Local, because the inputs are local: the server action puts them back together with the
    // browser's own offset.
    const when = new Date(2026, 3, 2, 9, 30);
    expect(dueFields(when)).toEqual({ date: '2026-04-02', time: '09:30' });
  });

  it('pads single digits, which an input refuses without', () => {
    expect(dueFields(new Date(2026, 0, 5, 8, 5))).toEqual({ date: '2026-01-05', time: '08:05' });
  });

  it('defaults to tomorrow at ten, which is what “follow up” means if nobody says otherwise', () => {
    const now = new Date(2026, 3, 2, 16, 42);
    expect(defaultDue(now)).toEqual({ date: '2026-04-03', time: '10:00' });
  });

  it('crosses a month boundary rather than producing the 32nd', () => {
    expect(defaultDue(new Date(2026, 3, 30, 16, 0)).date).toBe('2026-05-01');
  });
});
