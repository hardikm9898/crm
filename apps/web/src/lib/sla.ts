import { request } from '@/lib/api';

/**
 * The SLA shapes the screens read, hand-written against the documented envelope.
 *
 * The vocabulary is **declared here rather than imported from `@leados/shared`**, for the reason
 * `lib/tasks.ts` records: that package's entry point reaches `node:async_hooks` through the tenant
 * context, and a client component that transitively imports it fails `next build`. `sla.spec.ts`
 * runs in Node and reconciles the two.
 */
export const SLA_TARGETS = ['first_response', 'next_response', 'resolution'] as const;
export type SlaTarget = (typeof SLA_TARGETS)[number];

export const SLA_HEALTHS = [
  'breached',
  'at_risk',
  'running',
  'met',
  'paused',
  'cancelled',
] as const;
export type SlaHealth = (typeof SLA_HEALTHS)[number];

export interface SlaClock {
  id: string;
  target: SlaTarget;
  state: string;
  /** Derived by the API from the clock, so a board is never a cron tick behind the truth. */
  health: SlaHealth;
  startedAt: string;
  dueAt: string;
  warnAt: string;
  targetMinutes: number;
  satisfiedAt: string | null;
  satisfiedBy: string | null;
  breachedAt: string | null;
  warnedAt: string | null;
  cancelledAt: string | null;
  metOnTime: boolean | null;
  leadId: string | null;
  lead: { id: string; fullName: string; phoneE164: string | null } | null;
  assignedUserId: string | null;
  policy: { id: string; name: string } | null;
}

export interface SlaPolicy {
  id: string;
  name: string;
  appliesTo: {
    sourceIds?: string[];
    priorities?: string[];
    pipelineIds?: string[];
    scoreBands?: string[];
  };
  firstResponseMinutes: number;
  nextResponseMinutes: number | null;
  resolutionMinutes: number | null;
  businessHoursOnly: boolean;
  warnAtPercent: number;
  escalateTo: { permission?: string; userIds?: string[] };
  priority: number;
  isActive: boolean;
  clockCount: number;
}

export interface SlaBoard {
  counts: Record<string, number>;
  items: SlaClock[];
  unacknowledged: number;
  generatedAt: string;
}

export interface Escalation {
  id: string;
  level: number;
  reason: 'at_risk' | 'breached';
  notifiedUserIds: string[];
  createdAt: string;
  acknowledgedAt: string | null;
  acknowledgedById: string | null;
  policy: { id: string; name: string } | null;
  clock: {
    id: string;
    target: string;
    dueAt: string;
    leadId: string | null;
    lead: { id: string; fullName: string } | null;
  } | null;
}

export async function loadSlaBoard(token: string | null, query = ''): Promise<SlaBoard> {
  return (await request<SlaBoard>(`/sla/board${query}`, { token })).data;
}

export async function loadEscalations(token: string | null, query = ''): Promise<Escalation[]> {
  return (await request<Escalation[]>(`/sla/escalations${query}`, { token })).data;
}

/**
 * The policies.
 *
 * `loadSlaPoliciesOrThrow` is for the settings screen, where an empty list and a failed request
 * look identical and must not — the distinction the product catalogue had to learn the hard way.
 */
export async function loadSlaPolicies(token: string | null, query = ''): Promise<SlaPolicy[]> {
  try {
    return await loadSlaPoliciesOrThrow(token, query);
  } catch {
    return [];
  }
}

export async function loadSlaPoliciesOrThrow(
  token: string | null,
  query = '',
): Promise<SlaPolicy[]> {
  return (await request<SlaPolicy[]>(`/sla/policies${query}`, { token })).data;
}

/** The clocks on one lead, for its detail screen. Swallows: one panel is not the page. */
export async function loadLeadSla(leadId: string, token: string | null): Promise<SlaClock[]> {
  try {
    return (await request<SlaClock[]>(`/sla/clocks?leadId=${leadId}&limit=10`, { token })).data;
  } catch {
    return [];
  }
}

export const TARGET_LABELS: Record<SlaTarget, string> = {
  first_response: 'First response',
  next_response: 'Next reply',
  resolution: 'Closing out',
};

export const HEALTH_LABELS: Record<SlaHealth, string> = {
  breached: 'Missed',
  at_risk: 'Running out',
  running: 'On track',
  met: 'Met',
  paused: 'Paused',
  cancelled: 'No longer applies',
};

/** Only a miss is red, and only a kept promise is green. "On track" is not news. */
export const HEALTH_CLASSES: Record<SlaHealth, string> = {
  breached: 'bg-rose-100 text-rose-800',
  at_risk: 'bg-amber-100 text-amber-900',
  running: 'bg-slate-100 text-slate-700',
  met: 'bg-emerald-100 text-emerald-800',
  paused: 'bg-slate-100 text-slate-500',
  cancelled: 'bg-slate-100 text-slate-500',
};

/** The order a manager reads the board in: what is already wrong, then what is about to be. */
export const BOARD_COUNTS: readonly { key: string; label: string; hint: string }[] = [
  { key: 'breached', label: 'Missed', hint: 'Past the deadline. Start here.' },
  { key: 'at_risk', label: 'Running out', hint: 'Still time, but not much.' },
  { key: 'running', label: 'On track', hint: 'Nothing to do yet.' },
  { key: 'met', label: 'Met', hint: 'Answered inside the promise.' },
  {
    key: 'answered_late',
    label: 'Answered late',
    hint: 'Somebody got there, after the deadline.',
  },
];

/**
 * A target in **working** minutes, as a business reads it.
 *
 * "540 working minutes" is a number; "a working day" is the promise. The distinction between
 * working and elapsed is kept in the words because it is the whole point of the feature — a lead
 * arriving at 18:50 on a Friday is not late at 19:50.
 */
export function describeTargetMinutes(minutes: number, businessHoursOnly = true): string {
  const unit = businessHoursOnly ? 'working ' : '';
  if (businessHoursOnly && minutes >= 60 * 9 && minutes % (60 * 9) === 0) {
    const days = minutes / (60 * 9);
    return days === 1 ? 'a working day' : `${days} working days`;
  }
  if (minutes % 60 === 0) {
    const hours = minutes / 60;
    // "an working hour" is what a careless article produces, and it reaches the screen.
    if (hours === 1) return businessHoursOnly ? 'a working hour' : 'an hour';
    return `${hours} ${unit}hours`;
  }
  return `${minutes} ${unit}minutes`;
}

/** How long is left, or how long ago it went. Signed, so one function serves both sides. */
export function minutesFromNow(instant: string, now = new Date()): number {
  return Math.round((new Date(instant).getTime() - now.getTime()) / 60_000);
}
