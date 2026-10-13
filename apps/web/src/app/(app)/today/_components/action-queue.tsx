'use client';

import { useEffect, useRef, useState } from 'react';
import {
  MAX_ATTEMPTS,
  readQueue,
  replaceAction,
  retryDelayMs,
  withoutAction,
  writeQueue,
  type QueuedAction,
  type QueuedKind,
  type QueueStorage,
} from '@/lib/action-queue';
import type { QueuedResult } from '../actions';

/**
 * The hook that owns the timers behind `/today`'s one-tap actions.
 *
 * The rules it implements are argued for in `lib/action-queue.ts`; this is the part that cannot be
 * tested in Node. Three things are worth knowing about it:
 *
 *  * **The queue is the state, and storage is a copy of it.** Every change goes through `commit`,
 *    which updates the ref React reads, the state React renders, and the browser storage that
 *    survives a reload — in that order, so a re-render never sees a stale queue.
 *  * **Retries recurse through a ref**, reassigned on every render. A `useCallback` that calls
 *    itself cannot see its own latest closure, and a stale one retries with the state the queue
 *    had three attempts ago.
 *  * **Anything still pending is resumed on mount**, which is what makes "a tap is never lost"
 *    true across a reload. It can therefore re-send a request whose *response* was lost — and the
 *    API refuses a follow-up that is already finished, with a sentence saying so, which is a far
 *    better outcome than the alternative of dropping the tap.
 */

export type Runner = (payload: Readonly<Record<string, string>>) => Promise<QueuedResult>;

export interface ActionQueue {
  readonly actions: readonly QueuedAction[];
  readonly settled: readonly string[];
  enqueue(action: Omit<QueuedAction, 'attempts' | 'failure'>): void;
  retry(id: string): void;
  dismiss(id: string): void;
}

function storageOf(): QueueStorage | undefined {
  if (typeof window === 'undefined') return undefined;
  try {
    return window.localStorage;
  } catch {
    // Blocked site data: the accessor itself throws. A degraded queue, not a broken screen.
    return undefined;
  }
}

export function useActionQueue(runners: Readonly<Record<QueuedKind, Runner>>): ActionQueue {
  const [actions, setActions] = useState<readonly QueuedAction[]>([]);
  /** Task ids whose action went through — hidden from the list before the server catches up. */
  const [settled, setSettled] = useState<readonly string[]>([]);
  const queue = useRef<readonly QueuedAction[]>([]);
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());
  const live = useRef(true);
  const runnersRef = useRef(runners);
  runnersRef.current = runners;

  const commit = (next: readonly QueuedAction[]): void => {
    queue.current = next;
    setActions(next);
    writeQueue(storageOf(), next);
  };

  const attempt = useRef<(action: QueuedAction) => Promise<void>>(async () => {});
  attempt.current = async (action: QueuedAction): Promise<void> => {
    let result: QueuedResult;
    try {
      result = await runnersRef.current[action.kind](action.payload);
    } catch {
      // A server action that throws is a request that never got an answer: the dropped
      // connection this whole mechanism exists for.
      result = { ok: false, message: 'Your connection dropped.', retryable: true };
    }
    if (!live.current) return;

    if (result.ok) {
      commit(withoutAction(queue.current, action.id));
      setSettled((previous) =>
        previous.includes(action.taskId) ? previous : [...previous, action.taskId],
      );
      return;
    }

    const attempts = action.attempts + 1;
    if (result.retryable && attempts < MAX_ATTEMPTS) {
      const next = { ...action, attempts, failure: null };
      commit(replaceAction(queue.current, next));
      const timer = setTimeout(() => {
        timers.current.delete(timer);
        void attempt.current(next);
      }, retryDelayMs(attempts));
      timers.current.add(timer);
      return;
    }
    commit(replaceAction(queue.current, { ...action, attempts, failure: result.message }));
  };

  useEffect(() => {
    live.current = true;
    const stored = readQueue(storageOf());
    if (stored.length > 0) {
      queue.current = stored;
      setActions(stored);
      for (const action of stored) if (action.failure === null) void attempt.current(action);
    }
    const running = timers.current;
    return () => {
      live.current = false;
      for (const timer of running) clearTimeout(timer);
      running.clear();
    };
    // Mount only: this is the resume, and re-running it would re-send everything on every render.
  }, []);

  return {
    actions,
    settled,
    enqueue(action) {
      const entry: QueuedAction = { ...action, attempts: 0, failure: null };
      commit([...queue.current, entry]);
      void attempt.current(entry);
    },
    retry(id) {
      const action = queue.current.find((entry) => entry.id === id);
      if (!action) return;
      const entry = { ...action, attempts: 0, failure: null };
      commit(replaceAction(queue.current, entry));
      void attempt.current(entry);
    },
    dismiss(id) {
      commit(withoutAction(queue.current, id));
    },
  };
}
