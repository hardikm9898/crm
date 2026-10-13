import { describe, expect, it } from 'vitest';
import {
  MAX_ATTEMPTS,
  QUEUE_STORAGE_KEY,
  actionsFor,
  failedCount,
  isExhausted,
  parseQueue,
  pendingCount,
  readQueue,
  replaceAction,
  retryDelayMs,
  withoutAction,
  writeQueue,
  type QueueStorage,
  type QueuedAction,
} from './action-queue';

/**
 * The rules behind "actions survive a flaky connection", which is one of Phase 3's exit criteria.
 *
 * The hook that owns the timers is React and is exercised in the browser check; everything here is
 * the part that decides *what* happens — how long to wait, when to stop, and what to do with a
 * queue written by an older version of the screen. The storage reader is the one with teeth: it is
 * the difference between a stale blob degrading the queue and a stale blob making the product's
 * landing page impossible to open.
 */

function action(overrides: Partial<QueuedAction> = {}): QueuedAction {
  return {
    id: 'a1',
    kind: 'complete',
    taskId: 't1',
    label: 'Done — Interested',
    payload: { taskId: 't1', outcomeId: 'o1' },
    attempts: 0,
    failure: null,
    ...overrides,
  };
}

/** A `localStorage` stand-in, and one that throws like a blocked one does. */
function fakeStorage(initial: Record<string, string> = {}): QueueStorage & {
  readonly data: Record<string, string>;
} {
  const data: Record<string, string> = { ...initial };
  return {
    data,
    getItem: (key) => data[key] ?? null,
    setItem: (key, value) => {
      data[key] = value;
    },
    removeItem: (key) => {
      delete data[key];
    },
  };
}

function hostileStorage(): QueueStorage {
  return {
    getItem() {
      throw new Error('site data blocked');
    },
    setItem() {
      throw new Error('site data blocked');
    },
    removeItem() {
      throw new Error('site data blocked');
    },
  };
}

describe('retryDelayMs', () => {
  it('does not delay the first attempt: a tap on a good connection must feel immediate', () => {
    expect(retryDelayMs(0)).toBe(0);
  });

  it('backs off exponentially and then stops growing', () => {
    expect(retryDelayMs(1)).toBe(1000);
    expect(retryDelayMs(2)).toBe(2000);
    expect(retryDelayMs(3)).toBe(4000);
    // Capped: a queue that waits half a minute between tries is indistinguishable from one that
    // has given up, and by then the manual retry is the better answer.
    expect(retryDelayMs(9)).toBe(4000);
  });

  it('gives up inside about seven seconds in total', () => {
    const total = Array.from({ length: MAX_ATTEMPTS }, (_, index) => retryDelayMs(index)).reduce(
      (sum, delay) => sum + delay,
      0,
    );
    expect(total).toBeLessThanOrEqual(7000);
  });
});

describe('what the queue reports', () => {
  it('separates what is still being tried from what has stopped', () => {
    const queue = [action(), action({ id: 'a2', failure: 'Your connection dropped.' })];
    expect(pendingCount(queue)).toBe(1);
    expect(failedCount(queue)).toBe(1);
    expect(isExhausted(queue[0]!)).toBe(false);
    expect(isExhausted(queue[1]!)).toBe(true);
  });

  it('finds the actions outstanding for one card, which is what makes it show “sending”', () => {
    const queue = [action(), action({ id: 'a2', taskId: 't2' })];
    expect(actionsFor(queue, 't2').map((entry) => entry.id)).toEqual(['a2']);
    expect(actionsFor(queue, 'nobody')).toHaveLength(0);
  });

  it('removes and replaces without touching the rest', () => {
    const queue = [action(), action({ id: 'a2', taskId: 't2' })];
    expect(withoutAction(queue, 'a1').map((entry) => entry.id)).toEqual(['a2']);
    const moved = replaceAction(queue, { ...queue[0]!, attempts: 2 });
    expect(moved[0]!.attempts).toBe(2);
    expect(moved[1]).toBe(queue[1]);
  });
});

describe('parseQueue', () => {
  it('reads back what was written', () => {
    const queue = [action(), action({ id: 'a2', kind: 'reschedule', taskId: 't2' })];
    expect(parseQueue(JSON.stringify(queue))).toEqual(queue);
  });

  it('treats nothing, rubbish and the wrong shape as an empty queue rather than throwing', () => {
    // The queue outlives a deploy, so a blob from an older version of this screen is a normal
    // thing to find. A screen that threw while reading it could not be opened at all until
    // somebody cleared their site data — not a thing to ask of a sales executive.
    expect(parseQueue(null)).toEqual([]);
    expect(parseQueue('')).toEqual([]);
    expect(parseQueue('not json at all')).toEqual([]);
    expect(parseQueue('{"not":"an array"}')).toEqual([]);
    expect(parseQueue('[1, 2, 3]')).toEqual([]);
  });

  it('drops the entries it cannot trust and keeps the ones it can', () => {
    const raw = JSON.stringify([
      action(),
      { ...action({ id: 'a2' }), kind: 'something_new' },
      { ...action({ id: 'a3' }), taskId: '' },
      { ...action({ id: 'a4' }), attempts: 'two' },
      { ...action({ id: 'a5' }), payload: { fine: 'yes', bad: 7 } },
      { ...action({ id: 'a6' }), failure: 42 },
      { ...action({ id: 'a7' }), payload: ['not', 'an', 'object'] },
    ]);
    expect(parseQueue(raw).map((entry) => entry.id)).toEqual(['a1']);
  });

  it('keeps a failed action, because the card has to go on offering “try again”', () => {
    const failed = action({ failure: 'Your connection dropped.', attempts: 4 });
    expect(parseQueue(JSON.stringify([failed]))).toEqual([failed]);
  });
});

describe('storage', () => {
  it('writes under one key and removes it when the queue empties', () => {
    const storage = fakeStorage();
    writeQueue(storage, [action()]);
    expect(Object.keys(storage.data)).toEqual([QUEUE_STORAGE_KEY]);
    writeQueue(storage, []);
    expect(storage.data[QUEUE_STORAGE_KEY]).toBeUndefined();
  });

  it('round-trips', () => {
    const storage = fakeStorage();
    const queue = [action(), action({ id: 'a2', kind: 'reschedule' })];
    writeQueue(storage, queue);
    expect(readQueue(storage)).toEqual(queue);
  });

  it('survives storage that throws on the accessor itself', () => {
    // A private window, blocked site data, a thumbnail capture: the getter throws rather than
    // returning empty. The screen has to work without storage — it only loses the
    // across-a-reload part, which is the least important of its guarantees.
    expect(() => writeQueue(hostileStorage(), [action()])).not.toThrow();
    expect(readQueue(hostileStorage())).toEqual([]);
  });

  it('survives having no storage at all, which is what the server render has', () => {
    expect(readQueue(undefined)).toEqual([]);
    expect(() => writeQueue(undefined, [action()])).not.toThrow();
  });
});
