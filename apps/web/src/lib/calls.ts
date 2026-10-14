import { request } from '@/lib/api';

/**
 * Calls, on the web side (`FR-CALL-1..3`).
 *
 * The vocabulary is **declared here rather than imported from `@leados/shared`**, for the reason
 * `tasks.ts` states: that package's entry point reaches `node:async_hooks` through the tenant
 * context, and a client component that transitively imports it fails `next build` outright. The two
 * copies are reconciled by `calls.spec.ts`, which runs in Node and so may import both — including
 * `isContact`, whose answer decides whether a lead is marked contacted and is therefore the one
 * piece of this vocabulary that must not drift.
 */

export const CALL_DIRECTIONS = ['outbound', 'inbound'] as const;
export type CallDirection = (typeof CALL_DIRECTIONS)[number];

export const CALL_STATUSES = ['dialing', 'completed', 'no_answer', 'busy', 'failed'] as const;
export type CallStatus = (typeof CALL_STATUSES)[number];

export const CALL_OUTCOME_CATEGORIES = [
  'connected',
  'no_answer',
  'busy',
  'wrong_number',
  'not_interested',
  'callback',
] as const;
export type CallOutcomeCategory = (typeof CALL_OUTCOME_CATEGORIES)[number];

/** What the status says, as a person would read it. */
export const STATUS_LABELS: Record<CallStatus, string> = {
  dialing: 'No outcome yet',
  completed: 'Spoke',
  no_answer: 'No answer',
  busy: 'Line busy',
  failed: 'Call failed',
};

/**
 * A `dialing` row is amber, not grey.
 *
 * It is the one state that is asking somebody for something: the call was made and nobody has said
 * what happened. A quiet colour there is how a lead ends up with four attempts and no record of
 * any of them.
 */
export const STATUS_CLASSES: Record<CallStatus, string> = {
  dialing: 'bg-amber-100 text-amber-900',
  completed: 'bg-emerald-100 text-emerald-900',
  no_answer: 'bg-[var(--color-surface-muted)] text-[var(--color-text-muted)]',
  busy: 'bg-[var(--color-surface-muted)] text-[var(--color-text-muted)]',
  failed: 'bg-rose-100 text-rose-900',
};

export const CATEGORY_LABELS: Record<CallOutcomeCategory, string> = {
  connected: 'Spoke to them',
  no_answer: 'No answer',
  busy: 'Line busy',
  wrong_number: 'Wrong number',
  not_interested: 'Not interested',
  callback: 'Asked to call back',
};

/** The categories the API treats as having reached the person. See `isContact` in the API. */
export function isContactCategory(category: string): boolean {
  return category === 'connected' || category === 'callback' || category === 'not_interested';
}

/**
 * The connection status a chosen outcome implies — the API's `statusForCategory`, hand-written.
 *
 * The form asks **once**, for the outcome: `status` is what the telephony saw, and with the manual
 * driver there is no telephony, so asking the person both questions is asking the same one in two
 * vocabularies. `wrong_number` connected (somebody answered) while `isContactCategory` says nobody
 * was reached — the one category where the two diverge, which is why they are two functions.
 */
export function statusForCategory(category: string): CallStatus {
  if (category === 'no_answer') return 'no_answer';
  if (category === 'busy') return 'busy';
  return 'completed';
}

/** A duration a human reads. The API sends the sentence too; this is for a local recount. */
export function describeCallDuration(seconds: number | null): string {
  if (seconds === null || seconds <= 0) return 'no time on the call';
  if (seconds < 60) return `${seconds} sec`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes < 60) return rest === 0 ? `${minutes} min` : `${minutes} min ${rest} sec`;
  const hours = Math.floor(minutes / 60);
  return `${hours} hr ${minutes % 60} min`;
}

/** Minutes and seconds from the two boxes the form offers, as whole seconds. */
export function durationSeconds(minutes: string | null, seconds: string | null): number | null {
  // `Number(null)` and `Number('')` are both 0, and 0 is a meaningful duration — so an empty form
  // must come back as "not recorded", not as a call that lasted no time.
  if (!minutes && !seconds) return null;
  const m = minutes ? Number(minutes) : 0;
  const s = seconds ? Number(seconds) : 0;
  if (!Number.isFinite(m) || !Number.isFinite(s) || m < 0 || s < 0) return null;
  return Math.round(m) * 60 + Math.round(s);
}

