import { request } from '@/lib/api';

/**
 * The oversight screen's shapes and its link vocabulary, hand-written against the documented
 * envelope (the `@leados/shared` rule again; `oversight.spec.ts` reconciles them).
 *
 * The link vocabulary is the interesting half. "Every number has a drill-through to the filtered
 * list behind it — a metric you cannot click is a dead end" (`docs/frontend-architecture.md` §5.4),
 * so every figure this screen renders is produced by a function here that also knows where it goes.
 * Keeping the number and its destination in one place is what stops the two drifting into a link
 * that shows a different count from the one that was clicked.
 */

export interface OversightPerson {
  userId: string;
  name: string;
  email: string;
  openFollowUps: number;
  overdue: number;
  rescheduled: number;
  awaitingFirstContact: number;
  noNextAction: number;
  promisesBreached: number;
  promisesAtRisk: number;
  promisesMet: number;
  promisesAnsweredLate: number;
  /** `null`, not 0 or 100, for somebody who has answered nothing yet. */
  onTimeRate: number | null;
  medianResponseMinutes: number | null;
  leadsAssigned: number;
  converted: number;
}

export interface Oversight {
  generatedAt: string;
  timeZone: string;
  period: { from: string; to: string; days: number };
  scope: { kind: string; people: number; truncated: boolean };
  queue: {
    unassigned: number;
    awaitingFirstContact: number;
    noNextAction: number;
    overdue: number;
    dueToday: number;
  };
  promises: {
    breached: number;
    atRisk: number;
    met: number;
    answeredLate: number;
    onTimeRate: number | null;
    medianResponseMinutes: number | null;
  } | null;
  people: OversightPerson[];
}

export const OVERSIGHT_WINDOWS = [7, 30, 90] as const;
export type OversightWindow = (typeof OVERSIGHT_WINDOWS)[number];

export function isOversightWindow(value: number): value is OversightWindow {
  return (OVERSIGHT_WINDOWS as readonly number[]).includes(value);
}

export async function loadOversight(token: string | null, days: number): Promise<Oversight> {
  return (await request<Oversight>(`/oversight?days=${days}`, { token })).data;
}

/** How wide the caller's own grant is, said in a sentence rather than as a scope name. */
export function describeScope(kind: string, people: number): string {
  const who = people === 1 ? '1 person' : `${people} people`;
  switch (kind) {
    case 'organization':
      return `Everyone in the workspace — ${who}.`;
    case 'branch':
      return `Your branch — ${who}.`;
    case 'team':
      return `Your team — ${who}.`;
    default:
      return `Only your own work — ${who}.`;
  }
}

/** The five tiles across the top: the backlog that belongs to the workspace, not to a person. */
export const QUEUE_TILES = [
  {
    key: 'unassigned',
    label: 'Unassigned',
    hint: 'Nobody owns them, so nobody is behind on them.',
    href: '/leads?f=assignedUserId:is_null',
  },
  {
    key: 'awaitingFirstContact',
    label: 'Never contacted',
    hint: 'Captured, and nobody has spoken to them yet.',
    href: '/leads?f=firstContactedAt:is_null',
  },
  {
    key: 'noNextAction',
    label: 'Nothing planned',
    hint: 'Open leads nobody owes anything to.',
    href: '/leads?f=nextActionAt:is_null',
  },
  {
    key: 'overdue',
    label: 'Overdue',
    hint: 'Follow-ups past their time, across everyone.',
    href: '/tasks?bucket=overdue&everyone=true',
  },
  {
    key: 'dueToday',
    label: 'Due today',
    hint: 'Still to do before the day ends.',
    href: '/tasks?bucket=due_today&everyone=true',
  },
] as const;

export type QueueTileKey = (typeof QUEUE_TILES)[number]['key'];

/**
 * The columns of the people table, each with where its number leads.
 *
 * **There is no rank, no score and no total column**, and that is the design rather than an
 * omission: a single number would hide which of these somebody is actually behind on, and the
 * moment it exists people optimise it. Nothing here counts activity either — a leaderboard ranked
 * by calls logged teaches everybody to log calls.
 */
export interface PersonColumn {
  readonly key: keyof OversightPerson;
  readonly label: string;
  readonly hint: string;
  /** `cost` columns are the ones where a high number is bad; `outcome` columns the opposite. */
  readonly kind: 'outcome' | 'cost' | 'volume';
  readonly href: (person: OversightPerson) => string | null;
  /** How the value reads. `null` becomes an em dash rather than a zero. */
  readonly format?: (person: OversightPerson) => string;
}

