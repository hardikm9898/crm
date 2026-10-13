import { request } from '@/lib/api';

/**
 * The notification centre's shapes and vocabulary, hand-written against the documented envelope.
 *
 * Like `lib/tasks.ts` and `lib/today.ts`: `@leados/shared` reaches `node:async_hooks` and a client
 * component that transitively imports it fails `next build`. `notifications.spec.ts` runs in Node
 * and reconciles the two.
 */

export const NOTIFICATION_GROUPS = ['work', 'leads', 'workspace'] as const;
export type NotificationGroup = (typeof NOTIFICATION_GROUPS)[number];

/** The heading each group of switches sits under, in the order somebody reads them. */
export const GROUP_LABELS: Record<NotificationGroup, string> = {
  work: 'Your work',
  leads: 'Leads',
  workspace: 'The workspace',
};

export const GROUP_HINTS: Record<NotificationGroup, string> = {
  work: 'Follow-ups you owe, and the promises your workspace made.',
  leads: 'Leads arriving, and leads nobody has picked up.',
  workspace: 'People, billing and anything that affects everyone.',
};

export interface NotificationTypePreference {
  type: string;
  label: string;
  hint: string;
  group: NotificationGroup;
  /** `false` for the notices `FR-NOT-3` says cannot be switched off. */
  optOut: boolean;
  defaultChannels: string[];
  /** `null` when this person has never touched it — the screen says "default". */
  channels: string[] | null;
  effectiveChannels: string[];
}

export interface NotificationPreferences {
  quietHours: { startMinute: number; endMinute: number } | null;
  timeZone: string | null;
  effectiveTimeZone: string;
  workspaceTimeZone: string;
  deliverableChannels: string[];
  types: NotificationTypePreference[];
}

export interface NotificationRow {
  id: string;
  type: string;
  title: string;
  body: string | null;
  link: string | null;
  data: Record<string, unknown>;
  readAt: string | null;
  createdAt: string;
}

/**
 * The settings, with a throwing twin.
 *
 * A preferences screen whose failure looks like "nothing is configured" would invite somebody to
 * re-save settings they already have — and on this screen a wrong save means being woken up. So
 * the page uses the throwing one and shows the refusal.
 */
export async function loadNotificationPreferences(
  token: string | null,
): Promise<NotificationPreferences> {
  return (await request<NotificationPreferences>('/notifications/preferences', { token })).data;
}

export async function loadNotifications(token: string | null): Promise<NotificationRow[]> {
  const response = await request<NotificationRow[]>('/notifications?limit=50', { token });
  return Array.isArray(response.data) ? response.data : [];
}

/** `1290` → `21:30`. The API speaks minutes; a person reads a clock. */
export function formatMinuteOfDay(minuteOfDay: number): string {
  const hour = Math.floor(minuteOfDay / 60);
  const minute = minuteOfDay % 60;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

/**
 * The sentence that says what the quiet window actually does.
 *
 * Worth a function because the two shapes read differently: a window inside one day is "between
 * 13:00 and 14:00", and the usual one crosses midnight and has to say so — otherwise "between
 * 21:30 and 07:00" looks like a mistake somebody made entering it.
 */
export function describeQuietHours(
  quiet: { startMinute: number; endMinute: number } | null,
  timeZone: string,
): string {
  if (!quiet) {
    return 'Off — you will be told about things as they happen, at any hour.';
  }
  const from = formatMinuteOfDay(quiet.startMinute);
  const to = formatMinuteOfDay(quiet.endMinute);
  const overnight = quiet.endMinute <= quiet.startMinute;
  return overnight
    ? `Held from ${from} until ${to} the next morning, ${timeZone} time.`
    : `Held from ${from} until ${to}, ${timeZone} time.`;
}

/** Whether a notification was held before it reached the inbox — `data.heldUntil` says so. */
export function heldUntil(row: NotificationRow): string | null {
  const value = row.data?.['heldUntil'];
  return typeof value === 'string' ? value : null;
}

/** The types grouped for the screen, with empty groups dropped rather than left as bare headings. */
export function byGroup(
  types: readonly NotificationTypePreference[],
): { group: NotificationGroup; types: NotificationTypePreference[] }[] {
  return NOTIFICATION_GROUPS.map((group) => ({
    group,
    types: types.filter((entry) => entry.group === group),
  })).filter((section) => section.types.length > 0);
}

/** Whether a type is on, given what the person chose and what the registry says. */
export function isOn(entry: NotificationTypePreference): boolean {
  return entry.effectiveChannels.length > 0;
}