export interface CallOutcome {
  id: string;
  name: string;
  category: CallOutcomeCategory;
  requiresNote: boolean;
  sortOrder: number;
  /** Derived by the API, so no screen reimplements which categories mean "reached". */
  isContact?: boolean;
  isActive?: boolean;
  callCount?: number;
}

export interface CallRecord {
  id: string;
  leadId: string | null;
  lead: { id: string; fullName: string; phoneE164: string | null } | null;
  taskId: string | null;
  task: { id: string; title: string; status: string } | null;
  direction: CallDirection;
  status: CallStatus;
  fromE164: string | null;
  toE164: string | null;
  outcomeId: string | null;
  outcome: { id: string; name: string; category: CallOutcomeCategory } | null;
  reached: boolean;
  durationSeconds: number | null;
  duration: string;
  notes: string | null;
  recordingUrl: string | null;
  provider: string | null;
  agentUserId: string;
  startedAt: string;
  endedAt: string | null;
  createdAt: string;
  deletedAt: string | null;
}

export interface CallConfig {
  outcomes: CallOutcome[];
  /**
   * What the dial button will actually do.
   *
   * `placesCalls: false` is the manual driver, which hands the number to the device — and the
   * screen has to say so rather than implying the product is ringing somebody.
   */
  telephony: { driver: string; placesCalls: boolean };
}

export async function loadCallConfig(token: string | null): Promise<CallConfig> {
  try {
    return await loadCallConfigOrThrow(token);
  } catch {
    return { outcomes: [], telephony: { driver: 'unavailable', placesCalls: false } };
  }
}

/**
 * The throwing twin, for the settings screen and anywhere "there are no outcomes" would be a lie
 * somebody acts on. The swallowing version is for a panel beside other content.
 */
export async function loadCallConfigOrThrow(token: string | null): Promise<CallConfig> {
  return (await request<CallConfig>('/calls/config', { token })).data;
}

/** One lead's calls, newest first. Swallows: a missing panel beats a lead that will not open. */
export async function loadLeadCalls(
  leadId: string,
  token: string | null,
): Promise<{ items: CallRecord[]; total: number; talkTimeSeconds: number; connected: number }> {
  try {
    const response = await request<CallRecord[]>(`/calls?leadId=${leadId}&limit=20`, { token });
    const meta = response.meta as { totalTalkTimeSeconds?: number; connected?: number } | undefined;
    return {
      items: response.data,
      // The whole filter's totals, not the page's — the API aggregates them for exactly that
      // reason, and recounting the twenty loaded rows here would undo it.
      total: response.pagination?.total ?? response.data.length,
      talkTimeSeconds: meta?.totalTalkTimeSeconds ?? 0,
      connected: meta?.connected ?? 0,
    };
  } catch {
    return { items: [], total: 0, talkTimeSeconds: 0, connected: 0 };
  }
}

/** A page of calls, with the whole filter's totals rather than the page's. */
export async function loadCalls(
  query: string,
  token: string | null,
): Promise<{
  items: CallRecord[];
  total: number;
  nextCursor: string | null;
  talkTimeSeconds: number;
  connected: number;
}> {
  const response = await request<CallRecord[]>(`/calls${query}`, { token });
  const meta = response.meta as { totalTalkTimeSeconds?: number; connected?: number } | undefined;
  return {
    items: response.data,
    total: response.pagination?.total ?? response.data.length,
    nextCursor: response.pagination?.nextCursor ?? null,
    talkTimeSeconds: meta?.totalTalkTimeSeconds ?? 0,
    connected: meta?.connected ?? 0,
  };
}

export async function loadCallOutcomes(token: string | null, query = ''): Promise<CallOutcome[]> {
  return (await request<CallOutcome[]>(`/settings/call-outcomes${query}`, { token })).data;
}