export const PERSON_COLUMNS: readonly PersonColumn[] = [
  {
    key: 'onTimeRate',
    label: 'Answered on time',
    hint: 'Of the promises they answered in this period.',
    kind: 'outcome',
    href: (person) => `/sla?assignedUserId=${person.userId}`,
    format: (person) => (person.onTimeRate === null ? '—' : `${person.onTimeRate}%`),
  },
  {
    key: 'medianResponseMinutes',
    label: 'Median reply',
    hint: 'Half their replies were faster than this.',
    kind: 'outcome',
    href: (person) => `/sla?assignedUserId=${person.userId}`,
    format: (person) =>
      person.medianResponseMinutes === null ? '—' : describeMinutes(person.medianResponseMinutes),
  },
  {
    key: 'promisesBreached',
    label: 'Missed',
    hint: 'Promises past their deadline, unanswered.',
    kind: 'cost',
    href: (person) => `/sla?assignedUserId=${person.userId}`,
  },
  {
    key: 'overdue',
    label: 'Overdue',
    hint: 'Their follow-ups past their time.',
    kind: 'cost',
    href: (person) => `/tasks?bucket=overdue&assignedUserId=${person.userId}`,
  },
  {
    key: 'rescheduled',
    label: 'Moved',
    hint: 'Follow-ups they pushed back in this period.',
    kind: 'cost',
    href: (person) => `/tasks?assignedUserId=${person.userId}`,
  },
  {
    key: 'awaitingFirstContact',
    label: 'Never called',
    hint: 'Their leads nobody has spoken to.',
    kind: 'cost',
    href: (person) => `/leads?f=assignedUserId:eq:${person.userId}~firstContactedAt:is_null`,
  },
  {
    key: 'noNextAction',
    label: 'Nothing planned',
    hint: 'Their open leads with nothing owed.',
    kind: 'cost',
    href: (person) => `/leads?f=assignedUserId:eq:${person.userId}~nextActionAt:is_null`,
  },
  {
    key: 'openFollowUps',
    label: 'Open',
    hint: 'Everything still owed, overdue or not.',
    kind: 'volume',
    href: (person) => `/tasks?assignedUserId=${person.userId}`,
  },
  {
    key: 'leadsAssigned',
    label: 'New leads',
    hint: 'Given to them in this period.',
    kind: 'volume',
    href: (person) => `/leads?f=assignedUserId:eq:${person.userId}`,
  },
  {
    key: 'converted',
    label: 'Converted',
    hint: 'Became customers in this period.',
    kind: 'outcome',
    href: (person) => `/leads?f=assignedUserId:eq:${person.userId}~convertedAt:is_not_null`,
  },
];

/** `14` → `14 minutes`; `190` → `3 hours`. The same vocabulary `/today` uses. */
export function describeMinutes(minutes: number): string {
  const whole = Math.round(Math.abs(minutes));
  if (whole < 60) return `${whole} min`;
  if (whole < 24 * 60) {
    const hours = Math.round(whole / 60);
    return `${hours} hour${hours === 1 ? '' : 's'}`;
  }
  const days = Math.round(whole / (24 * 60));
  return `${days} day${days === 1 ? '' : 's'}`;
}

/** What a cell shows: the column's own format, or the number. */
export function cellValue(column: PersonColumn, person: OversightPerson): string {
  if (column.format) return column.format(person);
  const value = person[column.key];
  return typeof value === 'number' ? String(value) : '—';
}

/**
 * The sentence under the heading.
 *
 * Leads with the thing nobody owns, because that is the number no person's row contains and
 * therefore the one a manager would otherwise never see.
 */
export function describeBacklog(queue: Oversight['queue']): string {
  const parts: string[] = [];
  if (queue.unassigned > 0) parts.push(`${queue.unassigned} unassigned`);
  if (queue.overdue > 0) parts.push(`${queue.overdue} overdue`);
  if (queue.awaitingFirstContact > 0) parts.push(`${queue.awaitingFirstContact} never contacted`);
  if (parts.length === 0) return 'Nothing is unassigned, overdue or waiting for a first call.';
  return `${parts.join(' · ')}.`;
}
