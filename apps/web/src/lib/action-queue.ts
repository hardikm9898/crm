/**
 * The queue behind `/today`'s one-tap actions.
 *
 * **Why a queue at all.** Phase 3's exit criteria say the Today workspace's actions must "survive a
 * flaky connection (queued + retried)", and that is not a nicety: the person using this screen is
 * standing outside a site visit on a 4G signal that comes and goes, and a tap that silently does
 * nothing teaches them not to trust the product. Everywhere else in the app an action is a server
 * action and a round trip, and a refusal is shown — which is right for a form somebody is sitting
 * in front of, and wrong for a queue being worked one thumb at a time.
 *
 * **What it guarantees, exactly.** A tap is recorded before the request is made, retried with
 * backoff while it keeps failing, kept across a reload, and — when it has finally run out of
 * attempts — shown as failed with a button to try again. It does *not* guarantee delivery: nothing
 * running in a browser tab can. It guarantees the tap is never lost silently, which is the thing
 * that actually erodes trust.
 *
 * The pure parts live here so they can be tested in Node; the hook that owns the timers is in
 * `app/(app)/today/_components/action-queue.tsx`.
 */

export const QUEUE_STORAGE_KEY = 'leados.today.queue.v1';

/** Four attempts: immediate, then roughly one, two and four seconds later. */
export const MAX_ATTEMPTS = 4;

export type QueuedKind = 'complete' | 'reschedule';

export interface QueuedAction {
  /** Minted in the browser, so the same tap can be recognised across a reload. */
  readonly id: string;
  readonly kind: QueuedKind;
  /** What the action is about, so the card it belongs to can show its own state. */
  readonly taskId: string;
  /** What to tell somebody it was: "Done — Interested", "Moved to tomorrow 10:00". */
  readonly label: string;
  /** The server action's arguments, as strings, because this is written to storage. */
  readonly payload: Readonly<Record<string, string>>;
  readonly attempts: number;
  /** The refusal, once it has stopped trying. `null` while it is still being attempted. */
  readonly failure: string | null;
}

/**
 * How long to wait before attempt `n`.
 *
 * Zero first — a tap on a good connection must not feel delayed — then exponential. Capped at four
 * seconds, because a queue that waits half a minute between tries is indistinguishable from one
 * that has given up, and the manual retry is a better answer by then.
 */
export function retryDelayMs(attempt: number): number {
  if (attempt <= 0) return 0;
  return Math.min(4000, 1000 * 2 ** (attempt - 1));
}

export function isExhausted(action: QueuedAction): boolean {
  return action.failure !== null;
}

export function pendingCount(actions: readonly QueuedAction[]): number {
  return actions.filter((action) => action.failure === null).length;
}

export function failedCount(actions: readonly QueuedAction[]): number {
  return actions.filter((action) => action.failure !== null).length;
}

/** The actions still outstanding for one card — what makes a card show "sending" or "failed". */
export function actionsFor(
  actions: readonly QueuedAction[],
  taskId: string,
): readonly QueuedAction[] {
  return actions.filter((action) => action.taskId === taskId);
}

export function withoutAction(
  actions: readonly QueuedAction[],
  id: string,
): readonly QueuedAction[] {
  return actions.filter((action) => action.id !== id);
}

export function replaceAction(
  actions: readonly QueuedAction[],
  next: QueuedAction,
): readonly QueuedAction[] {
  return actions.map((action) => (action.id === next.id ? next : action));
}

/**
 * Anything in storage that is not a well-formed action is dropped rather than trusted.
 *
 * The queue outlives a deploy — it is per-viewer browser storage — so a blob written by an older
 * version of this screen is a normal thing to find, not an exceptional one. A screen that threw
 * while reading it would be a screen that cannot be opened at all until somebody clears their site
 * data, which is not a thing to ask of a sales executive.
 */
export function parseQueue(raw: string | null): QueuedAction[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(isQueuedAction).map((action) => ({
    id: action.id,
    kind: action.kind,
    taskId: action.taskId,
    label: action.label,
    payload: action.payload,
    attempts: action.attempts,
    failure: action.failure,
  }));
}

function isQueuedAction(value: unknown): value is QueuedAction {
  if (typeof value !== 'object' || value === null) return false;
  const action = value as Record<string, unknown>;
  if (typeof action['id'] !== 'string' || action['id'] === '') return false;
  if (action['kind'] !== 'complete' && action['kind'] !== 'reschedule') return false;
  if (typeof action['taskId'] !== 'string' || action['taskId'] === '') return false;
  if (typeof action['label'] !== 'string') return false;
  if (typeof action['attempts'] !== 'number' || !Number.isFinite(action['attempts'])) return false;
  if (action['failure'] !== null && typeof action['failure'] !== 'string') return false;
  const payload = action['payload'];
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return false;
  return Object.values(payload as Record<string, unknown>).every(
    (entry) => typeof entry === 'string',
  );
}

/**
 * Reading and writing the queue, through anything that looks like `localStorage`.
 *
 * Every access is wrapped: in a private window, with site data blocked, during a thumbnail capture
 * or inside an iframe, the accessor itself throws rather than returning empty. The screen has to
 * work without storage — it simply loses the across-a-reload part, which is the least important of
 * the guarantees above.
 */
export interface QueueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export function readQueue(storage: QueueStorage | undefined): QueuedAction[] {
  if (!storage) return [];
  try {
    return parseQueue(storage.getItem(QUEUE_STORAGE_KEY));
  } catch {
    return [];
  }
}

export function writeQueue(
  storage: QueueStorage | undefined,
  actions: readonly QueuedAction[],
): void {
  if (!storage) return;
  try {
    if (actions.length === 0) storage.removeItem(QUEUE_STORAGE_KEY);
    else storage.setItem(QUEUE_STORAGE_KEY, JSON.stringify(actions));
  } catch {
    /* No storage is a degraded queue, not a broken screen. */
  }
}
