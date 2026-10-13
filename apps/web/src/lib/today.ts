import { request } from '@/lib/api';

/**
 * The Today screen's payload, hand-written against the documented envelope.
 *
 * Like `lib/tasks.ts`, and for the same reason: `@leados/shared`'s entry point reaches
 * `node:async_hooks`, and a client component that transitively imports it fails `next build`. The
 * reconciliation is in `today.spec.ts`, which runs in Node and may import both.
 */

export interface TodayTaskCard {
  id: string;
  title: string;
  status: string;
  bucket: 'overdue' | 'due_now' | 'due_today' | 'upcoming' | 'completed' | 'cancelled';
  priority: 'low' | 'medium' | 'high' | 'urgent';
  dueAt: string;
  /** Negative once it has passed, which is what "2 days late" is rendered from. */
  minutesUntilDue: number;
  rescheduleCount: number;
  taskType: { id: string; name: string; icon: string | null } | null;
  leadId: string | null;
  lead: {
    id: string;
    fullName: string;
    phoneE164: string | null;
    whatsappE164: string | null;
    city: string | null;
    score: number;
    scoreBand: string | null;
    valueMinor: number | null;
    currency: string | null;
    consentWhatsapp: boolean;
    consentCalls: boolean;
    source: { id: string; name: string } | null;
  } | null;
  customerId: string | null;
  customer: { id: string; fullName: string } | null;
  dealId: string | null;
  deal: { id: string; name: string } | null;
}

export interface TodayLeadCard {
  id: string;
  fullName: string;
  phoneE164: string | null;
  city: string | null;
  score: number;
  scoreBand: string | null;
  valueMinor: number | null;
  currency: string | null;
  createdAt: string;
  source: { id: string; name: string } | null;
  status: { id: string; name: string } | null;
  promise: { id: string; dueAt: string; health: string; minutesLeft: number } | null;
}

export interface TodayClockCard {
  id: string;
  target: string;
  health: string;
  dueAt: string;
  targetMinutes: number;
  minutesLeft: number;
  lead: { id: string; fullName: string; phoneE164: string | null } | null;
}

export interface TodaySection<T> {
  /** An aggregate over the whole set. Never `items.length` — see the API's own note. */
  count: number;
  items: T[];
  truncated: boolean;
  /** `false` when the caller's role withholds the permission the section reads. */
  available: boolean;
}

export interface Today {
  generatedAt: string;
  timeZone: string;
  for: { userId: string | null };
  counts: {
    overdue: number;
    dueNow: number;
    laterToday: number;
    upcoming: number;
    awaitingFirstContact: number;
    noNextAction: number;
    promisesBreached: number;
    promisesAtRisk: number;
    unacknowledgedEscalations: number;
  };
  sections: {
    overdue: TodaySection<TodayTaskCard>;
    dueNow: TodaySection<TodayTaskCard>;
    laterToday: TodaySection<TodayTaskCard>;
    awaitingFirstContact: TodaySection<TodayLeadCard>;
    promisesRunningOut: TodaySection<TodayClockCard>;
  };
}

/**
 * The whole screen, in one request.
 *
 * No swallowing twin: a Today screen that renders empty because the request failed is the worst
 * outcome this product has — somebody reads "nothing overdue" and goes home. The page shows the
 * refusal instead.
 */
export async function loadToday(token: string | null): Promise<Today> {
  return (await request<Today>('/my/today', { token })).data;
}

/** The four tiles above the queue, in the order they are read. */
export const TODAY_TILES = [
  {
    key: 'overdue',
    label: 'Overdue',
    hint: 'Past their time. Start here.',
    href: '/tasks?bucket=overdue',
  },
  {
    key: 'dueNow',
    label: 'Due now',
    hint: 'Within the next half hour.',
    href: '/tasks?bucket=due_now',
  },
  {
    key: 'laterToday',
    label: 'Later today',
    hint: 'Still today, in your workspace’s time.',
    href: '/tasks?bucket=due_today',
  },
  {
    key: 'awaitingFirstContact',
    label: 'New leads',
    hint: 'Nobody has spoken to them yet.',
    href: '/leads?f=firstContactedAt:is_null',
  },
] as const;

export type TodayTileKey = (typeof TODAY_TILES)[number]['key'];

export const HEALTH_LABELS: Record<string, string> = {
  breached: 'Missed',
  at_risk: 'Running out',
  running: 'On time',
  met: 'Answered',
  paused: 'Paused',
  cancelled: 'No longer applies',
};

export const HEALTH_CLASSES: Record<string, string> = {
  breached: 'bg-rose-100 text-rose-800',
  at_risk: 'bg-amber-100 text-amber-900',
  running: 'bg-slate-100 text-slate-700',
  met: 'bg-emerald-100 text-emerald-800',
  paused: 'bg-slate-100 text-slate-500',
  cancelled: 'bg-slate-100 text-slate-500',
};

/**
 * How late, or how soon — in the words somebody would use out loud.
 *
 * "2 days late" rather than "-2880 minutes", and "now" rather than "in 0 minutes". The sign is the
 * whole message on this screen, so it is never dropped.
 */
export function describeDelta(minutes: number): string {
  const magnitude = Math.abs(minutes);
  const late = minutes < 0;
  if (magnitude < 1) return 'now';
  const amount = describeMinutes(magnitude);
  return late ? `${amount} late` : `in ${amount}`;
}

/** How long a stretch of minutes reads as. Used by `describeDelta` and by the promise line. */
export function describeMinutes(minutes: number): string {
  const whole = Math.round(Math.abs(minutes));
  if (whole < 60) return `${whole} minute${whole === 1 ? '' : 's'}`;
  if (whole < 24 * 60) {
    const hours = Math.round(whole / 60);
    return `${hours} hour${hours === 1 ? '' : 's'}`;
  }
  const days = Math.round(whole / (24 * 60));
  return `${days} day${days === 1 ? '' : 's'}`;
}

/**
 * The sentence under the greeting.
 *
 * Assembled from the counts rather than hardcoded, and it omits what is zero: "You have 12
 * follow-ups today · 0 overdue · 0 new leads" reads as a system reporting fields, while "12
 * follow-ups today, 3 overdue" reads as somebody telling you where you stand.
 */
export function describeDay(counts: Today['counts']): string {
  const today = counts.dueNow + counts.laterToday;
  const parts: string[] = [];
  parts.push(today === 1 ? '1 follow-up left today' : `${today} follow-ups left today`);
  if (counts.overdue > 0) parts.push(`${counts.overdue} overdue`);
  if (counts.awaitingFirstContact > 0) {
    parts.push(
      counts.awaitingFirstContact === 1
        ? '1 new lead to call'
        : `${counts.awaitingFirstContact} new leads to call`,
    );
  }
  if (counts.promisesBreached > 0) parts.push(plural(counts.promisesBreached, 'missed promise'));
  else if (counts.promisesAtRisk > 0) {
    parts.push(`${plural(counts.promisesAtRisk, 'promise')} running out`);
  }
  if (today === 0 && counts.overdue === 0 && parts.length === 1) {
    return 'Nothing is owed today. A good moment to call the leads nobody has reached.';
  }
  return `${parts.join(' · ')}.`;
}

/**
 * "1 missed promise", not "1 missed promises".
 *
 * Worth its own function because the sentence is assembled from four clauses and the browser check
 * caught the one that had been written without it — a screen that cannot count to one reads as
 * machine output, which is exactly what the sentence exists to avoid.
 */
function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

/** Morning, afternoon or evening, in the viewer's own hours. */
export function greeting(now: Date): string {
  const hour = now.getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
}
